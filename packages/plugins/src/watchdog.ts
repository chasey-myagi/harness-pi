/**
 * Watchdog —— 单 turn 超时强终止。
 *
 * 用 `wrapTurn` 包整个 turn 体；触发后 `ctx.abort(reason)` 让当前 turn 走完后退出。
 * 详见 docs/05-plugins.md §5.1。
 */

import type { Hook, HookContext } from "@harness-pi/core";

export interface WatchdogOptions {
  /** 单 turn 最大耗时（ms）。 */
  turnTimeoutMs: number;
  /** 超时回调（记 metric / 通知外部）。 */
  onTimeout?: (ctx: HookContext, turnIdx: number) => void;
}

export function watchdog(opts: WatchdogOptions): Hook {
  if (opts.turnTimeoutMs <= 0) {
    throw new Error("watchdog: turnTimeoutMs must be > 0");
  }

  return {
    name: "watchdog",
    async wrapTurn(ctx, next) {
      const timer = setTimeout(() => {
        try {
          opts.onTimeout?.(ctx, ctx.turnIdx);
        } catch {
          // onTimeout 抛错也不影响 abort
        }
        ctx.abort(
          `watchdog: turn ${ctx.turnIdx} timed out after ${opts.turnTimeoutMs}ms`,
        );
      }, opts.turnTimeoutMs);
      if (typeof (timer as { unref?: () => void }).unref === "function") {
        (timer as { unref: () => void }).unref();
      }
      try {
        await next();
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
