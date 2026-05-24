/**
 * HookDispatcher —— 按 hook 形态走不同执行策略：
 *   - Event       并行 Promise.all + merge
 *   - Decision    顺序 await + short-circuit (first decisive wins)
 *                 关键：additionalContext / systemMessage 不算决断，会被聚合；
 *                 只有 decision / updatedInput / continue=false 才短路。
 *                 hook throw/timeout 默认 fail-open，failClosed=true 时视为 deny。
 *   - Pipe        顺序 await + 链式 transform
 *   - Around      reduceRight 构造嵌套链
 *
 * Per-hook timeout（默认按类型）+ try/catch + 上报 failureSink。
 *
 * **聚合粒度差异**（注意 sink/dashboard 一致性）：
 *   - Event 路径：`MergedHookResult.systemMessages` 是 `string[]`，kernel 在 `_flushSystemMessages`
 *     里逐条 emit 给 consoleSink —— N 条 systemMessage = N 次 sink call。
 *   - Decision 路径：`HookResult.systemMessage` / `additionalContext` 是单数字段，dispatcher
 *     已把多 hook 累积值 `join("\n")` 成一条 —— N 条 systemMessage = 1 次 sink call。
 *   - 如果 dashboard 按 sink call 计数，两路径会差一截；按字节数 / 行数计就一致。
 */

import type { ToolCall } from "@mariozechner/pi-ai";
import type {
  ContinuationCheckInput,
  ErrorInput,
  Hook,
  HookContext,
  HookResult,
  LlmEndInput,
  MergedHookResult,
  PostToolUseInput,
  PreToolUseInput,
  SessionEndInput,
  SessionStartInput,
  ToolExecResult,
  TurnEndInput,
  TurnStartInput,
  UserPromptSubmitInput,
} from "./hook.js";
import type { Message } from "@mariozechner/pi-ai";

/* ────────────── 默认 timeout ────────────── */

const DEFAULT_TIMEOUTS = {
  event: 100,
  decision: 200,
  pipe: 500,
} as const;

type Category = keyof typeof DEFAULT_TIMEOUTS;

const EVENT_METHODS = new Set([
  "onSessionStart",
  "onSessionEnd",
  "onContinuationCheck",
  "onTurnStart",
  "onTurnEnd",
  "onLlmEnd",
  "onPostToolUse",
  "onError",
] as const);

const DECISION_METHODS = new Set([
  "onPreToolUse",
  "onUserPromptSubmit",
] as const);

const PIPE_METHODS = new Set([
  "transformSystemPromptBeforeLlm",
  "transformMessagesBeforeLlm",
] as const);

/* ────────────── HookFailureSink ────────────── */

export interface HookFailureInfo {
  hookName: string;
  method: string;
  errorMessage: string;
  timeoutMs?: number;
  internal: boolean;
  /** True 时表示该 decision hook 被 fail-closed 处理（视为 deny）。 */
  failedClosed?: boolean;
}

export type HookFailureSink = (info: HookFailureInfo) => void;

const defaultFailureSink: HookFailureSink = (info) => {
  if (info.internal) return;
  // eslint-disable-next-line no-console
  console.error(
    `[harness-pi] hook "${info.hookName}".${info.method} failed:`,
    info.errorMessage,
    info.timeoutMs ? `(timeout ${info.timeoutMs}ms)` : "",
    info.failedClosed ? "[fail-closed: treated as deny]" : "",
  );
};

/* ────────────── Dispatcher ────────────── */

export interface EventInputMap {
  onSessionStart: SessionStartInput;
  onSessionEnd: SessionEndInput;
  onContinuationCheck: ContinuationCheckInput;
  onTurnStart: TurnStartInput;
  onTurnEnd: TurnEndInput;
  onLlmEnd: LlmEndInput;
  onPostToolUse: PostToolUseInput;
}

export interface DecisionInputMap {
  onPreToolUse: PreToolUseInput;
  onUserPromptSubmit: UserPromptSubmitInput;
}

export class HookDispatcher {
  constructor(
    private readonly hooks: ReadonlyArray<Hook>,
    private readonly failureSink: HookFailureSink = defaultFailureSink,
  ) {}

  /* ────────────── Event: 并行 ────────────── */

  async fireEvent<M extends keyof EventInputMap>(
    method: M,
    input: EventInputMap[M],
    ctx: HookContext,
  ): Promise<MergedHookResult> {
    const matched = this.hooks.filter(
      (h) => typeof h[method] === "function",
    );
    const results = await Promise.all(
      matched.map((h) => this._invokeSafe(h, method, [input, ctx], "event")),
    );
    return mergeResults(results.map((r) => r.value));
  }

  /** Special: onError 不返回值，just observe. */
  async fireError(input: ErrorInput, ctx: HookContext): Promise<void> {
    const matched = this.hooks.filter((h) => typeof h.onError === "function");
    await Promise.all(
      matched.map((h) =>
        this._invokeSafe(h, "onError", [input, ctx], "event"),
      ),
    );
  }

  /* ────────────── Decision: 顺序 short-circuit ────────────── */

  /**
   * Decision 路径：顺序问每个 hook，**只在 decision / updatedInput / continue=false 上短路**。
   * - additionalContext / systemMessage 累积，不算决断（关键修复：避免 context-injection hook 误屏蔽下游安全检查）。
   * - failClosed=true 的 hook 失败时返回 deny。
   */
  async fireDecision<M extends keyof DecisionInputMap>(
    method: M,
    input: DecisionInputMap[M],
    ctx: HookContext,
  ): Promise<HookResult | null> {
    const additionalContexts: string[] = [];
    const systemMessages: string[] = [];

    for (const h of this.hooks) {
      if (typeof h[method] !== "function") continue;
      const inv = await this._invokeSafe(h, method, [input, ctx], "decision");

      // hook failed (throw/timeout): fail-closed 视为 deny
      if (inv.error) {
        if (h.failClosed) {
          const denyResult: HookResult = {
            decision: "deny",
            reason: `hook "${h.name}" failed (${inv.error.message}); failClosed=true → denied`,
          };
          if (additionalContexts.length > 0) {
            denyResult.additionalContext = additionalContexts.join("\n");
          }
          if (systemMessages.length > 0) {
            denyResult.systemMessage = systemMessages.join("\n");
          }
          return denyResult;
        }
        // fail-open: 继续
        continue;
      }

      const r = inv.value;
      if (!r || typeof r !== "object" || Array.isArray(r)) continue;
      const hr = r as HookResult;

      // 聚合 transient context（永不短路）
      if (hr.additionalContext) additionalContexts.push(hr.additionalContext);
      if (hr.systemMessage) systemMessages.push(hr.systemMessage);

      // 真正的决断：decision / updatedInput / continue=false
      if (
        hr.decision !== undefined ||
        hr.updatedInput !== undefined ||
        hr.continue === false
      ) {
        const out: HookResult = { ...hr };
        if (additionalContexts.length > 0) {
          out.additionalContext = additionalContexts.join("\n");
        }
        if (systemMessages.length > 0) {
          out.systemMessage = systemMessages.join("\n");
        }
        return out;
      }
    }

    // 没人决断：如果累积了 context，构造一个 non-decisive 结果交给 caller
    if (additionalContexts.length > 0 || systemMessages.length > 0) {
      const out: HookResult = {};
      if (additionalContexts.length > 0) {
        out.additionalContext = additionalContexts.join("\n");
      }
      if (systemMessages.length > 0) {
        out.systemMessage = systemMessages.join("\n");
      }
      return out;
    }
    return null;
  }

  /* ────────────── Pipe: 顺序 transform ────────────── */

  async firePipeSystemPrompt(
    value: string,
    ctx: HookContext,
  ): Promise<string> {
    let v = value;
    for (const h of this.hooks) {
      if (typeof h.transformSystemPromptBeforeLlm !== "function") continue;
      const inv = await this._invokeSafe(
        h,
        "transformSystemPromptBeforeLlm",
        [v, ctx],
        "pipe",
      );
      if (typeof inv.value === "string") v = inv.value;
    }
    return v;
  }

  async firePipeMessages(
    value: Message[],
    ctx: HookContext,
  ): Promise<Message[]> {
    let v = value;
    for (const h of this.hooks) {
      if (typeof h.transformMessagesBeforeLlm !== "function") continue;
      const inv = await this._invokeSafe(
        h,
        "transformMessagesBeforeLlm",
        [v, ctx],
        "pipe",
      );
      if (Array.isArray(inv.value)) v = inv.value as Message[];
    }
    return v;
  }

  /* ────────────── Around: 嵌套 ────────────── */

  buildWrapTurn(
    ctx: HookContext,
    inner: () => Promise<void>,
  ): () => Promise<void> {
    const matched = this.hooks.filter(
      (h) => typeof h.wrapTurn === "function",
    );
    return matched.reduceRight<() => Promise<void>>(
      (next, h) => () => h.wrapTurn!(ctx, next),
      inner,
    );
  }

  buildWrapToolExec(
    call: ToolCall,
    ctx: HookContext,
    inner: () => Promise<ToolExecResult>,
  ): () => Promise<ToolExecResult> {
    const matched = this.hooks.filter(
      (h) => typeof h.wrapToolExec === "function",
    );
    return matched.reduceRight<() => Promise<ToolExecResult>>(
      (next, h) => () => h.wrapToolExec!(call, ctx, next),
      inner,
    );
  }

  /* ────────────── invoke with timeout + fail-open ────────────── */

  /**
   * 调一个 hook 方法，返回 { value, error }。
   * error 为 null 表示成功；否则 caller 决定 fail-open / fail-closed。
   */
  private async _invokeSafe(
    h: Hook,
    method: string,
    args: unknown[],
    category: Category,
  ): Promise<{ value: HookResult | string | Message[] | void | undefined; error: Error | null }> {
    const fn = (h as unknown as Record<string, unknown>)[method];
    if (typeof fn !== "function") return { value: undefined, error: null };

    const timeoutMs = h.timeout ?? DEFAULT_TIMEOUTS[category];
    let timer: ReturnType<typeof setTimeout> | null = null;

    try {
      const value = await Promise.race<HookResult | string | Message[] | void | undefined>([
        Promise.resolve((fn as (...a: unknown[]) => unknown).apply(h, args)) as Promise<
          HookResult | string | Message[] | void | undefined
        >,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new HookTimeoutError(h.name, method, timeoutMs));
          }, timeoutMs);
          if (typeof (timer as { unref?: () => void }).unref === "function") {
            (timer as { unref: () => void }).unref();
          }
        }),
      ]);
      return { value, error: null };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const info: HookFailureInfo = {
        hookName: h.name,
        method,
        errorMessage: error.message,
        internal: h.internal === true,
      };
      if (error instanceof HookTimeoutError) info.timeoutMs = timeoutMs;
      if (h.failClosed && category === "decision") info.failedClosed = true;
      this.failureSink(info);
      return { value: undefined, error };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export class HookTimeoutError extends Error {
  constructor(
    public hookName: string,
    public method: string,
    public timeoutMs: number,
  ) {
    super(
      `Hook "${hookName}" method "${method}" timed out after ${timeoutMs}ms`,
    );
    this.name = "HookTimeoutError";
  }
}

/* ────────────── merge multi-hook results (Event 路径用) ────────────── */

export function mergeResults(
  results: ReadonlyArray<HookResult | string | Message[] | void | undefined>,
): MergedHookResult {
  const out: MergedHookResult = {
    additionalContexts: [],
    systemMessages: [],
  };

  for (const r of results) {
    if (!r || typeof r === "string" || Array.isArray(r)) continue;
    const hr = r as HookResult;

    if (hr.continue === false) {
      out.continue = false;
      if (!out.stopReason && hr.stopReason) out.stopReason = hr.stopReason;
    } else if (hr.continue === true && out.continue === undefined) {
      out.continue = true;
    }

    if (hr.decision && out.decision === undefined) {
      out.decision = hr.decision;
      if (hr.reason) out.reason = hr.reason;
    }

    if (hr.updatedInput) out.updatedInput = hr.updatedInput;
    if (hr.updatedToolOutput) out.updatedToolOutput = hr.updatedToolOutput;
    if (hr.additionalContext) out.additionalContexts.push(hr.additionalContext);
    if (hr.systemMessage) out.systemMessages.push(hr.systemMessage);
    if (hr.initialUserMessage && !out.initialUserMessage) {
      out.initialUserMessage = hr.initialUserMessage;
    }
  }

  return out;
}

export function defaultTimeoutFor(method: string): number {
  if ((EVENT_METHODS as Set<string>).has(method)) return DEFAULT_TIMEOUTS.event;
  if ((DECISION_METHODS as Set<string>).has(method)) return DEFAULT_TIMEOUTS.decision;
  if ((PIPE_METHODS as Set<string>).has(method)) return DEFAULT_TIMEOUTS.pipe;
  throw new Error(`defaultTimeoutFor: unknown method "${method}" — not in EVENT/DECISION/PIPE sets`);
}

export { EVENT_METHODS, DECISION_METHODS, PIPE_METHODS };
