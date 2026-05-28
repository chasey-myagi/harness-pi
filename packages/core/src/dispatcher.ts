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

/* ────────────── Decision outcome ────────────── */

/**
 * `fireDecisionOutcome` 的返回类型。Caller 必须 switch `kind` 穷举三种情况——比
 * nullable `HookResult` + 字段判更类型安全。详见 `fireDecisionOutcome` 文档。
 */
export type DecisionOutcome =
  | { kind: "decided"; result: HookResult }
  | { kind: "context-only"; additionalContext?: string; systemMessage?: string }
  | { kind: "none" };

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
      matched.map((h) =>
        this._invokeSafe<HookResult | void>(h, method, [input, ctx], "event"),
      ),
    );
    return mergeResults(results.map((r) => r.value));
  }

  /** Special: onError 不返回值，just observe. */
  async fireError(input: ErrorInput, ctx: HookContext): Promise<void> {
    const matched = this.hooks.filter((h) => typeof h.onError === "function");
    await Promise.all(
      matched.map((h) =>
        this._invokeSafe<void>(h, "onError", [input, ctx], "event"),
      ),
    );
  }

  /* ────────────── Decision: 顺序 short-circuit ────────────── */

  /**
   * Decision 路径：顺序问每个 hook，**只在 decision / updatedInput / continue=false 上短路**。
   * - additionalContext / systemMessage 累积，不算决断（关键修复：避免 context-injection hook 误屏蔽下游安全检查）。
   * - failClosed=true 的 hook 失败时返回 deny。
   *
   * **类型表面**：返回 `HookResult | null`——caller 必须用 optional chain 判 decision/continue 字段。
   * 新 caller 推荐用 `fireDecisionOutcome` 拿 discriminated union（必须 switch kind 穷举）。
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
      const inv = await this._invokeSafe<HookResult | void>(
        h,
        method,
        [input, ctx],
        "decision",
      );

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
      if (!r) continue;

      // 聚合 transient context（永不短路）
      if (r.additionalContext) additionalContexts.push(r.additionalContext);
      if (r.systemMessage) systemMessages.push(r.systemMessage);

      // 真正的决断：decision / updatedInput / continue=false
      if (
        r.decision !== undefined ||
        r.updatedInput !== undefined ||
        r.continue === false
      ) {
        const out: HookResult = { ...r };
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

  /**
   * Phase 2 加：discriminated-union 形态的 decision 出口。caller 必须 switch `kind` 穷举
   * 三种情况，编译器帮你拦下"忘判 context-only"那种 bug。
   *
   *   - kind === "decided"     真的有 hook 给出 decision / updatedInput / continue=false
   *   - kind === "context-only" 没人 decide，但有人累积了 additionalContext / systemMessage
   *   - kind === "none"         没人 decide，也没人发表意见
   */
  async fireDecisionOutcome<M extends keyof DecisionInputMap>(
    method: M,
    input: DecisionInputMap[M],
    ctx: HookContext,
  ): Promise<DecisionOutcome> {
    const r = await this.fireDecision(method, input, ctx);
    if (!r) return { kind: "none" };

    const hasDecision =
      r.decision !== undefined ||
      r.updatedInput !== undefined ||
      r.continue === false;
    if (hasDecision) {
      return { kind: "decided", result: r };
    }
    return {
      kind: "context-only",
      ...(r.additionalContext !== undefined
        ? { additionalContext: r.additionalContext }
        : {}),
      ...(r.systemMessage !== undefined
        ? { systemMessage: r.systemMessage }
        : {}),
    };
  }

  /* ────────────── Pipe: 顺序 transform ────────────── */

  async firePipeSystemPrompt(
    value: string,
    ctx: HookContext,
  ): Promise<string> {
    let v = value;
    for (const h of this.hooks) {
      if (typeof h.transformSystemPromptBeforeLlm !== "function") continue;
      const inv = await this._invokeSafe<string | void>(
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
      const inv = await this._invokeSafe<Message[] | void>(
        h,
        "transformMessagesBeforeLlm",
        [v, ctx],
        "pipe",
      );
      if (Array.isArray(inv.value)) v = inv.value;
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
   * 调一个 hook 方法，返回 { value, error }。caller 在调用点明确 R，避免 union 在下游
   * 二次 typeof 鉴别。
   *
   * - R = HookResult | void：event / decision 路径
   * - R = string：transformSystemPromptBeforeLlm
   * - R = Message[]：transformMessagesBeforeLlm
   * - around hook 走 buildWrapTurn / buildWrapToolExec，不经此路径
   *
   * error 为 null 表示成功；否则 caller 决定 fail-open / fail-closed。
   */
  private async _invokeSafe<R>(
    h: Hook,
    method: string,
    args: unknown[],
    category: Category,
  ): Promise<{ value: R | undefined; error: Error | null }> {
    const fn = (h as unknown as Record<string, unknown>)[method];
    if (typeof fn !== "function") return { value: undefined, error: null };

    const timeoutMs = h.timeout ?? DEFAULT_TIMEOUTS[category];
    let timer: ReturnType<typeof setTimeout> | null = null;

    try {
      const value = await Promise.race<R | undefined>([
        Promise.resolve((fn as (...a: unknown[]) => unknown).apply(h, args)) as Promise<
          R | undefined
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

/* ────────────── Plugin dependency verification ────────────── */

export interface HookDependencyWarning {
  kind: "missing-required" | "required-after-self" | "conflict" | "duplicate-name";
  hook: string;
  /** missing-required / required-after-self: 被依赖的名字；conflict: 冲突的名字；duplicate-name: 重名 */
  related: string;
  message: string;
}

/**
 * 校验 hook list 的 requires / conflictsWith 软依赖。返回 warnings 数组（空数组 = 无问题）。
 * 由 caller 决定如何展示（session 构造期通过 consoleSink emit；plugin author 可在 test 里 assert）。
 *
 * 规则：
 *   - duplicate-name：重名（多次注册同名 hook）警告，但不阻塞。
 *   - missing-required：A.requires=["B"]，但 B 根本没在 list 里。
 *   - required-after-self：A.requires=["B"]，B 在 A 之后才注册（顺序错）。
 *   - conflict：A.conflictsWith=["B"] 且 B 在 list 里。
 */
export function verifyHookDependencies(
  hooks: ReadonlyArray<Hook>,
): HookDependencyWarning[] {
  const warnings: HookDependencyWarning[] = [];
  const nameToIdxs = new Map<string, number[]>();

  for (let i = 0; i < hooks.length; i++) {
    const h = hooks[i];
    if (!h) continue;
    const arr = nameToIdxs.get(h.name) ?? [];
    arr.push(i);
    nameToIdxs.set(h.name, arr);
  }

  for (const [name, idxs] of nameToIdxs) {
    if (idxs.length > 1) {
      warnings.push({
        kind: "duplicate-name",
        hook: name,
        related: name,
        message: `hook "${name}" is registered ${idxs.length} times — names should be unique for log attribution`,
      });
    }
  }

  for (let i = 0; i < hooks.length; i++) {
    const h = hooks[i];
    if (!h) continue;
    if (h.requires) {
      for (const reqName of h.requires) {
        const reqIdxs = nameToIdxs.get(reqName);
        if (!reqIdxs || reqIdxs.length === 0) {
          warnings.push({
            kind: "missing-required",
            hook: h.name,
            related: reqName,
            message: `hook "${h.name}" requires "${reqName}", but it is not registered`,
          });
        } else if (reqIdxs[0]! > i) {
          warnings.push({
            kind: "required-after-self",
            hook: h.name,
            related: reqName,
            message: `hook "${h.name}" requires "${reqName}", but "${reqName}" is registered after it (idx ${reqIdxs[0]} > ${i}). Reorder so "${reqName}" comes first.`,
          });
        }
      }
    }
    if (h.conflictsWith) {
      for (const conflictName of h.conflictsWith) {
        if (nameToIdxs.has(conflictName)) {
          warnings.push({
            kind: "conflict",
            hook: h.name,
            related: conflictName,
            message: `hook "${h.name}" conflicts with "${conflictName}"; they should not be used together`,
          });
        }
      }
    }
  }

  return warnings;
}
