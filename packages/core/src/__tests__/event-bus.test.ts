import { describe, it, expect } from "vitest";
import { AgentSession } from "../session.js";
import type { LiveEvent } from "../session.js";
import { createFakeModel } from "../testing.js";
import type { HarnessTool } from "../types.js";
import type { AssistantMessage } from "@earendil-works/pi-ai";

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
    // stopReason="error" message (does NOT reject). The kernel emits message_end with that message
    // BEFORE escalating the turn to reason="error" (#53), so message_end still carries it.
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
    let snapshot: AssistantMessage | undefined;
    let final: AssistantMessage | undefined;
    session.on("message_start", () => seq.push("start"));
    session.on("text_delta", () => seq.push("delta"));
    session.on("message_update", (e) => {
      seq.push("update");
      snapshot = e.message;
    });
    session.on("message_end", (e) => {
      seq.push("end");
      final = e.message as AssistantMessage;
    });
    await session.run("hi");
    // one snapshot, fired at text_end — after the deltas, before message_end
    expect(seq).toEqual(["start", "delta", "delta", "update", "end"]);
    // 契约：message_update 携带的是「中间态、逐块 partial 快照」——一个**独立对象**，**不是**落进 history 的
    // 权威终态对象（即便单块回合下二者内容恰好相等，对象身份也不同）。要终态对象/终态判定请用 message_end。
    expect(final).toBe(session.messages.at(-1)); // message_end 才是落 history 的权威终态对象
    expect(snapshot).not.toBe(final); // update 是独立 partial 快照，绝非终态对象（不能 ===）
    expect(snapshot!.content).toEqual(final!.content); // 单块回合：该块收尾后 partial 内容 == 终态内容
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

  // 头号契约（test-review #2/#3）：一帧 message_update 的 content 是「截至此刻已收尾块」的 partial，
  // 早期帧**严格少于**终态——把早期 update 当终态会丢块。这里用 [text, toolCall] 两块回合直接证伪
  // 「update == 终态」：text_end 那帧只有 1 块（text），而 message_end 终态有 2 块（text+toolCall）。
  it("an early message_update snapshot has FEWER blocks than the final (update ⊊ message_end)", async () => {
    const fake = createFakeModel([
      {
        content: [
          { type: "text", text: "ans" },
          { type: "toolCall", name: "noop", arguments: { a: 1 } },
        ],
        textDeltas: ["an", "s"],
        toolcallDeltas: ['{"a":', "1}"],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({ model: fake, tools: [noopTool] });
    const frames: AssistantMessage[] = [];
    let final: AssistantMessage | undefined;
    session.on("message_update", (e) => frames.push(e.message as AssistantMessage));
    session.on("message_end", (e) => {
      if (e.message && !final) final = e.message as AssistantMessage; // 抓第一回合终态
    });
    await session.run("hi");

    // 第一回合两块 → 两帧 update：第 1 帧（text_end）只含 text，第 2 帧（toolcall_end）含 text+toolCall。
    const first = frames[0]!;
    const second = frames[1]!;
    expect(first.content.map((b) => b.type)).toEqual(["text"]); // 早期帧：1 块
    expect(second.content.map((b) => b.type)).toEqual(["text", "toolCall"]); // 后续帧：2 块
    // 终态（message_end）有 2 块；早期 update 帧块数 < 终态 → 拿早期帧当终态会丢 toolCall 块。
    expect(final!.content.length).toBe(2);
    expect(first.content.length).toBeLessThan(final!.content.length);
    // 且每帧 update 都是独立 partial 对象，不是落 history 的终态对象。
    expect(first).not.toBe(final);
    expect(second).not.toBe(final);
    fake.teardown();
  });

  // 状态组合（test-review #3）：跨块快照内容**单调增长**——thinking 帧只含 thinking，text 帧含 thinking+text。
  // 锁住「partial 逐块累积」而非「每帧都是同一份终态」。
  it("message_update snapshots grow monotonically across blocks (thinking → thinking+text)", async () => {
    const fake = createFakeModel([
      {
        content: [{ type: "text", text: "answer" }],
        thinkingDeltas: ["mull"],
        textDeltas: ["ans", "wer"],
      },
    ]);
    const session = new AgentSession({ model: fake, tools: [] });
    const frames: AssistantMessage[] = [];
    session.on("message_update", (e) => frames.push(e.message as AssistantMessage));
    await session.run("hi");

    expect(frames).toHaveLength(2);
    expect(frames[0]!.content.map((b) => b.type)).toEqual(["thinking"]); // 第 1 帧（thinking_end）
    expect(frames[1]!.content.map((b) => b.type)).toEqual(["thinking", "text"]); // 第 2 帧（text_end）
    // 第 1 帧是独立快照，不会被后续 push 回填成 2 块（证明每帧 content 是当时的拷贝、互不别名）。
    expect(frames[0]!.content).toHaveLength(1);
    expect(frames[0]).not.toBe(frames[1]);
    fake.teardown();
  });

  // 头号契约 mid-abort（test-review #1）：流被中途打断时，最后一帧 message_update 只含**已收尾块**、
  // 缺尚未流出的块；终态（含 stopReason:"aborted"）只能由 message_end 得知，绝不能拿最后一帧 update 当终态。
  it("on mid-stream abort, the last message_update lacks the unstreamed block; message_end carries the aborted final", async () => {
    const fake = createFakeModel([
      {
        // 脚本本想发 thinking + text 两块，但在 thinking 收尾后 abort：text 永不流出。
        content: [{ type: "text", text: "never streamed" }],
        thinkingDeltas: ["reason"],
        textDeltas: ["wont", "happen"],
        abortAfterBlock: "thinking",
      },
    ]);
    const session = new AgentSession({ model: fake, tools: [], consoleSink: () => {} });
    const frames: AssistantMessage[] = [];
    let final: AssistantMessage | undefined;
    session.on("message_update", (e) => frames.push(e.message as AssistantMessage));
    session.on("message_end", (e) => (final = e.message as AssistantMessage | undefined));
    await session.run("hi");

    // 只为已收尾的 thinking 块发了一帧 update；text 块从未收尾 → 内核绝不为它臆造 update。
    expect(frames).toHaveLength(1);
    expect(frames[0]!.content.map((b) => b.type)).toEqual(["thinking"]); // 最后一帧缺 text 块
    // 终态由 message_end 携带，且 stopReason 标记 aborted——这是「中途打断」的唯一权威信号，
    // message_update 不带 stopReason，拿它当终态既缺块也判不出 aborted。
    expect(final).toBeDefined();
    expect(final!.stopReason).toBe("aborted");
    fake.teardown();
  });

  // 隔离（test-review #4）：message_update 是块边界单独 emit 的代码路径，不能假设它和 delta 共享隔离行为。
  // 一个 message_update listener 抛错：loop 仍跑完、其他 message_update listener 仍收快照、错误经 consoleSink 记 [event-bus]。
  it("isolates a throwing message_update listener: loop completes, other update listeners still fire, error logged", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "hi" }], textDeltas: ["h", "i"] },
    ]);
    const logs: string[] = [];
    const session = new AgentSession({ model: fake, tools: [], consoleSink: (m) => logs.push(m) });
    const good: AssistantMessage[] = [];
    session.on("message_update", () => {
      throw new Error("boom in update");
    });
    session.on("message_update", (e) => good.push(e.message as AssistantMessage));
    const summary = await session.run("hi");
    expect(summary.reason).toBe("done"); // 抛错的 update listener 没拖垮 run
    expect(good).toHaveLength(1); // 另一个 update listener 仍拿到那帧快照
    expect(good[0]!.content.map((b) => b.type)).toEqual(["text"]);
    expect(logs.some((m) => m.includes("[event-bus]"))).toBe(true); // 抛错被记
    fake.teardown();
  });

  // 错误路径（test-review #5）：错误回合没有任何块收尾 → 不应有任何 message_update。
  // 覆盖两条 provider 失败路径：sync-throw（建流即抛）与 runtime error 事件（result resolve 出 error 终态）。
  it("emits no message_update on an error turn (no block ever completes) — both sync-throw and error-event paths", async () => {
    // 路径 A：stream() 同步抛。
    const fa = createFakeModel([{ content: [], streamThrows: new Error("boom") }]);
    const sa = new AgentSession({ model: fa, tools: [], consoleSink: () => {} });
    let ua = 0;
    sa.on("message_update", () => ua++);
    const ra = await sa.run("hi");
    expect(ra.reason).toBe("error");
    expect(ua).toBe(0); // 无块收尾 → 无 update
    fa.teardown();

    // 路径 B：runtime error 事件 → result() resolve 出 stopReason:"error" 终态（不 reject）。
    const fb = createFakeModel([{ content: [], throwError: new Error("api 500") }]);
    const sb = new AgentSession({ model: fb, tools: [], consoleSink: () => {} });
    let ub = 0;
    sb.on("message_update", () => ub++);
    await sb.run("hi");
    expect(ub).toBe(0); // 同样无块收尾 → 无 update
    fb.teardown();
  });

  // 多回合归属（test-review #6）：toolcall 回合 + text 回合，每回合各发一次 update，整轮共 2 次、不串块。
  it("attributes message_update per turn across a multi-turn run (one per turn, no cross-turn leakage)", async () => {
    const fake = createFakeModel([
      { content: [{ type: "toolCall", name: "noop", arguments: {} }], toolcallDeltas: ["{}"] },
      { content: [{ type: "text", text: "done" }], textDeltas: ["do", "ne"] },
    ]);
    const session = new AgentSession({ model: fake, tools: [noopTool] });
    const frames: AssistantMessage[] = [];
    session.on("message_update", (e) => frames.push(e.message as AssistantMessage));
    await session.run("hi");

    expect(frames).toHaveLength(2); // 整轮共两帧：每回合各一帧
    expect(frames[0]!.content.map((b) => b.type)).toEqual(["toolCall"]); // 第 1 回合：toolcall 块
    expect(frames[1]!.content.map((b) => b.type)).toEqual(["text"]); // 第 2 回合：text 块（不含上一回合的 toolCall）
    fake.teardown();
  });
});
