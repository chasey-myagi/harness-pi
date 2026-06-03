/**
 * Edge cases —— 边界、错误路径、状态组合补充测试。
 *
 * 覆盖 test-review 指出的缺失场景：
 *   - mergeResults: updatedInput last-writer / empty input
 *   - fireDecision: 全 undefined / hook throw fail-open / hook throw failClosed → deny
 *   - firePipe: hook throw fail-open / 部分 transform 返 undefined 混合
 *   - wrapTurn: next() throw 传播 / outer 能 catch inner / next() 被调 2 次
 *   - Pipe + Around timeout 兜底
 *   - decision 路径 additionalContext 聚合（不短路）
 *   - hook fail-open vs fail-closed 区分
 */

import { describe, it, expect, vi } from "vitest";
import { Type } from "@mariozechner/pi-ai";
import { AgentSession } from "../session.js";
import {
  HookDispatcher,
  HookTimeoutError,
  defaultTimeoutFor,
  mergeResults,
} from "../dispatcher.js";
import type {
  HarnessTool,
  Hook,
  HookContext,
} from "../index.js";
import { createFakeModel, createTestContext } from "../testing.js";

function fakeCtx(): HookContext {
  return createTestContext().ctx;
}

/* ──────────────── mergeResults edge cases ──────────────── */

describe("mergeResults edge cases", () => {
  it("empty array returns sane default", () => {
    const out = mergeResults([]);
    expect(out.additionalContexts).toEqual([]);
    expect(out.systemMessages).toEqual([]);
    expect(out.continue).toBeUndefined();
    expect(out.decision).toBeUndefined();
  });

  it("updatedInput last-writer-wins (event形态)", () => {
    const out = mergeResults([
      { updatedInput: { a: 1 } },
      { updatedInput: { b: 2 } },
      { updatedInput: { c: 3 } },
    ]);
    expect(out.updatedInput).toEqual({ c: 3 });
  });

  it("continue=false 同时聚合 additionalContext", () => {
    const out = mergeResults([
      { additionalContext: "before halt" },
      { continue: false, stopReason: "halt", additionalContext: "halt context" },
      { additionalContext: "after halt" },
    ]);
    expect(out.continue).toBe(false);
    expect(out.stopReason).toBe("halt");
    expect(out.additionalContexts).toEqual([
      "before halt",
      "halt context",
      "after halt",
    ]);
  });

  it("initialUserMessage first non-empty wins", () => {
    const out = mergeResults([
      {},
      { initialUserMessage: "first" },
      { initialUserMessage: "second (ignored)" },
    ]);
    expect(out.initialUserMessage).toBe("first");
  });
});

/* ──────────────── defaultTimeoutFor unknown method ──────────────── */

describe("defaultTimeoutFor", () => {
  it("known event method", () => {
    expect(defaultTimeoutFor("onSessionStart")).toBe(100);
  });
  it("known decision method", () => {
    expect(defaultTimeoutFor("onPreToolUse")).toBe(200);
  });
  it("known pipe method", () => {
    expect(defaultTimeoutFor("transformMessagesBeforeLlm")).toBe(500);
  });
  it("unknown method throws", () => {
    expect(() => defaultTimeoutFor("unknownMethod")).toThrow(/unknown method/);
  });

  it("onError is in EVENT_METHODS (not unknown)", () => {
    // 回归：onError 之前不在 EVENT_METHODS 里，对外 defaultTimeoutFor("onError") 会 throw
    expect(defaultTimeoutFor("onError")).toBe(100);
  });
});

/* ──────────────── fireDecision edge cases ──────────────── */

describe("fireDecision edge cases", () => {
  it("all hooks return undefined → returns null", async () => {
    const hooks: Hook[] = [
      { name: "a", onPreToolUse: () => undefined },
      { name: "b", onPreToolUse: () => undefined },
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
    expect(out).toBeNull();
  });

  it("only additionalContext returned → does NOT short-circuit subsequent hooks", async () => {
    // 关键 fix 验证：之前 _isDecisive 把 additionalContext 算决断，会屏蔽 hook B
    const denyCalled = vi.fn();
    const hooks: Hook[] = [
      {
        name: "ctx-injector",
        onPreToolUse: () => ({ additionalContext: "<r>just adding context</r>" }),
      },
      {
        name: "security-check",
        onPreToolUse: () => {
          denyCalled();
          return { decision: "deny", reason: "really blocked" };
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
    expect(denyCalled).toHaveBeenCalled();
    expect(out?.decision).toBe("deny");
    expect(out?.reason).toBe("really blocked");
    // additionalContext from first hook should still be carried into final result
    expect(out?.additionalContext).toContain("just adding context");
  });

  it("decision hook throw → fail-open (continue to next)", async () => {
    const log = vi.fn();
    const hooks: Hook[] = [
      {
        name: "thrower",
        onPreToolUse: () => {
          throw new Error("kaboom");
        },
      },
      {
        name: "decider",
        onPreToolUse: () => ({ decision: "deny", reason: "after recovery" }),
      },
    ];
    const d = new HookDispatcher(hooks, (info) => log(info));
    const out = await d.fireDecision(
      "onPreToolUse",
      {
        call: { type: "toolCall", id: "1", name: "x", arguments: {} },
        tool: { name: "x" } as any,
      },
      fakeCtx(),
    );
    expect(out?.decision).toBe("deny");
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ hookName: "thrower" }),
    );
  });

  it("decision hook throw with failClosed=true → deny", async () => {
    const log = vi.fn();
    const hooks: Hook[] = [
      {
        name: "strict",
        failClosed: true,
        onPreToolUse: () => {
          throw new Error("permission check crashed");
        },
      },
      {
        name: "would-allow",
        onPreToolUse: () => undefined,
      },
    ];
    const d = new HookDispatcher(hooks, (info) => log(info));
    const out = await d.fireDecision(
      "onPreToolUse",
      {
        call: { type: "toolCall", id: "1", name: "x", arguments: {} },
        tool: { name: "x" } as any,
      },
      fakeCtx(),
    );
    expect(out?.decision).toBe("deny");
    expect(out?.reason).toContain("failClosed");
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ failedClosed: true }),
    );
  });

  it("decision hook timeout → fail-open by default", async () => {
    const log = vi.fn();
    const hooks: Hook[] = [
      {
        name: "slow",
        timeout: 20,
        onPreToolUse: () =>
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 200)),
      },
      {
        name: "decisive",
        onPreToolUse: () => ({ decision: "deny", reason: "after timeout" }),
      },
    ];
    const d = new HookDispatcher(hooks, (info) => log(info));
    const out = await d.fireDecision(
      "onPreToolUse",
      {
        call: { type: "toolCall", id: "1", name: "x", arguments: {} },
        tool: { name: "x" } as any,
      },
      fakeCtx(),
    );
    expect(out?.decision).toBe("deny");
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ hookName: "slow", timeoutMs: 20 }),
    );
  });
});

/* ──────────────── firePipe edge cases ──────────────── */

describe("firePipe edge cases", () => {
  it("hook returns undefined → keeps previous value (pipe through)", async () => {
    const hooks: Hook[] = [
      { name: "a", transformSystemPromptBeforeLlm: (s) => s + " A" },
      { name: "b", transformSystemPromptBeforeLlm: () => undefined },
      { name: "c", transformSystemPromptBeforeLlm: (s) => s + " C" },
    ];
    const d = new HookDispatcher(hooks);
    const out = await d.firePipeSystemPrompt("base", fakeCtx());
    expect(out).toBe("base A C");
  });

  it("pipe hook throw → fail-open (subsequent still runs)", async () => {
    const hooks: Hook[] = [
      {
        name: "thrower",
        transformSystemPromptBeforeLlm: () => {
          throw new Error("nope");
        },
      },
      { name: "second", transformSystemPromptBeforeLlm: (s) => s + " B" },
    ];
    const d = new HookDispatcher(hooks);
    const out = await d.firePipeSystemPrompt("base", fakeCtx());
    expect(out).toBe("base B");
  });

  it("pipe hook timeout → fail-open", async () => {
    const hooks: Hook[] = [
      {
        name: "slow",
        timeout: 20,
        transformSystemPromptBeforeLlm: () =>
          new Promise<string>((resolve) => setTimeout(() => resolve("slow"), 200)),
      },
      { name: "fast", transformSystemPromptBeforeLlm: (s) => s + " fast" },
    ];
    const d = new HookDispatcher(hooks);
    const out = await d.firePipeSystemPrompt("base", fakeCtx());
    expect(out).toBe("base fast");
  });
});

/* ──────────────── wrapTurn edge cases ──────────────── */

describe("wrapTurn edge cases", () => {
  it("next() throws → propagates through outer wrap (finally runs)", async () => {
    const calls: string[] = [];
    const hooks: Hook[] = [
      {
        name: "outer",
        async wrapTurn(_ctx, next) {
          calls.push("outer-pre");
          try {
            await next();
          } finally {
            calls.push("outer-post-finally");
          }
        },
      },
    ];
    const d = new HookDispatcher(hooks);
    const chain = d.buildWrapTurn(fakeCtx(), async () => {
      calls.push("body");
      throw new Error("body died");
    });
    await expect(chain()).rejects.toThrow("body died");
    expect(calls).toEqual(["outer-pre", "body", "outer-post-finally"]);
  });

  it("outer can catch inner errors", async () => {
    const hooks: Hook[] = [
      {
        name: "catcher",
        async wrapTurn(_ctx, next) {
          try {
            await next();
          } catch {
            /* swallow */
          }
        },
      },
    ];
    const d = new HookDispatcher(hooks);
    const chain = d.buildWrapTurn(fakeCtx(), async () => {
      throw new Error("inner");
    });
    await expect(chain()).resolves.toBeUndefined();
  });

  it("HookTimeoutError carries hook + method names", () => {
    const err = new HookTimeoutError("foo", "onTurnEnd", 42);
    expect(err.hookName).toBe("foo");
    expect(err.method).toBe("onTurnEnd");
    expect(err.timeoutMs).toBe(42);
    expect(err.message).toContain("foo");
    expect(err.message).toContain("42ms");
  });
});

/* ──────────────── kernel integration edge cases ──────────────── */

const echoTool: HarnessTool = {
  name: "echo",
  description: "echo",
  parameters: Type.Object({ msg: Type.String() }),
  async execute(args) {
    return { content: [{ type: "text", text: `echoed: ${args["msg"]}` }] };
  },
};

describe("AgentSession edge cases", () => {
  it("maxTurns: 0 returns immediately with max_turns reason", async () => {
    const model = createFakeModel([
      { content: [{ type: "text", text: "should not see this" }] },
    ]);
    const session = new AgentSession({
      model,
      tools: [],
      maxTurns: 0,
    });
    const summary = await session.run("hi");
    expect(summary.reason).toBe("max_turns");
    expect(summary.turns).toBe(0);
  });

  it("LLM returns toolCall but tool not found → isError result + LLM proceeds", async () => {
    const model = createFakeModel([
      { content: [{ type: "toolCall", name: "nonexistent", arguments: {} }] },
      { content: [{ type: "text", text: "got it" }] },
    ]);
    const session = new AgentSession({ model, tools: [echoTool] });
    const summary = await session.run("call nonexistent");
    expect(summary.reason).toBe("done");
    const tr = session.messages.find((m) => m.role === "toolResult");
    expect(tr && tr.role === "toolResult" && tr.isError).toBe(true);
    expect(
      tr && tr.role === "toolResult" && (tr.content[0] as any).text,
    ).toContain("not found");
  });

  it("one tool throws, other tools in same turn still execute", async () => {
    const goodTool: HarnessTool = {
      name: "good",
      description: "ok",
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text", text: "good ok" }] };
      },
    };
    const badTool: HarnessTool = {
      name: "bad",
      description: "throws",
      parameters: Type.Object({}),
      async execute() {
        throw new Error("bad fail");
      },
    };
    const model = createFakeModel([
      {
        content: [
          { type: "toolCall", id: "g1", name: "good", arguments: {} },
          { type: "toolCall", id: "b1", name: "bad", arguments: {} },
          { type: "toolCall", id: "g2", name: "good", arguments: {} },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({
      model,
      tools: [goodTool, badTool],
    });
    await session.run("call all");
    const trs = session.messages.filter((m) => m.role === "toolResult");
    expect(trs).toHaveLength(3);
    const isErrors = trs.map((m) => m.role === "toolResult" && m.isError);
    expect(isErrors).toEqual([false, true, false]);
  });

  it("safe + unsafe mixed: an unsafe call is a barrier — preserves model order (#11.1)", async () => {
    const events: string[] = [];
    const safeTool: HarnessTool = {
      name: "safe",
      description: "concurrency-safe",
      parameters: Type.Object({ id: Type.String() }),
      isConcurrencySafe: () => true,
      async execute(args) {
        events.push(`safe-${args["id"]}-start`);
        await new Promise((r) => setTimeout(r, 30));
        events.push(`safe-${args["id"]}-end`);
        return { content: [{ type: "text", text: String(args["id"]) }] };
      },
    };
    const unsafeTool: HarnessTool = {
      name: "unsafe",
      description: "not safe",
      parameters: Type.Object({ id: Type.String() }),
      async execute(args) {
        events.push(`unsafe-${args["id"]}-start`);
        await new Promise((r) => setTimeout(r, 10));
        events.push(`unsafe-${args["id"]}-end`);
        return { content: [{ type: "text", text: String(args["id"]) }] };
      },
    };
    const model = createFakeModel([
      {
        content: [
          { type: "toolCall", name: "safe", arguments: { id: "s1" } },
          { type: "toolCall", name: "unsafe", arguments: { id: "u1" } },
          { type: "toolCall", name: "safe", arguments: { id: "s2" } },
          { type: "toolCall", name: "unsafe", arguments: { id: "u2" } },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({
      model,
      tools: [safeTool, unsafeTool],
    });
    await session.run("go");
    // [safe, unsafe, safe, unsafe]：每个 safe 都被 unsafe barrier 隔开、互不相邻 → 不并发，
    // 严格按模型顺序执行。修复前 s1/s2 会被提到一批并发、u1 抢在 s2 前跑（#11.1）。
    expect(events).toEqual([
      "safe-s1-start",
      "safe-s1-end",
      "unsafe-u1-start",
      "unsafe-u1-end",
      "safe-s2-start",
      "safe-s2-end",
      "unsafe-u2-start",
      "unsafe-u2-end",
    ]);
  });

  it("aborting in middle of session: onSessionEnd still fires once with reason=aborted", async () => {
    const model = createFakeModel([
      { content: [{ type: "text", text: "r1" }], stopReason: "toolUse" },
      { content: [{ type: "text", text: "r2" }] },
    ]);
    const seenSessionEnds: Array<{ reason: string }> = [];
    const hook: Hook = {
      name: "spy",
      onSessionEnd(input) {
        seenSessionEnds.push({ reason: input.reason });
      },
      onTurnStart(_input, ctx) {
        if (ctx.turnIdx === 0) ctx.abort("manual stop");
      },
    };
    const session = new AgentSession({ model, tools: [], hooks: [hook] });
    const summary = await session.run("hi");
    expect(summary.reason).toBe("aborted");
    expect(seenSessionEnds).toHaveLength(1);
    expect(seenSessionEnds[0]?.reason).toBe("aborted");
  });

  it("max_continuations: onContinuationCheck fires N times, onSessionEnd exactly once", async () => {
    const model = createFakeModel(
      Array.from({ length: 10 }, () => ({
        content: [{ type: "text" as const, text: "r" }],
      })),
    );
    const sessionEnds: Array<{ reason: string; continuations: number }> = [];
    const continuationChecks: Array<{ continuations: number }> = [];
    const hook: Hook = {
      name: "infloop",
      onSessionEnd(input) {
        sessionEnds.push({
          reason: input.reason,
          continuations: input.continuations,
        });
      },
      onContinuationCheck(input) {
        continuationChecks.push({ continuations: input.continuations });
        return { continue: true };
      },
    };
    const session = new AgentSession({
      model,
      tools: [],
      hooks: [hook],
      maxContinuations: 2,
    });
    const summary = await session.run("hi");
    expect(summary.reason).toBe("max_continuations");
    expect(summary.continuations).toBe(2);
    // onContinuationCheck 触发 2 次（第 3 次因 maxContinuations 限额跳过）
    expect(continuationChecks).toHaveLength(2);
    // onSessionEnd 恰好 1 次，reason=max_continuations
    expect(sessionEnds).toHaveLength(1);
    expect(sessionEnds[0]?.reason).toBe("max_continuations");
    expect(sessionEnds[0]?.continuations).toBe(2);
  });

  it("use() while running throws", async () => {
    const model = createFakeModel([
      { content: [{ type: "text", text: "r" }], delayMs: 50 },
    ]);
    const session = new AgentSession({ model, tools: [] });
    const runPromise = session.run("hi");
    expect(() => session.use({ name: "late" })).toThrow(/in progress/);
    await runPromise;
  });

  it("hookFailureSink stays attached after use()", async () => {
    const sink = vi.fn();
    const model = createFakeModel([
      { content: [{ type: "text", text: "r" }] },
    ]);
    const failHook: Hook = {
      name: "fail",
      onTurnEnd: () => {
        throw new Error("boom");
      },
    };
    const session = new AgentSession({
      model,
      tools: [],
      hookFailureSink: sink,
    });
    session.use(failHook);
    await session.run("hi");
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({ hookName: "fail" }),
    );
  });

  it("concurrent run() throws", async () => {
    const model = createFakeModel([
      { content: [{ type: "text", text: "r" }], delayMs: 30 },
    ]);
    const session = new AgentSession({ model, tools: [] });
    const p1 = session.run("first");
    await expect(session.run("second")).rejects.toThrow(/in progress/);
    await p1;
  });
});

/* ──────────────── pipeMessages transform edge case ──────────────── */

describe("transformMessagesBeforeLlm", () => {
  it("returning undefined keeps previous; mixed undefined/array chains correctly", async () => {
    const model = createFakeModel([
      { content: [{ type: "text", text: "ok" }] },
    ]);
    let seen: any[] = [];
    const hooks: Hook[] = [
      {
        name: "add-one",
        transformMessagesBeforeLlm: (msgs) => [
          ...msgs,
          { role: "user", content: "extra-from-A", timestamp: 0 } as any,
        ],
      },
      {
        name: "noop",
        transformMessagesBeforeLlm: () => undefined,
      },
      {
        name: "spy",
        transformMessagesBeforeLlm: (msgs) => {
          seen = [...msgs];
          return undefined;
        },
      },
    ];
    const session = new AgentSession({ model, tools: [], hooks });
    await session.run("hi");
    // spy sees A's addition (B was noop)
    expect(seen.some((m) => (m as any).content === "extra-from-A")).toBe(true);
  });
});
