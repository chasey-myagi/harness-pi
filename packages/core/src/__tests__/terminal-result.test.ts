import { describe, it, expect } from "vitest";
import { AgentSession } from "../session.js";
import { createFakeModel } from "../testing.js";
import type { HarnessTool } from "../types.js";
import type { Hook } from "../hook.js";

const noopTool: HarnessTool = {
  name: "noop",
  description: "noop",
  parameters: { type: "object", properties: {} } as never,
  async execute() {
    return { content: [{ type: "text", text: "ok" }] };
  },
};

describe("RunSummary as typed terminal result", () => {
  it("accumulates usage across turns and exposes the final assistant message + stopReason", async () => {
    const fake = createFakeModel([
      { content: [{ type: "toolCall", name: "noop", arguments: {} }], usage: { input: 10, output: 5 } },
      { content: [{ type: "text", text: "done" }], usage: { input: 20, output: 8 } },
    ]);
    const session = new AgentSession({ model: fake, tools: [noopTool] });

    const summary = await session.run("hi");

    expect(summary.reason).toBe("done");
    expect(summary.usage.input).toBe(30); // 10 + 20
    expect(summary.usage.output).toBe(13); // 5 + 8
    expect(summary.usage.totalTokens).toBe(43); // 15 + 28
    expect(summary.lastMessage?.role).toBe("assistant");
    expect(summary.lastMessage?.content).toEqual([{ type: "text", text: "done" }]);
    expect(summary.stopReason).toBe("stop");
    fake.teardown();
  });

  it("reports reason='error' with a (zero) usage and no lastMessage when the stream throws", async () => {
    const fake = createFakeModel([{ content: [], streamThrows: new Error("boom") }]);
    const session = new AgentSession({ model: fake, tools: [], consoleSink: () => {} });
    const summary = await session.run("hi");
    expect(summary.reason).toBe("error");
    expect(summary.error).toBeInstanceOf(Error);
    expect(summary.usage.totalTokens).toBe(0); // usage always present, even on failure
    expect(summary.lastMessage).toBeUndefined(); // no assistant landed
    fake.teardown();
  });

  it("reports reason='aborted' with usage present when the caller signal is already aborted", async () => {
    const fake = createFakeModel([{ content: [{ type: "text", text: "never" }] }]);
    const session = new AgentSession({ model: fake, tools: [] });
    const ac = new AbortController();
    ac.abort();
    const summary = await session.run("hi", { signal: ac.signal });
    expect(summary.reason).toBe("aborted");
    expect(summary.usage).toBeDefined();
    expect(summary.usage.totalTokens).toBe(0); // aborted before any LLM call
    fake.teardown();
  });

  it("reports reason='max_turns' yet still accumulates usage and exposes lastMessage", async () => {
    const fake = createFakeModel([
      { content: [{ type: "toolCall", name: "noop", arguments: {} }], usage: { input: 7, output: 3 } },
      { content: [{ type: "toolCall", name: "noop", arguments: {} }], usage: { input: 7, output: 3 } },
    ]);
    const session = new AgentSession({ model: fake, tools: [noopTool], maxTurns: 1 });
    const summary = await session.run("hi");
    expect(summary.reason).toBe("max_turns");
    expect(summary.usage.input).toBe(7); // exactly one turn ran
    expect(summary.lastMessage?.role).toBe("assistant");
    expect(summary.lastMessage?.content).toEqual([{ type: "toolCall", id: expect.any(String), name: "noop", arguments: {} }]);
    expect(summary.stopReason).toBe("toolUse");
    fake.teardown();
  });

  it("reports reason='max_continuations' with usage accumulated over the run+continued turns", async () => {
    const keepGoing: Hook = { name: "keep-going", onContinuationCheck: () => ({ continue: true }) };
    const fake = createFakeModel([
      { content: [{ type: "text", text: "a" }], usage: { input: 1, output: 1 } },
      { content: [{ type: "text", text: "b" }], usage: { input: 1, output: 1 } },
    ]);
    const session = new AgentSession({ model: fake, tools: [], maxContinuations: 1, hooks: [keepGoing] });
    const summary = await session.run("hi");
    expect(summary.reason).toBe("max_continuations");
    expect(summary.continuations).toBe(1);
    expect(summary.usage.input).toBe(2); // both turns counted
    expect(summary.lastMessage?.content).toEqual([{ type: "text", text: "b" }]);
    fake.teardown();
  });

  it("usage is SESSION-cumulative across run() then continue() (not per-call)", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "a" }], usage: { input: 10, output: 5 } },
      { content: [{ type: "text", text: "b" }], usage: { input: 20, output: 7 } },
    ]);
    const session = new AgentSession({ model: fake, tools: [] });
    const s1 = await session.run("hi");
    expect(s1.usage.input).toBe(10);
    const s2 = await session.continue();
    expect(s2.usage.input).toBe(30); // 10 + 20 — cumulative over the session's messages
    expect(s2.usage.output).toBe(12);
    fake.teardown();
  });

  it("onUserPromptSubmit halt: reason='aborted', 0 turns, zero usage, no lastMessage", async () => {
    const deny: Hook = {
      name: "deny",
      onUserPromptSubmit: () => ({ continue: false, reason: "policy: blocked" }),
    };
    const fake = createFakeModel([{ content: [{ type: "text", text: "never" }] }]);
    const session = new AgentSession({ model: fake, tools: [], hooks: [deny] });
    const summary = await session.run("hi");
    expect(summary.reason).toBe("aborted");
    expect(summary.turns).toBe(0);
    expect(summary.usage.totalTokens).toBe(0);
    expect(summary.abortReason).toContain("policy: blocked");
    expect(summary.lastMessage).toBeUndefined(); // no assistant ever ran
    fake.teardown();
  });

  it("provider-reported error (error EVENT, resolves) lands the error message as lastMessage, with reason='done'", async () => {
    // distinct from streamThrows (sync throw -> catch -> reason='error', no lastMessage). Here
    // result() RESOLVES a stopReason='error' assistant which IS pushed, so lastMessage is present.
    // PINNED CONTRACT: this is complete()-equivalent — the loop only reports reason='error' on a
    // genuine THROW; a provider error surfaced as a resolved message is a normal turn (stopReason
    // != toolUse) => reason='done'. The failure on THIS path is signaled by lastMessage.stopReason,
    // not by summary.reason (matches RunSummary.lastMessage doc).
    const fake = createFakeModel([{ content: [], throwError: new Error("api 500") }]);
    const session = new AgentSession({ model: fake, tools: [], consoleSink: () => {} });
    const summary = await session.run("hi");
    expect(summary.lastMessage).toBeDefined();
    expect(summary.lastMessage?.stopReason).toBe("error");
    expect(summary.stopReason).toBe("error");
    expect(summary.reason).toBe("done"); // NOT 'error' — failure is in lastMessage.stopReason here
    fake.teardown();
  });

  it("accumulates cacheRead and always exposes a complete cost object (even with zero usage)", async () => {
    const fake = createFakeModel([{ content: [{ type: "text", text: "a" }], usage: { input: 5, output: 2, cached: 3 } }]);
    const session = new AgentSession({ model: fake, tools: [] });
    const summary = await session.run("hi");
    expect(summary.usage.cacheRead).toBe(3); // usage.cached -> cacheRead
    // cost object is always a complete, non-undefined shape so controllers can read cost.total safely
    expect(summary.usage.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
    fake.teardown();
  });

  it("counts usage from injected history (initialMessages) — the documented carried-messages overlap", async () => {
    // Executable contract for the lifecycle-restart overlap: a session built with injected history
    // counts that history's usage too. Hence restart-via-carried-messages overlaps usage (a known,
    // documented controller-layer semantic), not a kernel bug.
    const priorAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "prior" }],
      api: "x",
      provider: "x",
      model: "x",
      usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: 0,
    } as never;
    const fake = createFakeModel([{ content: [{ type: "text", text: "new" }], usage: { input: 5, output: 0 } }]);
    const session = new AgentSession({ model: fake, tools: [], initialMessages: [priorAssistant] });
    const summary = await session.run("hi");
    expect(summary.usage.input).toBe(105); // injected 100 + this run's 5 — the overlap is real
    fake.teardown();
  });
});
