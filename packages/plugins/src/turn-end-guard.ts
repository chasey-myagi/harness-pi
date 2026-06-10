/**
 * Turn-end quality guard —— stopHook 式「想停时先过一道闸」。纯插件、零内核改动。
 *
 * 对齐 Claude Code stopHook 的 `preventContinuation + blockingError`：session 走到 would-be-done
 * （`reason==="done"` 且还有续跑预算）时，内核 fire `onContinuationCheck`；本插件在这里跑一个
 * 调用方注入的 `check`：
 *   - **不过**（`ok:false`）→ 用 `ctx.appendMessage(createUserMessage(message))` 注入一条**持久**阻断
 *     消息（进 session.messages、下次 LLM call 可见——对齐 cc 的 isMeta blocking user message，比 transient
 *     `additionalContext` 更忠实，模型在后续轮始终看得到「为什么没让你停」），**并** return `{ continue: true }`
 *     强制再跑一轮让模型修。
 *   - **过**（`ok:true`）→ return 空（放行，session 正常停止）。
 *
 * 这就覆盖了 cc stopHook 的核心语义，**不动内核一行**——`onContinuationCheck` 是唯一能「强制再来一轮」
 * 的 hook（`onTurnEnd` 只能 `continue:false` 中止、不能强制续跑）。
 *
 * **防死循环：两层兜底。**
 *   - 内核侧：`maxContinuations`（AgentSessionOptions，默认 5）是续跑硬上限，超出内核以
 *     `reason:"max_continuations"` 收尾——这是最终安全网。
 *   - 插件侧：`maxRetries`（默认 3）。连续强制 `maxRetries` 次后 `check` 仍不过，本插件**停止强制**
 *     （return 空 → 放行停止），避免在 `maxContinuations` 被调得很大时空转。选「放行停止」而非
 *     `ctx.abort`：插件 domain-free，不替调用方决定「修不好就是错误」；session 以正常 `done` 收尾，调用方
 *     可在 onSessionEnd 自行判定。计数随 `ok:true` 重置（一次通过后重新给满预算）。
 *
 * **与其它 `onContinuationCheck` hook 的合并交互**（见 dispatcher.ts `mergeResults`）：`onContinuationCheck`
 * 走 **event 并行 + merge** 路径。`continue` 的合并是「`false` 优先、否则任一 `true` 即 `true`」——本插件
 * 返回 `continue:true` 不会被别的 hook 的「沉默/`true`」覆盖，能可靠强制续跑；唯一能压过它的是别的 hook
 * 显式 `continue:false`，但 `mergeResults` 对 event 路径的 `false` 只在调用点用于「是否续跑」判定，且
 * `false` 也不会取消已 `appendMessage` 的持久阻断消息（那是即时副作用）。`appendMessage` 不经 merge、直接
 * push 进 session.messages，故多个 turnEndGuard / 其它注入 hook 共存时各自的消息都会落上，互不抢占。
 *
 * **超时**：`onContinuationCheck` 是 **event 类** hook，dispatcher 默认 per-hook timeout 仅 100ms；而本插件的
 * `check` 通常做 I/O（跑测试 / lint / 调 LLM）必然超 100ms，一旦超时其 `{continue:true}` 会被 `_invokeSafe`
 * 静默丢弃 → 质量闸形同虚设。故返回的 Hook **自设较宽的 `timeout`**（默认 30s，对齐 `onAfterFlush` 对
 * 「可调 LLM 的 hook 应放宽 timeout」的同款约定），调用方可经 `timeoutMs` 覆盖。
 *
 * **domain-free**：插件不认识「测试」「lint」这类业务；`check` 全由调用方注入，`message` 是要回灌给模型的
 * 阻断说明（如 "测试未过：<输出>，修复后再停"）。
 */

import {
  createUserMessage,
  type ContinuationCheckInput,
  type Hook,
  type HookContext,
  type HookResult,
} from "@harness-pi/core";

declare module "@harness-pi/core" {
  interface HookStateRegistry {
    "turn-end-guard.retries": number;
  }
}

/**
 * `check` 的返回。`ok:true` 放行停止；`ok:false` 时 `message` 是要持久回灌给模型的阻断说明
 * （缺省给一句兜底文案）。
 */
export interface TurnEndGuardResult {
  ok: boolean;
  /** `ok:false` 时回灌给模型的阻断消息。省略则用兜底文案。 */
  message?: string;
}

export interface TurnEndGuardOptions {
  /**
   * 质量闸校验。session 想停时跑一次：`ok:false` → 注入 `message` + 强制再跑一轮让模型修；
   * `ok:true` → 放行停止。`ctx` 给到 messages / state / config 等只读视图。
   */
  check: (ctx: HookContext) => Promise<TurnEndGuardResult> | TurnEndGuardResult;
  /**
   * 插件自身的连续强制上限（默认 3）。连续失败到此上限后停止强制、放行停止——
   * 与内核 `maxContinuations` 互补，避免后者很大时空转。计数随一次 `ok:true` 重置。
   */
  maxRetries?: number;
  /**
   * 返回 Hook 的 per-hook timeout（毫秒，默认 30000）。`onContinuationCheck` 是 event 类、dispatcher
   * 默认仅 100ms，而 `check` 通常做 I/O 必然超时被静默丢弃 → 闸失效。故放宽默认；`check` 更慢时调大。
   */
  timeoutMs?: number;
}

const KEY = "turn-end-guard.retries" as const;

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_BLOCK_MESSAGE =
  "turn-end-guard: quality check did not pass; please fix the issue before stopping.";

export function turnEndGuard(opts: TurnEndGuardOptions): Hook {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  if (maxRetries <= 0) {
    throw new Error("turnEndGuard: maxRetries must be > 0");
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (timeoutMs <= 0) {
    throw new Error("turnEndGuard: timeoutMs must be > 0");
  }

  return {
    name: "turn-end-guard",
    // event 类默认 100ms 远不够 check 做 I/O——放宽，否则超时丢弃 {continue:true} → 闸静默失效。
    timeout: timeoutMs,

    onSessionStart(_input, ctx) {
      // 每次 run/continue 重置，避免续跑串味（对齐 emptyRunGuard）。
      ctx.state.set(KEY, 0);
    },

    async onContinuationCheck(
      _input: ContinuationCheckInput,
      ctx: HookContext,
    ): Promise<HookResult | void> {
      const result = await opts.check(ctx);

      if (result.ok) {
        // 过闸：放行停止，并重置预算（下次 run 内再想停时重新给满 maxRetries）。
        ctx.state.set(KEY, 0);
        return;
      }

      // 不过闸。先看插件侧预算是否用尽。
      const used = ctx.state.get(KEY) ?? 0;
      if (used >= maxRetries) {
        // 连续强制到上限仍不过：停止强制，放行停止（不 abort——domain-free，让调用方在
        // onSessionEnd 自行判定）。重置计数，避免 continue/resume 串味。
        ctx.state.set(KEY, 0);
        ctx.log.warn(
          `turn-end-guard: maxRetries (${maxRetries}) exhausted, allowing stop`,
        );
        return;
      }

      // 注入持久阻断消息（进 session.messages、下次 LLM call 可见），并强制再跑一轮。
      const message = result.message ?? DEFAULT_BLOCK_MESSAGE;
      ctx.appendMessage(createUserMessage(message));
      ctx.state.set(KEY, used + 1);
      return { continue: true };
    },
  };
}
