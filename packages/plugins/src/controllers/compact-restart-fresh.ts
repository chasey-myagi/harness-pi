/**
 * compactRestartFresh —— 最便宜的 compaction 策略（docs/09 §4.2，建在 §3.6 内核 overflow 事件 #6 上）。
 *
 * 思路（doc-08 的结论）：「overflow 时直接 abort + 重启 fresh，比在原 session 里魔法缩小 token 更直接」。
 * 拆成两件可独立组合的东西：
 *   1. `compactOnOverflow()` —— 一个 Hook：监听内核 `onContextOverflow` → `ctx.abort("compaction:…")`，
 *      让本次 run 以 `reason:"aborted"` + 该 abortReason 收尾。
 *   2. `CompactRestartFresh` —— 一个控制器：捕捉 compaction-class abort → 用 fresh session **重跑同一
 *      prompt**（丢掉越界的 ReAct trace），直到非 compaction abort 或重启次数耗尽。
 *
 * 为什么不复用 `LifecycleRestart`：它 `continue()` 并搬入 `[...session.messages]` —— 那是「带着历史续跑」，
 * 对 overflow 恰恰会**再次越界**。compactRestartFresh 要的是相反语义：**丢掉**越界 trace、fresh 重跑。
 * 两者共享同一个 `isCompactionRestart` 谓词，所以想要「带历史重启」的调用方也可把它喂给 LifecycleRestart 的
 * `isRetryable`。
 *
 * ⚠️ 适用边界（诚实声明）：只有当 overflow 来自**多轮累积的 trace** 时，fresh 重跑才有进展；若 overflow 来自
 * **初始 prompt 本身过大**，每次 fresh 重跑会同样越界，控制器会在 `maxRestarts` 后返回最后一次的 aborted
 * summary（不假装恢复成功）。需要真正缩小上下文的场景用 `compactSummarize`（在 transformMessagesBeforeLlm
 * 里总结 + 写 compaction 边界）。
 */

import type { AgentSession, RunSummary } from "@harness-pi/core";
import type { Hook } from "@harness-pi/core";

/** compactOnOverflow 默认用的 abort reason。`compaction:` 前缀是 isCompactionRestart 的识别契约。 */
export const COMPACTION_OVERFLOW_REASON = "compaction:overflow";

export interface CompactOnOverflowOptions {
  /** 自定义 abort reason；**必须** `compaction:` 前缀，否则 isCompactionRestart 不认、不会重启。 */
  reason?: string;
}

/**
 * Hook：把内核的 onContextOverflow 观测点转成一次 `ctx.abort("compaction:…")`。
 * 装进 `CompactRestartFresh.sessionFactory` 造的每个 session 里。
 */
export function compactOnOverflow(opts: CompactOnOverflowOptions = {}): Hook {
  const reason = opts.reason ?? COMPACTION_OVERFLOW_REASON;
  return {
    name: "compactOnOverflow",
    onContextOverflow: (_input, ctx) => {
      ctx.abort(reason);
    },
  };
}

/**
 * 判定一次 abort 是否由 compaction 触发（abortReason 以 `compaction:` 开头）。
 * 既给 `CompactRestartFresh` 内部用，也可作 `LifecycleRestart` 的 `isRetryable`。
 */
export function isCompactionRestart(abortReason: string | undefined): boolean {
  return abortReason !== undefined && abortReason.startsWith("compaction:");
}

export interface CompactRestartFreshOptions {
  /**
   * 造 fresh session 的工厂；首跑 + 每次重启各调一次。**工厂里务必装 `compactOnOverflow()` hook**，
   * 否则 overflow 不会变成 compaction abort、控制器无从感知。
   */
  sessionFactory: () => AgentSession;
  /** 最大重启次数（不含首跑），默认 3。 */
  maxRestarts?: number;
}

export interface CompactRestartResult extends RunSummary {
  /** 实际重启次数（不含首跑）。 */
  restarts: number;
}

const DEFAULT_MAX_RESTARTS = 3;

export class CompactRestartFresh {
  constructor(private readonly opts: CompactRestartFreshOptions) {
    if ((opts.maxRestarts ?? DEFAULT_MAX_RESTARTS) < 0) {
      throw new Error("CompactRestartFresh: maxRestarts must be >= 0");
    }
  }

  /**
   * 跑 prompt，overflow-abort 则 fresh 重跑，直到非 compaction abort 或 maxRestarts 耗尽。
   * 注意：只代理 `signal` 给每次 `AgentSession.run`，其余 run 选项不穿透（与 LifecycleRestart 同）。
   */
  async run(
    prompt: string,
    opts?: { signal?: AbortSignal },
  ): Promise<CompactRestartResult> {
    const max = this.opts.maxRestarts ?? DEFAULT_MAX_RESTARTS;
    const runOpts = opts?.signal ? { signal: opts.signal } : {};

    let summary = await this.opts.sessionFactory().run(prompt, runOpts);
    let restarts = 0;

    while (
      summary.reason === "aborted" &&
      isCompactionRestart(summary.abortReason) &&
      restarts < max &&
      !opts?.signal?.aborted
    ) {
      restarts++;
      // fresh session：丢掉上一次越界的 trace，从同一 prompt 重跑。
      summary = await this.opts.sessionFactory().run(prompt, runOpts);
    }

    return { ...summary, restarts };
  }
}
