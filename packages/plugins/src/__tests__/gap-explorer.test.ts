/**
 * #14 subAgent tool factory + GapExplorer 覆盖率闭环控制器测试（docs/09 §4.7）。
 */

import { describe, it, expect, vi } from "vitest";
import { AgentSession, Type, type HarnessTool } from "@harness-pi/core";
import { createFakeModel, createTestContext } from "@harness-pi/core/testing";
import {
  subAgentTool,
  GapExplorer,
  type Gap,
  type ExplorerFinding,
} from "../controllers/index.js";

function blockText(content: unknown): string {
  return Array.isArray(content)
    ? content.map((b) => ("text" in b ? (b as { text: string }).text : "")).join("")
    : String(content ?? "");
}

/* ──────────────── subAgentTool ──────────────── */

describe("subAgentTool", () => {
  it("spawns a bounded sub-agent and returns its last assistant text + terminal details", async () => {
    const subFake = createFakeModel([
      { content: [{ type: "text", text: "sub answer" }], stopReason: "stop", usage: { input: 5, output: 3 } },
    ]);
    const tool = subAgentTool({
      sessionFactory: () => new AgentSession({ model: subFake, tools: [] }),
    });
    const { ctx } = createTestContext();
    const result = await tool.execute({ task: "do X" }, ctx, new AbortController().signal);

    expect(blockText(result.content)).toContain("sub answer");
    const details = result.details as { subAgent?: { reason?: string; turns?: number } } | undefined;
    expect(details?.subAgent?.reason).toBe("done");
    expect(details?.subAgent?.turns).toBe(1);
    subFake.teardown();
  });

  it("passes the task + parent ctx to the sessionFactory", async () => {
    const subFake = createFakeModel([{ content: [{ type: "text", text: "ok" }], stopReason: "stop" }]);
    let gotTask = "";
    let gotCtx: unknown = null;
    const { ctx } = createTestContext();
    const tool = subAgentTool({
      sessionFactory: (task, c) => {
        gotTask = task;
        gotCtx = c;
        return new AgentSession({ model: subFake, tools: [] });
      },
    });
    await tool.execute({ task: "hello" }, ctx, new AbortController().signal);
    expect(gotTask).toBe("hello");
    expect(gotCtx).toBe(ctx);
    subFake.teardown();
  });

  it("throws on an empty/missing task (HarnessTool error contract)", async () => {
    const subFake = createFakeModel([]);
    const tool = subAgentTool({ sessionFactory: () => new AgentSession({ model: subFake, tools: [] }) });
    const { ctx } = createTestContext();
    const sig = new AbortController().signal;
    await expect(tool.execute({ task: "" }, ctx, sig)).rejects.toThrow(/empty task/);
    await expect(tool.execute({ task: "   " }, ctx, sig)).rejects.toThrow(/empty task/);
    await expect(tool.execute({}, ctx, sig)).rejects.toThrow(/empty task/);
    subFake.teardown();
  });

  it("enforces the maxSubAgents budget (fail-loud after the cap)", async () => {
    const subFake = createFakeModel([
      { content: [{ type: "text", text: "1" }], stopReason: "stop" },
    ]);
    const tool = subAgentTool({
      sessionFactory: () => new AgentSession({ model: subFake, tools: [] }),
      maxSubAgents: 1,
    });
    const { ctx } = createTestContext();
    const sig = new AbortController().signal;
    await tool.execute({ task: "a" }, ctx, sig); // spawned = 1
    await expect(tool.execute({ task: "b" }, ctx, sig)).rejects.toThrow(/budget exhausted/);
    subFake.teardown();
  });

  it("passes the parent signal to the sub-agent (cooperative cancel) → details.reason reflects abort", async () => {
    // 子代理里跑一个尊重 signal 的慢工具；父 signal abort 后子 run 以 reason "aborted" 收尾。
    const slow: HarnessTool = {
      name: "slow",
      description: "slow",
      parameters: Type.Object({}),
      async execute(_a, _c, sig: AbortSignal) {
        await new Promise<void>((res) => {
          const t = setTimeout(res, 1000);
          sig.addEventListener("abort", () => {
            clearTimeout(t);
            res();
          });
        });
        return { content: [{ type: "text", text: "r" }] };
      },
    };
    const subFake = createFakeModel([
      { content: [{ type: "toolCall", name: "slow", arguments: {} }] },
      { content: [{ type: "text", text: "after" }], stopReason: "stop" },
    ]);
    const tool = subAgentTool({
      sessionFactory: () => new AgentSession({ model: subFake, tools: [slow] }),
    });
    const { ctx } = createTestContext();
    const ctrl = new AbortController();
    const p = tool.execute({ task: "t" }, ctx, ctrl.signal);
    setTimeout(() => ctrl.abort(), 10);
    const result = await p;

    const details = result.details as { subAgent?: { reason?: string } } | undefined;
    expect(details?.subAgent?.reason).toBe("aborted"); // 信号确实到了子 session（非 done 终态也照常回灌）
    subFake.teardown();
  });

  it("falls back to a placeholder when the sub-agent produced no text", async () => {
    const subFake = createFakeModel([{ content: [], stopReason: "stop" }]); // lastMessage 无 text block
    const tool = subAgentTool({
      sessionFactory: () => new AgentSession({ model: subFake, tools: [] }),
    });
    const { ctx } = createTestContext();
    const result = await tool.execute({ task: "t" }, ctx, new AbortController().signal);
    expect(blockText(result.content)).toBe("(sub-agent produced no text output)");
    subFake.teardown();
  });
});

/* ──────────────── GapExplorer ──────────────── */

describe("GapExplorer", () => {
  /** 每个 gap 一个 fresh fake（空队列 → 默认 done 响应），收集起来供 teardown。 */
  function freshFactory() {
    const fakes: Array<ReturnType<typeof createFakeModel>> = [];
    const factory = () => {
      const f = createFakeModel([{ content: [{ type: "text", text: "explored" }], stopReason: "stop" }]);
      fakes.push(f);
      return new AgentSession({ model: f, tools: [] });
    };
    const teardown = () => fakes.forEach((f) => f.teardown());
    return { factory, teardown };
  }

  it("explores fresh gaps in parallel and returns a finding per gap", async () => {
    const { factory, teardown } = freshFactory();
    const ex = new GapExplorer({ sessionFactory: factory });
    const r = await ex.explore([
      { id: "g1", prompt: "p1" },
      { id: "g2", prompt: "p2" },
    ]);
    expect(r.explored.map((f) => f.gap.id).sort()).toEqual(["g1", "g2"]);
    expect(r.explored.every((f) => f.terminal.reason === "done")).toBe(true);
    expect(r.promoted.map((f) => f.gap.id).sort()).toEqual(["g1", "g2"]); // 默认全 promote
    teardown();
  });

  it("dedups by gap.id across calls (second sighting → skipped:duplicate)", async () => {
    const { factory, teardown } = freshFactory();
    const ex = new GapExplorer({ sessionFactory: factory });
    await ex.explore([{ id: "g1", prompt: "p1" }]);
    const r = await ex.explore([
      { id: "g1", prompt: "p1-again" },
      { id: "g2", prompt: "p2" },
    ]);
    expect(r.skipped.duplicate).toEqual(["g1"]);
    expect(r.explored.map((f) => f.gap.id)).toEqual(["g2"]);
    teardown();
  });

  it("enforces maxExplorers (excess → skipped:budget) and budget-skipped is retryable next call", async () => {
    const { factory, teardown } = freshFactory();
    const ex = new GapExplorer({ sessionFactory: factory, maxExplorers: 2 });
    const gaps: Gap[] = [
      { id: "g1", prompt: "p" },
      { id: "g2", prompt: "p" },
      { id: "g3", prompt: "p" },
    ];
    const r1 = await ex.explore(gaps);
    expect(r1.explored.map((f) => f.gap.id)).toEqual(["g1", "g2"]);
    expect(r1.skipped.budget).toEqual(["g3"]);

    // g1/g2 现在 seen（去重），g3 budget-skip 过 → 可重试。
    const r2 = await ex.explore(gaps);
    expect(r2.skipped.duplicate.sort()).toEqual(["g1", "g2"]);
    expect(r2.explored.map((f) => f.gap.id)).toEqual(["g3"]);
    teardown();
  });

  it("honors the promote gate: rejected findings are not applied to KB", async () => {
    const { factory, teardown } = freshFactory();
    const applyToKb = vi.fn();
    const ex = new GapExplorer({
      sessionFactory: factory,
      promote: (f: ExplorerFinding) => f.gap.id !== "bad",
      applyToKb,
    });
    const r = await ex.explore([
      { id: "good", prompt: "p" },
      { id: "bad", prompt: "p" },
    ]);
    expect(r.promoted.map((f) => f.gap.id)).toEqual(["good"]);
    expect(r.rejected.map((f) => f.gap.id)).toEqual(["bad"]);
    expect(applyToKb).toHaveBeenCalledTimes(1);
    expect((applyToKb.mock.calls[0]![0] as ExplorerFinding).gap.id).toBe("good");
    teardown();
  });

  it("toReanswer is the deduped union of promoted findings' affects", async () => {
    const { factory, teardown } = freshFactory();
    const ex = new GapExplorer({
      sessionFactory: factory,
      promote: (f: ExplorerFinding) => f.gap.id !== "bad",
    });
    const r = await ex.explore([
      { id: "g1", prompt: "p", affects: ["q1", "q2"] },
      { id: "g2", prompt: "p", affects: ["q2", "q3"] },
      { id: "bad", prompt: "p", affects: ["q9"] }, // rejected → 不计入 toReanswer
    ]);
    expect(r.toReanswer.sort()).toEqual(["q1", "q2", "q3"]);
    expect(r.toReanswer).not.toContain("q9");
    teardown();
  });

  it("a failing explorer is reported in failed[] and its gap stays retryable", async () => {
    const { factory, teardown } = freshFactory();
    const ex = new GapExplorer({
      sessionFactory: (gap) => {
        if (gap.id === "boom") throw new Error("factory blew up");
        return factory();
      },
    });
    const r1 = await ex.explore([
      { id: "ok1", prompt: "p" },
      { id: "boom", prompt: "p" },
    ]);
    expect(r1.explored.map((f) => f.gap.id)).toEqual(["ok1"]);
    expect(r1.failed.map((f) => f.gap.id)).toEqual(["boom"]);

    // boom 失败 → 从 _seen 移除 → 下次可重试（不是 duplicate）。
    const r2 = await ex.explore([{ id: "boom", prompt: "p" }]);
    expect(r2.skipped.duplicate).toEqual([]);
    teardown();
  });

  it("rejects negative maxExplorers at construction", () => {
    const { factory, teardown } = freshFactory();
    expect(() => new GapExplorer({ sessionFactory: factory, maxExplorers: -1 })).toThrow(/maxExplorers/);
    teardown();
  });

  it("a non-done explorer (max_turns) goes to incomplete, NOT explored/promoted, and stays retryable", async () => {
    // AgentSession.run() 不 throw——这个 explorer 每轮都想调工具，maxTurns:1 → 以 reason "max_turns" 收尾
    // （status 仍 "ok"）。控制器必须据 terminal.reason 把它分到 incomplete、绝不当 finding 默认 promote 污染 KB。
    const fakes: Array<ReturnType<typeof createFakeModel>> = [];
    const applyToKb = vi.fn();
    const ex = new GapExplorer({
      sessionFactory: () => {
        const noop: HarnessTool = {
          name: "noop",
          description: "noop",
          parameters: Type.Object({}),
          async execute() {
            return { content: [{ type: "text", text: "r" }] };
          },
        };
        const f = createFakeModel([{ content: [{ type: "toolCall", name: "noop", arguments: {} }] }]);
        fakes.push(f);
        return new AgentSession({ model: f, tools: [noop], maxTurns: 1 });
      },
      applyToKb,
    });
    const r1 = await ex.explore([{ id: "g1", prompt: "p" }]);
    expect(r1.explored).toEqual([]);
    expect(r1.incomplete.map((f) => f.gap.id)).toEqual(["g1"]);
    expect(r1.incomplete[0]!.terminal.reason).toBe("max_turns");
    expect(r1.promoted).toEqual([]);
    expect(applyToKb).not.toHaveBeenCalled(); // 半成品绝不写 KB

    // incomplete 的 gap 从 _seen 移除 → 下次可重探（非 duplicate）。
    const r2 = await ex.explore([{ id: "g1", prompt: "p" }]);
    expect(r2.skipped.duplicate).toEqual([]);
    fakes.forEach((f) => f.teardown());
  });

  it("an explorer aborted mid-run lands in incomplete (signal reaches the explorer session)", async () => {
    const fakes: Array<ReturnType<typeof createFakeModel>> = [];
    const ctrl = new AbortController();
    const ex = new GapExplorer({
      signal: ctrl.signal,
      sessionFactory: () => {
        const slow: HarnessTool = {
          name: "slow",
          description: "slow",
          parameters: Type.Object({}),
          async execute(_a, _c, sig: AbortSignal) {
            await new Promise<void>((res) => {
              const t = setTimeout(res, 1000);
              sig.addEventListener("abort", () => {
                clearTimeout(t);
                res();
              });
            });
            return { content: [{ type: "text", text: "r" }] };
          },
        };
        const f = createFakeModel([
          { content: [{ type: "toolCall", name: "slow", arguments: {} }] },
          { content: [{ type: "text", text: "done" }], stopReason: "stop" },
        ]);
        fakes.push(f);
        return new AgentSession({ model: f, tools: [slow] });
      },
    });
    const p = ex.explore([{ id: "g1", prompt: "p" }]);
    setTimeout(() => ctrl.abort(), 10);
    const r = await p;

    expect(r.explored).toEqual([]); // 被中止的 explorer 不当成功 finding
    expect(r.incomplete.map((f) => f.gap.id)).toEqual(["g1"]);
    expect(r.incomplete[0]!.terminal.reason).toBe("aborted"); // signal 确实到了 explorer session
    fakes.forEach((f) => f.teardown());
  });

  it("promote can block asynchronously (applyToKb only fires after promote resolves)", async () => {
    const { factory, teardown } = freshFactory();
    let release: (v: boolean) => void = () => {};
    const gate = new Promise<boolean>((res) => {
      release = res;
    });
    const applyToKb = vi.fn();
    const ex = new GapExplorer({ sessionFactory: factory, promote: () => gate, applyToKb });

    const p = ex.explore([{ id: "g1", prompt: "p" }]);
    await new Promise((r) => setTimeout(r, 20)); // 让 explore 跑到 await promote
    expect(applyToKb).not.toHaveBeenCalled(); // promote 未 resolve（等人审）→ 还没写 KB
    release(true);
    const r = await p;
    expect(applyToKb).toHaveBeenCalledTimes(1);
    expect(r.promoted.map((f) => f.gap.id)).toEqual(["g1"]);
    teardown();
  });

  it("maxExplorers: 0 explores nothing (all budget-skipped, retryable)", async () => {
    const { factory, teardown } = freshFactory();
    const ex = new GapExplorer({ sessionFactory: factory, maxExplorers: 0 });
    const r = await ex.explore([{ id: "g1", prompt: "p" }]);
    expect(r.explored).toEqual([]);
    expect(r.skipped.budget).toEqual(["g1"]);
    const r2 = await ex.explore([{ id: "g1", prompt: "p" }]); // budget-skip 不入 _seen → 可重探
    expect(r2.skipped.duplicate).toEqual([]);
    teardown();
  });
});
