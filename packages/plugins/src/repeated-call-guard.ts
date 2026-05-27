/**
 * Repeated call guard —— 检测 LLM 反复用同 args 调同一 tool（"原地打转"）。
 *
 * token-budget 的 diminishing returns 是 token-delta 信号，跟 semantic 进度无关；
 * 这个 plugin 补上 semantic 信号——窗口内同 (tool, args) 重复达阈值就触发回调。
 *
 * 典型用例：
 *   - bidding-agent 反复 grep 同一关键词
 *   - research agent 反复搜索同一 query
 *   - 任何"agent 卡在某个想法上"的场景
 *
 * 不内置 abort——回调里调 ctx.abort、记 metric、注 reminder 都行，由用户组合。
 */

import type { Hook, HookContext } from "@harness-pi/core";

export interface RepeatedCallGuardOptions {
  /** 同 (tool, args) 在窗口内累计 ≥ threshold 次即触发 onRepeat。 */
  threshold: number;
  /** 滑动窗口大小（最近 N 个 tool call）。默认 20。 */
  windowSize?: number;
  /** 触发时回调（典型：ctx.abort / 记 metric / 注 reminder via ctx.state）。 */
  onRepeat: (
    ctx: HookContext,
    pattern: {
      tool: string;
      args: Record<string, unknown>;
      count: number;
      windowSize: number;
    },
  ) => void;
  /** 哪些工具计入。undefined = 全部。 */
  watchTools?: string[];
  /** 自定义 args 等价判定（默认 JSON.stringify 比较）。 */
  argsEqual?: (a: Record<string, unknown>, b: Record<string, unknown>) => boolean;
  /** 触发后是否归零（避免每次后续 call 都触发）。默认 true。 */
  resetOnTrigger?: boolean;
}

interface CallRecord {
  tool: string;
  argsKey: string;
  args: Record<string, unknown>;
}

declare module "@harness-pi/core" {
  interface HookStateRegistry {
    "repeated-call-guard.window": CallRecord[];
  }
}

const KEY = "repeated-call-guard.window" as const;

function defaultArgsEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  // 注意：JSON.stringify 对 key order 敏感。绝大多数 LLM tool call 同语义会同 order，
  // 真有需求让用户传 argsEqual 自定义。
  return JSON.stringify(a) === JSON.stringify(b);
}

export function repeatedCallGuard(opts: RepeatedCallGuardOptions): Hook {
  if (opts.threshold <= 1) {
    throw new Error("repeatedCallGuard: threshold must be > 1");
  }
  const windowSize = opts.windowSize ?? 20;
  const argsEqual = opts.argsEqual ?? defaultArgsEqual;
  const watchSet = opts.watchTools ? new Set(opts.watchTools) : null;
  const resetOnTrigger = opts.resetOnTrigger ?? true;

  return {
    name: "repeated-call-guard",
    timeout: 50,

    onSessionStart(_input, ctx) {
      ctx.state.set(KEY, [] as CallRecord[]);
    },

    onPostToolUse(input, ctx) {
      if (watchSet && !watchSet.has(input.call.name)) return;
      if (input.result.isError) return; // 失败的 call 不计

      const window = ctx.state.get(KEY);
      if (!window) return;

      const argsKey = safeStringify(input.call.arguments);
      window.push({
        tool: input.call.name,
        argsKey,
        args: input.call.arguments,
      });

      // 滑窗裁剪
      while (window.length > windowSize) window.shift();

      // 数同 (tool, args) 出现次数
      let count = 0;
      for (const r of window) {
        if (r.tool === input.call.name && r.argsKey === argsKey) {
          // 用户自定义 argsEqual 时，argsKey 字符串相等只是 fast path；
          // 再走 callback 确认（防止 JSON.stringify 假阳/阴性）
          if (argsEqual === defaultArgsEqual || argsEqual(r.args, input.call.arguments)) {
            count++;
          }
        }
      }

      if (count >= opts.threshold) {
        try {
          opts.onRepeat(ctx, {
            tool: input.call.name,
            args: input.call.arguments,
            count,
            windowSize,
          });
        } catch {
          /* swallow: plugin callback 抛错不影响 session */
        }
        if (resetOnTrigger) {
          // 把这个 pattern 从窗口里清掉，避免下次又触发
          const filtered = window.filter(
            (r) =>
              !(
                r.tool === input.call.name &&
                (argsEqual === defaultArgsEqual
                  ? r.argsKey === argsKey
                  : argsEqual(r.args, input.call.arguments))
              ),
          );
          ctx.state.set(KEY, filtered);
        }
      }
    },
  };
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
