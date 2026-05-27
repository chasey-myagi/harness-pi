/**
 * Empty-run guard —— 连续 N turn 无 tool call 视为 LLM 卡死，主动 abort。
 *
 * Session 续跑场景：onSessionStart 在每次 run/continue 都 fire，所以 counter 自动重置——
 * plugin 不用特殊处理。session.continue() 同样会发 onSessionStart（source="continue"）。
 *
 * 详见 docs/05-plugins.md §5.3。
 */

import type { Hook, TurnEndInput, HookContext } from "@harness-pi/core";

declare module "@harness-pi/core" {
  interface HookStateRegistry {
    "empty-run.consecutive": number;
  }
}

export interface EmptyRunGuardOptions {
  /** 连续 N turn toolResults.length === 0 即触发 abort。 */
  maxEmptyTurns: number;
  /** 自定义"啥算空"判定（默认 input.toolResults.length === 0）。 */
  considerEmpty?: (input: TurnEndInput) => boolean;
}

const KEY = "empty-run.consecutive" as const;

export function emptyRunGuard(opts: EmptyRunGuardOptions): Hook {
  if (opts.maxEmptyTurns <= 0) {
    throw new Error("emptyRunGuard: maxEmptyTurns must be > 0");
  }
  const considerEmpty =
    opts.considerEmpty ?? ((i: TurnEndInput) => i.toolResults.length === 0);

  return {
    name: "empty-run-guard",
    timeout: 50,

    onSessionStart(_input, ctx) {
      // 每次 run/continue 都重置计数，避免续跑串味
      ctx.state.set(KEY, 0);
    },

    onTurnEnd(input, ctx: HookContext) {
      const prev = ctx.state.get(KEY) ?? 0;
      const isEmpty = considerEmpty(input);
      const now = isEmpty ? prev + 1 : 0;
      ctx.state.set(KEY, now);
      if (now >= opts.maxEmptyTurns) {
        ctx.abort(
          `empty-run-guard: ${now} consecutive empty turns (no tool calls)`,
        );
      }
    },
  };
}
