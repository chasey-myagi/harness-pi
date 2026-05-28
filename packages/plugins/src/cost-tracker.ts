/**
 * Cost tracker —— 累计 token / cost / duration / per-model breakdown 到 ctx.state。
 *
 * 不抄 Claude Code 的全局 mutable state；用 ctx.state，跟 session 等长。
 * 详见 docs/05-plugins.md §5.10。
 */

import type { Hook, HookContext } from "@harness-pi/core";

/* ── 在 core 的 HookStateRegistry 上 augment 本 plugin 用到的 key ── */
declare module "@harness-pi/core" {
  interface HookStateRegistry {
    "cost-tracker.stats": CostStats;
    "cost-tracker.startTs": number;
  }
}

export interface CostTrackerOptions {
  /** 自定义 USD 计算（null 则只统计 token 不算 cost）。 */
  costModel?: (
    modelId: string,
    usage: { input: number; output: number; cached: number },
  ) => number;
  /** session 结束时回调（典型用：emit metric / 持久化）。 */
  onSessionFinalized?: (ctx: HookContext, stats: CostStats) => void;
  /**
   * 累计单元（Phase 3 新增）。默认 `"per-run"` 保持向后兼容。
   *
   * - `"per-run"`：每次 `session.run()` 重置；外部 `session.continue()` 沿用累计
   * - `"lifetime"`：整个 session 生命周期累计；多次 `run()` 不重置
   *
   * kernel-internal continuation loop（`onContinuationCheck → continue=true`）始终
   * 沿用累计——不属于"run"边界。
   */
  mode?: "per-run" | "lifetime";
}

export interface CostStats {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUSD: number;
  durationMs: number;
  llmCallCount: number;
  byModel: Map<
    string,
    {
      input: number;
      output: number;
      cached: number;
      costUSD: number;
      calls: number;
    }
  >;
}

// `as const` 保留字面类型，让 TypedStateMap 走 typed overload 而不是 string fallback
const KEY = "cost-tracker.stats" as const;
const KEY_START = "cost-tracker.startTs" as const;

function newStats(): CostStats {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    costUSD: 0,
    durationMs: 0,
    llmCallCount: 0,
    byModel: new Map(),
  };
}

export function costTracker(opts: CostTrackerOptions = {}): Hook {
  const mode = opts.mode ?? "per-run";

  return {
    name: "cost-tracker",
    internal: true,
    timeout: 50,

    onSessionStart(input, ctx) {
      // 注意：kernel 的内部 continuation loop（onContinuationCheck → continue=true）
      // **不**会 fire onSessionStart——这里的 "continue" 仅指外部 `session.continue()` 调用。
      //
      // 累积规则（mode='per-run' 默认）：
      //   - 首次 run()：init fresh
      //   - 外部 continue()：沿用累计；首次进入才 init
      //   - 同 session 多次 run()：每次 run 重置（独立计数单元）
      //
      // 累积规则（mode='lifetime'）：
      //   - 首次 run()：init fresh
      //   - 之后所有 run/continue：沿用累计，永不重置
      if (input.source === "continue") {
        if (!ctx.state.has(KEY)) {
          ctx.state.set(KEY_START, Date.now());
          ctx.state.set(KEY, newStats());
        }
        return;
      }
      // source === "run"
      if (mode === "lifetime" && ctx.state.has(KEY)) {
        // lifetime 模式下，第二次 run() 不重置
        return;
      }
      ctx.state.set(KEY_START, Date.now());
      ctx.state.set(KEY, newStats());
    },

    onLlmEnd(input, ctx) {
      const stats = ctx.state.get(KEY);
      if (!stats) return;
      const usage = input.msg.usage;
      const modelId = input.msg.model || "unknown";
      const inputTok = usage.input ?? 0;
      const outputTok = usage.output ?? 0;
      const cachedTok = usage.cacheRead ?? 0;

      let cost = 0;
      try {
        cost =
          opts.costModel?.(modelId, {
            input: inputTok,
            output: outputTok,
            cached: cachedTok,
          }) ?? 0;
      } catch {
        cost = 0;
      }

      stats.inputTokens += inputTok;
      stats.outputTokens += outputTok;
      stats.cachedTokens += cachedTok;
      stats.costUSD += cost;
      stats.llmCallCount += 1;

      const m = stats.byModel.get(modelId) ?? {
        input: 0,
        output: 0,
        cached: 0,
        costUSD: 0,
        calls: 0,
      };
      m.input += inputTok;
      m.output += outputTok;
      m.cached += cachedTok;
      m.costUSD += cost;
      m.calls += 1;
      stats.byModel.set(modelId, m);
    },

    onSessionEnd(_input, ctx) {
      const stats = ctx.state.get(KEY);
      const startTs = ctx.state.get(KEY_START);
      if (!stats || startTs === undefined) return;
      stats.durationMs = Date.now() - startTs;
      opts.onSessionFinalized?.(ctx, stats);
    },
  };
}

export function getCostStats(ctx: HookContext): CostStats | undefined {
  return ctx.state.get(KEY);
}
