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

/**
 * 剔除「悬挂的 tool 调用」，让一段 messages snapshot 重新喂给 pi-ai 时合法。
 *
 * 背景：snapshot 可能停在 tool batch 中途——assistant 已发出 `toolCall`，但对应的
 * `toolResult` 还没 append。把这种带「无 result 的 toolCall」的消息直接喂 provider 会
 * 报错（orphan tool_use 400）。fork / sub-agent 这类「拿父 snapshot 当 initialMessages」
 * 的路径必须先过一遍本函数。借鉴 Claude Code `filterIncompleteToolCalls`
 * （[08-claude-code-lessons](docs/08-claude-code-lessons.md)），并补齐对称的 orphan-result 清理。
 *
 * 三遍、纯函数（不改入参）：
 *   1. 收集所有 `toolResult` 的 `toolCallId`。
 *   2. 丢掉「含任一未被 result 的 `toolCall`」的整条 assistant（连同其 text/thinking——
 *      与 pi-ai 消息原子性一致：assistant 的 content 块不可拆开发）。
 *   3. 丢掉 orphan `toolResult`（其 `toolCallId` 对应的 assistant 已在第 2 步被丢）。
 *
 * snapshot 无悬挂时返回**内容等价**的新数组（始终是 copy，不返回原引用）。
 */
export function filterIncompleteToolCalls(messages: Message[]): Message[] {
  // Pass 1：已有 result 的 toolCallId。
  const resolved = new Set<string>();
  for (const m of messages) {
    if (m.role === "toolResult") resolved.add(m.toolCallId);
  }

  // Pass 2：保留 non-assistant + 所有 toolCall 都有 result 的 assistant；
  // 记录存活的 toolCall id 供 Pass 3 清理 orphan result。
  const survivingToolCallIds = new Set<string>();
  const afterAssistantFilter = messages.filter((m) => {
    if (m.role !== "assistant") return true;
    let hasIncomplete = false;
    for (const block of m.content) {
      if (block.type === "toolCall" && !resolved.has(block.id)) {
        hasIncomplete = true;
        break;
      }
    }
    if (hasIncomplete) return false;
    for (const block of m.content) {
      if (block.type === "toolCall") survivingToolCallIds.add(block.id);
    }
    return true;
  });

  // Pass 3：丢掉 toolCall 已被丢弃的 orphan toolResult。
  return afterAssistantFilter.filter(
    (m) => m.role !== "toolResult" || survivingToolCallIds.has(m.toolCallId),
  );
}
