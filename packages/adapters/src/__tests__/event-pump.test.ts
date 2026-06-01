import { describe, it, expect } from "vitest";
import { AgentSession, Type, type SessionEvent, type HarnessTool } from "@harness-pi/core";
import { createFakeModel } from "@harness-pi/core/testing";
import { EventPump, type TransportEnvelope, type TransportSink } from "../event-pump.js";

function makeSink() {
  const sent: TransportEnvelope[] = [];
  return { sent, send: (e: TransportEnvelope) => void sent.push(e) };
}

describe("EventPump", () => {
  it("forwards live delta events with well-formed envelopes (sessionId/track/tag/monotonic seq)", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "hello" }], textDeltas: ["he", "llo"], stopReason: "stop" },
    ]);
    const sink = makeSink();
    const session = new AgentSession({ model: fake, tools: [], sessionId: "S1" });
    const pump = new EventPump(session, { sink, tag: "q1" });

    const detach = pump.attachLive();
    await session.run("hi");
    detach();

    const types = sink.sent.map((e) => e.event.type);
    expect(types).toContain("message_start");
    expect(types.filter((t) => t === "text_delta").length).toBe(2);
    expect(types).toContain("message_end");
    expect(sink.sent.every((e) => e.track === "live")).toBe(true);
    expect(sink.sent.every((e) => e.sessionId === "S1")).toBe(true);
    expect(sink.sent.every((e) => e.tag === "q1")).toBe(true);
    // seq 单调、从 0 起、无洞。
    expect(sink.sent.map((e) => e.seq)).toEqual(sink.sent.map((_, i) => i));
    // payload 透传保真：envelope.event 整体原样（不止 .type），逐字段深等。
    expect(sink.sent.filter((e) => e.event.type === "text_delta").map((e) => e.event)).toEqual([
      { type: "text_delta", contentIndex: 0, delta: "he" },
      { type: "text_delta", contentIndex: 0, delta: "llo" },
    ]);
    fake.teardown();
  });

  it("respects the liveTypes filter (forwards only the requested types)", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "hi" }], textDeltas: ["a", "b"], stopReason: "stop" },
    ]);
    const sink = makeSink();
    const session = new AgentSession({ model: fake, tools: [] });
    const pump = new EventPump(session, { sink, liveTypes: ["text_delta"] });

    const detach = pump.attachLive();
    await session.run("hi");
    detach();

    expect(sink.sent.length).toBe(2); // 只有 2 条 text_delta
    expect(sink.sent.every((e) => e.event.type === "text_delta")).toBe(true);
    fake.teardown();
  });

  it("detach() stops forwarding", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "hi" }], textDeltas: ["a"], stopReason: "stop" },
    ]);
    const sink = makeSink();
    const session = new AgentSession({ model: fake, tools: [] });
    const pump = new EventPump(session, { sink });

    const detach = pump.attachLive();
    detach(); // 立刻退订
    await session.run("hi");

    expect(sink.sent).toHaveLength(0);
    fake.teardown();
  });

  it("omits tag when not configured", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "hi" }], textDeltas: ["a"], stopReason: "stop" },
    ]);
    const sink = makeSink();
    const session = new AgentSession({ model: fake, tools: [] });
    const pump = new EventPump(session, { sink });

    const detach = pump.attachLive();
    await session.run("hi");
    detach();

    expect(sink.sent.length).toBeGreaterThan(0);
    expect(sink.sent.every((e) => !("tag" in e))).toBe(true);
    fake.teardown();
  });

  it("pumpRecorded forwards recorded lifecycle events AND re-yields them (tee)", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ]);
    const sink = makeSink();
    const session = new AgentSession({ model: fake, tools: [], sessionId: "S2" });
    const pump = new EventPump(session, { sink });

    const stream = session.runStreaming("go");
    const seen: SessionEvent[] = [];
    for await (const ev of pump.pumpRecorded(stream)) seen.push(ev);
    await stream.finalSummary;

    // re-yield：调用方仍拿到事件。
    expect(seen.map((e) => e.type)).toContain("session-start");
    expect(seen.map((e) => e.type)).toContain("session-end");
    // sink 收到同样的事件，全为 recorded 轨。
    expect(sink.sent.every((e) => e.track === "recorded")).toBe(true);
    expect(sink.sent.every((e) => e.sessionId === "S2")).toBe(true);
    expect(sink.sent.map((e) => e.event.type)).toEqual(seen.map((e) => e.type));
    fake.teardown();
  });

  it("forwardRecorded sends a single recorded envelope", () => {
    const fake = createFakeModel([]);
    const sink = makeSink();
    const session = new AgentSession({ model: fake, tools: [], sessionId: "S3" });
    const pump = new EventPump(session, { sink, tag: "t" });

    pump.forwardRecorded({ type: "turn-start", turnIdx: 0 });
    expect(sink.sent).toHaveLength(1);
    expect(sink.sent[0]).toMatchObject({
      sessionId: "S3",
      tag: "t",
      track: "recorded",
      seq: 0,
      event: { type: "turn-start", turnIdx: 0 },
    });
    fake.teardown();
  });

  it("seq is monotonic across both tracks within one pump", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "hi" }], textDeltas: ["a"], stopReason: "stop" },
    ]);
    const sink = makeSink();
    const session = new AgentSession({ model: fake, tools: [] });
    const pump = new EventPump(session, { sink });

    pump.forwardRecorded({ type: "turn-start", turnIdx: 0 }); // seq 0 (recorded)
    const detach = pump.attachLive();
    await session.run("hi"); // live events seq 1,2,...
    detach();
    pump.forwardRecorded({ type: "turn-end", turnIdx: 0, toolResultsCount: 0, stopReason: "stop" });

    const seqs = sink.sent.map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i)); // 全局单调无洞
    expect(sink.sent[0]!.track).toBe("recorded");
    expect(sink.sent.at(-1)!.track).toBe("recorded");
    fake.teardown();
  });

  it("isolates a sink.send failure on the live track (run completes, other events still forwarded, onError fires)", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "hi" }], textDeltas: ["a", "b"], stopReason: "stop" },
    ]);
    const got: TransportEnvelope[] = [];
    const errs: unknown[] = [];
    const sink: TransportSink = {
      send(e) {
        if (e.event.type === "text_delta") throw new Error("ws closed");
        got.push(e);
      },
    };
    const session = new AgentSession({ model: fake, tools: [] });
    const pump = new EventPump(session, { sink, onError: (err) => void errs.push(err) });

    const detach = pump.attachLive();
    const summary = await session.run("hi"); // sink 抛错不应让 run 抛
    detach();

    expect(summary.reason).toBe("done");
    expect(errs).toHaveLength(2); // 2 条 text_delta send 失败 → onError ×2
    // 其余事件照常转发（失败被隔离，不中断后续）。
    expect(got.some((e) => e.event.type === "message_start")).toBe(true);
    expect(got.some((e) => e.event.type === "message_end")).toBe(true);
    fake.teardown();
  });

  it("isolates a sink.send failure on the recorded track (pumpRecorded keeps yielding, caller's for-await unbroken)", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ]);
    const errs: unknown[] = [];
    const sink: TransportSink = {
      send(e) {
        if (e.event.type === "turn-start") throw new Error("ws closed");
      },
    };
    const session = new AgentSession({ model: fake, tools: [] });
    const pump = new EventPump(session, { sink, onError: (err) => void errs.push(err) });

    const stream = session.runStreaming("go");
    const seen: SessionEvent[] = [];
    for await (const ev of pump.pumpRecorded(stream)) seen.push(ev); // sink 抛错不应炸调用方循环
    await stream.finalSummary;

    expect(seen.map((e) => e.type)).toContain("session-end"); // re-yield 未被打断
    expect(errs.length).toBeGreaterThanOrEqual(1); // turn-start send 失败 → onError
    fake.teardown();
  });

  it("forwards thinking/toolcall deltas with payload fidelity, across multiple turns", async () => {
    const noop: HarnessTool = {
      name: "noop",
      description: "noop",
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text", text: "r" }] };
      },
    };
    const fake = createFakeModel([
      // turn 0：含 toolCall（→续 turn）+ thinking/toolcall delta
      { content: [{ type: "toolCall", name: "noop", arguments: {} }], thinkingDeltas: ["pondering"], toolcallDeltas: ["{}"] },
      // turn 1：收尾
      { content: [{ type: "text", text: "done" }], stopReason: "stop" },
    ]);
    const sink = makeSink();
    const session = new AgentSession({ model: fake, tools: [noop] });
    const pump = new EventPump(session, { sink });

    const detach = pump.attachLive();
    await session.run("go");
    detach();

    const thinking = sink.sent.find((e) => e.event.type === "thinking_delta");
    expect(thinking?.event).toEqual({ type: "thinking_delta", contentIndex: 0, delta: "pondering" });
    const toolcall = sink.sent.find((e) => e.event.type === "toolcall_delta");
    expect(toolcall?.event).toEqual({ type: "toolcall_delta", contentIndex: 0, delta: "{}" });

    // 多 turn：message_start / message_end 每 turn 各一次（共 2 turn）。
    const types = sink.sent.map((e) => e.event.type);
    expect(types.filter((t) => t === "message_start").length).toBe(2);
    expect(types.filter((t) => t === "message_end").length).toBe(2);
    // seq 跨 turn 连续无洞。
    expect(sink.sent.map((e) => e.seq)).toEqual(sink.sent.map((_, i) => i));
    fake.teardown();
  });

  it("a dropped send leaves a seq gap the consumer can detect", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "hi" }], textDeltas: ["a", "b"], stopReason: "stop" },
    ]);
    // 真实 transport：抛错 = 没投递。只把成功投递的 seq 收进 delivered。
    const delivered: number[] = [];
    const sink: TransportSink = {
      send(e) {
        if (e.event.type === "text_delta") throw new Error("drop");
        delivered.push(e.seq);
      },
    };
    const session = new AgentSession({ model: fake, tools: [] });
    const pump = new EventPump(session, { sink });
    const detach = pump.attachLive();
    await session.run("hi");
    detach();

    // message_start(seq0), text_delta(1,丢), text_delta(2,丢), message_end(3)
    // → 投递到的是 [0,3]，seq 1/2 缺失 = 消费端可见的跳号（丢失检测）。
    expect(delivered).toEqual([0, 3]);
    fake.teardown();
  });

  it("a sink failure without onError is silently dropped (run still completes)", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "hi" }], textDeltas: ["a"], stopReason: "stop" },
    ]);
    const sink: TransportSink = {
      send(e) {
        if (e.event.type === "text_delta") throw new Error("drop");
      },
    };
    const session = new AgentSession({ model: fake, tools: [] });
    const pump = new EventPump(session, { sink }); // 不传 onError
    const detach = pump.attachLive();
    const summary = await session.run("hi"); // 静默丢弃、不抛
    detach();
    expect(summary.reason).toBe("done");
    fake.teardown();
  });

  it("liveTypes: [] forwards zero live events (explicit empty subscription)", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "hi" }], textDeltas: ["a"], stopReason: "stop" },
    ]);
    const sink = makeSink();
    const session = new AgentSession({ model: fake, tools: [] });
    const pump = new EventPump(session, { sink, liveTypes: [] });

    const detach = pump.attachLive();
    await session.run("hi");
    detach();

    expect(sink.sent).toHaveLength(0);
    fake.teardown();
  });
});
