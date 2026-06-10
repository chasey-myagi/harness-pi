// ─────────── Hook protocol ───────────
export type {
  Hook,
  HookContext,
  HookResult,
  MergedHookResult,
  ToolDecision,
  ToolExecResult,
  SessionStartInput,
  SessionEndInput,
  ContinuationCheckInput,
  TurnStartInput,
  TurnEndInput,
  SteerInput,
  LlmEndInput,
  ContextOverflowInput,
  OnAfterFlushInput,
  OnAfterFlushResult,
  OnSubagentStartInput,
  OnSubagentEndInput,
  PreToolUseInput,
  PostToolUseInput,
  UserPromptSubmitInput,
  ErrorInput,
  // ─── Phase 1: state typing / structured log / config view ───
  HookStateRegistry,
  TypedStateMap,
  HookLogger,
  LogLevel,
  SessionConfigView,
} from "./hook.js";

// ─────────── Dispatcher (advanced; plugin authors usually don't need) ───────────
export {
  HookDispatcher,
  HookTimeoutError,
  defaultTimeoutFor,
  mergeResults,
  verifyHookDependencies,
  assertCriticalDecisionHooks,
} from "./dispatcher.js";
export type {
  HookFailureSink,
  HookFailureInfo,
  DecisionOutcome,
  HookDependencyWarning,
} from "./dispatcher.js";

// ─────────── Context-overflow 默认分类器（可经 AgentSessionOptions.isContextOverflow 覆盖） ───────────
export { defaultIsContextOverflow } from "./context-overflow.js";

// ─────────── Tool 形态 + message helpers ───────────
export type { HarnessTool } from "./types.js";
export {
  createUserMessage,
  createAttachmentMessage,
  filterIncompleteToolCalls,
} from "./types.js";

// ─────────── Session persistence (协议在内核，落盘实现在 adapter) ───────────
export { MemorySessionStore } from "./session-store.js";
export type {
  SessionStore,
  SessionEntry,
  StoredEntry,
  ForkLineage,
} from "./session-store.js";

// ─────────── Kernel ───────────
export { AgentSession, findToolByName } from "./session.js";
export type {
  AgentSessionOptions,
  RunSummary,
  SessionEvent,
  LiveEvent,
} from "./session.js";

// ─────────── LLM seam（自定义 Model 构造 + typed llmOptions，收口 pi-ai 公共面） ───────────
export { makeOpenAICompatibleModel, resolveLlmOptions } from "./llm-model.js";
export type { OpenAICompatibleModelSpec, LlmOptions } from "./llm-model.js";

// ─────────── HookContextImpl 实例类型（plugin / controller 偶尔需要） ───────────
export type { HookContextImpl, HookContextDeps } from "./context.js";
// 注意：getKernelInternals / KERNEL_INTERNALS_BAG 故意不导出——它们是 kernel-internal API。
// Plugin 没有 KERNEL_INTERNALS_BAG 引用，也没有 getKernelInternals 函数，无法访问 mutator。

// ─────────── pi-ai re-exports（方便用户少写一个 import）───────────
export type {
  Message,
  AssistantMessage,
  UserMessage,
  ToolResultMessage,
  ToolCall,
  Tool,
  Model,
  Api,
  Usage,
  StopReason,
  Context,
  OpenAICompletionsCompat,
} from "@earendil-works/pi-ai";
export { Type } from "@earendil-works/pi-ai";
export type { Static, TSchema } from "@earendil-works/pi-ai";
