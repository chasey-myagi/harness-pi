/**
 * cache-ab.ts — 真 provider prompt-cache A/B（#116，env-gated）。
 *
 * 对比同一多轮工具会话在「全量(无压缩) baseline」vs「封存投影(autoCompaction)」下的
 * prompt-cache 命中率 + 总 token，验证封存投影**省 token 且不显著破坏 cache**
 * （boundary 一次性跳变后前缀稳定 → 命中率不跌破 baseline − 容差）。
 *
 * DeepSeek 报 cached usage（qwen 不报，见 memory harness-pi-cache-trim-finding）。跑法：
 *   DEEPSEEK_API_KEY=$(security find-generic-password -a "$USER" -s DEEPSEEK_API_KEY -w) \
 *     pnpm --filter @harness-pi/coding-agent exec tsx scripts/cache-ab.ts
 * 缺 key → skip(exit 0)，CI 默认不跑（与 d0-smoke 同惯例）。
 */
import { AgentSession, makeOpenAICompatibleModel, type HarnessTool } from "@harness-pi/core";
import { autoCompaction } from "@harness-pi/plugins";
import { Type } from "@earendil-works/pi-ai";

const key = process.env.DEEPSEEK_API_KEY;
if (!key) {
  console.log("[cache-ab] skip: 缺 DEEPSEEK_API_KEY（env-gated，CI 默认不跑）");
  process.exit(0);
}

const MODEL_ID = process.env.CACHE_AB_MODEL ?? "deepseek-chat";
const llmOptions = { apiKey: key };

function makeModel() {
  return makeOpenAICompatibleModel({
    id: MODEL_ID,
    baseUrl: "https://api.deepseek.com",
    contextWindow: 65536,
    maxTokens: 8192,
  });
}

// 产生可观历史的工具：多轮逐条记录 → 历史累积触发压缩，且前缀可被 provider 缓存。
const noteTool: HarnessTool = {
  name: "note",
  description: "Record one note and echo it back. Call once per item.",
  parameters: Type.Object({ text: Type.String({ description: "the note text" }) }),
  isConcurrencySafe: () => true,
  async execute(args) {
    return { content: [{ type: "text", text: `noted: ${(args as { text: string }).text}` }] };
  },
};

const ITEMS = ["苹果", "香蕉", "橙子", "葡萄", "西瓜", "菠萝", "草莓", "蓝莓"];
const PROMPT =
  `逐条记录这些水果，每个都单独调用一次 note 工具（共 ${ITEMS.length} 次），全部记完后用一句话总结：` +
  ITEMS.join("、");

interface Sample {
  reason: string;
  input: number;
  cacheRead: number;
  output: number;
  total: number;
  hitRate: number;
}

async function runOnce(label: string, useCompaction: boolean): Promise<Sample> {
  const hooks = useCompaction
    ? [
        autoCompaction({
          // 压得狠一点确保触发 boundary：留最近 4 条、阈值低。
          maxContextTokens: 1500,
          triggerRatio: 0.6,
          keepRecent: 4,
          summarize: async (msgs) => `（已压缩 ${msgs.length} 条早期消息：记录了若干水果）`,
        }),
      ]
    : [];
  const session = new AgentSession({ model: makeModel(), tools: [noteTool], llmOptions, hooks });
  const summary = await session.run(PROMPT);
  const u = summary.usage;
  const cacheable = u.input + u.cacheRead;
  const hitRate = cacheable > 0 ? u.cacheRead / cacheable : 0;
  console.log(
    `[${label}] reason=${summary.reason} input=${u.input} cacheRead=${u.cacheRead} ` +
      `output=${u.output} total=${u.totalTokens} → cache 命中率=${(hitRate * 100).toFixed(1)}%`,
  );
  return { reason: summary.reason, input: u.input, cacheRead: u.cacheRead, output: u.output, total: u.totalTokens, hitRate };
}

async function main(): Promise<void> {
  console.log(`[cache-ab] model=${MODEL_ID}\n`);
  const baseline = await runOnce("baseline 全量(无压缩)", false);
  const sealed = await runOnce("封存投影(autoCompaction)", true);

  console.log(
    `\n对比：命中率 baseline=${(baseline.hitRate * 100).toFixed(1)}% / 封存=${(sealed.hitRate * 100).toFixed(1)}%` +
      ` ｜ 总 token baseline=${baseline.total} / 封存=${sealed.total}`,
  );

  // 验收两条：① 封存命中率不跌破 baseline − 5%（boundary 一次跳变损失有限、前缀仍稳）；
  //          ② 封存总 token ≤ baseline（压缩确实省了 context）。
  const cacheOk = sealed.hitRate >= baseline.hitRate - 0.05;
  const tokenOk = sealed.total <= baseline.total;
  console.log(cacheOk ? "✓ 封存命中率 ≥ baseline − 5%" : "✗ 封存命中率显著低于 baseline（破坏 cache）");
  console.log(tokenOk ? "✓ 封存总 token ≤ baseline（省了 context）" : "✗ 封存未省 token");
  process.exit(cacheOk && tokenOk ? 0 : 1);
}

main().catch((err) => {
  console.error("[cache-ab] 失败:", err);
  process.exit(1);
});
