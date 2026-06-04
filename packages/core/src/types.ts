/**
 * 共用类型。
 *
 * 大部分类型直接从 pi-ai re-export（Tool / Message / Model / Context / ToolCall 等），
 * 我们只补 pi-ai 没有的几个：HarnessTool（在 pi-ai Tool 基础上加 execute）。
 */

import type { Tool, Message } from "@earendil-works/pi-ai";
import type { HookContext, ToolExecResult } from "./hook.js";

/**
 * harness-pi 自己的 tool 形态：pi-ai 的 Tool（name / description / parameters）
 * 加上一个 execute 函数。
 *
 * - args：已被 pi-ai 的 validateToolCall 按 TypeBox schema 验过
 * - ctx：当前 session 的 HookContext（plugin 可以挂 hook 看 ctx.state 等）
 * - signal：尊重它，超时/abort 时立刻停
 *
 * throw 任何 Error 会被 kernel 捕获，以 isError=true 的 ToolExecResult 形式回灌给 LLM。
 * 不要返回 isError=true 当作正常路径 —— throw 才是合约。
 */
export interface HarnessTool extends Tool {
  /** UI 标签，可选。kernel 不消费，仅供 plugin（如 session-log）展示。 */
  label?: string;

  /**
   * 旧名字列表，向后兼容。LLM 学过的老 toolCall.name 可以匹配到这里。
   * 借鉴 Claude Code Tool.ts:371 的 `aliases`。
   *
   * 用例：bidding-agent 的 `submit_evidence_v1 → submit_evidence`，加 aliases 老调用不会因为 name 不匹配被 kernel 拒。
   */
  aliases?: string[];

  /**
   * 标记本工具的某次调用是否可以跟同 turn 其他 concurrency-safe 工具**并行执行**。
   * 默认 `false`（保守）。借鉴 Claude Code Tool.ts:402 的 `isConcurrencySafe`。
   *
   * 触发场景：一次 assistant message 含多个 toolCall（LLM 一口气调用多个工具）。
   * kernel 把 safe 批 `Promise.all` 并行，unsafe 批顺序。
   *
   * 安全条件（粗略）：
   *   - 工具是只读 / 幂等 / 无 cross-call 副作用
   *   - 不依赖其他同批 tool 的输出
   *
   * 不安全示例：写同一个文件 / 修改 ctx.state 同一个 key / bash 命令
   * 安全示例：Read / Grep / kb_search / submit_evidence（按不同 questionId）/ WebSearch
   */
  isConcurrencySafe?(input: Record<string, unknown>): boolean;

  /**
   * Tool 的真正执行入口。kernel 在 PreToolUse decision 通过 + validateToolCall
   * 通过后调用。
   *
   * - args：已被 pi-ai validateToolCall 按 TypeBox schema 验过
   * - ctx：当前 session 的 HookContext（tool 也能读 ctx.state / appendMessage）
   * - signal：尊重它，超时 / abort 时立刻停
   *
   * **throw** 任何 Error 会被 kernel 捕获，以 isError=true 的 ToolExecResult
   * 形式回灌给 LLM。不要返回 `{ isError: true }` 当作正常路径——throw 才是合约。
   */
  execute(
    args: Record<string, unknown>,
    ctx: HookContext,
    signal: AbortSignal,
  ): Promise<ToolExecResult>;
}

/**
 * Re-export ToolExecResult 给消费者，避免他们要从 hook.js 拉。
 * 实际定义在 hook.ts 里，因为 hook 的 `transformToolResult` 等也用同一个 shape。
 *
 * 注意：ToolExecResult 现在多了一个 `newMessages` 字段，详见 hook.ts。
 */
export type { ToolExecResult } from "./hook.js";

/**
 * Helper：创建一条 user message。Kernel 内部也用这个。
 * 暴露给 plugin / controller / 业务代码，避免每个地方手写 `{ role: "user", content: ... }`。
 */
export function createUserMessage(
  content: string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>,
): Message {
  return {
    role: "user",
    content,
    timestamp: Date.now(),
  } as Message;
}

/**
 * Helper：创建一条 attachment message —— 用于 hook 注入的 transient context。
 *
 * **不进 session.messages**；kernel 在 LLM call 前临时拼到 messages view 末尾，
 * 这样 transcript 渲染 / 序列化 / 调试都能区分"hook 加的"vs"用户发的"。
 *
 * 借鉴 Claude Code `createAttachmentMessage({ type: 'hook_additional_context', hookName, hookEvent })`。
 *
 * 物理形态：user role + text content。`_meta` 是 harness-pi 自定义字段，kernel 在
 * 发给 pi-ai 前会剥掉（参见 session.ts stripHarnessOnlyFields）。
 */
export function createAttachmentMessage(opts: {
  type: "hook_additional_context" | "tool_result_overflow" | (string & {});
  content: string;
  hookName?: string;
  hookEvent?: string;
}): Message & { _meta?: Record<string, unknown> } {
  return {
    role: "user",
    content: opts.content,
    timestamp: Date.now(),
    _meta: {
      kind: "attachment",
      type: opts.type,
      ...(opts.hookName ? { hookName: opts.hookName } : {}),
      ...(opts.hookEvent ? { hookEvent: opts.hookEvent } : {}),
    },
  } as Message & { _meta?: Record<string, unknown> };
}
