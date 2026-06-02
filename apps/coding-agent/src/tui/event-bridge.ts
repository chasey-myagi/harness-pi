/**
 * Event bridge —— 把内核的 **coarse 轨**（`AgentSession.runStreaming()` 产出的 `SessionEvent`）归一成
 * 一串 domain-free 的 `TuiAction`，供 TUI 层照单渲染。
 *
 * 这是 TUI 的**纯逻辑核心**：事件 → 动作的映射全在这里、可单测，把 pi-tui（需真实终端、难自动化测）
 * 留给极薄的 app 层。P0 只接 coarse 轨（整条 assistant 消息在 `llm-end` 定稿、无 token 流）；P1 再叠加
 * fine 轨（`session.on` 的 LiveEvent）做逐 token 打字机。
 */

import type {
  AssistantMessage,
  RunSummary,
  SessionEvent,
  ToolCall,
  ToolExecResult,
} from "@harness-pi/core";

export type TuiAction =
  | { kind: "status"; text: string } // 瞬时状态行（"思考中…/turn N…"）
  | { kind: "assistant"; text: string; thinking: string } // 定稿的助手文本（P0：来自 llm-end.msg）
  | { kind: "toolCalls"; calls: ToolCall[] } // 助手本回合请求的工具调用
  | { kind: "toolResult"; name: string; ok: boolean; output: string; durationMs: number }
  | { kind: "error"; phase: string; message: string }
  | { kind: "done"; summary: RunSummary };

/** 拼接 assistant 消息里的纯文本块。 */
export function assistantText(msg: AssistantMessage): string {
  return msg.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** 拼接 assistant 消息里的 thinking 块（换行连接）。 */
export function assistantThinking(msg: AssistantMessage): string {
  return msg.content
    .filter((b): b is { type: "thinking"; thinking: string } => b.type === "thinking")
    .map((b) => b.thinking)
    .join("\n");
}

/** 取出 assistant 消息里的 toolCall 块。 */
export function assistantToolCalls(msg: AssistantMessage): ToolCall[] {
  return msg.content.filter((b): b is ToolCall => b.type === "toolCall");
}

/** 把一条工具结果渲染成可显示文本（image 块标注占位）。 */
export function toolResultText(result: ToolExecResult): string {
  return result.content
    .map((b) => (b.type === "text" ? b.text : `[image ${b.mimeType}]`))
    .join("\n");
}

export interface CoarseOptions {
  /**
   * fine 轨（LiveEvent）激活时置 true：`llm-end` 的 assistant/toolCalls 已由 fine 轨的
   * message_start→message_end 渲染，这里不再重复产出（否则同一条助手消息出现两次）。
   * 其余事件（turn-start/tool-end/session-end/error）不受影响。
   */
  suppressAssistant?: boolean;
}

/**
 * 把一条 coarse `SessionEvent` 映射成 0..N 个 `TuiAction`。纯函数、无副作用、穷尽处理所有事件类型。
 * 注：用户自己的 prompt 不在此产出——app 在 submit 时直接插一条 user 消息（session-start 不回放它）。
 */
export function coarseEventToActions(event: SessionEvent, opts: CoarseOptions = {}): TuiAction[] {
  switch (event.type) {
    case "turn-start":
      return [{ kind: "status", text: `turn ${event.turnIdx}…` }];
    case "llm-end": {
      if (opts.suppressAssistant) return []; // fine 轨已渲染 assistant + toolCalls
      const actions: TuiAction[] = [];
      const text = assistantText(event.msg);
      const thinking = assistantThinking(event.msg);
      if (text.length > 0 || thinking.length > 0) {
        actions.push({ kind: "assistant", text, thinking });
      }
      const calls = assistantToolCalls(event.msg);
      if (calls.length > 0) actions.push({ kind: "toolCalls", calls });
      return actions;
    }
    case "tool-end":
      return [
        {
          kind: "toolResult",
          name: event.call.name,
          ok: !event.result.isError,
          output: toolResultText(event.result),
          durationMs: event.durationMs,
        },
      ];
    case "error":
      return [{ kind: "error", phase: event.phase, message: event.message }];
    case "session-end":
      return [{ kind: "done", summary: event.summary }];
    case "session-start":
    case "turn-end":
    case "continuation-check":
      return [];
    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      return [];
    }
  }
}
