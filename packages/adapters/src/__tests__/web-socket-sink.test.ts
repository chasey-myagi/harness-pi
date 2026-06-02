import { describe, it, expect } from "vitest";
import { AgentSession } from "@harness-pi/core";
import { createFakeModel } from "@harness-pi/core/testing";
import { EventPump, type TransportEnvelope } from "../event-pump.js";
import { WebSocketSink, type WebSocketLike } from "../web-socket-sink.js";

// WebSocket.readyState 标准取值：0 CONNECTING / 1 OPEN / 2 CLOSING / 3 CLOSED。
const OPEN = 1;
const CLOSED = 3;

class FakeSocket implements WebSocketLike {
  readyState = OPEN;
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
}

function env(seq: number): TransportEnvelope {
  return {
    sessionId: "S1",
    track: "recorded",
    seq,
    event: { type: "turn-start", turnIdx: 0 },
  };
}

describe("WebSocketSink", () => {
  it("forwards a JSON-serialized envelope when the socket is OPEN (default serialize)", () => {
    const sock = new FakeSocket();
    const sink = new WebSocketSink(sock);
    const e = env(0);
    sink.send(e);
    expect(sock.sent).toHaveLength(1);
    expect(JSON.parse(sock.sent[0]!)).toEqual(e); // 默认 JSON.stringify，可往返
  });

  it("uses an injected serialize() (protocol mapping into a custom wire string)", () => {
    const sock = new FakeSocket();
    const sink = new WebSocketSink(sock, {
      serialize: (env) => `${env.track}#${env.seq}`, // 映射成自定义前端协议
    });
    sink.send(env(7));
    expect(sock.sent).toEqual(["recorded#7"]);
  });

  it("does NOT call socket.send when the socket is not OPEN; reports the drop via onDrop", () => {
    const dropped: TransportEnvelope[] = [];
    for (const state of [0, 2, 3]) {
      // CONNECTING / CLOSING / CLOSED
      const sock = new FakeSocket();
      sock.readyState = state;
      const sink = new WebSocketSink(sock, { onDrop: (e) => dropped.push(e) });
      sink.send(env(state));
      expect(sock.sent).toHaveLength(0); // 没在非 OPEN 上 send（浏览器 WebSocket 会抛 InvalidStateError）
    }
    expect(dropped.map((e) => e.seq)).toEqual([0, 2, 3]); // 三种非 OPEN 状态都丢且都报了
  });

  it("drops silently (no throw) when the socket is closed and no onDrop is given", () => {
    const sock = new FakeSocket();
    sock.readyState = CLOSED;
    const sink = new WebSocketSink(sock);
    expect(() => sink.send(env(0))).not.toThrow();
    expect(sock.sent).toHaveLength(0);
  });

  it("reads readyState live on each send (open→forward, closed→drop, reopen→forward)", () => {
    const sock = new FakeSocket();
    const dropped: number[] = [];
    const sink = new WebSocketSink(sock, { onDrop: (e) => dropped.push(e.seq) });

    sink.send(env(0)); // OPEN
    sock.readyState = CLOSED;
    sink.send(env(1)); // dropped
    sock.readyState = OPEN;
    sink.send(env(2)); // OPEN again

    expect(sock.sent.map((s) => JSON.parse(s).seq)).toEqual([0, 2]);
    expect(dropped).toEqual([1]);
  });

  it("lets a socket.send throw propagate (so EventPump's onError can isolate it)", () => {
    const sock: WebSocketLike = {
      readyState: OPEN,
      send() {
        throw new Error("ws closed mid-send");
      },
    };
    const sink = new WebSocketSink(sock);
    expect(() => sink.send(env(0))).toThrow("ws closed mid-send");
  });

  it("lets a serialize throw propagate (e.g. circular JSON) rather than swallowing it", () => {
    const sock = new FakeSocket();
    const sink = new WebSocketSink(sock, {
      serialize: () => {
        throw new Error("circular");
      },
    });
    expect(() => sink.send(env(0))).toThrow("circular");
    expect(sock.sent).toHaveLength(0);
  });

  it("implements TransportSink: plugs into EventPump and carries live envelopes end-to-end", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "hello" }], textDeltas: ["he", "llo"], stopReason: "stop" },
    ]);
    const sock = new FakeSocket();
    const sink = new WebSocketSink(sock);
    const session = new AgentSession({ model: fake, tools: [], sessionId: "S1" });
    const pump = new EventPump(session, { sink, tag: "q1" });

    const detach = pump.attachLive();
    await session.run("hi");
    detach();

    expect(sock.sent.length).toBeGreaterThan(0);
    const parsed = sock.sent.map((s) => JSON.parse(s) as TransportEnvelope);
    // 每条都是合法 envelope：sessionId/track/tag/单调 seq 透传，event payload 保真。
    expect(parsed.every((e) => e.sessionId === "S1" && e.track === "live" && e.tag === "q1")).toBe(true);
    expect(parsed.map((e) => e.seq)).toEqual(parsed.map((_, i) => i));
    expect(parsed.filter((e) => e.event.type === "text_delta").map((e) => (e.event as { delta: string }).delta)).toEqual(["he", "llo"]);
    fake.teardown();
  });

  it("end-to-end: a socket that closes mid-stream drops cleanly via onDrop; EventPump survives, seq gap stays detectable", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "hello world" }], textDeltas: ["a", "b", "c", "d"], stopReason: "stop" },
    ]);
    const sock = new FakeSocket();
    const dropped: number[] = [];
    // 收到第 2 条后把 socket 标记为关闭——之后的 send 应被 WebSocketSink 丢弃（不抛）。
    const realSend = sock.send.bind(sock);
    sock.send = (data: string) => {
      realSend(data);
      if (sock.sent.length === 2) sock.readyState = CLOSED;
    };
    const sink = new WebSocketSink(sock, { onDrop: (e) => dropped.push(e.seq) });
    const session = new AgentSession({ model: fake, tools: [], sessionId: "S1" });
    const pump = new EventPump(session, { sink });

    const detach = pump.attachLive();
    await expect(session.run("hi")).resolves.toBeDefined(); // pump 不被 sink 行为搞死
    detach();

    // 前 2 条送达，其余被丢；丢的 seq + 送达的 seq 合起来仍是连续无洞（消费端凭 seq 跳号可检测丢失）。
    const sentSeqs = sock.sent.map((s) => JSON.parse(s).seq as number);
    expect(sentSeqs).toHaveLength(2);
    expect(dropped.length).toBeGreaterThan(0);
    const all = [...sentSeqs, ...dropped].sort((a, b) => a - b);
    expect(all).toEqual(all.map((_, i) => i)); // 0..n-1 连续，无 envelope 凭空消失
    fake.teardown();
  });
});
