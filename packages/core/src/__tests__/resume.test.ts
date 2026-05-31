import { describe, it, expect } from "vitest";
import { AgentSession } from "../session.js";
import { MemorySessionStore } from "../session-store.js";
import { createFakeModel } from "../testing.js";
import { createUserMessage } from "../types.js";
import type { HarnessTool } from "../types.js";

// NOTE: only valid for string-content messages (all fakes here use string content).
const text = (m: { content: unknown }) => m.content;

const noopTool: HarnessTool = {
  name: "noop",
  description: "noop",
  parameters: { type: "object", properties: {} } as never,
  async execute() {
    return { content: [{ type: "text", text: "ok" }] };
  },
};

/** Store that throws once on its Nth appendEntry call, to exercise the retry path. */
class FlakyOnceStore extends MemorySessionStore {
  calls = 0;
  constructor(private readonly failAtCall: number) {
    super();
  }
  override async appendEntry(sessionId: string, entry: Parameters<MemorySessionStore["appendEntry"]>[1]) {
    this.calls++;
    if (this.calls === this.failAtCall) throw new Error("transient store blip");
    return super.appendEntry(sessionId, entry);
  }
}

describe("SessionStore resume", () => {
  it("persists a run to the store and resumes its messages into a fresh session", async () => {
    const store = new MemorySessionStore();
    const fake = createFakeModel([{ content: [{ type: "text", text: "answer one" }] }]);
    const session = new AgentSession({ model: fake, tools: [], store });

    await session.run("question one");
    const persisted = await store.getPathToLeaf(session.id);
    // user prompt + assistant at minimum
    expect(persisted.length).toBeGreaterThanOrEqual(2);

    // resume into a brand-new AgentSession bound to the same lineage
    const fake2 = createFakeModel([{ content: [{ type: "text", text: "answer two" }] }]);
    const resumed = await AgentSession.resume(store, session.id, { model: fake2, tools: [] });

    expect(resumed.id).toBe(session.id);
    // content integrity, not just role/count
    expect(resumed.messages.map((m) => m.role)).toEqual(session.messages.map((m) => m.role));
    expect(resumed.messages.map(text)).toEqual(session.messages.map(text));

    await resumed.continue();
    expect(text(resumed.messages.at(-1)!)).toEqual([{ type: "text", text: "answer two" }]);
    fake.teardown();
    fake2.teardown();
  });

  it("uses a per-item high-water-mark: a transient append failure retries WITHOUT duplicating (and stays best-effort)", async () => {
    // throw once on the 2nd append (the assistant). Old 'advance after loop' code would re-append
    // the user msg on the retry flush -> duplicate. Per-item advance + best-effort must avoid both.
    const store = new FlakyOnceStore(2);
    const fake = createFakeModel([{ content: [{ type: "text", text: "a1" }] }]);
    const session = new AgentSession({ model: fake, tools: [], store, consoleSink: () => {} });
    const summary = await session.run("q1");

    expect(summary.reason).toBe("done"); // best-effort: the store blip did NOT hijack the terminal
    const roles = (await store.getPathToLeaf(session.id))
      .filter((e) => e.entry.kind === "message")
      .map((e) => (e.entry.kind === "message" ? e.entry.message.role : null));
    // exactly [user, assistant] — the old 'advance after loop' bug would re-append user => [user,user,assistant]
    expect(roles).toEqual(["user", "assistant"]);
    fake.teardown();
  });

  it("collapses MULTIPLE consecutive compaction boundaries to the last summary", async () => {
    const store = new MemorySessionStore();
    await store.appendEntry("s", { kind: "message", message: createUserMessage("a") });
    await store.appendEntry("s", { kind: "compaction_boundary", summary: createUserMessage("S1") });
    await store.appendEntry("s", { kind: "message", message: createUserMessage("b") });
    await store.appendEntry("s", { kind: "compaction_boundary", summary: createUserMessage("S2") });
    await store.appendEntry("s", { kind: "message", message: createUserMessage("c") });
    const fake = createFakeModel([{ content: [{ type: "text", text: "ok" }] }]);
    const resumed = await AgentSession.resume(store, "s", { model: fake, tools: [] });
    expect(resumed.messages.map(text)).toEqual(["S2", "c"]);
    fake.teardown();
  });

  it("handles a boundary as the LAST entry (summary only)", async () => {
    const store = new MemorySessionStore();
    await store.appendEntry("s", { kind: "message", message: createUserMessage("old") });
    await store.appendEntry("s", { kind: "compaction_boundary", summary: createUserMessage("S") });
    const fake = createFakeModel([{ content: [{ type: "text", text: "ok" }] }]);
    const resumed = await AgentSession.resume(store, "s", { model: fake, tools: [] });
    expect(resumed.messages.map(text)).toEqual(["S"]);
    fake.teardown();
  });

  it("IGNORES a terminal entry mid-chain (does not truncate replay there)", async () => {
    const store = new MemorySessionStore();
    await store.appendEntry("s", { kind: "message", message: createUserMessage("m1") });
    await store.appendEntry("s", { kind: "terminal", result: { turns: 1, continuations: 0, reason: "done", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
    await store.appendEntry("s", { kind: "message", message: createUserMessage("m2") });
    const fake = createFakeModel([{ content: [{ type: "text", text: "ok" }] }]);
    const resumed = await AgentSession.resume(store, "s", { model: fake, tools: [] });
    expect(resumed.messages.map(text)).toEqual(["m1", "m2"]); // terminal skipped, not a stop point
    fake.teardown();
  });

  it("resumes a session that ended NON-done (max_turns) — terminal metadata doesn't pollute replay", async () => {
    const store = new MemorySessionStore();
    const fake = createFakeModel([{ content: [{ type: "toolCall", name: "noop", arguments: {} }] }]);
    const session = new AgentSession({ model: fake, tools: [noopTool], store, maxTurns: 1 });
    const summary = await session.run("go");
    expect(summary.reason).toBe("max_turns");

    const fake2 = createFakeModel([{ content: [{ type: "text", text: "after" }] }]);
    const resumed = await AgentSession.resume(store, session.id, { model: fake2, tools: [noopTool] });
    expect(resumed.messages.map((m) => m.role)).toEqual(session.messages.map((m) => m.role));
    const s2 = await resumed.continue();
    expect(s2.reason).toBe("done"); // resumed session continues cleanly
    fake.teardown();
    fake2.teardown();
  });

  it("persists a multi-message tool turn and resumes every message", async () => {
    const store = new MemorySessionStore();
    const fake = createFakeModel([
      { content: [{ type: "toolCall", name: "noop", arguments: {} }] }, // assistant(toolcall) + toolResult
      { content: [{ type: "text", text: "final" }] },
    ]);
    const session = new AgentSession({ model: fake, tools: [noopTool], store });
    await session.run("q");
    const persistedRoles = (await store.getPathToLeaf(session.id))
      .filter((e) => e.entry.kind === "message")
      .map((e) => (e.entry.kind === "message" ? e.entry.message.role : null));
    // user, assistant(toolcall), toolResult, assistant(text)
    expect(persistedRoles).toEqual(["user", "assistant", "toolResult", "assistant"]);

    const fake2 = createFakeModel([{ content: [{ type: "text", text: "z" }] }]);
    const resumed = await AgentSession.resume(store, session.id, { model: fake2, tools: [noopTool] });
    expect(resumed.messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    fake.teardown();
    fake2.teardown();
  });

  it("resume + run(newPrompt) appends the new user prompt and assistant, not the resumed prefix", async () => {
    const store = new MemorySessionStore();
    const fake = createFakeModel([{ content: [{ type: "text", text: "a1" }] }]);
    const session = new AgentSession({ model: fake, tools: [], store });
    await session.run("q1");
    const before = (await store.getPathToLeaf(session.id)).filter((e) => e.entry.kind === "message").length; // 2

    const fake2 = createFakeModel([{ content: [{ type: "text", text: "a2" }] }]);
    const resumed = await AgentSession.resume(store, session.id, { model: fake2, tools: [] });
    await resumed.run("q2"); // pushes user q2 + assistant a2
    const after = (await store.getPathToLeaf(session.id)).filter((e) => e.entry.kind === "message").length;
    expect(after).toBe(before + 2); // +user +assistant, prefix not re-appended
    fake.teardown();
    fake2.teardown();
  });

  it("a failing TERMINAL append stays best-effort: messages persist, run is still done", async () => {
    const store = new FlakyOnceStore(3); // calls: 1=user, 2=assistant, 3=terminal -> terminal throws
    const fake = createFakeModel([{ content: [{ type: "text", text: "a" }] }]);
    const session = new AgentSession({ model: fake, tools: [], store, consoleSink: () => {} });
    const summary = await session.run("q");
    expect(summary.reason).toBe("done"); // terminal append failure did not hijack the run
    const roles = (await store.getPathToLeaf(session.id))
      .filter((e) => e.entry.kind === "message")
      .map((e) => (e.entry.kind === "message" ? e.entry.message.role : null));
    expect(roles).toEqual(["user", "assistant"]); // messages still landed
    fake.teardown();
  });

  it("high-water-mark survives resume: a continue-time store blip retries from the prefix, never re-appending it", async () => {
    const store = new FlakyOnceStore(4); // run uses calls 1-3; continue's a2 append is call 4 -> throws once
    const fake = createFakeModel([{ content: [{ type: "text", text: "a1" }] }]);
    const session = new AgentSession({ model: fake, tools: [], store, consoleSink: () => {} });
    await session.run("q1");
    const fake2 = createFakeModel([{ content: [{ type: "text", text: "a2" }] }]);
    const resumed = await AgentSession.resume(store, session.id, { model: fake2, tools: [], consoleSink: () => {} });
    const summary = await resumed.continue();
    expect(summary.reason).toBe("done");
    const roles = (await store.getPathToLeaf(session.id))
      .filter((e) => e.entry.kind === "message")
      .map((e) => (e.entry.kind === "message" ? e.entry.message.role : null));
    expect(roles).toEqual(["user", "assistant", "assistant"]); // q1, a1, a2 — prefix not re-appended after resume
    fake.teardown();
    fake2.teardown();
  });

  it("resume drops the compaction-replaced prefix and continues from the summary (boundary trimming is resume's job)", async () => {
    const store = new MemorySessionStore();
    await store.appendEntry("s", { kind: "message", message: createUserMessage("old-1") });
    await store.appendEntry("s", { kind: "message", message: createUserMessage("old-2") });
    await store.appendEntry("s", { kind: "compaction_boundary", summary: createUserMessage("SUMMARY") });
    await store.appendEntry("s", { kind: "message", message: createUserMessage("recent") });

    const fake = createFakeModel([{ content: [{ type: "text", text: "ok" }] }]);
    const resumed = await AgentSession.resume(store, "s", { model: fake, tools: [] });
    // pre-boundary old-1/old-2 dropped; summary + post-boundary survive
    expect(resumed.messages.map(text)).toEqual(["SUMMARY", "recent"]);
    fake.teardown();
  });

  it("appends a terminal entry recording the run summary", async () => {
    const store = new MemorySessionStore();
    const fake = createFakeModel([{ content: [{ type: "text", text: "a" }] }]);
    const session = new AgentSession({ model: fake, tools: [], store });
    await session.run("hi");
    const path = await store.getPathToLeaf(session.id);
    const last = path.at(-1)!.entry;
    expect(last.kind).toBe("terminal");
    if (last.kind === "terminal") expect(last.result.reason).toBe("done");
    fake.teardown();
  });

  it("resume + continue appends only NEW messages — never re-persists the resumed prefix", async () => {
    const store = new MemorySessionStore();
    const fake = createFakeModel([{ content: [{ type: "text", text: "a1" }] }]);
    const session = new AgentSession({ model: fake, tools: [], store });
    await session.run("q1"); // persists: user q1, assistant a1 (+ terminal)
    const msgsAfterRun = (await store.getPathToLeaf(session.id)).filter((e) => e.entry.kind === "message").length;
    expect(msgsAfterRun).toBe(2);

    const fake2 = createFakeModel([{ content: [{ type: "text", text: "a2" }] }]);
    const resumed = await AgentSession.resume(store, session.id, { model: fake2, tools: [] });
    await resumed.continue(); // adds exactly one new assistant (continue pushes no user msg)

    const msgsAfterContinue = (await store.getPathToLeaf(session.id)).filter((e) => e.entry.kind === "message").length;
    expect(msgsAfterContinue).toBe(msgsAfterRun + 1); // resumed prefix NOT re-appended
    fake.teardown();
    fake2.teardown();
  });

  it("is a no-op without a store, and resuming an unknown session yields empty history", async () => {
    const fake = createFakeModel([{ content: [{ type: "text", text: "x" }] }]);
    const session = new AgentSession({ model: fake, tools: [] }); // no store
    const summary = await session.run("hi");
    expect(summary.reason).toBe("done"); // runs fine, just nothing persisted

    const store = new MemorySessionStore();
    const fake2 = createFakeModel([{ content: [{ type: "text", text: "y" }] }]);
    const resumed = await AgentSession.resume(store, "never-ran", { model: fake2, tools: [] });
    expect(resumed.messages).toHaveLength(0);
    fake.teardown();
    fake2.teardown();
  });
});
