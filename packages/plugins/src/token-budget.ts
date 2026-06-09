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
  /** 累计超 budget × completionThreshold 时,每 turn 的 remaining 提示升级为「该收尾」urgency（默认 0.9）。 */
  completionThreshold?: number;
  /** Diminishing returns 阈值。连续 N turn delta < 这个值视为收敛（默认 500）。 */
  diminishingThreshold?: number;
  /** 触发 diminishing 判定前最少 turn 数（默认 3）。 */
  diminishingMinNudges?: number;
  /** 每 turn 注入的 remaining 提示文案。`usedTokens` 是**累计**已用 token（非单 turn）。 */
  nudgeMessage?: (pct: number, usedTokens: number, budget: number) => string;
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
  usedTokens: number,
  budget: number,
): string {
  const remaining = Math.max(0, budget - usedTokens);
  return `Token budget: ${usedTokens.toLocaleString()} / ${budget.toLocaleString()} tokens used (${pct}%), ${remaining.toLocaleString()} remaining. Plan remaining work to fit the budget; summarize and stop if little remains.`;
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
    // cost-tracker 累计 token 是首选信号；缺它走 fallback 自累。
    // 用 `prefers`（不发 warning），不用 `requires`（会 warn 噪音）。
    prefers: ["cost-tracker"],

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

    // X4（issue #43）：每 turn 开始注入「剩余预算」结构化提示——**持续反馈**(不只停时)，让模型据此
    // 规划剩余工作。补上原先 0.9~1.0 临界区无反馈的缺口。additionalContext 一次性消费语义正好匹配
    // 「每 call 注入」；走通用 prompt 注入，不依赖 provider beta（实仓核验 pi-ai 无 task_budget）。
    onTurnStart(_input, ctx): HookResult | void {
      if (opts.budget == null || opts.budget <= 0) return;
      const totalTokens = readCumulativeTokens(ctx);
      const pct = Math.round((totalTokens / opts.budget) * 100);
      // 越过 completionThreshold 进入临界区 → reminder 升级为「该收尾」紧急提示（补原先 0.9~1.0 无反馈的缺口）。
      const urgent = totalTokens >= opts.budget * completionThreshold;
      const body =
        nudgeMsg(pct, totalTokens, opts.budget) +
        (urgent ? " You are near the budget limit — wrap up and stop soon." : "");
      return {
        additionalContext: `<system-reminder>${body}</system-reminder>`,
      };
    },

    // turn 收尾只做**停止决策**（预算耗尽 / diminishing 收敛）——持续 remaining 反馈已移到 onTurnStart。
    onTurnEnd(_input, ctx): HookResult | void {
      if (opts.budget == null || opts.budget <= 0) return;

      const tr = ctx.state.get(KEY);
      if (!tr) return;

      const totalTokens = readCumulativeTokens(ctx);
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

      // 每 turn 推进收敛跟踪（nudgeCount 现作「已观察 turn 数」，喂 diminishing 判定）。
      tr.nudgeCount++;
      tr.lastDeltaTokens = delta;
      tr.lastTotalTokens = totalTokens;
      return;
    },
  };
}
