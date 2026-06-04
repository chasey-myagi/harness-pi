/**
 * 把 harness-pi 内核装配成 bot 用的 AgentSession，并把 `provider:modelId` spec 解析成 pi-ai Model。
 *
 * 不复用 coding-agent 的 createCodingAgent —— 那套带文件系统工具和 coding system prompt。
 * 这里直接 new AgentSession，挂最小够用的几个 plugin。
 */

import {
  AgentSession,
  type Api,
  type HarnessTool,
  type Hook,
  type Model,
  type Usage,
} from "@harness-pi/core";
import { calculateCost, getEnvApiKey, getModels, getProviders } from "@earendil-works/pi-ai";
import {
  costTracker,
  emptyRunGuard,
  metrics,
  repeatedCallGuard,
  sessionLog,
  toolStats,
  trimHistory,
  type CostTrackerOptions,
  type MetricsSink,
} from "@harness-pi/plugins";
import type { BotConfig } from "./config.js";
import type { MemoryStore } from "./memory.js";

/**
 * 解析 `provider:modelId`。精确匹配优先；找不到精确 id 时退化到该 provider 目录里
 * 名字含 "flash" 的、否则最后一个，并告警（容忍 pi-ai 目录里 model id 轮换）。
 * provider 未知 / 目录为空 / 缺 API key 都 throw（fail fast）。
 */
export function resolveModel(spec: string): Model<Api> {
  const sep = spec.indexOf(":");
  if (sep <= 0 || sep === spec.length - 1) {
    throw new Error(`Invalid model spec "${spec}". Expected provider:modelId.`);
  }
  const provider = spec.slice(0, sep);
  const modelId = spec.slice(sep + 1);

  const providers = getProviders() as string[];
  if (!providers.includes(provider)) {
    throw new Error(`Unknown provider "${provider}". Known: ${providers.join(", ")}`);
  }

  const models = getModels(provider as never);
  if (models.length === 0) {
    throw new Error(`No models in pi-ai catalog for provider "${provider}".`);
  }

  let model = models.find((m) => m.id === modelId);
  if (!model) {
    const fallback = models.find((m) => m.id.includes("flash")) ?? models[models.length - 1];
    // models.length > 0 已校验，fallback 必有值
    model = fallback as (typeof models)[number];
    console.error(
      `[lark-bot] model "${modelId}" not in pi-ai catalog for "${provider}"; falling back to "${model.id}". ` +
        `Available: ${models.map((m) => m.id).join(", ")}`,
    );
  }

  if (!getEnvApiKey(provider)) {
    throw new Error(
      `Missing API key for provider "${provider}". Set the provider's env var (e.g. DEEPSEEK_API_KEY) before starting.`,
    );
  }
  return model as Model<Api>;
}

/** 用 pi-ai 的定价表把内核 usage 折算成 $ 成本（搬自 coding-agent）。无定价的 model 折算为 0。 */
export function createPiAiCostModel(
  model: Model<Api>,
): NonNullable<CostTrackerOptions["costModel"]> {
  return (_modelId, usage) => {
    const piUsage: Usage = {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cached,
      cacheWrite: 0,
      totalTokens: usage.input + usage.output + usage.cached,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    return calculateCost(model, piUsage).total;
  };
}

/** 观测/评测插件的落点：共享的 metrics sink + 每会话 sessionLog 目录。 */
export interface Observability {
  /** 跨所有会话共享的一个 metrics 落盘 sink（NDJSON）。 */
  metricsSink: MetricsSink;
  /** sessionLog（全量 trace）目录，每会话一份 `<id>.ndjson`。 */
  logDir: string;
}

/**
 * 新建一条 bot 会话（每个飞书 chat 一条，复用以保留多轮记忆）。
 * - `memory`：自生长记忆，每次 LLM 调用前把全文层叠到人设 prompt 之上（构造期 prompt 保持纯人设）。
 * - `obs`：给了即挂观测插件 sessionLog(trace) + metrics(NDJSON) + costTracker($/token) + toolStats。
 */
export function createBotSession(
  cfg: BotConfig,
  model: Model<Api>,
  tools: HarnessTool[],
  memory: MemoryStore,
  obs?: Observability,
): AgentSession {
  const hooks: Hook[] = [];

  // 记忆注入：把当下记忆全文层叠到人设 prompt 之上（live 读取，turn N 写的下一轮就能用）。
  hooks.push({
    name: "memory-inject",
    transformSystemPromptBeforeLlm(systemPrompt: string): string | void {
      const mem = memory.load();
      if (mem.length === 0) return;
      return `${systemPrompt}\n\n# 你的记忆（过往沉淀，优先参考；若与现实不符就用工具核实并 remember 更新）\n\n${mem}`;
    },
  });

  // 观测/评测插件（sessionLog 排最前：完整记录每个 event 作为 trace）。
  if (obs) {
    hooks.push(sessionLog({ dir: obs.logDir }));
    hooks.push(metrics({ sink: obs.metricsSink }));
    hooks.push(costTracker({ mode: "lifetime", costModel: createPiAiCostModel(model) }));
    hooks.push(toolStats({}));
  }

  // 控制类插件
  hooks.push(
    // 控历史长度（小机器 + 长对话防 context 爆）
    trimHistory({ keepRecent: 16 }),
    // 连续空 turn 早停
    emptyRunGuard({ maxEmptyTurns: 3 }),
    // 同一工具反复调用兜底中止（防 deepseek 卡在某个 lark-cli 报错上死循环）
    repeatedCallGuard({
      threshold: 4,
      windowSize: 20,
      onRepeat(ctx, pattern) {
        ctx.abort(`repeated-call-guard: ${pattern.tool} repeated ${pattern.count}x`);
      },
    }),
  );

  return new AgentSession({
    model,
    tools,
    systemPrompt: cfg.systemPrompt,
    maxTurns: cfg.maxTurns,
    hooks,
  });
}
