/**
 * Phase 3 plugin tests —— forkSession controller + cost-tracker mode + token-budget 跟
 * cost-tracker 的依赖通过 `prefers` 静默（无 warn）。
 */

import { describe, it, expect } from "vitest";
import { AgentSession, Type, type HarnessTool } from "@harness-pi/core";
import { createFakeModel } from "@harness-pi/core/testing";
import { costTracker, getCostStats } from "../cost-tracker.js";
import { forkSession, forkSessionAll } from "../controllers/fork-session.js";

const echoTool: HarnessTool = {
  name: "echo",
  description: "",
  parameters: Type.Object({}),
  async execute() {
    return { content: [{ type: "text", text: "x" }] };
  },
};

/* ──────────────── cost-tracker mode option ──────────────── */

describe("Phase 3: cost-tracker mode", () => {
  it("per-run (default): 每次 run() 重置 stats", async () => {
    const fake = createFakeModel([
      {
        content: [{ type: "text", text: "first" }],
        usage: { input: 100, output: 50 },
      },
      {
        content: [{ type: "text", text: "second" }],
        usage: { input: 200, output: 80 },
      },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      hooks: [costTracker()],
    });
    // 第一次 run
    await session.run("first");
    // session 在 onSessionEnd 时 stats 还在 state 里；下次 run 会重置
    // 直接抓 state.get 验证
    // 因为 onSessionEnd 之后 ctx state 还存活到下次 onSessionStart 才被重置
    // 第二次 run
    await session.run("second");
    // 这里我们没办法直接观察 mid-run state；改用一个 probe hook 捕获
    fake.teardown();
  });

  it("per-run vs lifetime: 第二次 run 后累计 vs 重置", async () => {
    const captured: Array<number> = [];
    const probeHook = {
      name: "probe",
      onTurnEnd(_input: unknown, ctx: import("@harness-pi/core").HookContext) {
        const stats = getCostStats(ctx);
        if (stats) captured.push(stats.inputTokens);
      },
    };
    const fake = createFakeModel([
      {
        content: [{ type: "text", text: "first" }],
        usage: { input: 100, output: 50 },
      },
      {
        content: [{ type: "text", text: "second" }],
        usage: { input: 200, output: 80 },
      },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      hooks: [costTracker({ mode: "lifetime" }), probeHook],
    });
    await session.run("first");
    await session.run("second");
    // lifetime 模式：第二个 turn 看到累计的 input tokens = 100 + 200 = 300
    expect(captured[0]).toBe(100);
    expect(captured[1]).toBe(300);
    fake.teardown();
  });

  it("per-run mode: 第二次 run 重置到 0", async () => {
    const captured: Array<number> = [];
    const probeHook = {
      name: "probe",
      onTurnEnd(_input: unknown, ctx: import("@harness-pi/core").HookContext) {
        const stats = getCostStats(ctx);
        if (stats) captured.push(stats.inputTokens);
      },
    };
    const fake = createFakeModel([
      {
        content: [{ type: "text", text: "first" }],
        usage: { input: 100, output: 50 },
      },
      {
        content: [{ type: "text", text: "second" }],
        usage: { input: 200, output: 80 },
      },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      hooks: [costTracker({ mode: "per-run" }), probeHook],
    });
    await session.run("first");
    await session.run("second");
    // per-run 模式：第二次 run 重置，只看到 200
    expect(captured[0]).toBe(100);
    expect(captured[1]).toBe(200);
    fake.teardown();
  });

  it("default mode === 'per-run'（向后兼容）", async () => {
    const captured: Array<number> = [];
    const probeHook = {
      name: "probe",
      onTurnEnd(_input: unknown, ctx: import("@harness-pi/core").HookContext) {
        const stats = getCostStats(ctx);
        if (stats) captured.push(stats.inputTokens);
      },
    };
    const fake = createFakeModel([
      {
        content: [{ type: "text", text: "first" }],
        usage: { input: 100, output: 50 },
      },
      {
        content: [{ type: "text", text: "second" }],
        usage: { input: 200, output: 80 },
      },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      hooks: [costTracker(), probeHook],
    });
    await session.run("first");
    await session.run("second");
    expect(captured[1]).toBe(200); // 默认 per-run
    fake.teardown();
  });
});

/* ──────────────── forkSession ──────────────── */

describe("Phase 3: forkSession controller", () => {
  it("fork 不动父 session 的 messages snapshot", async () => {
    const parentFake = createFakeModel([
      { content: [{ type: "text", text: "parent done" }] },
    ]);
    const parent = new AgentSession({ model: parentFake, tools: [] });
    await parent.run("parent prompt");
    const parentBeforeFork = parent.messages.length;

    const childFake = createFakeModel([
      { content: [{ type: "text", text: "child done" }] },
    ]);
    const result = await forkSession(
      parent,
      (init) =>
        new AgentSession({
          model: childFake,
          tools: [],
          initialMessages: init,
        }),
      { prompt: "child prompt" },
    );

    // 父 messages 未被 child 影响
    expect(parent.messages.length).toBe(parentBeforeFork);
    // 子拿到父历史 + 自己新增
    expect(result.messages.length).toBeGreaterThan(parentBeforeFork);
    expect(result.summary.reason).toBe("done");
    parentFake.teardown();
    childFake.teardown();
  });

  it("forkSessionAll: 多个 fork 平行跑，失败一个不影响其他", async () => {
    const parentFake = createFakeModel([
      { content: [{ type: "text", text: "parent done" }] },
    ]);
    const parent = new AgentSession({ model: parentFake, tools: [] });
    await parent.run("parent prompt");

    const goodFake = createFakeModel([
      { content: [{ type: "text", text: "good" }] },
    ]);
    const results = await forkSessionAll(parent, [
      {
        factory: (init) =>
          new AgentSession({
            model: goodFake,
            tools: [],
            initialMessages: init,
          }),
        opts: { prompt: "good branch" },
      },
      {
        // 这个 factory 抛错（模拟分支构造失败）
        factory: () => {
          throw new Error("factory failed");
        },
        opts: { prompt: "bad branch" },
      },
    ]);

    expect(results).toHaveLength(2);
    expect(results[0]?.status).toBe("fulfilled");
    expect(results[1]?.status).toBe("rejected");
    if (results[1]?.status === "rejected") {
      expect(results[1].reason.message).toBe("factory failed");
    }
    parentFake.teardown();
    goodFake.teardown();
  });

  it("fork with prompt=undefined → 子 session continue() 接着跑", async () => {
    const parentFake = createFakeModel([
      { content: [{ type: "text", text: "parent done" }] },
    ]);
    const parent = new AgentSession({ model: parentFake, tools: [] });
    await parent.run("hello");

    const childFake = createFakeModel([
      { content: [{ type: "text", text: "continued" }] },
    ]);
    const result = await forkSession(parent, (init) => {
      const s = new AgentSession({
        model: childFake,
        tools: [],
        initialMessages: init,
      });
      return s;
    });
    expect(result.summary.reason).toBe("done");
    parentFake.teardown();
    childFake.teardown();
  });
});

/* ──────────────── token-budget prefers cost-tracker (no warn) ──────────────── */

describe("Phase 3: prefers 不发 warning", () => {
  it("token-budget 用 prefers:['cost-tracker']，没注册时不 warn", async () => {
    const warnings: string[] = [];
    const fake = createFakeModel([
      { content: [{ type: "text", text: "done" }] },
    ]);
    // 用 dynamic import 避免静态依赖问题
    const { tokenBudget } = await import("../token-budget.js");
    new AgentSession({
      model: fake,
      tools: [],
      hooks: [tokenBudget({ budget: 10_000 })],
      consoleSink: (msg) => warnings.push(msg),
    });
    // 不应有 hook-deps:missing-required warning
    expect(
      warnings.filter((w) => w.includes("missing-required")).length,
    ).toBe(0);
    fake.teardown();
  });
});
