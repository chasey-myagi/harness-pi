/**
 * 端到端集成测试：证明 harness-pi 的零件**拼起来能跑通**一条完整链路——
 * pipeline()（多阶段）+ 每题一个 AgentSession + SessionStore 落盘 + AgentSession.resume() 续跑
 * + EventPump → WebSocketSink 推事件。纯 domain-free（toy「lookup」工具 + fake model）。
 *
 * 这是 docs/09 Phase 0/1 验收的**干跑预演**：在 bidding 付出迁移成本之前，先证明这些机制咬合。
 */

import { describe, it, expect } from "vitest";
import { MemorySessionStore } from "@harness-pi/core";
import { createFakeModel, type FakeModel } from "@harness-pi/core/testing";
import { WebSocketSink, type WebSocketLike, type TransportEnvelope } from "@harness-pi/adapters";
import { runBatch, resumeAndContinue, type BatchItem } from "../batch-pipeline.js";

class FakeSocket implements WebSocketLike {
  readyState = 1; // OPEN
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
}

// 每题脚本化：turn1 调 lookup（toolUse）→ turn2 出答案文本（带 live deltas）。
function answeringModel(id: string): FakeModel {
  return createFakeModel([
    { content: [{ type: "toolCall", name: "lookup", arguments: { key: id } }], stopReason: "toolUse" },
    {
      content: [{ type: "text", text: `answer for ${id}` }],
      textDeltas: ["answer ", `for ${id}`],
      stopReason: "stop",
    },
  ]);
}

function parsed(sock: FakeSocket): TransportEnvelope[] {
  return sock.sent.map((s) => JSON.parse(s) as TransportEnvelope);
}

describe("batch-pipeline reference example", () => {
  it("runs a batch through pipeline(): every item settles with a typed result, persisted + streamed", async () => {
    const items: BatchItem[] = [
      { id: "q1", prompt: "question one" },
      { id: "q2", prompt: "question two" },
      { id: "q3", prompt: "question three" },
    ];
    const store = new MemorySessionStore();
    const sock = new FakeSocket();
    const models = new Map(items.map((it) => [it.id, answeringModel(it.id)]));

    const outcomes = await runBatch({
      items,
      store,
      sink: new WebSocketSink(sock),
      makeModel: (it) => models.get(it.id)!,
      concurrency: 2,
    });

    // 1) MUST-SETTLE：与输入等长、按 index 有序、全部 ok（没有静默丢题）。
    expect(outcomes).toHaveLength(3);
    expect(outcomes.map((o) => o.index)).toEqual([0, 1, 2]);
    expect(outcomes.every((o) => o.status === "ok")).toBe(true);

    // 2) 终值是 pipeline 末阶段产出的结果记录（answer + reason + score）。
    const results = outcomes.map((o) => (o.status === "ok" ? o.value : null));
    expect(results.map((r) => r?.id)).toEqual(["q1", "q2", "q3"]);
    expect(results.every((r) => r!.reason === "done")).toBe(true);
    expect(results.every((r) => r!.answer.includes("answer for") && r!.score > 0)).toBe(true);

    // 3) 每题的 session 真落盘到 store（resume 的前提）。
    for (const it of items) {
      const path = await store.getPathToLeaf(it.id);
      expect(path.length).toBeGreaterThan(0);
    }

    // 4) 事件经 EventPump→WebSocketSink 推出：合法 envelope、按题 tag、live 轨、含 token/tool delta。
    const envs = parsed(sock);
    expect(envs.length).toBeGreaterThan(0);
    expect(new Set(envs.map((e) => e.tag))).toEqual(new Set(["q1", "q2", "q3"]));
    expect(envs.every((e) => e.track === "live")).toBe(true);
    expect(envs.some((e) => e.event.type === "text_delta")).toBe(true);
    expect(envs.some((e) => e.event.type === "message_start")).toBe(true); // 消息生命周期 live 事件也流出

    for (const m of models.values()) m.teardown();
  });

  it("resumes a persisted session from the store and continues with a follow-up (recorded track)", async () => {
    const store = new MemorySessionStore();
    const sock = new FakeSocket();
    const m1 = answeringModel("only");

    // 先跑一题，落盘。
    await runBatch({
      items: [{ id: "only", prompt: "first" }],
      store,
      sink: new WebSocketSink(sock),
      makeModel: () => m1,
    });
    const afterFirst = await store.getPathToLeaf("only");
    m1.teardown();

    // 「进程重启」：用一个全新 fake model，从 store resume 同一 session，再问个 follow-up。
    const m2 = createFakeModel([
      { content: [{ type: "text", text: "follow-up answer" }], stopReason: "stop" },
    ]);
    const rsock = new FakeSocket();
    const { summary, recordedCount } = await resumeAndContinue({
      store,
      sessionId: "only",
      makeModel: () => m2,
      followUp: "second",
      sink: new WebSocketSink(rsock),
    });

    expect(summary.reason).toBe("done");
    expect(recordedCount).toBeGreaterThan(0);
    // recorded 轨经 pumpRecorded 流出（不是 live）——钉死「续跑用的是 runStreaming + pumpRecorded」。
    const rEnvs = parsed(rsock);
    expect(rEnvs.length).toBeGreaterThan(0);
    expect(rEnvs.every((e) => e.track === "recorded")).toBe(true);

    // **resume 的核心契约**：续跑那次喂给 model 的 context 必须含历史前缀 "first"。这才证明 resume 真把
    // 前缀重建进 messages 并喂回了 model——仅靠「store 里还有 first」证明不了（append-only store 本就不丢
    // 历史，即使根本没 resume、只复用 sessionId 新建 session 也成立）。getCalls() 是 LLM 实际收到的 context。
    const fedToModel = JSON.stringify(m2.getCalls());
    expect(fedToModel).toContain("first"); // resume 重建的历史前缀确实进了 LLM context
    expect(fedToModel).toContain("second"); // 新 follow-up 也在

    // 且续跑只追加、不重发前缀：store 路径变长，新旧消息都在。
    const afterResume = await store.getPathToLeaf("only");
    expect(afterResume.length).toBeGreaterThan(afterFirst.length);
    const texts = afterResume
      .filter((e) => e.entry.kind === "message")
      .map((e) => (e.entry.kind === "message" ? e.entry.message.content : ""));
    expect(JSON.stringify(texts)).toContain("first");
    expect(JSON.stringify(texts)).toContain("second");
    m2.teardown();
  });

  it("isolates a failing item without dropping the batch (MUST-SETTLE under failure)", async () => {
    const items: BatchItem[] = [
      { id: "ok1", prompt: "fine" },
      { id: "bad", prompt: "boom" },
      { id: "ok2", prompt: "fine" },
    ];
    const store = new MemorySessionStore();
    const sock = new FakeSocket();
    const models = new Map([
      ["ok1", answeringModel("ok1")],
      ["ok2", answeringModel("ok2")],
    ]);

    const outcomes = await runBatch({
      items,
      store,
      sink: new WebSocketSink(sock),
      makeModel: (it) => {
        if (it.id === "bad") throw new Error("model unavailable"); // 该题答题阶段就炸
        return models.get(it.id)!;
      },
      concurrency: 3,
    });

    // 批次不崩、3 个 item 都有终态：两个 ok、一个 failed（归因到 stage 0），无静默丢失。
    expect(outcomes).toHaveLength(3);
    expect(outcomes.map((o) => o.status)).toEqual(["ok", "failed", "ok"]);
    const bad = outcomes[1]!;
    expect(bad.status).toBe("failed");
    if (bad.status === "failed") {
      expect((bad.error as Error).message).toBe("model unavailable");
      expect(bad.stage).toBe(0);
    }
    for (const m of models.values()) m.teardown();
  });
});
