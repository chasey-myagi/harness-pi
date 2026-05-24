/**
 * Hook protocol —— harness-pi 的核心扩展面。
 *
 * 四种形态（按 method 前缀 / 返回 envelope 区分）：
 *   - Event       (on*)        并行；返回 HookResult 中只 additionalContext/systemMessage 等"输出型"字段生效
 *   - Decision    (onPreToolUse/onUserPromptSubmit) 顺序短路；首个 decision/updatedInput/continue=false 拿决策权
 *   - Transform   (transform*) 顺序 pipe；前者输出 = 后者输入
 *   - Around      (wrap*)      洋葱嵌套；早注册在外层
 *
 * 详细执行模型 / 合并规则 / 性能契约见 docs/03-hook-system.md。
 */

import type {
  AssistantMessage,
  Message,
  ToolCall,
} from "@mariozechner/pi-ai";
import type { HarnessTool } from "./types.js";

/* ──────────────────── Tool 执行结果 ──────────────────── */

/**
 * Tool 执行结果 —— 跟 pi-ai 的 toolResult message content 结构一致，外加 isError + （可选）
 * newMessages 字段。
 *
 * kernel 收到后会：
 *   1. 包成一条 toolResult message 追加进 session.messages
 *   2. 如果 newMessages 非空，**逐条追加进 session.messages**（在 toolResult 之后）
 */
export interface ToolExecResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;

  /**
   * 【高级用法】Tool 主动追加的额外 message。详见 docs/04-context-injection.md §6。
   * 大多数 plugin 应优先用 hook `additionalContext` 注入；只有"附加 message 是
   * tool 输出语义的一部分"才用 newMessages。
   *
   * 这些 message 是 persistent（进 session.messages、序列化时带）。
   */
  newMessages?: Message[];
}

/* ──────────────────── Hook event input 类型 ──────────────────── */

export interface SessionStartInput {
  /** 是 `run()` 还是 `continue()` 触发的 session start。 */
  source: "run" | "continue";
  /** 仅 source="run" 时存在，是 caller 给的 prompt。 */
  initialPrompt?: string;
}

export interface SessionEndInput {
  turns: number;
  reason: "done" | "max_turns" | "aborted" | "error" | "max_continuations";
  /** session 内同 run 触发的续跑次数（从 onContinuationCheck → continue=true 累计）。 */
  continuations: number;
}

/**
 * Continuation check —— `reason === "done"` 且还有续跑预算时，kernel 询问 hook 是否要续跑。
 * Hook 返回 `{ continue: true }` 让 session 在同一个 `run()` 内再跑一轮。
 *
 * **跟 `onSessionEnd` 严格区分**：
 *   - `onContinuationCheck` 可能 fire 0..maxContinuations 次（reason 永远是 "done"）
 *   - `onSessionEnd` 每次 run() 保证 fire **恰好一次**，在所有 turn loop + continuation 结束之后
 *
 * 这种分离让 session-log / cost-tracker 等 plugin 在 onSessionEnd 里安全做"终结"动作（关流、调
 * onSessionFinalized 回调）—— 不会被中间询问触发多次。
 */
export interface ContinuationCheckInput {
  turns: number;
  /** 本次询问之前已发生的续跑次数。 */
  continuations: number;
}

export interface TurnStartInput {
  turnIdx: number;
}

export interface TurnEndInput {
  turnIdx: number;
  assistantMessage: AssistantMessage;
  toolResults: ToolExecResult[];
}

export interface LlmEndInput {
  msg: AssistantMessage;
  durationMs: number;
}

export interface PreToolUseInput {
  call: ToolCall;
  tool: HarnessTool;
}

export interface PostToolUseInput {
  call: ToolCall;
  result: ToolExecResult;
  durationMs: number;
}

export interface UserPromptSubmitInput {
  userMessage: Message;
}

export interface ErrorInput {
  phase: "llm" | "tool" | "hook";
  err: Error;
  call?: ToolCall;
  hookName?: string;
}

/* ──────────────────── 统一返回 envelope ──────────────────── */

/**
 * 所有 hook 方法的统一返回 shape。每个方法只用其中一部分字段，无效字段被 dispatcher 忽略。
 * 借鉴 Claude Code `syncHookResponseSchema`。
 */
export interface HookResult {
  // ── Control flow ──
  /** false → 结束 session。默认 true。 */
  continue?: boolean;
  /** continue=false 时给 user / log 的解释。 */
  stopReason?: string;

  // ── Decision (PreToolUse / UserPromptSubmit) ──
  decision?: "allow" | "deny";
  reason?: string;
  /** 改 tool args（仅 PreToolUse）。 */
  updatedInput?: Record<string, unknown>;
  /** 改 tool result（仅 PostToolUse）。 */
  updatedToolOutput?: ToolExecResult;

  // ── Context injection ──
  /** Transient：包成 attachment 拼到下次 LLM call。多 hook 拼数组按注册顺序。 */
  additionalContext?: string;
  /** Persistent：仅 SessionStart 用，作为初始 user message 入 session.messages。 */
  initialUserMessage?: string;

  // ── UX ──
  /** 给 user console 看的，永不进 LLM context。 */
  systemMessage?: string;
}

/**
 * Dispatcher 把多 hook 的结果合并后的产物。详见 docs/03-hook-system.md §5 合并规则。
 */
export interface MergedHookResult {
  continue?: boolean;
  stopReason?: string;
  decision?: "allow" | "deny";
  reason?: string;
  updatedInput?: Record<string, unknown>;
  updatedToolOutput?: ToolExecResult;
  additionalContexts: string[];
  systemMessages: string[];
  initialUserMessage?: string;
}

/* ──────────────────── HookContext ──────────────────── */

/**
 * 整个 session 共享一个 HookContext 实例。turnIdx 等运行时字段由 kernel 在 turn 切换时更新。
 *
 * 详见 docs/02-kernel.md §7。
 */
export interface HookContext {
  readonly sessionId: string;
  /** 当前 turn 序号（0-based）。kernel 在 onTurnStart 之前更新。 */
  readonly turnIdx: number;
  /** session 级 abort signal。任何 hook / tool 应该尊重它。 */
  readonly signal: AbortSignal;
  /** Plugin 之间协作的共享 map。约定 key 带 plugin 前缀防撞名。 */
  readonly state: Map<string, unknown>;
  /** 当前 session.messages 的只读引用。 */
  readonly messages: ReadonlyArray<Message>;

  /** Persistent message 注入：push 到 session.messages，下次 LLM call 看见。 */
  appendMessage(msg: Message): void;

  /** 主动结束 session。当前 turn 走完后退出。 */
  abort(reason: string): void;

  /** 内部 emit（用于 kernel ↔ plugin 互通；极少用）。 */
  emit(event: { type: string; [k: string]: unknown }): void;
}

/* ──────────────────── Hook 接口 ──────────────────── */

/**
 * Hook = 一个对象，按 method 名声明它要 hook 的事件 / 阶段。
 * 所有方法可选；plugin 只实现自己关心的。
 *
 * @example
 *   export function watchdog(opts: { turnTimeoutMs: number }): Hook {
 *     return {
 *       name: "watchdog",
 *       async wrapTurn(ctx, next) {
 *         const timer = setTimeout(() => ctx.abort("watchdog timeout"), opts.turnTimeoutMs);
 *         try { await next(); } finally { clearTimeout(timer); }
 *       },
 *     };
 *   }
 */
export interface Hook {
  /** 调试 / metrics / log 归因用。必须唯一（重名不报错但混淆 log）。 */
  name: string;

  /** Per-hook timeout (ms)。默认按 method 类型走：event 100 / decision 200 / pipe 500。 */
  timeout?: number;

  /** Internal hook 不上报 hook 自身的 metric。 */
  internal?: boolean;

  /**
   * 仅对 **decision** hook（onPreToolUse / onUserPromptSubmit）有效。
   *
   * - `false`（默认）：hook throw / timeout → fail-open（视为没发表意见，继续问下一个 hook）。
   *   适合"软策略"：通知 / 注 context / 软建议。
   * - `true`：hook throw / timeout → fail-closed（视为 deny，工具被拒绝执行）。
   *   适合"硬策略"：权限检查 / lease / 鉴权——宁可错杀，不可放过。
   *
   * 对 event / pipe / around hook 不生效（这些形态 fail-open 是合理默认）。
   */
  failClosed?: boolean;

  // ─────────── Event (parallel) ───────────
  onSessionStart?(
    input: SessionStartInput,
    ctx: HookContext,
  ): HookResult | void | Promise<HookResult | void>;
  onSessionEnd?(
    input: SessionEndInput,
    ctx: HookContext,
  ): HookResult | void | Promise<HookResult | void>;
  onTurnStart?(
    input: TurnStartInput,
    ctx: HookContext,
  ): HookResult | void | Promise<HookResult | void>;
  onTurnEnd?(
    input: TurnEndInput,
    ctx: HookContext,
  ): HookResult | void | Promise<HookResult | void>;
  onLlmEnd?(
    input: LlmEndInput,
    ctx: HookContext,
  ): HookResult | void | Promise<HookResult | void>;
  onPostToolUse?(
    input: PostToolUseInput,
    ctx: HookContext,
  ): HookResult | void | Promise<HookResult | void>;
  /**
   * 询问续跑的事件——只在 reason === "done" 且 continuations < maxContinuations 时 fire。
   * 返回 `{ continue: true, additionalContext: "..." }` 触发同 session 续跑。
   * 不要在这里关流、调 finalize ——那是 onSessionEnd 的事。
   */
  onContinuationCheck?(
    input: ContinuationCheckInput,
    ctx: HookContext,
  ): HookResult | void | Promise<HookResult | void>;
  onError?(input: ErrorInput, ctx: HookContext): void | Promise<void>;

  // ─────────── Decision (sequential short-circuit) ───────────
  onPreToolUse?(
    input: PreToolUseInput,
    ctx: HookContext,
  ): HookResult | void | Promise<HookResult | void>;
  onUserPromptSubmit?(
    input: UserPromptSubmitInput,
    ctx: HookContext,
  ): HookResult | void | Promise<HookResult | void>;

  // ─────────── Transform (sequential pipe) ───────────
  transformSystemPromptBeforeLlm?(
    systemPrompt: string,
    ctx: HookContext,
  ): string | void | Promise<string | void>;
  transformMessagesBeforeLlm?(
    messages: Message[],
    ctx: HookContext,
  ): Message[] | void | Promise<Message[] | void>;

  // ─────────── Around (nested) ───────────
  wrapTurn?(ctx: HookContext, next: () => Promise<void>): Promise<void>;
  wrapToolExec?(
    call: ToolCall,
    ctx: HookContext,
    next: () => Promise<ToolExecResult>,
  ): Promise<ToolExecResult>;
}

/* ──────────────────── ToolDecision (legacy 兼容名) ──────────────────── */

/**
 * 历史名字，等同于 HookResult 中 decision/updatedInput 字段的子集。
 * 新代码请直接返回 HookResult。
 */
export interface ToolDecision {
  deny?: string;
  modifyArgs?: Record<string, unknown>;
}
