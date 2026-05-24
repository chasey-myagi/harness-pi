/**
 * Lease decision —— 多 worker 并行时拦截 tool args 跟当前 lease 不一致的调用。
 *
 * 详见 docs/05-plugins.md §5.8。
 */

import type { Hook, HookContext } from "@harness-pi/core";
import type { ToolCall } from "@mariozechner/pi-ai";

export interface LeaseDecisionOptions {
  /** 返回当前 lease 持有的 id；null/undefined = 没 lease，跳过检查。 */
  currentLease: (ctx: HookContext) => string | null | undefined;
  /** Tool args 里哪个字段是 lease id（默认 "questionId"）。 */
  argField?: string;
  /** 只检查这些工具；undefined = 所有携带 argField 的工具。 */
  guardedTools?: string[];
  /** 冲突回调。 */
  onConflict?: (
    call: ToolCall,
    actualLease: string,
    requestedLease: string,
    ctx: HookContext,
  ) => void;
  /** 拒绝消息前缀。 */
  reasonPrefix?: string;
}

export function leaseDecision(opts: LeaseDecisionOptions): Hook {
  const argField = opts.argField ?? "questionId";
  const reasonPrefix = opts.reasonPrefix ?? "Lease mismatch:";
  const guardedSet = opts.guardedTools ? new Set(opts.guardedTools) : null;

  return {
    name: "lease-decision",
    timeout: 50,

    onPreToolUse(input, ctx) {
      if (guardedSet && !guardedSet.has(input.call.name)) return;
      const args = input.call.arguments as Record<string, unknown>;
      const requested = args[argField];
      if (typeof requested !== "string" || requested.length === 0) return;

      const actual = opts.currentLease(ctx);
      if (!actual) return;
      if (actual === requested) return;

      opts.onConflict?.(input.call, actual, requested, ctx);
      return {
        decision: "deny",
        reason: `${reasonPrefix} tool ${input.call.name} used ${argField}="${requested}", current lease is "${actual}". Process the leased item first.`,
        additionalContext: `<system-reminder>The previous tool call was rejected because it referenced ${argField}="${requested}" but the current lease is "${actual}". Switch to "${actual}".</system-reminder>`,
      };
    },
  };
}
