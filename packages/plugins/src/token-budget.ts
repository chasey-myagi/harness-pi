/**
 * Token budget —— 跟踪 session 累计 token，按预算决定 nudge / stop。
 *
 * 借鉴 Claude Code query/tokenBudget.ts 的 completion threshold + diminishing returns 算法。
 * 优先从 cost-tracker plugin 拉累计 token；否则 fallback 自己累计（精度略弱）。
 *
 * 详见 docs/05-plugins.md §5.11。
 */

import type { Hook, HookContext, HookResult } from "@harness-pi/core";

declare module "@harness-pi/core" {
  interface HookStateRegistry {
    "token-budget.tracker": BudgetTracker;
  }
}

export interface TokenBudgetOptions {
  /** session 总 token 预算。null = 不限。 */
  budget: number | null;
  /** 当前累计超 budget × completionThreshold 时停止 nudge（默认 0.9）。 */
  completionThreshold?: number;
  /** Diminishing returns 阈值。连续 N turn delta < 这个值视为收敛（默认 500）。 */
  diminishingThreshold?: number;
  /** 触发 diminishing 判定前最少 continuation 次数（默认 3）。 */
  diminishingMinNudges?: number;
  /** 触发 nudge 的文案。 */
  nudgeMessage?: (pct: number, turnTokens: number, budget: number) => string;
}

interface BudgetTracker {
  nudgeCount: number;
  lastDeltaTokens: number;
  lastTotalTokens: number;
  startedAt: number;
  fallbackInput: number;
  fallbackOutput: number;
}

const KEY = "token-budget.tracker" as const;

function defaultNudge(
  pct: number,
  turnTokens: number,
  budget: number,
): string {
  return `You've used ${turnTokens.toLocaleString()} / ${budget.toLocaleString()} tokens (${pct}%). Continue if more useful work remains; otherwise summarize and stop.`;
}

function readCumulativeTokens(ctx: HookContext): number {
  // 优先 cost-tracker 累计（已通过 module augmentation 注册到 HookStateRegistry）
  const cost = ctx.state.get("cost-tracker.stats");
  if (cost) return cost.inputTokens + cost.outputTokens;
  // fallback：本 plugin 自己 onLlmEnd 累计
  const t = ctx.state.get(KEY);
  return t ? t.fallbackInput + t.fallbackOutput : 0;
}

export function tokenBudget(opts: TokenBudgetOptions): Hook {
  const completionThreshold = opts.completionThreshold ?? 0.9;
  const diminishingThreshold = opts.diminishingThreshold ?? 500;
  const diminishingMinNudges = opts.diminishingMinNudges ?? 3;
  const nudgeMsg = opts.nudgeMessage ?? defaultNudge;

  return {
    name: "token-budget",
    timeout: 50,
    // 软依赖：cost-tracker 累计 token 是首选信号；缺它就走 fallback 自累。
    // 不阻塞构造，只 warn。
    requires: ["cost-tracker"],

    onSessionStart(_input, ctx) {
      ctx.state.set(KEY, {
        nudgeCount: 0,
        lastDeltaTokens: 0,
        lastTotalTokens: 0,
        startedAt: Date.now(),
        fallbackInput: 0,
        fallbackOutput: 0,
      } satisfies BudgetTracker);
    },

    onLlmEnd(input, ctx) {
      const tr = ctx.state.get(KEY);
      if (!tr) return;
      tr.fallbackInput += input.msg.usage.input ?? 0;
      tr.fallbackOutput += input.msg.usage.output ?? 0;
    },

    onTurnEnd(_input, ctx): HookResult | void {
      if (opts.budget == null || opts.budget <= 0) return;

      const tr = ctx.state.get(KEY);
      if (!tr) return;

      const totalTokens = readCumulativeTokens(ctx);
      const pct = Math.round((totalTokens / opts.budget) * 100);
      const delta = totalTokens - tr.lastTotalTokens;

      const isDiminishing =
        tr.nudgeCount >= diminishingMinNudges &&
        delta < diminishingThreshold &&
        tr.lastDeltaTokens < diminishingThreshold;

      if (totalTokens >= opts.budget) {
        return {
          continue: false,
          stopReason: `token budget exhausted: ${totalTokens}/${opts.budget}`,
        };
      }

      if (isDiminishing) {
        return {
          continue: false,
          stopReason: `diminishing returns: last continuations added <${diminishingThreshold} tokens each`,
        };
      }

      if (totalTokens < opts.budget * completionThreshold) {
        tr.nudgeCount++;
        tr.lastDeltaTokens = delta;
        tr.lastTotalTokens = totalTokens;
        return {
          additionalContext: `<system-reminder>${nudgeMsg(pct, totalTokens, opts.budget)}</system-reminder>`,
        };
      }

      // 已到完成阈值但未爆——不强停，让 LLM 自然收尾
      tr.lastDeltaTokens = delta;
      tr.lastTotalTokens = totalTokens;
      return;
    },
  };
}
