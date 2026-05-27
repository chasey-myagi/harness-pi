/**
 * Dispatcher tests —— 4 hook 形态 + 合并规则 + timeout + fail-open。
 */

import { describe, it, expect, vi } from "vitest";
import { HookDispatcher, mergeResults } from "../dispatcher.js";
import type { Hook, HookContext, MergedHookResult } from "../index.js";

function fakeCtx(): HookContext {
  const ac = new AbortController();
  const noopLog = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  return {
    sessionId: "test",
    turnIdx: 0,
    signal: ac.signal,
    state: new Map() as unknown as HookContext["state"],
    messages: [],
    config: {
      sessionId: "test",
      model: { id: "fake", provider: "fake" },
      toolNames: [],
      maxTurns: 200,
      maxContinuations: 5,
    },
    log: noopLog,
    appendMessage: vi.fn(),
    abort: vi.fn(),
    emit: vi.fn(),
  };
}

describe("HookDispatcher event (parallel)", () => {
  it("fires all matched hooks", async () => {
    const calls: string[] = [];
    const hooks: Hook[] = [
      {
        name: "a",
        onTurnEnd: async () => {
          calls.push("a");
        },
      },
      {
        name: "b",
        onTurnEnd: async () => {
          calls.push("b");
        },
      },
    ];
    const d = new HookDispatcher(hooks);
    await d.fireEvent(
      "onTurnEnd",
      {
        turnIdx: 0,
        assistantMessage: { stopReason: "stop" } as any,
        toolResults: [],
      },
      fakeCtx(),
    );
    expect(calls.sort()).toEqual(["a", "b"]);
  });

  it("merges additionalContexts in registration order", async () => {
    const hooks: Hook[] = [
      { name: "a", onTurnEnd: () => ({ additionalContext: "first" }) },
      { name: "b", onTurnEnd: () => ({ additionalContext: "second" }) },
    ];
    const d = new HookDispatcher(hooks);
    const out = await d.fireEvent(
      "onTurnEnd",
      {
        turnIdx: 0,
        assistantMessage: { stopReason: "stop" } as any,
        toolResults: [],
      },
      fakeCtx(),
    );
    expect(out.additionalContexts).toEqual(["first", "second"]);
  });

  it("continue=false from any hook wins", async () => {
    const hooks: Hook[] = [
      { name: "a", onTurnEnd: () => ({ continue: true }) },
      {
        name: "b",
        onTurnEnd: () => ({ continue: false, stopReason: "halted" }),
      },
    ];
    const d = new HookDispatcher(hooks);
    const out = await d.fireEvent(
      "onTurnEnd",
      {
        turnIdx: 0,
        assistantMessage: { stopReason: "stop" } as any,
        toolResults: [],
      },
      fakeCtx(),
    );
    expect(out.continue).toBe(false);
    expect(out.stopReason).toBe("halted");
  });

  it("fail-open: hook throw doesn't break others", async () => {
    const log = vi.fn();
    const hooks: Hook[] = [
      {
        name: "thrower",
        onTurnEnd: () => {
          throw new Error("boom");
        },
      },
      { name: "good", onTurnEnd: () => ({ additionalContext: "ok" }) },
    ];
    const d = new HookDispatcher(hooks, (info) => log(info));
    const out = await d.fireEvent(
      "onTurnEnd",
      {
        turnIdx: 0,
        assistantMessage: { stopReason: "stop" } as any,
        toolResults: [],
      },
      fakeCtx(),
    );
    expect(out.additionalContexts).toEqual(["ok"]);
    expect(log).toHaveBeenCalledOnce();
  });

  it("hook timeout triggers fail-open", async () => {
    const log = vi.fn();
    const hooks: Hook[] = [
      {
        name: "slow",
        timeout: 20,
        onTurnEnd: () =>
          new Promise<void>((resolve) => setTimeout(resolve, 200)),
      },
      { name: "fast", onTurnEnd: () => ({ additionalContext: "fast" }) },
    ];
    const d = new HookDispatcher(hooks, (info) => log(info));
    const out = await d.fireEvent(
      "onTurnEnd",
      {
        turnIdx: 0,
        assistantMessage: { stopReason: "stop" } as any,
        toolResults: [],
      },
      fakeCtx(),
    );
    expect(out.additionalContexts).toEqual(["fast"]);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ hookName: "slow", timeoutMs: 20 }),
    );
  });
});

describe("HookDispatcher decision (sequential short-circuit)", () => {
  it("first decisive hook wins; subsequent skipped", async () => {
    const calls: string[] = [];
    const hooks: Hook[] = [
      {
        name: "a",
        onPreToolUse: () => {
          calls.push("a");
          return { decision: "deny", reason: "no" };
        },
      },
      {
        name: "b",
        onPreToolUse: () => {
          calls.push("b");
          return { decision: "allow" };
        },
      },
    ];
    const d = new HookDispatcher(hooks);
    const out = await d.fireDecision(
      "onPreToolUse",
      {
        call: { type: "toolCall", id: "1", name: "x", arguments: {} },
        tool: { name: "x" } as any,
      },
      fakeCtx(),
    );
    expect(out?.decision).toBe("deny");
    expect(calls).toEqual(["a"]);
  });

  it("non-decisive return continues to next hook", async () => {
    const hooks: Hook[] = [
      { name: "skip", onPreToolUse: () => undefined },
      {
        name: "act",
        onPreToolUse: () => ({ decision: "deny", reason: "yes" }),
      },
    ];
    const d = new HookDispatcher(hooks);
    const out = await d.fireDecision(
      "onPreToolUse",
      {
        call: { type: "toolCall", id: "1", name: "x", arguments: {} },
        tool: { name: "x" } as any,
      },
      fakeCtx(),
    );
    expect(out?.decision).toBe("deny");
    expect(out?.reason).toBe("yes");
  });
});

describe("HookDispatcher transform pipe", () => {
  it("system prompt: chained transform", async () => {
    const hooks: Hook[] = [
      { name: "a", transformSystemPromptBeforeLlm: (s) => s + " A" },
      { name: "b", transformSystemPromptBeforeLlm: (s) => s + " B" },
    ];
    const d = new HookDispatcher(hooks);
    const out = await d.firePipeSystemPrompt("hi", fakeCtx());
    expect(out).toBe("hi A B");
  });

  it("messages: chained transform", async () => {
    const hooks: Hook[] = [
      {
        name: "a",
        transformMessagesBeforeLlm: (msgs) => [
          ...msgs,
          { role: "user", content: "from A", timestamp: 0 } as any,
        ],
      },
      {
        name: "b",
        transformMessagesBeforeLlm: (msgs) => [
          ...msgs,
          { role: "user", content: "from B", timestamp: 0 } as any,
        ],
      },
    ];
    const d = new HookDispatcher(hooks);
    const out = await d.firePipeMessages([], fakeCtx());
    expect(out).toHaveLength(2);
    expect((out[0] as any).content).toBe("from A");
    expect((out[1] as any).content).toBe("from B");
  });
});

describe("HookDispatcher around (nested)", () => {
  it("early registered = outer", async () => {
    const calls: string[] = [];
    const hooks: Hook[] = [
      {
        name: "outer",
        async wrapTurn(_ctx, next) {
          calls.push("outer-pre");
          await next();
          calls.push("outer-post");
        },
      },
      {
        name: "inner",
        async wrapTurn(_ctx, next) {
          calls.push("inner-pre");
          await next();
          calls.push("inner-post");
        },
      },
    ];
    const d = new HookDispatcher(hooks);
    const chain = d.buildWrapTurn(fakeCtx(), async () => {
      calls.push("body");
    });
    await chain();
    expect(calls).toEqual([
      "outer-pre",
      "inner-pre",
      "body",
      "inner-post",
      "outer-post",
    ]);
  });
});

describe("mergeResults", () => {
  it("aggregates additionalContexts in order", () => {
    const out = mergeResults([
      { additionalContext: "1" },
      undefined,
      { additionalContext: "2" },
      { additionalContext: "3" },
    ]);
    expect(out.additionalContexts).toEqual(["1", "2", "3"]);
  });

  it("first decision wins", () => {
    const out = mergeResults([
      { decision: "allow" },
      { decision: "deny", reason: "later" },
    ]);
    expect(out.decision).toBe("allow");
  });

  it("updatedToolOutput last writer wins", () => {
    const r1 = { content: [{ type: "text" as const, text: "a" }] };
    const r2 = { content: [{ type: "text" as const, text: "b" }] };
    const out = mergeResults([
      { updatedToolOutput: r1 },
      { updatedToolOutput: r2 },
    ]);
    expect(out.updatedToolOutput).toBe(r2);
  });

  it("ignores non-object/array entries (transform results)", () => {
    const out = mergeResults(["a string", ["msg" as any], undefined]);
    expect(out.additionalContexts).toEqual([]);
    expect(out.systemMessages).toEqual([]);
  });
});
