/**
 * Per-work-item metrics 归账测试（docs/09 §4.4，#11）。
 * 验证 metrics({ workItemId }) 在每条事件打 workItemId 戳，以及 WorkItemAggregator 按 workItemId
 * 把 token / tool / error 归账。domain 中性——只认 workItemId。
 */

import { describe, it, expect } from "vitest";
import {
  AgentSession,
  Type,
  type HarnessTool,
} from "@harness-pi/core";
import { createFakeModel } from "@harness-pi/core/testing";
import {
  metrics,
  MemorySink,
  WorkItemAggregator,
  type MetricEvent,
} from "../index.js";

describe("metrics workItemId stamping", () => {
  it("stamps workItemId on every emitted event when given", async () => {
    const sink = new MemorySink();
    const fake = createFakeModel([
      { content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      hooks: [metrics({ sink, workItemId: "wi-42" })],
    });
    await session.run("hi");

    const events = sink.snapshot();
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.workItemId === "wi-42")).toBe(true);
    fake.teardown();
  });

  it("omits workItemId when not configured", async () => {
    const sink = new MemorySink();
    const fake = createFakeModel([
      { content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      hooks: [metrics({ sink })],
    });
    await session.run("hi");

    expect(sink.snapshot().every((e) => e.workItemId === undefined)).toBe(true);
    fake.teardown();
  });
});

describe("WorkItemAggregator", () => {
  function ev(kind: string, extra: Record<string, unknown>): MetricEvent {
    return { kind, ts: 0, ...extra };
  }

  it("rolls up llm / tool / error events per workItemId", () => {
    const agg = new WorkItemAggregator();
    agg.enqueue(ev("llm.called", { workItemId: "w1", tokensInput: 10, tokensOutput: 5, tokensCacheRead: 2, durationMs: 100 }));
    agg.enqueue(ev("tool.called", { workItemId: "w1", isError: false, durationMs: 30 }));
    agg.enqueue(ev("tool.called", { workItemId: "w1", isError: true, durationMs: 20 }));
    agg.enqueue(ev("error.observed", { workItemId: "w1" }));
    agg.enqueue(ev("llm.called", { workItemId: "w2", tokensInput: 3, tokensOutput: 1 }));

    expect(agg.rollup("w1")).toEqual({
      workItemId: "w1",
      llmCalls: 1,
      toolCalls: 2,
      toolErrors: 1,
      errors: 1,
      tokensInput: 10,
      tokensOutput: 5,
      tokensCacheRead: 2,
      llmDurationMs: 100,
      toolDurationMs: 50,
    });
    expect(agg.rollup("w2")?.tokensInput).toBe(3);
    expect(agg.rollup("unknown")).toBeUndefined();
    expect(agg.all().map((r) => r.workItemId).sort()).toEqual(["w1", "w2"]);
  });

  it("ignores events without a workItemId (and non-accounted kinds)", () => {
    const agg = new WorkItemAggregator();
    agg.enqueue(ev("llm.called", { tokensInput: 99 })); // 无 workItemId → 不计
    agg.enqueue(ev("session.started", { workItemId: "w1" })); // 不归账的 kind
    expect(agg.all()).toEqual([]);
  });

  it("tolerates malformed numeric payloads (non-numbers count as 0)", () => {
    const agg = new WorkItemAggregator();
    agg.enqueue(ev("llm.called", { workItemId: "w1", tokensInput: "oops", durationMs: null }));
    expect(agg.rollup("w1")).toMatchObject({ llmCalls: 1, tokensInput: 0, llmDurationMs: 0 });
  });

  it("treats an absent isError as not-an-error (public-sink contract: absent ≠ error)", () => {
    const agg = new WorkItemAggregator();
    agg.enqueue(ev("tool.called", { workItemId: "w1", durationMs: 10 })); // 无 isError 字段
    expect(agg.rollup("w1")).toMatchObject({ toolCalls: 1, toolErrors: 0 });
  });

  it("accumulates repeated error.observed for the same workItemId", () => {
    const agg = new WorkItemAggregator();
    agg.enqueue(ev("error.observed", { workItemId: "w1" }));
    agg.enqueue(ev("error.observed", { workItemId: "w1" }));
    expect(agg.rollup("w1")?.errors).toBe(2);
  });

  it("returns defensive copies — mutating a rollup does not corrupt internal state", () => {
    const agg = new WorkItemAggregator();
    agg.enqueue(ev("llm.called", { workItemId: "w1", tokensInput: 5 }));
    const r = agg.rollup("w1")!;
    r.llmCalls = 999;
    r.tokensInput = 999;
    expect(agg.rollup("w1")).toMatchObject({ llmCalls: 1, tokensInput: 5 });
    // all() 同样返回拷贝。
    agg.all()[0]!.llmCalls = 777;
    expect(agg.rollup("w1")?.llmCalls).toBe(1);
  });

  it("forwards every event to an inner sink (intact) while aggregating", () => {
    const inner = new MemorySink();
    const agg = new WorkItemAggregator({ forward: inner });
    const e1 = ev("llm.called", { workItemId: "w1", tokensInput: 1 });
    agg.enqueue(e1);
    agg.enqueue(ev("session.started", {})); // 无 workItemId 也照样透传
    expect(inner.snapshot()).toHaveLength(2);
    expect(inner.snapshot()[0]).toEqual(e1); // 透传保真：同 payload，不只是计数
    expect(agg.rollup("w1")?.llmCalls).toBe(1);
  });

  it("end-to-end: a real session's llm + tool activity rolls up under its workItemId", async () => {
    const echo: HarnessTool = {
      name: "echo",
      description: "echo",
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text", text: "r" }] };
      },
    };
    const fake = createFakeModel([
      { content: [{ type: "toolCall", name: "echo", arguments: {} }], usage: { input: 10, output: 5 } },
      { content: [{ type: "text", text: "done" }], stopReason: "stop", usage: { input: 2, output: 1 } },
    ]);
    const agg = new WorkItemAggregator();
    const session = new AgentSession({
      model: fake,
      tools: [echo],
      hooks: [metrics({ sink: agg, workItemId: "q-7" })],
    });
    await session.run("go");

    const r = agg.rollup("q-7");
    expect(r).toBeDefined();
    expect(r!.llmCalls).toBe(2); // 两个 turn 各一次 llm.called
    expect(r!.toolCalls).toBe(1); // 一次 echo 调用
    expect(r!.toolErrors).toBe(0);
    expect(r!.tokensInput).toBe(12); // 10 + 2
    expect(r!.tokensOutput).toBe(6); // 5 + 1
    fake.teardown();
  });
});
