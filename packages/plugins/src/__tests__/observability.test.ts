import { describe, expect, it, vi } from "vitest";
import {
  AgentSession,
  Type,
  type AssistantMessage,
  type HarnessTool,
} from "@harness-pi/core";
import { createFakeModel, createTestContext } from "@harness-pi/core/testing";
import {
  costTracker,
  getCostStats,
  toolStats,
  estimateParallelSavings,
  type CostStats,
  type ToolStats,
  type ToolSpan,
} from "../index.js";

function assistant(model: string, usage?: AssistantMessage["usage"]): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    api: "test-api",
    provider: "test-provider",
    model,
    usage:
      usage ??
      {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
    stopReason: "stop",
    timestamp: Date.now(),
  } as AssistantMessage;
}

describe("costTracker observability", () => {
  it("aggregates LLM duration totals and averages across models", async () => {
    const { ctx } = createTestContext();
    const hook = costTracker({
      costModel: (_model, usage) => usage.input / 100,
    });

    await hook.onSessionStart?.({ source: "run", initialPrompt: "go" }, ctx);
    await hook.onLlmEnd?.(
      {
        msg: assistant("model-a", {
          input: 100,
          output: 20,
          cacheRead: 10,
          cacheWrite: 0,
          totalTokens: 120,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        }),
        durationMs: 25,
      },
      ctx,
    );
    await hook.onLlmEnd?.(
      {
        msg: assistant("model-b", {
          input: 200,
          output: 40,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 240,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        }),
        durationMs: 75,
      },
      ctx,
    );

    const stats = getCostStats(ctx);
    expect(stats?.llmDurationMs).toBe(100);
    expect(stats?.avgLlmDurationMs).toBe(50);
    expect(stats?.byModel.get("model-a")?.durationMs).toBe(25);
    expect(stats?.byModel.get("model-b")?.durationMs).toBe(75);
  });

  it("treats missing usage and costModel errors as zero-cost observations", async () => {
    const { ctx } = createTestContext();
    const hook = costTracker({
      costModel: () => {
        throw new Error("pricing unavailable");
      },
    });

    await hook.onSessionStart?.({ source: "run", initialPrompt: "go" }, ctx);
    expect(() =>
      hook.onLlmEnd?.(
        {
          msg: { ...assistant("model-a"), usage: undefined } as unknown as AssistantMessage,
          durationMs: 10,
        },
        ctx,
      ),
    ).not.toThrow();

    const stats = getCostStats(ctx);
    expect(stats?.llmCallCount).toBe(1);
    expect(stats?.inputTokens).toBe(0);
    expect(stats?.outputTokens).toBe(0);
    expect(stats?.cachedTokens).toBe(0);
    expect(stats?.costUSD).toBe(0);
    expect(stats?.llmDurationMs).toBe(10);
  });
});

describe("toolStats", () => {
  const okTool: HarnessTool = {
    name: "ok",
    description: "ok",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [{ type: "text", text: "ok" }],
        details: {
          truncation: { truncated: true },
          fullOutputPath: "/tmp/full.log",
        },
      };
    },
  };

  const failTool: HarnessTool = {
    name: "fail",
    description: "fail",
    parameters: Type.Object({}),
    async execute() {
      throw new Error("boom");
    },
  };

  it("records success, thrown errors, details counters, and finalization callback", async () => {
    let finalized: ToolStats | undefined;
    const fake = createFakeModel([
      {
        content: [
          { type: "toolCall", name: "ok", arguments: {} },
          { type: "toolCall", name: "fail", arguments: {} },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);

    const session = new AgentSession({
      model: fake,
      tools: [okTool, failTool],
      hooks: [toolStats({ onSessionFinalized: (_ctx, stats) => (finalized = stats) })],
    });

    await session.run("go");

    expect(finalized).toBeDefined();
    expect(finalized?.byTool.get("ok")?.ok).toBe(1);
    expect(finalized?.byTool.get("ok")?.error).toBe(0);
    expect(finalized?.byTool.get("fail")?.ok).toBe(0);
    expect(finalized?.byTool.get("fail")?.error).toBe(1);
    expect(finalized?.truncationCount).toBe(1);
    expect(finalized?.fullOutputPathCount).toBe(1);
    fake.teardown();
  });

  it("estimates parallel savings from overlapping wrapToolExec spans", async () => {
    const slowSafe = (name: string): HarnessTool => ({
      name,
      description: name,
      parameters: Type.Object({}),
      isConcurrencySafe: () => true,
      async execute() {
        await new Promise<void>((resolve) => setTimeout(resolve, 40));
        return { content: [{ type: "text", text: name }] };
      },
    });
    let finalized: ToolStats | undefined;
    const fake = createFakeModel([
      {
        content: [
          { type: "toolCall", name: "slow_a", arguments: {} },
          { type: "toolCall", name: "slow_b", arguments: {} },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [slowSafe("slow_a"), slowSafe("slow_b")],
      hooks: [toolStats({ onSessionFinalized: (_ctx, stats) => (finalized = stats) })],
    });

    await session.run("go");

    expect(finalized?.totalCalls).toBe(2);
    expect(finalized?.estimatedParallelSavingsMs).toBeGreaterThan(0);
    fake.teardown();
  });

  it("calculates parallel savings deterministically from span unions", () => {
    const span = (
      startMs: number,
      endMs: number,
      turnIdx = 0,
    ): ToolSpan => ({
      turnIdx,
      callId: `${turnIdx}-${startMs}-${endMs}`,
      toolName: "tool",
      startMs,
      endMs,
      durationMs: endMs - startMs,
      isError: false,
      truncated: false,
    });

    expect(estimateParallelSavings([span(0, 40), span(10, 50)])).toBe(30);
    expect(estimateParallelSavings([span(0, 10), span(10, 20)])).toBe(0);
    expect(estimateParallelSavings([span(0, 100), span(20, 30)])).toBe(10);
    expect(
      estimateParallelSavings([
        span(0, 40, 0),
        span(10, 50, 0),
        span(0, 20, 1),
        span(30, 40, 1),
      ]),
    ).toBe(30);
  });

  it("does not count pre-tool denied calls as executed tool spans", async () => {
    let finalized: ToolStats | undefined;
    const fake = createFakeModel([
      { content: [{ type: "toolCall", name: "ok", arguments: {} }] },
      { content: [{ type: "text", text: "done" }] },
    ]);

    const session = new AgentSession({
      model: fake,
      tools: [okTool],
      hooks: [
        {
          name: "deny-ok",
          onPreToolUse() {
            return { decision: "deny" as const, reason: "not now" };
          },
        },
        toolStats({ onSessionFinalized: (_ctx, stats) => (finalized = stats) }),
      ],
    });

    await session.run("go");

    expect(finalized?.totalCalls).toBe(0);
    expect(finalized?.error).toBe(0);
    fake.teardown();
  });

  it("does not require onSessionFinalized", async () => {
    const fake = createFakeModel([
      { content: [{ type: "toolCall", name: "ok", arguments: {} }] },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [okTool],
      hooks: [toolStats()],
    });

    await expect(session.run("go")).resolves.toMatchObject({ reason: "done" });
    fake.teardown();
  });
});
