import { describe, it, expect } from "vitest";
import { AgentSession } from "../session.js";
import { MemorySessionStore } from "../session-store.js";
import type { SessionEntry } from "../session-store.js";
import { createFakeModel } from "../testing.js";
import type { Hook } from "../hook.js";
import type { HarnessTool } from "../types.js";

/**
 * 可配置失败的 SessionStore：读全部委托给 MemorySessionStore，只在 appendEntry 上按规则失败。
 * - `failKind` / `failKinds`：对该（些）kind 的 entry，appendEntry 抛错（不落库）。
 * - `failFirstCall`：只在第 1 次 appendEntry 调用抛错，之后恢复（验证瞬时错误 + HWM 重试）。
 * - `failOnCall`：只在第 N 次 appendEntry 调用抛错一次，之后恢复（验证多 turn HWM 重试不重不漏）。
 */
class FailingStore extends MemorySessionStore {
  calls = 0;
  constructor(
    private readonly opts: {
      failKind?: SessionEntry["kind"];
      failKinds?: SessionEntry["kind"][];
      failFirstCall?: boolean;
      failOnCall?: number;
    } = {},
  ) {
    super();
  }
  override async appendEntry(sessionId: string, entry: SessionEntry) {
    this.calls++;
    if (this.opts.failFirstCall && this.calls === 1) {
      throw new Error("transient store blip");
    }
    if (this.opts.failOnCall && this.calls === this.opts.failOnCall) {
      throw new Error(`store blip on call #${this.calls}`);
    }
    if (this.opts.failKind && entry.kind === this.opts.failKind) {
      throw new Error(`append(${entry.kind}) boom`);
    }
    if (this.opts.failKinds?.includes(entry.kind)) {
      throw new Error(`append(${entry.kind}) boom`);
    }
    return super.appendEntry(sessionId, entry);
  }
}

const sink = () => {};

const noopTool: HarnessTool = {
  name: "noop",
  description: "noop",
  parameters: { type: "object", properties: {} } as never,
  async execute() {
    return { content: [{ type: "text", text: "ok" }] };
  },
};

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

  it("multi-turn: 第 N 条 append 瞬时失败 → HWM 重试，最终 transcript 不重不漏", async () => {
    // 两 turn 续跑：turn1 assistant(toolCall) + toolResult，turn2 assistant(text)。
    // 让第 2 次 appendEntry（assistant-toolCall）失败一次：HWM 停在已成功处，下一 turn 从该条重试。
    const store = new FailingStore({ failOnCall: 2 });
    const fake = createFakeModel([
      { content: [{ type: "toolCall", name: "noop", arguments: {} }] },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({ model: fake, tools: [noopTool], store, consoleSink: sink });
    const summary = await session.run("q");

    expect(summary.reason).toBe("done");
    expect(summary.persistenceErrors!.some((e) => e.includes("call #2"))).toBe(true);

    // 最终落盘的 message 序列必须恰好 = 真实历史，无重复、无缺失（HWM 不变量）。
    const path = await store.getPathToLeaf(session.id);
    const roles = path
      .filter((e) => e.entry.kind === "message")
      .map((e) => (e.entry.kind === "message" ? e.entry.message.role : null));
    expect(roles).toEqual(["user", "assistant", "toolResult", "assistant"]);
    expect(path.at(-1)!.entry.kind).toBe("terminal");
    fake.teardown();
  });

  it("message + terminal 双失败（best-effort）：两条记录都如实暴露", async () => {
    const store = new FailingStore({ failKinds: ["message", "terminal"] });
    const fake = createFakeModel([{ content: [{ type: "text", text: "a" }] }]);
    const session = new AgentSession({ model: fake, tools: [], store, consoleSink: sink });
    const summary = await session.run("q");

    expect(summary.reason).toBe("done"); // best-effort 不改终态
    expect(summary.persistenceErrors!.some((e) => e.includes("appendEntry(message)"))).toBe(true);
    expect(summary.persistenceErrors!.some((e) => e.includes("appendEntry(terminal)"))).toBe(true);
    fake.teardown();
  });

  it("strict 改写后的 error.message 含 'strict persistence failed' 前缀 + 底层原因", async () => {
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
    expect(summary.error!.message).toContain("strict persistence failed");
    expect(summary.error!.message).toContain("boom"); // 底层 store 错误文案被带上
    fake.teardown();
  });

  it("strict 不覆盖某 turn 自然抛错的原始 error（reason 非 done 时不提级）", async () => {
    // streamThrows → LLM 调用同步抛 → reason 自然为 'error'、summary.error 是该 turn 错误。
    // 同时让 terminal append 失败：strict 只提级 done，故 reason 仍 'error'、error 仍是原始 turn 错误，
    // 不被 'strict persistence failed' 顶替；但 persistenceErrors 仍如实挂上。
    const store = new FailingStore({ failKind: "terminal" });
    const fake = createFakeModel([{ content: [], streamThrows: new Error("llm exploded") }]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      store,
      strictPersistence: true,
      consoleSink: sink,
    });
    const summary = await session.run("q");

    expect(summary.reason).toBe("error");
    expect(summary.error!.message).toContain("llm exploded"); // 原始 turn 错误被保留
    expect(summary.error!.message).not.toContain("strict persistence failed");
    expect(summary.persistenceErrors!.some((e) => e.includes("appendEntry(terminal)"))).toBe(true);
    fake.teardown();
  });

  it("strict 不覆盖自然 aborted（onUserPromptSubmit deny halt 路径 + terminal 失败）", async () => {
    // deny halt 走的是另一个 _finalizePersistence 调用点（prompt-deny 路径）。reason 自然为 'aborted'，
    // 即便 strict + terminal 落盘失败也不提级为 'error'（aborted 本就非干净成功），persistenceErrors 仍暴露。
    const store = new FailingStore({ failKinds: ["terminal", "message"] });
    const denyHook: Hook = {
      name: "gate",
      onUserPromptSubmit: () => ({ decision: "deny", reason: "no go" }),
    };
    const fake = createFakeModel([{ content: [{ type: "text", text: "unreached" }] }]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      hooks: [denyHook],
      store,
      strictPersistence: true,
      consoleSink: sink,
    });
    const summary = await session.run("blocked");

    expect(summary.reason).toBe("aborted"); // strict 不把合法 aborted 盖成 error
    expect(summary.abortReason).toContain("no go");
    expect(summary.persistenceErrors!.length).toBeGreaterThan(0); // 失败仍如实暴露
    fake.teardown();
  });

  it("persistenceErrors 是 per-run 信号：上一次失败不污染下一次干净 run", async () => {
    // R1 用失败 store 跑出 persistenceErrors；R2 换健康 store continue，断言 R2 不带 R1 的陈旧错误。
    const badStore = new FailingStore({ failKind: "message" });
    const fake = createFakeModel([
      { content: [{ type: "text", text: "r1" }] },
      { content: [{ type: "text", text: "r2" }] },
    ]);
    const session = new AgentSession({ model: fake, tools: [], store: badStore, consoleSink: sink });
    const r1 = await session.run("q1");
    expect(r1.persistenceErrors!.length).toBeGreaterThan(0); // R1 有失败

    // 让 store 恢复健康（清掉 failKind），第二次 run 走干净路径。
    delete (badStore as unknown as { opts: { failKind?: string } }).opts.failKind;
    const r2 = await session.run("q2");
    expect(r2.reason).toBe("done");
    expect(r2.persistenceErrors).toBeUndefined(); // 不带 R1 的陈旧错误
    fake.teardown();
  });
});
