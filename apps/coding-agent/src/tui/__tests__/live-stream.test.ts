import { describe, it, expect } from "vitest";
import type { AssistantMessage, LiveEvent } from "@harness-pi/core";
import { LiveStreamAccumulator, type StreamOp } from "../live-stream.js";

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function msg(content: AssistantMessage["content"]): AssistantMessage {
  return { role: "assistant", content, api: "", provider: "", model: "m", usage: ZERO, stopReason: "stop", timestamp: 0 };
}
function feed(acc: LiveStreamAccumulator, events: LiveEvent[]): StreamOp[] {
  return events.flatMap((e) => acc.onEvent(e));
}

describe("LiveStreamAccumulator", () => {
  it("message_start emits a begin op and resets buffers", () => {
    const acc = new LiveStreamAccumulator();
    expect(acc.onEvent({ type: "message_start" })).toEqual([{ kind: "begin" }]);
  });

  it("text_delta accumulates and emits the full text so far", () => {
    const acc = new LiveStreamAccumulator();
    acc.onEvent({ type: "message_start" });
    expect(acc.onEvent({ type: "text_delta", contentIndex: 0, delta: "He" })).toEqual([{ kind: "text", text: "He" }]);
    expect(acc.onEvent({ type: "text_delta", contentIndex: 0, delta: "llo" })).toEqual([{ kind: "text", text: "Hello" }]);
  });

  it("thinking_delta accumulates separately", () => {
    const acc = new LiveStreamAccumulator();
    acc.onEvent({ type: "message_start" });
    acc.onEvent({ type: "thinking_delta", contentIndex: 0, delta: "step1 " });
    expect(acc.onEvent({ type: "thinking_delta", contentIndex: 0, delta: "step2" })).toEqual([
      { kind: "thinking", text: "step1 step2" },
    ]);
  });

  it("toolcall_delta is ignored live (final tool calls come from message_end)", () => {
    const acc = new LiveStreamAccumulator();
    acc.onEvent({ type: "message_start" });
    expect(acc.onEvent({ type: "toolcall_delta", contentIndex: 0, delta: '{"path"' })).toEqual([]);
  });

  it("message_end uses the authoritative message text, correcting dropped deltas", () => {
    const acc = new LiveStreamAccumulator();
    const ops = feed(acc, [
      { type: "message_start" },
      { type: "text_delta", contentIndex: 0, delta: "Hel" }, // 丢了 "lo" 帧
      { type: "message_end", message: msg([{ type: "text", text: "Hello world" }]) },
    ]);
    expect(ops).toEqual([
      { kind: "begin" },
      { kind: "text", text: "Hel" },
      { kind: "end", text: "Hello world", thinking: "", toolCalls: [] }, // 权威文本，非累积的 "Hel"
    ]);
  });

  it("message_end carries thinking + toolCalls from the authoritative message", () => {
    const acc = new LiveStreamAccumulator();
    acc.onEvent({ type: "message_start" });
    const end = acc.onEvent({
      type: "message_end",
      message: msg([
        { type: "thinking", thinking: "because" },
        { type: "text", text: "answer" },
        { type: "toolCall", id: "1", name: "read", arguments: { path: "a" } },
      ]),
    });
    expect(end).toEqual([
      {
        kind: "end",
        text: "answer",
        thinking: "because",
        toolCalls: [{ type: "toolCall", id: "1", name: "read", arguments: { path: "a" } }],
      },
    ]);
  });

  it("message_end WITHOUT message falls back to accumulated buffers (sync-throw path)", () => {
    const acc = new LiveStreamAccumulator();
    const ops = feed(acc, [
      { type: "message_start" },
      { type: "text_delta", contentIndex: 0, delta: "partial" },
      { type: "thinking_delta", contentIndex: 0, delta: "t" },
      { type: "message_end" },
    ]);
    expect(ops.at(-1)).toEqual({ kind: "end", text: "partial", thinking: "t", toolCalls: [] });
  });

  it("a second message_start resets buffers (no bleed from the prior message)", () => {
    const acc = new LiveStreamAccumulator();
    feed(acc, [
      { type: "message_start" },
      { type: "text_delta", contentIndex: 0, delta: "first" },
      { type: "message_end", message: msg([{ type: "text", text: "first" }]) },
    ]);
    const second = feed(acc, [
      { type: "message_start" },
      { type: "text_delta", contentIndex: 0, delta: "B" },
    ]);
    expect(second).toEqual([{ kind: "begin" }, { kind: "text", text: "B" }]); // 不是 "firstB"
  });
});
