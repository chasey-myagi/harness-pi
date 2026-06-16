/**
 * progressVerifier —— loop-engineering 的 turn 级进展/目标 verifier hook。
 *
 * **用途**：供 /goal 循环等 loop-engineering 场景使用。在每个 turn 结束后调用用户提供的
 * `judge` 函数，判定：
 *   1. **目标是否达成**（`reached: true`）→ 停止 session（`onTurnEnd continue=false`）。
 *   2. **本 turn 是否有真实进展**（`hasProgress: false`）→ 累计计数；连续 N turn 无进展
 *      → 停止 session 或调用用户的 `onStall` 升级回调。
 *
 * **与其它 plugin 的语义边界**（不重叠原则）：
 *   - `repeatedCallGuard`：检测同一 (tool, args) 在滑窗内重复——这是 **tool-call 级别的
 *     语法/语义信号**（LLM 是否原地打转）。`progressVerifier` 检测的是 **turn 级目标进展**：
 *     由调用方注入的业务谓词（如「issue 是否已 closed」）或 LLM-judge 回调来判定，不关心
 *     具体调了哪个 tool。两者互补，不竞争。
 *   - `turnEndGuard`：挂在 `onContinuationCheck`（session **想停时**先过一道质量闸，可强制
 *     续跑）。`progressVerifier` 挂在 `onTurnEnd`（每 turn 后**主动停止**），是 verifier 闸
 *     而非续跑闸——触发方向相反：前者"不让停"，后者"主动停"。
 *   - `continuationCheck`：内核机制，用于 `turnEndGuard` 强制续跑。`progressVerifier` 不使用
 *     此 hook，因为其语义是"条件满足时停止"，而非"条件不满足时继续"。
 *
 * **hook 位置**：`onTurnEnd`（event 类）—— 返回 `{ continue: false }` 时内核在本 turn 结束
 * 后 abort session，`RunSummary.reason` 为 `"aborted"`、`abortReason` 含插件标识。
 *
 * **防死循环**：`noProgressThreshold` 是硬上限；`onStall` 回调可自定义升级逻辑（如报警、
 * 降级到人工审查）。默认在阈值触发后直接停止，不让 session 无限空跑。
 *
 * **判据抛错**：`judge` 抛错时记 warn 日志并跳过本 turn 计数（中性处理：不计无进展、不计进展），
 * session 继续运行——避免 judge 瞬时异常导致误停。
 *
 * **timeout 默认 30s**：`onTurnEnd` 是 event 类、dispatcher 默认 per-hook timeout 仅 100ms；
 * 而 `judge` 通常需要 LLM 判定，必然超 100ms。故本插件自设宽 timeout（对齐 `turnEndGuard` /
 * `onAfterFlush` 的同款约定），可经 `timeoutMs` 覆盖。
 */

import type {
  Hook,
  HookContext,
  HookResult,
  TurnEndInput,
} from "@harness-pi/core";

declare module "@harness-pi/core" {
  interface HookStateRegistry {
    "progress-verifier.noProgressCount": number;
  }
}

const KEY = "progress-verifier.noProgressCount" as const;
const DEFAULT_THRESHOLD = 3;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * `judge` 的返回。
 *
 * - `reached: true` → 目标达成，插件立即停止 session。
 * - `reached: false, hasProgress: true`（或省略 `hasProgress`）→ 本 turn 有真实进展，重置无进展计数。
 * - `reached: false, hasProgress: false` → 本 turn 无真实进展，累计计数；达阈值时停止/升级。
 */
export interface ProgressJudgement {
  /** 目标是否完全达成。`true` 时 session 立即停止。 */
  reached: boolean;
  /**
   * 本 turn 是否有真实进展。
   * 省略时默认 `true`（乐观：大多数 turn 都在做事）——只在本 turn 明确无进展时才设为 `false`。
   * `reached: true` 时本字段无意义。
   */
  hasProgress?: boolean;
  /** 停止时写入 `abortReason` 的说明；省略时用兜底文案。 */
  message?: string;
}

export interface ProgressVerifierOptions {
  /**
   * 每 turn 结束后调用的进展判断函数。可同步或异步（如需调 LLM）。
   * 抛错时按「中性」处理（不计无进展、不计进展），session 继续。
   */
  judge: (
    ctx: HookContext,
    input: TurnEndInput,
  ) => Promise<ProgressJudgement> | ProgressJudgement;

  /**
   * 连续多少 turn 无真实进展后触发停止/升级。默认 3，须 > 0。
   */
  noProgressThreshold?: number;

  /**
   * 连续无进展达阈值时的回调。可在此发报警、记 metric、或调 `ctx.abort(customReason)`。
   * - 若回调内调用了 `ctx.abort()`，插件不再二次停止。
   * - 若回调正常返回（未 abort），插件用默认 `{ continue: false }` 停止 session。
   * - 省略时：直接以默认原因停止。
   */
  onStall?: (
    ctx: HookContext,
    info: { consecutiveNoProgress: number },
  ) => void | Promise<void>;

  /**
   * 本插件的 per-hook timeout（毫秒），默认 30000。
   * `onTurnEnd` 是 event 类、dispatcher 默认仅 100ms；`judge` 做 LLM 调用必然超时 → 判断失效。
   * `judge` 更慢时调大此值。
   */
  timeoutMs?: number;
}

export function progressVerifier(opts: ProgressVerifierOptions): Hook {
  const threshold = opts.noProgressThreshold ?? DEFAULT_THRESHOLD;
  if (threshold <= 0) {
    throw new Error("progressVerifier: noProgressThreshold must be > 0");
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (timeoutMs <= 0) {
    throw new Error("progressVerifier: timeoutMs must be > 0");
  }

  return {
    name: "progress-verifier",
    // onTurnEnd 是 event 类，dispatcher 默认 100ms 远不够 judge 做 I/O。
    timeout: timeoutMs,

    onSessionStart(_input, ctx) {
      ctx.state.set(KEY, 0);
    },

    async onTurnEnd(
      input: TurnEndInput,
      ctx: HookContext,
    ): Promise<HookResult | void> {
      let judgement: ProgressJudgement;
      try {
        judgement = await opts.judge(ctx, input);
      } catch (err) {
        // judge 抛错：中性处理（跳过本 turn 计数），session 继续。
        ctx.log.warn("progressVerifier: judge threw, skipping turn", {
          hook: "progress-verifier",
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      // 目标达成 → 立即停止。
      if (judgement.reached) {
        const stopReason = judgement.message
          ? `progressVerifier: goal reached — ${judgement.message}`
          : "progressVerifier: goal reached";
        ctx.state.set(KEY, 0);
        return { continue: false, stopReason };
      }

      // hasProgress 默认 true（乐观）；只有显式 false 才计无进展。
      const hasProgress = judgement.hasProgress !== false;
      if (hasProgress) {
        ctx.state.set(KEY, 0);
        return;
      }

      // 本 turn 无进展，累计计数。
      const count = (ctx.state.get(KEY) ?? 0) + 1;
      ctx.state.set(KEY, count);

      if (count >= threshold) {
        // 触发 onStall 回调（如有）。
        if (opts.onStall) {
          await opts.onStall(ctx, { consecutiveNoProgress: count });
        }
        // onStall 若未 abort，插件用默认原因停止。
        if (!ctx.signal.aborted) {
          const stopReason = judgement.message
            ? `progressVerifier: no progress — ${judgement.message}`
            : "progressVerifier: no progress";
          return { continue: false, stopReason };
        }
      }
    },
  };
}
