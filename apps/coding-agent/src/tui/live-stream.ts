/**
 * Fine 轨累积器（P1）—— 把内核的 LiveEvent（`session.on` 的 token/thinking/toolcall delta）归一成
 * 一串 `StreamOp`，供 app 往"当前流式助手组件"上累积（打字机效果）。纯逻辑、可单测。
 *
 * 关键不变量（设计 risk #1）：**LiveEvent 可丢、不进 transcript，最终文本以 `message_end` 的 message 为权威**。
 * 所以 `end` op 在 message 存在时用它的内容覆盖累积值（修正丢帧）；只有 sync-throw（message 缺省）才退回累积。
 *
 * 排版假设：app 把 thinking 渲在答案上方，靠的是"谁先流先 append"——即**假设 provider 先发 thinking_delta
 * 再发 text_delta**（Qwen/DashScope reasoning 确实如此）。若将来接入乱序流的 provider，thinking 可能跑到
 * 答案下方（非崩溃、纯排版），届时需在 app 层按 message 预知顺序处理。
 */

import type { LiveEvent, ToolCall } from "@harness-pi/core";
import { assistantText, assistantThinking, assistantToolCalls } from "./event-bridge.js";

export type StreamOp =
  | { kind: "begin" } // 一条新助手消息开始（建流式组件）
  | { kind: "text"; text: string } // 到目前为止的全量文本
  | { kind: "thinking"; text: string } // 到目前为止的全量 thinking
  | { kind: "end"; text: string; thinking: string; toolCalls: ToolCall[] }; // 定稿（权威）

export class LiveStreamAccumulator {
  private text = "";
  private thinking = "";

  onEvent(event: LiveEvent): StreamOp[] {
    switch (event.type) {
      case "message_start":
        this.text = "";
        this.thinking = "";
        return [{ kind: "begin" }];
      case "text_delta":
        this.text += event.delta;
        return [{ kind: "text", text: this.text }];
      case "thinking_delta":
        this.thinking += event.delta;
        return [{ kind: "thinking", text: this.thinking }];
      case "toolcall_delta":
        return []; // P1 不渲染 live toolcall 增量；最终 toolCalls 在 message_end 权威取
      case "message_update":
        return []; // 快照轨：本累积器靠 delta 打字机 + message_end 定稿，不消费 message_update 快照
      case "message_end": {
        const text = event.message ? assistantText(event.message) : this.text;
        const thinking = event.message ? assistantThinking(event.message) : this.thinking;
        const toolCalls = event.message ? assistantToolCalls(event.message) : [];
        return [{ kind: "end", text, thinking, toolCalls }];
      }
      default: {
        const _exhaustive: never = event;
        void _exhaustive;
        return [];
      }
    }
  }
}
