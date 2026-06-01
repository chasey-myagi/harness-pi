/**
 * Plugin edge cases —— test-review missing scenarios 补强。
 */

import { describe, it, expect, vi } from "vitest";
import {
  AgentSession,
  Type,
  type HarnessTool,
  type Hook,
  type HookContext,
} from "@harness-pi/core";
import { createFakeModel } from "@harness-pi/core/testing";
import { watchdog } from "../watchdog.js";
import { trimHistory } from "../trim-history.js";
import { emptyRunGuard } from "../empty-run-guard.js";
import {
  toolOutputBuffer,
  getToolOutputBuffer,
} from "../tool-output-buffer.js";
import { systemReminder } from "../system-reminder.js";
import { batchCounter } from "../batch-counter.js";
import { leaseDecision } from "../lease-decision.js";
import { metrics, MemorySink } from "../metrics/index.js";
import { costTracker, getCostStats } from "../cost-tracker.js";
import { tokenBudget } from "../token-budget.js";

const echoTool: HarnessTool = {
  name: "echo",
  description: "echo",
  parameters: Type.Object({ msg: Type.String() }),
  async execute(args) {
    return { content: [{ type: "text", text: `echoed: ${args["msg"]}` }] };
  },
};

/* ──────────────── trim-history ──────────────── */

describe("trim-history edge", () => {
  it("keeps non-toolResult messages untouched", async () => {
    const model = createFakeModel([
      { content: [{ type: "toolCall", name: "echo", arguments: { msg: "1" } }] },
      { content: [{ type: "toolCall", name: "echo", arguments: { msg: "2" } }] },
      { content: [{ type: "toolCall", name: "echo", arguments: { msg: "3" } }] },
      { content: [{ type: "text", text: "done" }] },
    ]);
    let seenAtLast: any[] = [];
    const spy: Hook = {
      name: "spy",
      transformMessagesBeforeLlm(msgs) {
        seenAtLast = msgs;
        return undefined;
      },
    };
    const session = new AgentSession({
      model,
      tools: [echoTool],
      hooks: [trimHistory({ keepRecent: 1 }), spy],
    });
    await session.run("go");
    // Non-toolResult 消息全部原样保留
    const assistants = seenAtLast.filter((m: any) => m.role === "assistant");
    expect(assistants.length).toBeGreaterThan(0);
    for (const a of assistants) {
      // assistant 内容没被改
      expect(a.content).toBeDefined();
    }
  });

  it("custom placeholderText is used", async () => {
    const model = createFakeModel([
      { content: [{ type: "toolCall", name: "echo", arguments: { msg: "1" } }] },
      { content: [{ type: "toolCall", name: "echo", arguments: { msg: "2" } }] },
      { content: [{ type: "text", text: "done" }] },
    ]);
    let seen: any[] = [];
    const spy: Hook = {
      name: "spy",
      transformMessagesBeforeLlm(msgs) {
        seen = msgs;
        return undefined;
      },
    };
    const session = new AgentSession({
      model,
      tools: [echoTool],
      hooks: [
        trimHistory({
          keepRecent: 0,
          placeholderText: (name) => `<<TRIMMED:${name}>>`,
        }),
        spy,
      ],
    });
    await session.run("go");
    const tr = seen.find((m: any) => m.role === "toolResult");
    expect((tr as any).content[0].text).toBe("<<TRIMMED:echo>>");
  });
});

/* ──────────────── tool-output-buffer ──────────────── */

describe("tool-output-buffer edge", () => {
  it("maxEntries cap evicts oldest", async () => {
    const model = createFakeModel([
      { content: [{ type: "toolCall", name: "echo", arguments: { msg: "1" } }] },
      { content: [{ type: "toolCall", name: "echo", arguments: { msg: "2" } }] },
      { content: [{ type: "toolCall", name: "echo", arguments: { msg: "3" } }] },
      { content: [{ type: "text", text: "done" }] },
    ]);
    let snap: any[] = [];
    const grab: Hook = {
      name: "grab",
      onTurnEnd(_input, ctx) {
        const buf = getToolOutputBuffer(ctx);
        if (buf) snap = [...buf.snapshot()];
      },
    };
    const session = new AgentSession({
      model,
      tools: [echoTool],
      hooks: [
        toolOutputBuffer({
          track: ["echo"],
          maxEntries: 2,
          ttlMs: 10 * 60_000,
        }),
        grab,
      ],
    });
    await session.run("go");
    expect(snap).toHaveLength(2);
    expect((snap[0] as any).args.msg).toBe("2");
    expect((snap[1] as any).args.msg).toBe("3");
  });

  it("maxBytes cap evicts oldest", async () => {
    const big: HarnessTool = {
      name: "big",
      description: "big output",
      parameters: Type.Object({ id: Type.String() }),
      async execute(args) {
        return {
          content: [{ type: "text", text: "x".repeat(100) + args["id"] }],
        };
      },
    };
    const model = createFakeModel([
      { content: [{ type: "toolCall", name: "big", arguments: { id: "1" } }] },
      { content: [{ type: "toolCall", name: "big", arguments: { id: "2" } }] },
      { content: [{ type: "toolCall", name: "big", arguments: { id: "3" } }] },
      { content: [{ type: "text", text: "done" }] },
    ]);
    let snap: any[] = [];
    const grab: Hook = {
      name: "grab",
      onTurnEnd(_input, ctx) {
        const buf = getToolOutputBuffer(ctx);
        if (buf) snap = [...buf.snapshot()];
      },
    };
    const session = new AgentSession({
      model,
      tools: [big],
      hooks: [
        toolOutputBuffer({
          track: ["big"],
          maxEntries: 100,
          maxBytes: 250, // ~2 entries (100 chars + tiny suffix each)
          ttlMs: 60_000,
        }),
        grab,
      ],
    });
    await session.run("go");
    // Should have evicted earliest to stay under 250 bytes
    expect(snap.length).toBeLessThan(3);
  });
});

/* ──────────────── system-reminder ──────────────── */

describe("system-reminder edge", () => {
  it("on=postToolUse triggers after tool call", async () => {
    const model = createFakeModel([
      { content: [{ type: "toolCall", name: "echo", arguments: { msg: "x" } }] },
      { content: [{ type: "text", text: "done" }] },
    ]);
    let triggerCalls = 0;
    let attCount = 0;
    const spy: Hook = {
      name: "spy",
      transformMessagesBeforeLlm(msgs) {
        for (const m of msgs) {
          if (
            typeof (m as any).content === "string" &&
            ((m as any).content as string).includes("<system-reminder>")
          ) {
            attCount++;
          }
        }
        return undefined;
      },
    };
    const session = new AgentSession({
      model,
      tools: [echoTool],
      hooks: [
        systemReminder({
          on: "postToolUse",
          trigger: () => {
            triggerCalls++;
            return "post-tool reminder";
          },
        }),
        spy,
      ],
    });
    await session.run("go");
    expect(triggerCalls).toBeGreaterThan(0);
    expect(attCount).toBeGreaterThan(0);
  });

  it("trigger throwing → fail-open (no crash)", async () => {
    const model = createFakeModel([
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({
      model,
      tools: [],
      hooks: [
        systemReminder({
          on: "turnStart",
          trigger: () => {
            throw new Error("boom");
          },
        }),
      ],
    });
    const summary = await session.run("hi");
    expect(summary.reason).toBe("done");
  });

  it("wrap=false produces raw text without tag", async () => {
    const model = createFakeModel([
      { content: [{ type: "text", text: "ok" }] },
    ]);
    let seen: any[] = [];
    const spy: Hook = {
      name: "spy",
      transformMessagesBeforeLlm(msgs) {
        seen = msgs;
        return undefined;
      },
    };
    const session = new AgentSession({
      model,
      tools: [],
      hooks: [
        systemReminder({
          on: "turnStart",
          wrap: false,
          trigger: () => "RAW_REMINDER_NO_WRAP",
        }),
        spy,
      ],
    });
    await session.run("go");
    const att = seen.find(
      (m: any) =>
        typeof m.content === "string" &&
        m.content.includes("RAW_REMINDER_NO_WRAP"),
    );
    expect(att).toBeDefined();
    expect((att as any).content).not.toContain("<system-reminder>");
  });
});

/* ──────────────── batch-counter ──────────────── */

describe("batch-counter edge", () => {
  it("batchSize=1 triggers every call", async () => {
    const model = createFakeModel([
      {
        content: [
          { type: "toolCall", name: "echo", arguments: { msg: "1" } },
          { type: "toolCall", name: "echo", arguments: { msg: "2" } },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const onFull = vi.fn();
    const session = new AgentSession({
      model,
      tools: [echoTool],
      hooks: [
        batchCounter({ triggerTool: "echo", batchSize: 1, onFull }),
      ],
    });
    await session.run("go");
    expect(onFull).toHaveBeenCalledTimes(2);
  });

  it("counter persists across turns within session", async () => {
    const model = createFakeModel([
      { content: [{ type: "toolCall", name: "echo", arguments: { msg: "1" } }] },
      { content: [{ type: "toolCall", name: "echo", arguments: { msg: "2" } }] },
      { content: [{ type: "toolCall", name: "echo", arguments: { msg: "3" } }] },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const onFull = vi.fn();
    const session = new AgentSession({
      model,
      tools: [echoTool],
      hooks: [
        batchCounter({ triggerTool: "echo", batchSize: 3, onFull }),
      ],
    });
    await session.run("go");
    // 3 个调用跨 3 个 turn，应该触发一次
    expect(onFull).toHaveBeenCalledTimes(1);
  });

  it("onFull throwing does not break session", async () => {
    const model = createFakeModel([
      { content: [{ type: "toolCall", name: "echo", arguments: { msg: "x" } }] },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({
      model,
      tools: [echoTool],
      hooks: [
        batchCounter({
          triggerTool: "echo",
          batchSize: 1,
          onFull: () => {
            throw new Error("boom");
          },
        }),
      ],
    });
    const summary = await session.run("go");
    expect(summary.reason).toBe("done");
  });
});

/* ──────────────── lease-decision ──────────────── */

describe("lease-decision edge", () => {
  it("currentLease()=null → no lease enforcement, allow", async () => {
    let called = false;
    const tool: HarnessTool = {
      name: "answer",
      description: "answer",
      parameters: Type.Object({ questionId: Type.String() }),
      async execute() {
        called = true;
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
    const model = createFakeModel([
      {
        content: [
          {
            type: "toolCall",
            name: "answer",
            arguments: { questionId: "Q1" },
          },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({
      model,
      tools: [tool],
      hooks: [leaseDecision({ currentLease: () => null, argField: "questionId" })],
    });
    await session.run("go");
    expect(called).toBe(true);
  });

  it("args missing argField → allow (no enforcement)", async () => {
    let called = false;
    const tool: HarnessTool = {
      name: "answer",
      description: "answer",
      parameters: Type.Object({ other: Type.String() }),
      async execute() {
        called = true;
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
    const model = createFakeModel([
      {
        content: [
          {
            type: "toolCall",
            name: "answer",
            arguments: { other: "x" },
          },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({
      model,
      tools: [tool],
      hooks: [leaseDecision({ currentLease: () => "Q1", argField: "questionId" })],
    });
    await session.run("go");
    expect(called).toBe(true);
  });

  it("guardedTools filter: non-guarded passes through", async () => {
    let called = false;
    const tool: HarnessTool = {
      name: "free",
      description: "free",
      parameters: Type.Object({ questionId: Type.String() }),
      async execute() {
        called = true;
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
    const model = createFakeModel([
      {
        content: [
          {
            type: "toolCall",
            name: "free",
            arguments: { questionId: "Q2" }, // 不匹配
          },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({
      model,
      tools: [tool],
      hooks: [
        leaseDecision({
          currentLease: () => "Q1",
          argField: "questionId",
          guardedTools: ["other-tool"], // free 不在白名单
        }),
      ],
    });
    await session.run("go");
    expect(called).toBe(true);
  });
});

/* ──────────────── cost-tracker ──────────────── */

describe("cost-tracker edge", () => {
  it("multi-model: byModel.Map tracks each model separately", async () => {
    const m1 = createFakeModel([
      {
        content: [{ type: "text", text: "ok1" }],
        usage: { input: 10, output: 5 },
      },
    ]);
    const m2 = createFakeModel([
      {
        content: [{ type: "text", text: "ok2" }],
        usage: { input: 20, output: 10 },
      },
    ]);
    let snap: any = null;
    const grab: Hook = {
      name: "grab",
      onSessionEnd(_input, ctx) {
        snap = getCostStats(ctx);
      },
    };
    // Session1
    const s1 = new AgentSession({
      model: m1,
      tools: [],
      hooks: [costTracker(), grab],
    });
    await s1.run("hi1");
    expect(snap.byModel.size).toBe(1);

    // Session2 — uses different model — its own state
    const s2 = new AgentSession({
      model: m2,
      tools: [],
      hooks: [costTracker(), grab],
    });
    await s2.run("hi2");
    expect(snap.byModel.size).toBe(1);
    const calls2 = Array.from((snap.byModel as Map<string, any>).values())[0];
    expect(calls2.input).toBe(20);
  });

  it("missing usage doesn't crash (defensive)", async () => {
    const model = createFakeModel([
      {
        content: [{ type: "text", text: "ok" }],
        // no usage field → zero usage from fake provider
      },
    ]);
    let snap: any = null;
    const grab: Hook = {
      name: "grab",
      onSessionEnd(_input, ctx) {
        snap = getCostStats(ctx);
      },
    };
    const session = new AgentSession({
      model,
      tools: [],
      hooks: [costTracker(), grab],
    });
    await session.run("hi");
    expect(snap.llmCallCount).toBe(1);
    expect(snap.inputTokens).toBe(0);
    expect(snap.costUSD).toBe(0);
  });

  it("costModel throwing doesn't crash session", async () => {
    const model = createFakeModel([
      {
        content: [{ type: "text", text: "ok" }],
        usage: { input: 100, output: 50 },
      },
    ]);
    let snap: any = null;
    const grab: Hook = {
      name: "grab",
      onSessionEnd(_input, ctx) {
        snap = getCostStats(ctx);
      },
    };
    const session = new AgentSession({
      model,
      tools: [],
      hooks: [
        costTracker({
          costModel: () => {
            throw new Error("rate sheet broken");
          },
        }),
        grab,
      ],
    });
    const summary = await session.run("hi");
    expect(summary.reason).toBe("done");
    expect(snap.costUSD).toBe(0); // 异常时 cost 不累加
  });
});

/* ──────────────── token-budget ──────────────── */

describe("token-budget edge", () => {
  it("budget=0 noop", async () => {
    const model = createFakeModel([
      {
        content: [{ type: "text", text: "ok" }],
        usage: { input: 999999, output: 999999 },
      },
    ]);
    const session = new AgentSession({
      model,
      tools: [],
      hooks: [tokenBudget({ budget: 0 })],
    });
    const summary = await session.run("hi");
    expect(summary.reason).toBe("done");
  });

  it("nudge attached when token% in middle range", async () => {
    const model = createFakeModel([
      {
        content: [
          { type: "toolCall", name: "echo", arguments: { msg: "x" } },
        ],
        usage: { input: 30, output: 10 },
        stopReason: "toolUse",
      },
      {
        content: [{ type: "text", text: "ok" }],
        usage: { input: 5, output: 2 },
      },
    ]);
    let seen: any[] = [];
    const spy: Hook = {
      name: "spy",
      transformMessagesBeforeLlm(msgs) {
        seen = msgs;
        return undefined;
      },
    };
    const session = new AgentSession({
      model,
      tools: [echoTool],
      hooks: [costTracker(), tokenBudget({ budget: 100 }), spy],
    });
    await session.run("go");
    // Second LLM call's messages should include nudge (after first turn's tokenBudget ran)
    const nudge = seen.find(
      (m: any) =>
        typeof m.content === "string" &&
        (m.content as string).includes("system-reminder") &&
        (m.content as string).includes("tokens"),
    );
    expect(nudge).toBeDefined();
  });
});

/* ──────────────── repeated-call-guard ──────────────── */

describe("repeated-call-guard", () => {
  it("triggers onRepeat when same (tool, args) hits threshold", async () => {
    const model = createFakeModel([
      {
        content: [
          { type: "toolCall", name: "echo", arguments: { msg: "stuck" } },
          { type: "toolCall", name: "echo", arguments: { msg: "stuck" } },
          { type: "toolCall", name: "echo", arguments: { msg: "stuck" } },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const repeats: any[] = [];
    const session = new AgentSession({
      model,
      tools: [echoTool],
      hooks: [
        repeatedCallGuard({
          threshold: 3,
          onRepeat: (_ctx, pattern) => repeats.push(pattern),
        }),
      ],
    });
    await session.run("loop");
    expect(repeats).toHaveLength(1);
    expect(repeats[0].tool).toBe("echo");
    expect(repeats[0].count).toBe(3);
    expect(repeats[0].args.msg).toBe("stuck");
  });

  it("different args don't accumulate", async () => {
    const model = createFakeModel([
      {
        content: [
          { type: "toolCall", name: "echo", arguments: { msg: "a" } },
          { type: "toolCall", name: "echo", arguments: { msg: "b" } },
          { type: "toolCall", name: "echo", arguments: { msg: "c" } },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const repeats: any[] = [];
    const session = new AgentSession({
      model,
      tools: [echoTool],
      hooks: [
        repeatedCallGuard({
          threshold: 2,
          onRepeat: (_ctx, p) => repeats.push(p),
        }),
      ],
    });
    await session.run("vary");
    expect(repeats).toHaveLength(0);
  });

  it("watchTools filter: untracked tools don't count", async () => {
    const otherTool: HarnessTool = {
      name: "other",
      description: "x",
      parameters: Type.Object({ x: Type.String() }),
      async execute() {
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
    const model = createFakeModel([
      {
        content: [
          { type: "toolCall", name: "other", arguments: { x: "1" } },
          { type: "toolCall", name: "other", arguments: { x: "1" } },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const repeats: any[] = [];
    const session = new AgentSession({
      model,
      tools: [otherTool],
      hooks: [
        repeatedCallGuard({
          threshold: 2,
          watchTools: ["echo"], // 不监控 other
          onRepeat: (_ctx, p) => repeats.push(p),
        }),
      ],
    });
    await session.run("go");
    expect(repeats).toHaveLength(0);
  });

  it("error results don't count toward repeats", async () => {
    const failTool: HarnessTool = {
      name: "fail",
      description: "x",
      parameters: Type.Object({}),
      async execute() {
        throw new Error("boom");
      },
    };
    const model = createFakeModel([
      {
        content: [
          { type: "toolCall", name: "fail", arguments: {} },
          { type: "toolCall", name: "fail", arguments: {} },
          { type: "toolCall", name: "fail", arguments: {} },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const repeats: any[] = [];
    const session = new AgentSession({
      model,
      tools: [failTool],
      hooks: [
        repeatedCallGuard({
          threshold: 2,
          onRepeat: (_ctx, p) => repeats.push(p),
        }),
      ],
    });
    await session.run("go");
    expect(repeats).toHaveLength(0);
  });

  it("resetOnTrigger=true: doesn't re-fire next call same pattern", async () => {
    const model = createFakeModel([
      {
        content: [
          { type: "toolCall", name: "echo", arguments: { msg: "x" } },
          { type: "toolCall", name: "echo", arguments: { msg: "x" } },
        ],
      },
      {
        content: [
          { type: "toolCall", name: "echo", arguments: { msg: "x" } },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const repeats: any[] = [];
    const session = new AgentSession({
      model,
      tools: [echoTool],
      hooks: [
        repeatedCallGuard({
          threshold: 2,
          resetOnTrigger: true,
          onRepeat: (_ctx, p) => repeats.push(p),
        }),
      ],
    });
    await session.run("go");
    // 2 个 echo("x") 触发一次；第 3 个 echo("x") 不应该再触发（pattern 已 reset）
    expect(repeats).toHaveLength(1);
  });

  it("threshold <= 1 throws", () => {
    expect(() =>
      repeatedCallGuard({ threshold: 1, onRepeat: () => {} }),
    ).toThrow();
  });

  it("onRepeat can ctx.abort to stop session", async () => {
    const model = createFakeModel([
      {
        content: [
          { type: "toolCall", name: "echo", arguments: { msg: "x" } },
          { type: "toolCall", name: "echo", arguments: { msg: "x" } },
        ],
      },
      // 这条不应被消费——abort 后退出
      { content: [{ type: "text", text: "shouldn't see" }] },
    ]);
    const session = new AgentSession({
      model,
      tools: [echoTool],
      hooks: [
        repeatedCallGuard({
          threshold: 2,
          onRepeat: (ctx) => ctx.abort("stuck in loop"),
        }),
      ],
    });
    const summary = await session.run("go");
    expect(summary.reason).toBe("aborted");
    expect(summary.abortReason).toContain("stuck in loop");
  });
});

/* ──────────────── BatchingSink close drain ──────────────── */

import { BatchingSink } from "../metrics/batching-sink.js";
import type { MetricEvent } from "../metrics/types.js";
import { repeatedCallGuard } from "../repeated-call-guard.js";

describe("BatchingSink close drain", () => {
  it("drains buffer + in-flight enqueues before resolving", async () => {
    let writeStartedAt = 0;
    let writeCompletedAt = 0;
    const written: MetricEvent[][] = [];

    class TestSink extends BatchingSink {
      override async write(batch: MetricEvent[]): Promise<void> {
        writeStartedAt = Date.now();
        await new Promise<void>((r) => setTimeout(r, 30));
        written.push([...batch]);
        writeCompletedAt = Date.now();
      }
    }

    const sink = new TestSink({ batchSize: 2, flushIntervalMs: 5000 });
    sink.enqueue({ kind: "a", ts: 1 });
    sink.enqueue({ kind: "b", ts: 2 }); // triggers first flush (batch=2)

    // close() 在 in-flight flush 期间被调；drain loop 必须 await 完才能 return
    const closePromise = sink.close();
    // 此时尝试 enqueue("c") 会被 closed=true 拒绝（验证 close 之后 enqueue 静默丢）
    sink.enqueue({ kind: "c-after-close", ts: 3 });
    await closePromise;

    expect(written.length).toBeGreaterThanOrEqual(1);
    expect(written[0]).toHaveLength(2);
    expect(writeCompletedAt).toBeGreaterThanOrEqual(writeStartedAt + 25);
    // close 之后 enqueue 的不会被 write
    expect(
      written.flat().some((e) => e.kind === "c-after-close"),
    ).toBe(false);
  });

  it("close() escapes on permanent write failure (no infinite loop)", async () => {
    class BrokenSink extends BatchingSink {
      override async write(_batch: MetricEvent[]): Promise<void> {
        throw new Error("permanent failure");
      }
    }
    const sink = new BrokenSink({
      batchSize: 1,
      flushIntervalMs: 5000,
      bufferOverflow: 5000,
    });
    sink.enqueue({ kind: "a", ts: 1 });

    const t0 = Date.now();
    await sink.close();
    const took = Date.now() - t0;

    expect(took).toBeLessThan(1000); // 不应该 hang
    const stats = sink.stats();
    expect(stats.dropped).toBeGreaterThan(0); // 至少标了 dropped
  });
});

/* ──────────────── metrics ──────────────── */

describe("metrics edge", () => {
  it("error.observed emitted when tool throws", async () => {
    const failTool: HarnessTool = {
      name: "fail",
      description: "x",
      parameters: Type.Object({}),
      async execute() {
        throw new Error("boom");
      },
    };
    const sink = new MemorySink();
    const model = createFakeModel([
      { content: [{ type: "toolCall", name: "fail", arguments: {} }] },
      { content: [{ type: "text", text: "ok" }] },
    ]);
    const session = new AgentSession({
      model,
      tools: [failTool],
      hooks: [metrics({ sink })],
    });
    await session.run("go");
    const events = sink.snapshot();
    expect(events.some((e) => e.kind === "error.observed")).toBe(true);
  });

  it("MemorySink stats coherent (enqueued == flushed when no drops)", () => {
    const sink = new MemorySink();
    sink.enqueue({ kind: "session.started", ts: Date.now() });
    sink.enqueue({ kind: "turn.ended", ts: Date.now() });
    const stats = sink.stats();
    expect(stats.enqueued).toBe(2);
    expect(stats.flushed).toBe(2);
    expect(stats.dropped).toBe(0);
    expect(stats.pending).toBe(0);
  });

  it("MemorySink maxEvents drops oldest", () => {
    const sink = new MemorySink({ maxEvents: 2 });
    sink.enqueue({ kind: "a", ts: 1 });
    sink.enqueue({ kind: "b", ts: 2 });
    sink.enqueue({ kind: "c", ts: 3 });
    sink.enqueue({ kind: "d", ts: 4 });
    expect(sink.snapshot().map((e) => e.kind)).toEqual(["c", "d"]);
    expect(sink.stats().dropped).toBe(2);
  });
});

/* ──────────────── empty-run-guard ──────────────── */

describe("empty-run-guard edge", () => {
  it("onSessionStart resets counter so a fresh run() doesn't inherit stale count", async () => {
    // Run 1: turn 1-4 all empty (stopReason=toolUse 强续跑无 toolCall), guard maxEmptyTurns=5,
    //        到 turn 5 才 abort。
    // 但是我们只 push 4 个 response，model maxTurns 兜底让 turn 5 拿 fake "no more scripted"
    // → still empty → 5 个空 turn → abort.
    const model = createFakeModel([
      { content: [{ type: "text", text: "x" }], stopReason: "toolUse" },
      { content: [{ type: "text", text: "x" }], stopReason: "toolUse" },
      { content: [{ type: "text", text: "x" }], stopReason: "toolUse" },
      { content: [{ type: "text", text: "x" }], stopReason: "toolUse" },
      { content: [{ type: "text", text: "x" }], stopReason: "toolUse" },
    ]);
    const session1 = new AgentSession({
      model,
      tools: [],
      hooks: [emptyRunGuard({ maxEmptyTurns: 3 })],
    });
    const r1 = await session1.run("hi");
    expect(r1.reason).toBe("aborted");

    // Run 2 on a **new** session 应该重新从 0 开始计数
    const model2 = createFakeModel([
      {
        content: [
          { type: "toolCall", name: "echo", arguments: { msg: "ok" } },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session2 = new AgentSession({
      model: model2,
      tools: [echoTool],
      hooks: [emptyRunGuard({ maxEmptyTurns: 3 })],
    });
    const r2 = await session2.run("hi");
    expect(r2.reason).toBe("done");
  });

  it("custom considerEmpty: errored toolResult counts as empty", async () => {
    const failTool: HarnessTool = {
      name: "fail",
      description: "always fail",
      parameters: Type.Object({}),
      async execute() {
        throw new Error("nope");
      },
    };
    const model = createFakeModel([
      { content: [{ type: "toolCall", name: "fail", arguments: {} }] },
      { content: [{ type: "toolCall", name: "fail", arguments: {} }] },
      { content: [{ type: "toolCall", name: "fail", arguments: {} }] },
    ]);
    const session = new AgentSession({
      model,
      tools: [failTool],
      hooks: [
        emptyRunGuard({
          maxEmptyTurns: 2,
          considerEmpty: (input) =>
            input.toolResults.every((r) => r.isError === true),
        }),
      ],
    });
    const r = await session.run("hi");
    expect(r.reason).toBe("aborted");
    expect(r.abortReason).toContain("empty-run-guard");
  });
});

/* ──────────────── watchdog edge ──────────────── */

describe("watchdog edge", () => {
  it("onTimeout throwing doesn't prevent abort", async () => {
    const slow: HarnessTool = {
      name: "slow",
      description: "slow",
      parameters: Type.Object({}),
      async execute() {
        await new Promise<void>((r) => setTimeout(r, 200));
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
    const model = createFakeModel([
      { content: [{ type: "toolCall", name: "slow", arguments: {} }] },
    ]);
    const session = new AgentSession({
      model,
      tools: [slow],
      hooks: [
        watchdog({
          turnTimeoutMs: 30,
          onTimeout: () => {
            throw new Error("notification crashed");
          },
        }),
      ],
    });
    const summary = await session.run("go");
    expect(summary.reason).toBe("aborted");
    expect(summary.abortReason).toContain("watchdog");
  });
});
