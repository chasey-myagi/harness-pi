import { describe, it, expect } from "vitest";
import { AgentSession } from "../session.js";
import type { LiveEvent } from "../session.js";
import { createFakeModel } from "../testing.js";
import type { HarnessTool } from "../types.js";
import type { AssistantMessage } from "@mariozechner/pi-ai";

const noopTool: HarnessTool = {
  name: "noop",
  description: "noop",
  parameters: { type: "object", properties: {} } as never,
  async execute() {
    return { content: [{ type: "text", text: "ok" }] };
  },
};

describe("Event Bus · live token deltas via on()", () => {
  it("re-emits provider text deltas through session.on('text_delta')", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "hello" }], textDeltas: ["hel", "lo"] },
    ]);
    const session = new AgentSession({ model: fake, tools: [] });
    const deltas: string[] = [];
    session.on("text_delta", (e) => deltas.push(e.delta));

    const summary = await session.run("hi");

    expect(deltas).toEqual(["hel", "lo"]);
    expect(summary.reason).toBe("done");
    // final assembled message still lands in history
    const last = session.messages.at(-1)!;
    expect(last.role).toBe("assistant");
    fake.teardown();
  });

  it("re-emits thinking deltas", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "ok" }], thinkingDeltas: ["let me ", "think"] },
    ]);
    const session = new AgentSession({ model: fake, tools: [] });
    const got: string[] = [];
    session.on("thinking_delta", (e) => got.push(e.delta));
    await session.run("hi");
    expect(got).toEqual(["let me ", "think"]);
    fake.teardown();
  });

  it("re-emits toolcall deltas", async () => {
    const fake = createFakeModel([
      { content: [{ type: "toolCall", name: "noop", arguments: {} }], toolcallDeltas: ['{"a":', "1}"] },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const noop = {
      name: "noop",
      description: "noop",
      parameters: { type: "object", properties: {} } as never,
      async execute() {
        return { content: [{ type: "text" as const, text: "ok" }] };
      },
    };
    const session = new AgentSession({ model: fake, tools: [noop] });
    const got: string[] = [];
    session.on("toolcall_delta", (e) => got.push(e.delta));
    await session.run("hi");
    expect(got).toEqual(['{"a":', "1}"]);
    fake.teardown();
  });

  it("supports multiple listeners and unsubscribe", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "x" }], textDeltas: ["a", "b"] },
      { content: [{ type: "text", text: "y" }], textDeltas: ["c", "d"] },
    ]);
    const session = new AgentSession({ model: fake, tools: [] });
    const a: string[] = [];
    const b: string[] = [];
    const offB = session.on("text_delta", (e) => b.push(e.delta));
    session.on("text_delta", (e) => a.push(e.delta));
    await session.run("first");
    offB(); // unsubscribe b
    await session.run("second");
    expect(a).toEqual(["a", "b", "c", "d"]); // a saw both runs
    expect(b).toEqual(["a", "b"]); // b only the first
    fake.teardown();
  });

  it("isolates a throwing listener: loop completes and other listeners still fire", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "x" }], textDeltas: ["a", "b"] },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      // swallow the kernel's console warning about the throwing listener
      consoleSink: () => {},
    });
    const good: string[] = [];
    session.on("text_delta", () => {
      throw new Error("boom");
    });
    session.on("text_delta", (e) => good.push(e.delta));
    const summary = await session.run("hi");
    expect(summary.reason).toBe("done"); // throwing listener did not break the run
    expect(good).toEqual(["a", "b"]); // the other listener still got every delta
    fake.teardown();
  });

  it("brackets a turn with message_start before deltas and message_end after", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "hi" }], textDeltas: ["h", "i"] },
    ]);
    const session = new AgentSession({ model: fake, tools: [] });
    const seq: string[] = [];
    session.on("message_start", () => seq.push("start"));
    session.on("text_delta", () => seq.push("delta"));
    session.on("message_end", () => seq.push("end"));
    await session.run("hi");
    expect(seq).toEqual(["start", "delta", "delta", "end"]);
    fake.teardown();
  });

  it("keeps message_start/message_end paired even when the LLM call throws (no dangling start)", async () => {
    const fake = createFakeModel([{ content: [], streamThrows: new Error("boom") }]);
    const session = new AgentSession({ model: fake, tools: [], consoleSink: () => {} });
    const seq: string[] = [];
    session.on("message_start", () => seq.push("start"));
    session.on("message_end", (e) => seq.push(e.message ? "end+msg" : "end"));
    const summary = await session.run("hi");
    expect(summary.reason).toBe("error");
    expect(seq).toEqual(["start", "end"]); // paired; message_end carries NO message on failure
    fake.teardown();
  });

  it("on a runtime LLM error (error EVENT, not a sync throw) message_end still carries the error message", async () => {
    // Real providers surface runtime errors as an `error` stream event → result() RESOLVES to a
    // stopReason="error" message (does NOT reject) → success path → message_end carries that message.
    // Downstream must judge failure by message.stopReason, not by message presence.
    const fake = createFakeModel([{ content: [], throwError: new Error("api 500") }]);
    const session = new AgentSession({ model: fake, tools: [], consoleSink: () => {} });
    let captured: { stopReason?: string } | undefined;
    session.on("message_end", (e) => (captured = e.message as { stopReason?: string } | undefined));
    await session.run("hi");
    expect(captured).toBeDefined(); // message_end DID carry a message...
    expect(captured!.stopReason).toBe("error"); // ...and its stopReason marks the failure
    fake.teardown();
  });

  it("message_end carries the final assistant message", async () => {
    const fake = createFakeModel([{ content: [{ type: "text", text: "final" }], textDeltas: ["fin", "al"] }]);
    const session = new AgentSession({ model: fake, tools: [] });
    let captured: unknown;
    session.on("message_end", (e) => (captured = e.message));
    await session.run("hi");
    expect(captured).toBe(session.messages.at(-1)); // same object that landed in history
    fake.teardown();
  });

  it("transparently forwards contentIndex so deltas map to the right content block", async () => {
    const fake = createFakeModel([
      {
        content: [{ type: "text", text: "t" }, { type: "toolCall", name: "noop", arguments: {} }],
        textDeltas: ["x"],
        toolcallDeltas: ["y"],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({ model: fake, tools: [noopTool] });
    const textCI: number[] = [];
    const tcCI: number[] = [];
    session.on("text_delta", (e) => textCI.push(e.contentIndex));
    session.on("toolcall_delta", (e) => tcCI.push(e.contentIndex));
    await session.run("hi");
    expect(textCI).toEqual([0]); // text block is content[0]
    expect(tcCI).toEqual([1]); // toolCall block is content[1]
    fake.teardown();
  });

  it("brackets each turn: message_start/message_end fire once per turn across a multi-turn run", async () => {
    const fake = createFakeModel([
      { content: [{ type: "toolCall", name: "noop", arguments: {} }] },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({ model: fake, tools: [noopTool] });
    let starts = 0;
    let ends = 0;
    session.on("message_start", () => starts++);
    session.on("message_end", () => ends++);
    await session.run("hi");
    expect(starts).toBe(2); // one per turn
    expect(ends).toBe(2);
    fake.teardown();
  });

  it("still brackets a turn with no deltas (start+end fire, zero deltas)", async () => {
    const fake = createFakeModel([{ content: [{ type: "text", text: "hi" }] }]); // no *Deltas
    const session = new AgentSession({ model: fake, tools: [] });
    let starts = 0;
    let ends = 0;
    let deltas = 0;
    session.on("message_start", () => starts++);
    session.on("message_end", () => ends++);
    session.on("text_delta", () => deltas++);
    await session.run("hi");
    expect([starts, ends, deltas]).toEqual([1, 1, 0]);
    fake.teardown();
  });

  it("dedupes a listener registered twice and is idempotent on double-unsubscribe", async () => {
    const fake = createFakeModel([{ content: [{ type: "text", text: "x" }], textDeltas: ["a", "b"] }]);
    const session = new AgentSession({ model: fake, tools: [] });
    let count = 0;
    const cb = () => count++;
    session.on("text_delta", cb);
    const off = session.on("text_delta", cb); // same ref → Set dedupes to one entry
    await session.run("hi");
    expect(count).toBe(2); // 2 deltas × 1 entry, not 4
    expect(() => {
      off();
      off(); // double unsubscribe must not throw
    }).not.toThrow();
    fake.teardown();
  });

  it("a listener registered mid-emit fires from the NEXT event, not the current one", async () => {
    const fake = createFakeModel([{ content: [{ type: "text", text: "x" }], textDeltas: ["a", "b"] }]);
    const session = new AgentSession({ model: fake, tools: [] });
    const late: string[] = [];
    let added = false;
    session.on("text_delta", () => {
      if (!added) {
        added = true;
        session.on("text_delta", (e) => late.push(e.delta));
      }
    });
    await session.run("hi");
    expect(late).toEqual(["b"]); // snapshot: the late listener missed "a", saw "b"
    fake.teardown();
  });

  it("isolates throwing listeners registered BEFORE a good one and logs via consoleSink", async () => {
    const fake = createFakeModel([{ content: [{ type: "text", text: "x" }], textDeltas: ["a", "b"] }]);
    const logs: string[] = [];
    const session = new AgentSession({
      model: fake,
      tools: [],
      consoleSink: (msg) => logs.push(msg),
    });
    session.on("text_delta", () => {
      throw new Error("one");
    });
    session.on("text_delta", () => {
      throw new Error("two");
    });
    const good: string[] = [];
    session.on("text_delta", (e) => good.push(e.delta));
    const summary = await session.run("hi");
    expect(summary.reason).toBe("done");
    expect(good).toEqual(["a", "b"]); // good listener after two throwers still got everything
    expect(logs.some((m) => m.includes("[event-bus]"))).toBe(true); // throwers were logged
    fake.teardown();
  });

  it("emits message_update at a content-block boundary carrying the assembled message", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "hi" }], textDeltas: ["h", "i"] },
    ]);
    const session = new AgentSession({ model: fake, tools: [] });
    const seq: string[] = [];
    let snapshot: unknown;
    session.on("message_start", () => seq.push("start"));
    session.on("text_delta", () => seq.push("delta"));
    session.on("message_update", (e) => {
      seq.push("update");
      snapshot = e.message;
    });
    session.on("message_end", () => seq.push("end"));
    await session.run("hi");
    // one snapshot, fired at text_end — after the deltas, before message_end
    expect(seq).toEqual(["start", "delta", "delta", "update", "end"]);
    // the snapshot is the assembled assistant message (same object that lands in history)
    expect(snapshot).toBe(session.messages.at(-1));
    fake.teardown();
  });

  it("emits one message_update per content block (thinking + text => two snapshots)", async () => {
    const fake = createFakeModel([
      {
        content: [{ type: "text", text: "answer" }],
        thinkingDeltas: ["mull"],
        textDeltas: ["ans", "wer"],
      },
    ]);
    const session = new AgentSession({ model: fake, tools: [] });
    let updates = 0;
    session.on("message_update", () => updates++);
    await session.run("hi");
    expect(updates).toBe(2); // thinking_end + text_end
    fake.teardown();
  });
});

/* ──────────────── LiveEvent 契约：穷尽 switch + 负向/边界行为 ──────────────── */

describe("LiveEvent · 契约硬化", () => {
  // 编译期穷尽 switch：镜像 phase3-capabilities.test.ts 里对 SessionEvent 的 smoke。
  // 将来给 LiveEvent 加 arm 而不更新这里，`const _: never = e` 会让 tsc 报错。
  it("compile-time exhaustive switch (smoke) —— 也真跑一遍每个 arm", () => {
    const handle = (e: LiveEvent): string => {
      switch (e.type) {
        case "message_start":
          return "ms";
        case "text_delta":
          return "td";
        case "thinking_delta":
          return "kd";
        case "toolcall_delta":
          return "cd";
        case "message_update":
          return "mu";
        case "message_end":
          return "me";
        default: {
          const _: never = e;
          void _;
          return "?";
        }
      }
    };

    // 不只编译，喂每个 arm 真跑，确保 handle 是 total 的、且各分支可达。
    const msg = { role: "assistant", content: [] } as unknown as AssistantMessage;
    const all: LiveEvent[] = [
      { type: "message_start" },
      { type: "text_delta", contentIndex: 0, delta: "x" },
      { type: "thinking_delta", contentIndex: 0, delta: "x" },
      { type: "toolcall_delta", contentIndex: 0, delta: "x" },
      { type: "message_update", message: msg },
      { type: "message_end", message: msg },
    ];
    expect(all.map(handle)).toEqual(["ms", "td", "kd", "cd", "mu", "me"]);
  });

  // 负向：message_update 绝不在同一块的 *_delta 之间穿插；它只在块边界（*_end）发一次，
  // 即每块的所有 delta 都排在该块那条 update 之前。
  it("never fires message_update interleaved between deltas of the same block (only at *_end)", async () => {
    const fake = createFakeModel([
      {
        content: [{ type: "text", text: "answer" }],
        thinkingDeltas: ["mu", "ll"],
        textDeltas: ["ans", "wer"],
      },
    ]);
    const session = new AgentSession({ model: fake, tools: [] });
    const seq: string[] = [];
    session.on("thinking_delta", () => seq.push("kd"));
    session.on("text_delta", () => seq.push("td"));
    session.on("message_update", () => seq.push("mu"));
    await session.run("hi");

    // thinking 块：两条 kd 后才有一条 mu；text 块同理。绝无 kd→mu→kd 或 td→mu→td 穿插。
    expect(seq).toEqual(["kd", "kd", "mu", "td", "td", "mu"]);
    // 显式断言：任意 mu 之前不会再出现「与它同块、本该排在它前面」的 delta 被它隔开——
    // 即每条 mu 都紧跟在其块全部 delta 之后。
    const firstMu = seq.indexOf("mu");
    expect(seq.slice(0, firstMu).every((t) => t === "kd")).toBe(true); // 第一块（thinking）的 delta 全在第一条 mu 之前
    fake.teardown();
  });

  // 边界：仅含 toolCall 的回合（无 text/thinking）。message_update 在 toolcall_end 发一次。
  it("toolcall-only turn: message_update fires once for the toolcall block, between start and end", async () => {
    const fake = createFakeModel([
      {
        content: [{ type: "toolCall", name: "noop", arguments: { a: 1 } }],
        toolcallDeltas: ['{"a":', "1}"],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({ model: fake, tools: [noopTool] });
    const seq: string[] = [];
    let updates = 0;
    let snapshot: AssistantMessage | undefined;
    session.on("message_start", () => seq.push("start"));
    session.on("toolcall_delta", () => seq.push("cd"));
    session.on("message_update", (e) => {
      seq.push("update");
      updates++;
      snapshot = e.message;
    });
    session.on("message_end", () => seq.push("end"));
    await session.run("hi");

    // 第一回合（toolcall-only）的子序列：start → cd* → update（toolcall_end）→ end。
    // 取到第一个 end 为止即第一回合。
    const firstTurn = seq.slice(0, seq.indexOf("end") + 1);
    expect(firstTurn).toEqual(["start", "cd", "cd", "update", "end"]);
    expect(updates).toBe(1); // 整个回合只为 toolcall 块发了一次 update
    // 快照里确有 toolCall 块（即 update 携带的是这条 toolcall-only 消息的 partial）。
    expect(snapshot?.content.some((b) => b.type === "toolCall")).toBe(true);
    fake.teardown();
  });
});
