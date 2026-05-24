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
  LlmEndInput,
  PreToolUseInput,
  PostToolUseInput,
  UserPromptSubmitInput,
  ErrorInput,
} from "./hook.js";

// ─────────── Dispatcher (advanced; plugin authors usually don't need) ───────────
export {
  HookDispatcher,
  HookTimeoutError,
  defaultTimeoutFor,
  mergeResults,
} from "./dispatcher.js";
export type { HookFailureSink, HookFailureInfo } from "./dispatcher.js";

// ─────────── Tool 形态 + message helpers ───────────
export type { HarnessTool } from "./types.js";
export { createUserMessage, createAttachmentMessage } from "./types.js";

// ─────────── Kernel ───────────
export { AgentSession, findToolByName } from "./session.js";
export type { AgentSessionOptions, RunSummary } from "./session.js";

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
} from "@mariozechner/pi-ai";
export { Type } from "@mariozechner/pi-ai";
export type { Static, TSchema } from "@mariozechner/pi-ai";
