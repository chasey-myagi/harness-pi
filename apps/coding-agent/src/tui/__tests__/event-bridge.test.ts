import { describe, it, expect } from "vitest";
import type {
  AssistantMessage,
  RunSummary,
  SessionEvent,
  ToolCall,
  ToolExecResult,
} from "@harness-pi/core";
import {
  coarseEventToActions,
  assistantText,
  assistantThinking,
  assistantToolCalls,
  toolResultText,
  type TuiAction,
} from "../event-bridge.js";

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "",
    provider: "",
    model: "qwen-turbo",
    usage: ZERO_USAGE,
    stopReason: "stop",
    timestamp: 0,
  };
}

const summary: RunSummary = { turns: 1, continuations: 0, reason: "done", usage: ZERO_USAGE };

describe("event-bridge: content extraction helpers", () => {
  it("assistantText joins only text blocks", () => {
    const msg = assistant([
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "Hello " },
      { type: "toolCall", id: "1", name: "read", arguments: {} },
      { type: "text", text: "world" },
    ]);
    expect(assistantText(msg)).toBe("Hello world");
  });

  it("assistantThinking joins only thinking blocks", () => {
    const msg = assistant([
      { type: "thinking", thinking: "step 1" },
      { type: "text", text: "answer" },
      { type: "thinking", thinking: "step 2" },
    ]);
    expect(assistantThinking(msg)).toBe("step 1\nstep 2");
  });

  it("assistantToolCalls returns only toolCall blocks", () => {
    const calls: ToolCall[] = [{ type: "toolCall", id: "1", name: "bash", arguments: { cmd: "ls" } }];
    const msg = assistant([{ type: "text", text: "running" }, ...calls]);
    expect(assistantToolCalls(msg)).toEqual(calls);
  });

  it("toolResultText joins text content and marks images", () => {
    const ok: ToolExecResult = {
      content: [
        { type: "text", text: "line1" },
        { type: "image", data: "...", mimeType: "image/png" },
        { type: "text", text: "line2" },
      ],
    };
    expect(toolResultText(ok)).toBe("line1\n[image image/png]\nline2");
  });
});

describe("event-bridge: coarseEventToActions", () => {
  it("turn-start → a status action", () => {
    const actions = coarseEventToActions({ type: "turn-start", turnIdx: 2 });
    expect(actions).toEqual([{ kind: "status", text: expect.stringContaining("2") }]);
  });

  it("session-start emits no message (the app injects the user prompt itself)", () => {
    expect(coarseEventToActions({ type: "session-start", sessionId: "s", source: "run", initialPrompt: "hi" })).toEqual([]);
  });

  it("llm-end with text → an assistant action carrying the text", () => {
    const actions = coarseEventToActions({
      type: "llm-end",
      msg: assistant([{ type: "text", text: "the answer" }]),
      durationMs: 5,
    });
    expect(actions).toEqual([{ kind: "assistant", text: "the answer", thinking: "" }]);
  });

  it("llm-end with toolCalls → assistant action (if any text) + a toolCalls action", () => {
    const calls: ToolCall[] = [{ type: "toolCall", id: "1", name: "read", arguments: { path: "a.ts" } }];
    const actions = coarseEventToActions({
      type: "llm-end",
      msg: assistant([{ type: "text", text: "let me look" }, ...calls]),
      durationMs: 5,
    });
    expect(actions).toEqual([
      { kind: "assistant", text: "let me look", thinking: "" },
      { kind: "toolCalls", calls },
    ]);
  });

  it("llm-end with ONLY thinking (no text) → an assistant action: empty text + thinking", () => {
    const actions = coarseEventToActions({
      type: "llm-end",
      msg: assistant([{ type: "thinking", thinking: "reasoning…" }]),
      durationMs: 2,
    });
    expect(actions).toEqual([{ kind: "assistant", text: "", thinking: "reasoning…" }]);
  });

  it("llm-end with ONLY toolCalls (no text) → just the toolCalls action", () => {
    const calls: ToolCall[] = [{ type: "toolCall", id: "1", name: "ls", arguments: {} }];
    const actions = coarseEventToActions({ type: "llm-end", msg: assistant([...calls]), durationMs: 1 });
    expect(actions).toEqual([{ kind: "toolCalls", calls }]);
  });

  it("tool-end → a toolResult action with ok/output/duration", () => {
    const call: ToolCall = { type: "toolCall", id: "1", name: "bash", arguments: { cmd: "ls" } };
    const result: ToolExecResult = { content: [{ type: "text", text: "a.ts\nb.ts" }], isError: false };
    const actions = coarseEventToActions({ type: "tool-end", call, result, durationMs: 12 });
    expect(actions).toEqual([
      { kind: "toolResult", name: "bash", ok: true, output: "a.ts\nb.ts", durationMs: 12 },
    ]);
  });

  it("tool-end with isError → ok:false", () => {
    const call: ToolCall = { type: "toolCall", id: "1", name: "bash", arguments: {} };
    const result: ToolExecResult = { content: [{ type: "text", text: "boom" }], isError: true };
    const actions = coarseEventToActions({ type: "tool-end", call, result, durationMs: 3 });
    expect(actions[0]).toMatchObject({ kind: "toolResult", ok: false, output: "boom" });
  });

  it("error → an error action", () => {
    expect(coarseEventToActions({ type: "error", phase: "tool", message: "nope" })).toEqual([
      { kind: "error", phase: "tool", message: "nope" },
    ]);
  });

  it("session-end → a done action carrying the summary", () => {
    expect(coarseEventToActions({ type: "session-end", summary })).toEqual([
      { kind: "done", summary },
    ]);
  });

  it("turn-end / continuation-check produce no actions", () => {
    expect(coarseEventToActions({ type: "turn-end", turnIdx: 0, toolResultsCount: 0, stopReason: "stop" })).toEqual([]);
    expect(coarseEventToActions({ type: "continuation-check", turns: 1, continuations: 0 })).toEqual([]);
  });

  it("every SessionEvent type is handled (no throw, array result)", () => {
    const events: SessionEvent[] = [
      { type: "session-start", sessionId: "s", source: "run" },
      { type: "turn-start", turnIdx: 0 },
      { type: "llm-end", msg: assistant([{ type: "text", text: "x" }]), durationMs: 1 },
      { type: "tool-end", call: { type: "toolCall", id: "1", name: "ls", arguments: {} }, result: { content: [] }, durationMs: 1 },
      { type: "turn-end", turnIdx: 0, toolResultsCount: 0, stopReason: "stop" },
      { type: "continuation-check", turns: 1, continuations: 0 },
      { type: "session-end", summary },
      { type: "error", phase: "llm", message: "e" },
    ];
    for (const e of events) {
      const out: TuiAction[] = coarseEventToActions(e);
      expect(Array.isArray(out)).toBe(true);
    }
  });
});
