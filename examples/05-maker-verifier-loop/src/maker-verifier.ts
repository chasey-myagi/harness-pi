/**
 * maker-verifier loop —— 用 harness-pi **现成 hook** 拼出的「生成者 / 验证者分离」循环。
 *
 * 这不是一条内置 `/goal` 命令，而是从零件装出来的循环——#111「Loop Engineering substrate
 * （卖 hook 零件库，不卖命令）」的活样本。一条防摆烂的 loop 真正值钱的零件是 **maker-verifier
 * 分离**（"让作者别批改自己的作业"，reviewer 只回 PASS/FAIL 逼返工），而它全部能用现成件拼出来：
 *
 *   - **maker**：一个干活的 `AgentSession`（这里用 toy `submit` 工具代表「产出解」；真实场景是
 *     write/edit + 跑测试）。
 *   - **停止闸 = `turnEndGuard`**：maker 想停时，跑一个**独立 reviewer**判 PASS/FAIL；FAIL 就把
 *     gap 作为阻断消息回灌、强制 maker 返工。验证发生在**回合之外**，结构上绕开了「in-loop judge
 *     打断生产性回合」的老问题（#100 移除 progressVerifier 的根因）。
 *   - **reviewer**：一个**全新 `AgentSession`**——不同 system prompt、**无任何 tools**（不能改代码），
 *     只读 maker 提交的 solution，回 `"PASS"` / `"FAIL: <gap>"`。
 *   - **硬保险丝**：`tokenBudget`（总预算）+ `repeatedCallGuard`（无进展熔断）——loop 不会无限空转。
 *
 * ⚠️ 设计要点（修正一个常见误解）：强制验证闸应放在 `turnEndGuard.check` 里跑 reviewer，**不是**把
 * `subAgentTool` 丢给 maker 让它「自觉」调——后者是 maker **主动**委派子任务的工具，验证会变成可选、
 * 称职模型也可能跳过。要把验证做成**强制 gate**，就得挂在 maker 想停的那一刻（turnEndGuard）。
 *
 * 全部用 fake model 离线确定性演示；真实接入只需把 makerModel / reviewerModel 换成真 provider。
 */
import { AgentSession, Type, type HarnessTool, type Message } from "@harness-pi/core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { turnEndGuard, tokenBudget, repeatedCallGuard } from "@harness-pi/plugins";

/** 取 assistant 消息纯文本（reviewer 的 verdict 是纯文本）。 */
function assistantText(m: Message | undefined): string {
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  return m.content
    .map((b) => ("text" in b && typeof b.text === "string" ? b.text : ""))
    .join("");
}

export interface MakerVerifierResult {
  /** maker session 终态（reviewer 放行 / 达返工上限 / 预算耗尽 等）。 */
  reason: string;
  /** 被 reviewer FAIL 强制返工的次数。 */
  reworks: number;
  /** reviewer 最终是否放行（false = 达返工上限仍未过、放行停止）。 */
  passed: boolean;
  /** maker 最后提交的解。 */
  finalSolution: string;
  /**
   * **验证闸本身**失败时的原因（reviewer provider 抛错 / 非正常终态）。set 即表示这条结果**不可信**
   * ——不是「reviewer 说没过」，而是「reviewer 根本没判成」。与 passed=false 区分开，别把 gate 故障
   * 当普通未达成掩盖。
   */
  gateError?: string;
}

export interface MakerVerifierOptions {
  /** maker（干活方）的 model。 */
  makerModel: Model<Api>;
  /** reviewer（独立验证方）的 model——与 maker 不同实例、不同 system prompt。 */
  reviewerModel: Model<Api>;
  /** maker 要完成的任务。 */
  task: string;
  /** 验收标准（注入 reviewer 的 system prompt，作为 PASS/FAIL 依据）。 */
  stopCondition: string;
  /** 最多强制返工几次（达上限仍 FAIL 则放行停止，绝不无限转）。默认 3。 */
  maxReworks?: number;
  /**
   * **每一方** session 的 token 预算（硬保险丝）。默认 50_000。注意 reviewer 是独立 session，
   * 其用量不计入 maker 的预算——故对 maker、对**每次** review 各挂一道 budget。聚合上界 ≈
   * maker 预算 + (maxReworks + 1) × reviewer 单次预算（接真 provider 时据此估算总成本）。
   */
  budgetTokens?: number;
  /**
   * 单次 reviewer LLM 调用的超时（毫秒）。默认 120_000。turnEndGuard 是 event 类 hook，超时会 fail-open
   * 丢弃续跑结果 → gate 被静默绕过；真 reviewer provider 慢时必须给足，否则验证形同虚设。
   */
  reviewerTimeoutMs?: number;
}

/**
 * 跑一条 maker-verifier loop，返回循环结果。所有护栏都是 `@harness-pi/plugins` 现成 hook。
 */
export async function runMakerVerifierLoop(
  opts: MakerVerifierOptions,
): Promise<MakerVerifierResult> {
  let lastSolution = "";
  let passed = false;
  let gateError: string | undefined;

  // maker 提交解的 toy 工具（真实场景是 write/edit + 跑测试后提交 diff）。
  const submitTool: HarnessTool = {
    name: "submit",
    description: "Submit your current solution for independent review.",
    parameters: Type.Object({ solution: Type.String({ description: "the solution text" }) }),
    async execute(args) {
      lastSolution = String((args as { solution: string }).solution);
      return { content: [{ type: "text", text: "submitted for review" }] };
    },
  };

  const maxReworks = opts.maxReworks ?? 3;
  const budget = opts.budgetTokens ?? 50_000;
  const maker = new AgentSession({
    model: opts.makerModel,
    tools: [submitTool],
    // 内核在 fire onContinuationCheck **前**先查 maxContinuations（默认 5）。turnEndGuard 每次 FAIL→force
    // 算一次 continuation，所以 maxContinuations 必须 > maxReworks，否则 maxReworks≥5 时内核会先以
    // max_continuations 退出、reviewer 等不到最后那次 PASS/exhaust。留 +1 给最终评判的那次 check。
    maxContinuations: maxReworks + 1,
    hooks: [
      // 停止闸：maker 想停 → 跑独立 reviewer → FAIL 则回灌 gap 强制返工、PASS 则放行。
      // timeoutMs 必须覆盖真 reviewer provider 的耗时——turnEndGuard 是 event 类、超时 fail-open 会丢弃
      // 续跑结果让 gate 被静默绕过（默认 30s 对真 LLM 不够）。
      turnEndGuard({
        maxRetries: maxReworks,
        timeoutMs: opts.reviewerTimeoutMs ?? 120_000,
        check: async (ctx) => {
          // 独立 reviewer sub-agent：全新 AgentSession、不同 system prompt、无 edit/write 工具（不能改代码）。
          // 复用同一个 reviewerModel 实例 → fake model 的 response 队列在多轮 review 间推进
          //（真 provider 则是同一模型每次对当前 solution 重新判断）。挂自己的 tokenBudget 封住单次 review 成本
          // （reviewer 在独立 session、用量不进 maker 预算）。
          const reviewer = new AgentSession({
            model: opts.reviewerModel,
            tools: [],
            systemPrompt:
              `You are a strict, independent reviewer. You cannot edit code. ` +
              `Stop condition: ${opts.stopCondition}. ` +
              `Reply with exactly "PASS" or "FAIL: <one-line gap>".`,
            hooks: [tokenBudget({ budget, diminishingThreshold: 0 })],
          });
          // reviewer 基础设施失败（provider 抛错 / 非正常终态）→ 验证闸本身坏了。**别**把空/陈旧 verdict
          // 当普通 FAIL 掩盖（那会让外层以 done+passed=false 收场、看不出 gate 失效）。两种失败都接住：
          // ① reviewer.run 抛（stream 同步抛被内核 fail-open 后仍可能冒泡）；② 返回非 done 终态。
          // 经 gateError 显式 surface（ctx.abort 尽力而为，但从 continuation-check 内未必改写终态）。
          let summary;
          try {
            summary = await reviewer.run(
              `Review this submitted solution:\n${lastSolution || "(nothing submitted yet)"}`,
            );
          } catch (err) {
            gateError = `reviewer threw: ${err instanceof Error ? err.message : String(err)}`;
            ctx.abort(gateError);
            return { ok: true };
          }
          if (summary.reason !== "done") {
            gateError = `reviewer failed to produce a verdict (reviewer reason=${summary.reason})`;
            ctx.abort(gateError);
            return { ok: true };
          }
          const verdict = assistantText(summary.lastMessage);
          if (/^\s*PASS\b/i.test(verdict)) {
            passed = true;
            return { ok: true };
          }
          const gap = verdict.replace(/^\s*FAIL:?\s*/i, "").trim() || "stop condition not met";
          return { ok: false, message: `Reviewer says FAIL: ${gap}. Revise your solution and resubmit.` };
        },
      }),
      // 硬保险丝：总预算 + 无进展（重复同一 tool call）熔断 —— 防摆烂、防空转。
      // diminishingThreshold:0 关掉 tokenBudget 的「递减收益」启发式：它按 maker 每 turn 的 token delta 判
      // 「无进展」，但 maker-verifier loop 的实际进展发生在**回合外的 reviewer**、不计入 maker delta，简洁
      // 回合会被误判为摆烂、在 reviewer 评判前就 abort。这里只保留**显式预算上限**这一条硬闸。
      // repeatedCallGuard 不内置 abort，在 onRepeat 里 ctx.abort 当熔断（domain-free 设计，由调用方组合）。
      tokenBudget({ budget, diminishingThreshold: 0 }),
      repeatedCallGuard({
        threshold: 4,
        onRepeat: (ctx, p) =>
          ctx.abort(`repeated-call-guard: ${p.tool} 重复 ${p.count} 次无进展，熔断`),
      }),
    ],
  });

  const summary = await maker.run(opts.task);
  // reworks = 内核记录的强制续跑次数（turnEndGuard FAIL→force）。比手数 check-FAIL 更准：
  // 达 maxRetries 上限那次「放行停止」的 FAIL 不算返工，continuations 自然不计它。
  const result: MakerVerifierResult = {
    reason: summary.reason,
    reworks: summary.continuations,
    passed,
    finalSolution: lastSolution,
  };
  if (gateError !== undefined) result.gateError = gateError;
  return result;
}
