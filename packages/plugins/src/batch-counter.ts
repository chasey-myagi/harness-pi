/**
 * Batch counter —— 每 N 次目标 tool 触发回调，调用方决定下一步。
 *
 * 不内置 abort / reminder 等具体动作——回调里调 ctx.abort、写 ctx.state 让 system-reminder
 * 注入提示、记 metric 等都行，由用户自由组合。
 *
 * 详见 docs/05-plugins.md §5.7。
 */

import type { Hook, HookContext } from "@harness-pi/core";

export interface BatchCounterOptions {
  /** 只计这个工具的成功调用。 */
  triggerTool: string;
  /** 每 N 次触发 onFull；归零后重新计数。 */
  batchSize: number;
  /** 达到 batchSize 的回调。 */
  onFull: (ctx: HookContext, count: number) => void;
  /** 自定义 ctx.state key（多个 batch-counter 并存时区分）。 */
  stateKey?: string;
}

export function batchCounter(opts: BatchCounterOptions): Hook {
  if (opts.batchSize <= 0) {
    throw new Error("batchCounter: batchSize must be > 0");
  }
  const key = opts.stateKey ?? `batch-counter.${opts.triggerTool}.count`;

  return {
    name: `batch-counter(${opts.triggerTool}/${opts.batchSize})`,
    timeout: 50,

    onPostToolUse(input, ctx) {
      if (input.call.name !== opts.triggerTool) return;
      if (input.result.isError) return;

      const prev = (ctx.state.get(key) as number | undefined) ?? 0;
      const n = prev + 1;
      ctx.state.set(key, n);

      if (n >= opts.batchSize) {
        ctx.state.set(key, 0);
        opts.onFull(ctx, n);
      }
    },
  };
}
