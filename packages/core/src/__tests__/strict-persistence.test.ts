import { describe, it, expect } from "vitest";
import { AgentSession } from "../session.js";
import { MemorySessionStore } from "../session-store.js";
import type { SessionEntry } from "../session-store.js";
import { createFakeModel } from "../testing.js";

/**
 * 可配置失败的 SessionStore：读全部委托给 MemorySessionStore，只在 appendEntry 上按规则失败。
 * - `failKind`：对该 kind 的 entry，appendEntry 抛错（不落库）。
 * - `failFirstCall`：只在第 1 次 appendEntry 调用抛错，之后恢复（验证瞬时错误 + HWM 重试）。
 */
class FailingStore extends MemorySessionStore {
  calls = 0;
  constructor(
    private readonly opts: { failKind?: SessionEntry["kind"]; failFirstCall?: boolean } = {},
  ) {
    super();
  }
  override async appendEntry(sessionId: string, entry: SessionEntry) {
    this.calls++;
    if (this.opts.failFirstCall && this.calls === 1) {
      throw new Error("transient store blip");
    }
    if (this.opts.failKind && entry.kind === this.opts.failKind) {
      throw new Error(`append(${entry.kind}) boom`);
    }
    return super.appendEntry(sessionId, entry);
  }
}

const sink = () => {};

describe("strict persistence + surfaced persistenceErrors", () => {
  it("message-append failure, best-effort: natural reason kept, error surfaced", async () => {
    const store = new FailingStore({ failKind: "message" });
    const fake = createFakeModel([{ content: [{ type: "text", text: "a" }] }]);
    const session = new AgentSession({ model: fake, tools: [], store, consoleSink: sink });
    const summary = await session.run("q");

    expect(summary.reason).toBe("done"); // best-effort: 终态不被劫持
    expect(summary.persistenceErrors).toBeDefined();
    expect(summary.persistenceErrors!.some((e) => e.includes("appendEntry(message)"))).toBe(true);
    fake.teardown();
  });

  it("message-append failure, strict: reason rewritten to error", async () => {
    const store = new FailingStore({ failKind: "message" });
    const fake = createFakeModel([{ content: [{ type: "text", text: "a" }] }]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      store,
      strictPersistence: true,
      consoleSink: sink,
    });
    const summary = await session.run("q");

    expect(summary.reason).toBe("error");
    expect(summary.error).toBeInstanceOf(Error);
    expect(summary.persistenceErrors).toBeDefined();
    expect(summary.persistenceErrors!.length).toBeGreaterThan(0);
    fake.teardown();
  });

  it("terminal-append failure, best-effort: natural reason kept, terminal error surfaced", async () => {
    const store = new FailingStore({ failKind: "terminal" });
    const fake = createFakeModel([{ content: [{ type: "text", text: "a" }] }]);
    const session = new AgentSession({ model: fake, tools: [], store, consoleSink: sink });
    const summary = await session.run("q");

    expect(summary.reason).toBe("done");
    expect(summary.persistenceErrors).toBeDefined();
    expect(summary.persistenceErrors!.some((e) => e.includes("appendEntry(terminal)"))).toBe(true);
    fake.teardown();
  });

  it("terminal-append failure, strict: reason rewritten to error", async () => {
    const store = new FailingStore({ failKind: "terminal" });
    const fake = createFakeModel([{ content: [{ type: "text", text: "a" }] }]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      store,
      strictPersistence: true,
      consoleSink: sink,
    });
    const summary = await session.run("q");

    expect(summary.reason).toBe("error");
    expect(summary.error).toBeInstanceOf(Error);
    expect(summary.persistenceErrors!.some((e) => e.includes("appendEntry(terminal)"))).toBe(true);
    fake.teardown();
  });

  it("transient-then-recover, strict: reason stays done (persistedOk true) BUT error surfaced", async () => {
    // 第 1 次 append 抛错后恢复；HWM 重试让最终 flush+terminal 都成功 → persistedOk=true。
    // strict 据「真实完成」裁决，不因「出现过 error」误判，但瞬时错误仍如实暴露。
    const store = new FailingStore({ failFirstCall: true });
    const fake = createFakeModel([{ content: [{ type: "text", text: "a" }] }]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      store,
      strictPersistence: true,
      consoleSink: sink,
    });
    const summary = await session.run("q");

    expect(summary.reason).toBe("done"); // 最终落盘完成，strict 不误判
    expect(summary.persistenceErrors).toBeDefined();
    expect(summary.persistenceErrors!.length).toBeGreaterThan(0);
    fake.teardown();
  });

  it("no store: no persistenceErrors field, normal reason (regression)", async () => {
    const fake = createFakeModel([{ content: [{ type: "text", text: "a" }] }]);
    const session = new AgentSession({ model: fake, tools: [] });
    const summary = await session.run("q");

    expect(summary.reason).toBe("done");
    expect(summary.persistenceErrors).toBeUndefined();
    fake.teardown();
  });

  it("best-effort default healthy store: no persistenceErrors, transcript fully persisted", async () => {
    const store = new MemorySessionStore();
    const fake = createFakeModel([{ content: [{ type: "text", text: "a" }] }]);
    const session = new AgentSession({ model: fake, tools: [], store });
    const summary = await session.run("q");

    expect(summary.reason).toBe("done");
    expect(summary.persistenceErrors).toBeUndefined();

    const path = await store.getPathToLeaf(session.id);
    const roles = path
      .filter((e) => e.entry.kind === "message")
      .map((e) => (e.entry.kind === "message" ? e.entry.message.role : null));
    expect(roles).toEqual(["user", "assistant"]);
    expect(path.at(-1)!.entry.kind).toBe("terminal"); // terminal 也落盘了
    fake.teardown();
  });
});
