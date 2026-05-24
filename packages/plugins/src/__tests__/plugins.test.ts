/**
 * Plugin unit tests —— 每个 plugin 至少 happy + edge case。
 * 跑真实 AgentSession + fake LLM 验证 plugin 行为。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentSession,
  Type,
  type HarnessTool,
  type Hook,
  type HookContext,
} from "@harness-pi/core";
import { createFakeModel } from "@harness-pi/core/testing";
import {
  watchdog,
  trimHistory,
  emptyRunGuard,
  toolOutputBuffer,
  getToolOutputBuffer,
  sessionLog,
  systemReminder,
  batchCounter,
  leaseDecision,
  metrics,
  MemorySink,
  costTracker,
  getCostStats,
  tokenBudget,
} from "../index.js";

// (no global beforeEach: each test creates its own fake model)

const echoTool: HarnessTool = {
  name: "echo",
  description: "echo",
  parameters: Type.Object({ msg: Type.String() }),
  async execute(args) {
    return { content: [{ type: "text", text: `echoed: ${args["msg"]}` }] };
  },
};

/* ──────────────── watchdog ──────────────── */

describe("watchdog", () => {
  it("throws if turnTimeoutMs <= 0", () => {
    expect(() => watchdog({ turnTimeoutMs: 0 })).toThrow();
    expect(() => watchdog({ turnTimeoutMs: -1 })).toThrow();
  });

  it("aborts session when turn exceeds timeout", async () => {
    const slowTool: HarnessTool = {
      name: "slow",
      description: "slow",
      parameters: Type.Object({}),
      async execute() {
        await new Promise<void>((r) => setTimeout(r, 200));
        return { content: [{ type: "text", text: "done" }] };
      },
    };
    const model = createFakeModel([
      { content: [{ type: "toolCall", name: "slow", arguments: {} }] },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const onTimeout = vi.fn();
    const session = new AgentSession({
      model,
      tools: [slowTool],
      hooks: [watchdog({ turnTimeoutMs: 30, onTimeout })],
    });
    const summary = await session.run("go");
    expect(summary.reason).toBe("aborted");
    expect(summary.abortReason).toContain("watchdog");
    expect(onTimeout).toHaveBeenCalled();
  });
});

/* ──────────────── trim-history ──────────────── */

describe("trim-history", () => {
  it("does not modify when toolResults <= keepRecent", async () => {
    const model = createFakeModel([
      { content: [{ type: "toolCall", name: "echo", arguments: { msg: "1" } }] },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({
      model,
      tools: [echoTool],
      hooks: [trimHistory({ keepRecent: 5 })],
    });
    await session.run("go");
    // tool result content 应该保持原样（"echoed: 1"）
    const tr = session.messages.find((m) => m.role === "toolResult");
    expect(
      tr && tr.role === "toolResult" && (tr.content[0] as any).text,
    ).toContain("echoed: 1");
  });

  it("trims older tool results, keeps last N intact (transform view only)", async () => {
    // 跑 4 个 tool turn，keepRecent=2 → 看 transformMessagesBeforeLlm 输出
    const model = createFakeModel([
      { content: [{ type: "toolCall", name: "echo", arguments: { msg: "1" } }] },
      { content: [{ type: "toolCall", name: "echo", arguments: { msg: "2" } }] },
      { content: [{ type: "toolCall", name: "echo", arguments: { msg: "3" } }] },
      { content: [{ type: "toolCall", name: "echo", arguments: { msg: "4" } }] },
      { content: [{ type: "text", text: "done" }] },
    ]);
    // spy 在 trim 之后看到的 messages
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
      hooks: [trimHistory({ keepRecent: 2 }), spy],
    });
    await session.run("go");
    // session.messages 仍然全量
    const allTr = session.messages.filter((m) => m.role === "toolResult");
    expect(allTr.length).toBe(4);
    // 但最后一次 LLM call 看到的视图里，前 2 个 toolResult 应该被 trim 成 placeholder
    const trInView = seenAtLast.filter((m: any) => m.role === "toolResult");
    expect(trInView.length).toBe(4);
    expect(trInView[0].content[0].text).toContain("[trimmed");
    expect(trInView[1].content[0].text).toContain("[trimmed");
    expect(trInView[2].content[0].text).toContain("echoed: 3");
    expect(trInView[3].content[0].text).toContain("echoed: 4");
  });

  it("keepRecent: 0 trims all", async () => {
    const model = createFakeModel([
      { content: [{ type: "toolCall", name: "echo", arguments: { msg: "1" } }] },
      { content: [{ type: "toolCall", name: "echo", arguments: { msg: "2" } }] },
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
      hooks: [trimHistory({ keepRecent: 0 }), spy],
    });
    await session.run("go");
    const trInView = seenAtLast.filter((m: any) => m.role === "toolResult");
    for (const m of trInView) {
      expect((m as any).content[0].text).toContain("[trimmed");
    }
  });
});

/* ──────────────── empty-run-guard ──────────────── */

describe("empty-run-guard", () => {
  it("aborts after N consecutive empty turns", async () => {
    // 3 个空 turn（无 tool call）+ guard maxEmptyTurns: 2 → 第 2 个 turn 触发 abort
    const model = createFakeModel([
      { content: [{ type: "text", text: "hi" }], stopReason: "toolUse" }, // 这条没 toolCall 但 stopReason=toolUse 强续跑
      { content: [{ type: "text", text: "still" }], stopReason: "toolUse" },
      { content: [{ type: "text", text: "more" }], stopReason: "toolUse" },
    ]);
    const session = new AgentSession({
      model,
      tools: [],
      hooks: [emptyRunGuard({ maxEmptyTurns: 2 })],
    });
    const summary = await session.run("hi");
    expect(summary.reason).toBe("aborted");
    expect(summary.abortReason).toContain("empty-run-guard");
  });

  it("resets counter on non-empty turn", async () => {
    const model = createFakeModel([
      { content: [{ type: "text", text: "x" }], stopReason: "toolUse" },
      { content: [{ type: "toolCall", name: "echo", arguments: { msg: "x" } }] }, // not empty
      { content: [{ type: "text", text: "x" }], stopReason: "toolUse" },
      { content: [{ type: "text", text: "x" }], stopReason: "toolUse" },
      { content: [{ type: "text", text: "x" }], stopReason: "toolUse" },
    ]);
    const session = new AgentSession({
      model,
      tools: [echoTool],
      hooks: [emptyRunGuard({ maxEmptyTurns: 3 })],
      maxTurns: 10,
    });
    const summary = await session.run("hi");
    // 3 个空 turn 才触发；含中间非空 reset 后只有 3 连续 → 触发
    expect(summary.reason).toBe("aborted");
  });
});

/* ──────────────── tool-output-buffer ──────────────── */

describe("tool-output-buffer", () => {
  it("records tracked tools, ignores others", async () => {
    const noTrack: HarnessTool = {
      ...echoTool,
      name: "no-track",
    };
    const model = createFakeModel([
      {
        content: [
          { type: "toolCall", name: "echo", arguments: { msg: "tracked" } },
          { type: "toolCall", name: "no-track", arguments: { msg: "skip" } },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    let bufferAtEnd: any;
    const grab: Hook = {
      name: "grab",
      onTurnEnd(_input, ctx: HookContext) {
        bufferAtEnd = getToolOutputBuffer(ctx)?.snapshot();
      },
    };
    const session = new AgentSession({
      model,
      tools: [echoTool, noTrack],
      hooks: [toolOutputBuffer({ track: ["echo"] }), grab],
    });
    await session.run("go");
    expect(bufferAtEnd).toHaveLength(1);
    expect(bufferAtEnd[0].toolName).toBe("echo");
  });

  it("evicts on TTL", async () => {
    const model = createFakeModel([
      { content: [{ type: "toolCall", name: "echo", arguments: { msg: "1" } }] },
      { content: [{ type: "text", text: "done" }] },
    ]);
    let buf: any;
    const grab: Hook = {
      name: "grab",
      async onTurnEnd(_input, ctx: HookContext) {
        // 等 TTL 过期
        await new Promise((r) => setTimeout(r, 20));
        // 触发一次新 push 让 evict 跑
        const b = getToolOutputBuffer(ctx);
        b?.push({ toolName: "_trigger", args: {}, output: "", ts: Date.now() });
        buf = b?.snapshot();
      },
    };
    const session = new AgentSession({
      model,
      tools: [echoTool],
      hooks: [toolOutputBuffer({ track: ["echo"], ttlMs: 10 }), grab],
    });
    await session.run("go");
    // 原 entry 应该被 TTL 淘汰，只剩 _trigger
    expect(buf).toHaveLength(1);
    expect(buf[0].toolName).toBe("_trigger");
  });
});

/* ──────────────── session-log ──────────────── */

describe("session-log", () => {
  let tmp = "";
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "harness-pi-test-"));
  });

  it("writes NDJSON for each event", async () => {
    const model = createFakeModel([
      { content: [{ type: "toolCall", name: "echo", arguments: { msg: "x" } }] },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({
      model,
      tools: [echoTool],
      hooks: [sessionLog({ dir: tmp })],
    });
    await session.run("hi");
    // 等流写完
    await new Promise((r) => setTimeout(r, 30));

    const path = join(tmp, `${session.id}.ndjson`);
    const content = readFileSync(path, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBeGreaterThan(5);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    rmSync(tmp, { recursive: true, force: true });
  });
});

/* ──────────────── system-reminder ──────────────── */

describe("system-reminder", () => {
  it("injects reminder when trigger returns text", async () => {
    const model = createFakeModel([
      { content: [{ type: "text", text: "done" }] },
    ]);
    let seenAttachment: any = null;
    const spy: Hook = {
      name: "spy",
      transformMessagesBeforeLlm(msgs) {
        seenAttachment = msgs.find((m: any) =>
          typeof m.content === "string" && m.content.includes("system-reminder"),
        );
        return undefined;
      },
    };
    const session = new AgentSession({
      model,
      tools: [],
      hooks: [
        systemReminder({ on: "turnStart", trigger: () => "hello world" }),
        spy,
      ],
    });
    await session.run("go");
    expect(seenAttachment).toBeDefined();
    expect((seenAttachment as any).content).toContain(
      "<system-reminder>hello world</system-reminder>",
    );
  });

  it("does NOT inject when trigger returns null", async () => {
    const model = createFakeModel([
      { content: [{ type: "text", text: "done" }] },
    ]);
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
      tools: [],
      hooks: [
        systemReminder({ on: "turnStart", trigger: () => null }),
        spy,
      ],
    });
    await session.run("go");
    expect(attCount).toBe(0);
  });
});

/* ──────────────── batch-counter ──────────────── */

describe("batch-counter", () => {
  it("triggers onFull every batchSize successful calls", async () => {
    const model = createFakeModel([
      {
        content: [
          { type: "toolCall", name: "echo", arguments: { msg: "1" } },
          { type: "toolCall", name: "echo", arguments: { msg: "2" } },
        ],
      },
      {
        content: [
          { type: "toolCall", name: "echo", arguments: { msg: "3" } },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const onFull = vi.fn();
    const session = new AgentSession({
      model,
      tools: [echoTool],
      hooks: [
        batchCounter({
          triggerTool: "echo",
          batchSize: 2,
          onFull,
        }),
      ],
    });
    await session.run("go");
    // 3 个 echo 调用，batchSize=2 → onFull 触发 1 次（第 2 次时）
    expect(onFull).toHaveBeenCalledTimes(1);
  });

  it("ignores error results", async () => {
    const failTool: HarnessTool = {
      name: "fail",
      description: "fail",
      parameters: Type.Object({}),
      async execute() {
        throw new Error("nope");
      },
    };
    const model = createFakeModel([
      {
        content: [
          { type: "toolCall", name: "fail", arguments: {} },
          { type: "toolCall", name: "fail", arguments: {} },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const onFull = vi.fn();
    const session = new AgentSession({
      model,
      tools: [failTool],
      hooks: [
        batchCounter({ triggerTool: "fail", batchSize: 1, onFull }),
      ],
    });
    await session.run("go");
    // 2 个失败的 fail，不计数
    expect(onFull).not.toHaveBeenCalled();
  });

  it("throws on bad batchSize", () => {
    expect(() =>
      batchCounter({ triggerTool: "x", batchSize: 0, onFull: () => {} }),
    ).toThrow();
  });
});

/* ──────────────── lease-decision ──────────────── */

describe("lease-decision", () => {
  it("blocks tool call when args.questionId mismatch lease", async () => {
    const tool: HarnessTool = {
      name: "answer",
      description: "answer",
      parameters: Type.Object({ questionId: Type.String() }),
      async execute() {
        return { content: [{ type: "text", text: "answered" }] };
      },
    };
    const model = createFakeModel([
      {
        content: [
          {
            type: "toolCall",
            name: "answer",
            arguments: { questionId: "Q2" },
          },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const onConflict = vi.fn();
    const session = new AgentSession({
      model,
      tools: [tool],
      hooks: [
        leaseDecision({ currentLease: () => "Q1", onConflict }),
      ],
    });
    await session.run("go");
    expect(onConflict).toHaveBeenCalled();
    const tr = session.messages.find((m) => m.role === "toolResult");
    expect(tr && tr.role === "toolResult" && tr.isError).toBe(true);
  });

  it("allows when lease matches", async () => {
    const tool: HarnessTool = {
      name: "answer",
      description: "answer",
      parameters: Type.Object({ questionId: Type.String() }),
      async execute(args) {
        return {
          content: [{ type: "text", text: `did ${args["questionId"]}` }],
        };
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
      hooks: [leaseDecision({ currentLease: () => "Q1" })],
    });
    await session.run("go");
    const tr = session.messages.find((m) => m.role === "toolResult");
    expect(tr && tr.role === "toolResult" && tr.isError).toBe(false);
  });
});

/* ──────────────── metrics ──────────────── */

describe("metrics", () => {
  it("emits session/turn/llm/tool events to sink", async () => {
    const sink = new MemorySink();
    const model = createFakeModel([
      { content: [{ type: "toolCall", name: "echo", arguments: { msg: "x" } }] },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({
      model,
      tools: [echoTool],
      hooks: [metrics({ sink })],
    });
    await session.run("go");
    const events = sink.snapshot();
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("session.started");
    expect(kinds).toContain("session.ended");
    expect(kinds).toContain("turn.started");
    expect(kinds).toContain("turn.ended");
    expect(kinds).toContain("llm.called");
    expect(kinds).toContain("tool.called");
  });

  it("filters by kinds option", async () => {
    const sink = new MemorySink();
    const model = createFakeModel([
      { content: [{ type: "text", text: "ok" }] },
    ]);
    const session = new AgentSession({
      model,
      tools: [],
      hooks: [metrics({ sink, kinds: ["session.started", "session.ended"] })],
    });
    await session.run("go");
    const kinds = new Set(sink.snapshot().map((e) => e.kind));
    expect(kinds.has("session.started")).toBe(true);
    expect(kinds.has("session.ended")).toBe(true);
    expect(kinds.has("turn.started")).toBe(false);
    expect(kinds.has("llm.called")).toBe(false);
  });
});

/* ──────────────── cost-tracker ──────────────── */

describe("cost-tracker", () => {
  it("accumulates token + cost per model", async () => {
    const model = createFakeModel([
      {
        content: [{ type: "text", text: "ok" }],
        usage: { input: 100, output: 50 },
      },
    ]);
    let snap: any = null;
    const grab: Hook = {
      name: "grab",
      onSessionEnd(_input, ctx: HookContext) {
        snap = getCostStats(ctx);
      },
    };
    const session = new AgentSession({
      model,
      tools: [],
      hooks: [
        costTracker({
          costModel: (_id, usage) =>
            usage.input * 0.001 + usage.output * 0.002,
        }),
        grab,
      ],
    });
    await session.run("hi");
    expect(snap.inputTokens).toBe(100);
    expect(snap.outputTokens).toBe(50);
    expect(snap.costUSD).toBeCloseTo(100 * 0.001 + 50 * 0.002, 6);
    expect(snap.llmCallCount).toBe(1);
    // model id 是动态的 fake-model-N，找第一个非空 key
    const firstModelKey = Array.from(snap.byModel.keys())[0];
    expect(firstModelKey).toMatch(/^fake-model-/);
    expect(snap.byModel.get(firstModelKey)?.calls).toBe(1);
  });

  it("survives missing costModel", async () => {
    const model = createFakeModel([
      {
        content: [{ type: "text", text: "ok" }],
        usage: { input: 10, output: 5 },
      },
    ]);
    let snap: any = null;
    const grab: Hook = {
      name: "grab",
      onSessionEnd(_input, ctx: HookContext) {
        snap = getCostStats(ctx);
      },
    };
    const session = new AgentSession({
      model,
      tools: [],
      hooks: [costTracker(), grab],
    });
    await session.run("hi");
    expect(snap.costUSD).toBe(0);
    expect(snap.inputTokens).toBe(10);
  });
});

/* ──────────────── token-budget ──────────────── */

describe("token-budget", () => {
  it("returns continue: false when budget exhausted", async () => {
    // Configure budget=100, 单 call usage=120 → 超
    const model = createFakeModel([
      {
        content: [{ type: "text", text: "r1" }],
        usage: { input: 60, output: 60 },
        stopReason: "toolUse", // 强 continue 让 turnEnd 触发判断
      },
      // 第 2 turn 不应该跑（被 budget stop）
      { content: [{ type: "text", text: "r2 should not happen" }] },
    ]);
    const session = new AgentSession({
      model,
      tools: [],
      hooks: [costTracker(), tokenBudget({ budget: 100 })],
    });
    const summary = await session.run("hi");
    // tokenBudget 返 continue=false → kernel 把 abortReason 设上
    expect(summary.reason).toBe("aborted");
    expect(summary.abortReason).toContain("token budget");
  });

  it("noop when budget=null", async () => {
    const model = createFakeModel([
      {
        content: [{ type: "text", text: "ok" }],
        usage: { input: 999999, output: 999999 },
      },
    ]);
    const session = new AgentSession({
      model,
      tools: [],
      hooks: [tokenBudget({ budget: null })],
    });
    const summary = await session.run("hi");
    expect(summary.reason).toBe("done");
  });
});
