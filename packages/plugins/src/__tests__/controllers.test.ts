/**
 * Controller tests —— LifecycleRestart / WorkPool / LeaseQueue。
 */

import { describe, it, expect, vi } from "vitest";
import {
  AgentSession,
  Type,
  type HarnessTool,
  type Message,
} from "@harness-pi/core";
import { createFakeModel } from "@harness-pi/core/testing";
import { watchdog } from "../watchdog.js";
import {
  LifecycleRestart,
  WorkPool,
  LeaseQueue,
  type LeaseStatus,
} from "../controllers/index.js";

/* ──────────────── LifecycleRestart ──────────────── */

describe("LifecycleRestart", () => {
  it("happy path: no restart needed", async () => {
    const model = createFakeModel([
      { content: [{ type: "text", text: "done" }] },
    ]);
    const ctrl = new LifecycleRestart({
      sessionFactory: (im) =>
        new AgentSession({
          model,
          tools: [],
          ...(im ? { initialMessages: im } : {}),
        }),
    });
    const res = await ctrl.run("hi");
    expect(res.reason).toBe("done");
    expect(res.retries).toBe(0);
  });

  it("restarts on watchdog: abortReason, carries messages over", async () => {
    const slowTool: HarnessTool = {
      name: "slow",
      description: "slow",
      parameters: Type.Object({}),
      async execute() {
        await new Promise<void>((r) => setTimeout(r, 100));
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
    const model = createFakeModel([
      { content: [{ type: "toolCall", name: "slow", arguments: {} }] },
    ]);

    let factoryCount = 0;
    const initialMessagesSeen: Message[][] = [];
    const ctrl = new LifecycleRestart({
      maxRetries: 1,
      retryDelayMs: 0,
      sessionFactory: (im) => {
        factoryCount++;
        if (im) initialMessagesSeen.push(im);
        if (factoryCount === 2) {
          model.push({ content: [{ type: "text", text: "recovered" }] });
        }
        return new AgentSession({
          model,
          tools: [slowTool],
          hooks: [watchdog({ turnTimeoutMs: 20 })],
          ...(im ? { initialMessages: im } : {}),
        });
      },
    });
    const res = await ctrl.run("hi");
    expect(factoryCount).toBe(2);
    expect(res.retries).toBe(1);
    expect(initialMessagesSeen[0]?.length).toBeGreaterThan(0);
  });

  it("abort during the retry delay wakes the sleep and exits promptly (#11.4)", async () => {
    const slowTool: HarnessTool = {
      name: "slow",
      description: "slow",
      parameters: Type.Object({}),
      async execute() {
        await new Promise<void>((r) => setTimeout(r, 100));
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
    const model = createFakeModel([
      { content: [{ type: "toolCall", name: "slow", arguments: {} }] },
    ]);
    const ctrl = new LifecycleRestart({
      maxRetries: 1,
      // 5s delay vs a 2s assertion: if abort does NOT wake the sleep the run blocks ~5s and the
      // assertion fails cleanly — well under vitest's 10s timeout, so it's a clean fail, not a hang.
      retryDelayMs: 5_000,
      sessionFactory: (im) =>
        new AgentSession({
          model,
          tools: [slowTool],
          hooks: [watchdog({ turnTimeoutMs: 10 })],
          ...(im ? { initialMessages: im } : {}),
        }),
    });
    const ac = new AbortController();
    const t0 = Date.now();
    // first run watchdog-aborts (~10ms) → enters the 5s retry delay → abort lands during it
    setTimeout(() => ac.abort(), 100);
    const res = await ctrl.run("hi", { signal: ac.signal });
    expect(Date.now() - t0).toBeLessThan(2_000); // woke promptly, did NOT wait the full 5s
    expect(res.reason).toBe("aborted");
  });

  it("a pre-aborted signal performs no retry and returns promptly (#11.4)", async () => {
    const slowTool: HarnessTool = {
      name: "slow",
      description: "slow",
      parameters: Type.Object({}),
      async execute() {
        await new Promise<void>((r) => setTimeout(r, 100));
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
    const model = createFakeModel([
      { content: [{ type: "toolCall", name: "slow", arguments: {} }] },
    ]);
    const ctrl = new LifecycleRestart({
      maxRetries: 3,
      retryDelayMs: 10_000, // must never be entered
      sessionFactory: (im) =>
        new AgentSession({
          model,
          tools: [slowTool],
          hooks: [watchdog({ turnTimeoutMs: 10 })],
          ...(im ? { initialMessages: im } : {}),
        }),
    });
    const ac = new AbortController();
    ac.abort(); // already aborted before the run starts
    const t0 = Date.now();
    const res = await ctrl.run("hi", { signal: ac.signal });
    expect(Date.now() - t0).toBeLessThan(1_000); // no 10s retry delay
    expect(res.retries).toBe(0); // the while-guard `!signal.aborted` prevents any retry
  });

  it("non-retryable abortReason stops immediately", async () => {
    const model = createFakeModel([
      { content: [{ type: "text", text: "ok" }] },
    ]);
    const ctrl = new LifecycleRestart({
      maxRetries: 5,
      sessionFactory: (_im) => {
        const s = new AgentSession({ model, tools: [] });
        setTimeout(() => s.abort("custom-not-watchdog"), 1);
        return s;
      },
    });
    const res = await ctrl.run("hi");
    expect(res.retries).toBe(0);
  });

  it("max retries reached", async () => {
    const slowTool: HarnessTool = {
      name: "slow",
      description: "slow",
      parameters: Type.Object({}),
      async execute() {
        await new Promise<void>((r) => setTimeout(r, 100));
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
    const model = createFakeModel([
      { content: [{ type: "toolCall", name: "slow", arguments: {} }] },
    ]);
    const ctrl = new LifecycleRestart({
      maxRetries: 2,
      retryDelayMs: 0,
      sessionFactory: (im) => {
        model.push({
          content: [{ type: "toolCall", name: "slow", arguments: {} }],
        });
        return new AgentSession({
          model,
          tools: [slowTool],
          hooks: [watchdog({ turnTimeoutMs: 15 })],
          ...(im ? { initialMessages: im } : {}),
        });
      },
    });
    const res = await ctrl.run("hi");
    expect(res.retries).toBe(2);
    expect(res.reason).toBe("aborted");
  });
});

/* ──────────────── WorkPool ──────────────── */

describe("WorkPool", () => {
  interface Item {
    id: string;
    text: string;
  }

  it("processes groups in parallel up to maxConcurrency", async () => {
    const items: Item[] = [
      { id: "a", text: "hello" },
      { id: "b", text: "world" },
      { id: "c", text: "foo" },
    ];
    const groupCount = vi.fn();
    const pool = new WorkPool<Item>({
      items,
      partition: (items) =>
        items.map((it) => ({ id: it.id, items: [it] })),
      workerFactory: async (g) => {
        groupCount();
        const model = createFakeModel([
          { content: [{ type: "text", text: `done-${g.id}` }] },
        ]);
        const session = new AgentSession({ model, tools: [] });
        return { session, prompt: `do ${g.items[0]?.text}` };
      },
      maxConcurrency: 2,
    });

    const res = await pool.start();
    expect(res.totalItems).toBe(3);
    expect(res.completedGroups).toBe(3);
    expect(res.failedGroups).toBe(0);
    expect(groupCount).toHaveBeenCalledTimes(3);
  });

  it("empty groups returns immediately", async () => {
    const pool = new WorkPool<Item>({
      items: [],
      partition: () => [],
      workerFactory: async () => {
        throw new Error("should not be called");
      },
    });
    const res = await pool.start();
    expect(res.totalItems).toBe(0);
    expect(res.groups).toEqual([]);
  });

  it("group failure does not kill pool", async () => {
    const items: Item[] = [
      { id: "ok", text: "x" },
      { id: "bad", text: "y" },
    ];
    const onErr = vi.fn();
    const pool = new WorkPool<Item>({
      items,
      partition: (its) => its.map((it) => ({ id: it.id, items: [it] })),
      workerFactory: async (g) => {
        if (g.id === "bad") throw new Error("factory failure");
        const model = createFakeModel([
          { content: [{ type: "text", text: "ok" }] },
        ]);
        return {
          session: new AgentSession({ model, tools: [] }),
          prompt: "go",
        };
      },
      onGroupError: onErr,
    });
    const res = await pool.start();
    expect(res.completedGroups).toBe(1);
    expect(res.failedGroups).toBe(1);
    expect(onErr).toHaveBeenCalledOnce();
  });

  it("aborted mid-flight: drains in-flight workers before returning", async () => {
    // 5 items, concurrency=3, abort 后剩下的不被启动；in-flight 必须 await
    // 否则 caller 拿到的 completed 计数会在 return 之后继续变
    const inflight = { count: 0, peak: 0 };
    const items: Item[] = Array.from({ length: 5 }, (_, i) => ({
      id: `i${i}`,
      text: "x",
    }));
    const ac = new AbortController();
    const onSkip = vi.fn();
    const pool = new WorkPool<Item>({
      items,
      partition: (its) => its.map((it) => ({ id: it.id, items: [it] })),
      maxConcurrency: 3,
      workerFactory: async () => {
        inflight.count++;
        inflight.peak = Math.max(inflight.peak, inflight.count);
        await new Promise<void>((r) => setTimeout(r, 50));
        inflight.count--;
        const model = createFakeModel([
          { content: [{ type: "text", text: "ok" }] },
        ]);
        return { session: new AgentSession({ model, tools: [] }), prompt: "x" };
      },
      onGroupSkipped: onSkip,
    });
    setTimeout(() => ac.abort(), 20);
    const res = await pool.start(ac.signal);
    // 关键：start() 返回时，inflight 一定是 0（已 drain）
    expect(inflight.count).toBe(0);
    // #31:未启动的 group 不再静默消失——进 results 标 skipped、计入 skippedGroups、触发 onGroupSkipped。
    // 守恒:每个 group 都有终态,三类计数之和 === group 总数;results 也覆盖全部 group。
    expect(res.completedGroups + res.failedGroups + res.skippedGroups).toBe(5);
    expect(res.groups).toHaveLength(5);
    expect(res.skippedGroups).toBe(2); // 并发 3 先启动,abort 在任一完成前触发 → 剩 2 个从未启动
    expect(onSkip).toHaveBeenCalledTimes(2);
    expect(res.groups.filter((g) => g.skipped === "aborted")).toHaveLength(2);
  });

  it("pre-aborted signal:全部 group 直接 skipped、不启动 worker、onGroupSkipped 全触发", async () => {
    const onSkip = vi.fn();
    const ac = new AbortController();
    ac.abort(); // 启动前就已 abort
    const items: Item[] = [
      { id: "a", text: "x" },
      { id: "b", text: "y" },
    ];
    const pool = new WorkPool<Item>({
      items,
      partition: (its) => its.map((it) => ({ id: it.id, items: [it] })),
      workerFactory: async () => {
        throw new Error("workerFactory must not run under pre-aborted signal");
      },
      onGroupSkipped: onSkip,
    });
    const res = await pool.start(ac.signal);
    expect(res.completedGroups).toBe(0);
    expect(res.failedGroups).toBe(0);
    expect(res.skippedGroups).toBe(2);
    expect(res.groups).toHaveLength(2);
    expect(onSkip).toHaveBeenCalledTimes(2);
  });

  it("abort 时全部 in-flight(items <= 并发):无未启动 group → skippedGroups 0、不误触发 onGroupSkipped", async () => {
    const onSkip = vi.fn();
    const ac = new AbortController();
    const items: Item[] = Array.from({ length: 3 }, (_, i) => ({ id: `i${i}`, text: "x" }));
    const pool = new WorkPool<Item>({
      items,
      partition: (its) => its.map((it) => ({ id: it.id, items: [it] })),
      maxConcurrency: 3, // 全部一次性启动,queue 为空
      workerFactory: async () => {
        await new Promise<void>((r) => setTimeout(r, 50));
        const model = createFakeModel([{ content: [{ type: "text", text: "ok" }] }]);
        return { session: new AgentSession({ model, tools: [] }), prompt: "x" };
      },
      onGroupSkipped: onSkip,
    });
    setTimeout(() => ac.abort(), 20);
    const res = await pool.start(ac.signal);
    expect(res.skippedGroups).toBe(0); // queue 空,无未启动 group
    expect(onSkip).not.toHaveBeenCalled();
    expect(res.completedGroups + res.failedGroups).toBe(3); // 守恒:全是已启动的
  });

  it("混合终态(串行 maxConcurrency=1):已跑完的 group 仍 completed,未启动的 skipped,二者共存且守恒", async () => {
    // 钉死非退化(并非全 skipped)的守恒:abort 不会把已 completed 的 group 误判/回收成 skipped。
    // 串行下 g0 正常跑完 → onGroupComplete 内触发 abort → loop 顶部见 aborted 退出 → g1/g2 从未启动 → sweep skipped。
    const ac = new AbortController();
    const items: Item[] = Array.from({ length: 3 }, (_, i) => ({ id: `i${i}`, text: "x" }));
    const completedIds: string[] = [];
    const pool = new WorkPool<Item>({
      items,
      partition: (its) => its.map((it) => ({ id: it.id, items: [it] })),
      maxConcurrency: 1, // 串行,一次只跑一个
      workerFactory: async () => {
        const model = createFakeModel([{ content: [{ type: "text", text: "ok" }] }]);
        return { session: new AgentSession({ model, tools: [] }), prompt: "x" };
      },
      onGroupComplete: (id) => {
        completedIds.push(id);
        if (id === "i0") ac.abort(); // g0 收尾后立刻 abort,后续 group 应一个都不启动
      },
    });
    const res = await pool.start(ac.signal);
    expect(res.completedGroups).toBe(1); // g0 真完成,未被 abort 回收
    expect(res.skippedGroups).toBe(2); // g1/g2 从未启动
    expect(res.failedGroups).toBe(0);
    expect(res.completedGroups + res.failedGroups + res.skippedGroups).toBe(3); // 守恒,非退化(completed≥1 且 skipped≥1)
    expect(completedIds).toEqual(["i0"]); // 串行:abort 后没有第二个 group 被启动
    expect(res.groups.filter((g) => g.skipped === "aborted")).toHaveLength(2);
  });

  it("混合终态(串行):in-flight group factory 抛错(failed)与未启动 group(skipped)共存", async () => {
    // failedGroups≥1 && skippedGroups≥1 同时出现:证明 abort sweep 不吞掉真实失败、失败也不污染 skipped 计数。
    const ac = new AbortController();
    const items: Item[] = Array.from({ length: 3 }, (_, i) => ({ id: `i${i}`, text: "x" }));
    const onErr = vi.fn();
    const onSkip = vi.fn();
    const pool = new WorkPool<Item>({
      items,
      partition: (its) => its.map((it) => ({ id: it.id, items: [it] })),
      maxConcurrency: 1, // 串行:只有 g0 启动
      workerFactory: async (g) => {
        if (g.id === "i0") {
          ac.abort(); // g0 跑时 abort:其失败收尾后 loop 退出,g1/g2 不启动
          throw new Error("boom");
        }
        const model = createFakeModel([{ content: [{ type: "text", text: "ok" }] }]);
        return { session: new AgentSession({ model, tools: [] }), prompt: "x" };
      },
      onGroupError: onErr,
      onGroupSkipped: onSkip,
    });
    const res = await pool.start(ac.signal);
    expect(res.failedGroups).toBe(1); // g0 factory 抛错 → failed,不被 sweep 误判成 skipped
    expect(res.skippedGroups).toBe(2); // g1/g2 从未启动
    expect(res.completedGroups).toBe(0);
    expect(res.failedGroups + res.skippedGroups).toBe(3); // 守恒,失败与跳过两类共存
    expect(onErr).toHaveBeenCalledOnce();
    expect(onSkip).toHaveBeenCalledTimes(2);
  });

  it("空 items + 已 abort:直接全零返回,不启动 worker、不误触发 onGroupSkipped", async () => {
    const ac = new AbortController();
    ac.abort();
    const onSkip = vi.fn();
    const pool = new WorkPool<Item>({
      items: [],
      partition: () => [],
      workerFactory: async () => {
        throw new Error("should not be called");
      },
      onGroupSkipped: onSkip,
    });
    const res = await pool.start(ac.signal);
    expect(res).toMatchObject({
      totalItems: 0,
      completedGroups: 0,
      failedGroups: 0,
      skippedGroups: 0,
    });
    expect(res.groups).toEqual([]);
    expect(onSkip).not.toHaveBeenCalled();
  });

  it("maxConcurrency truly caps concurrent groups", async () => {
    // 5 items, concurrency 2, each takes 40ms.
    // Serial would be 200ms; concurrency=2 is 3 batches ≈ 120ms.
    let inflight = 0;
    let peakInflight = 0;
    const items: Item[] = Array.from({ length: 5 }, (_, i) => ({
      id: `i${i}`,
      text: "x",
    }));
    const pool = new WorkPool<Item>({
      items,
      partition: (its) => its.map((it) => ({ id: it.id, items: [it] })),
      maxConcurrency: 2,
      workerFactory: async () => {
        inflight++;
        peakInflight = Math.max(peakInflight, inflight);
        await new Promise<void>((r) => setTimeout(r, 40));
        inflight--;
        const model = createFakeModel([
          { content: [{ type: "text", text: "ok" }] },
        ]);
        return { session: new AgentSession({ model, tools: [] }), prompt: "x" };
      },
    });
    await pool.start();
    expect(peakInflight).toBeLessThanOrEqual(2);
    expect(peakInflight).toBeGreaterThanOrEqual(2);
  });
});

/* ──────────────── LeaseQueue ──────────────── */

describe("LeaseQueue", () => {
  interface Item {
    id: string;
  }

  it("processes all items with N workers; lease attempt = 1 on success", async () => {
    const items: Item[] = Array.from({ length: 5 }, (_, i) => ({
      id: `i${i}`,
    }));
    const seen: Array<{ id: string; workerId: string; attempt: number }> = [];

    const queue = new LeaseQueue<Item>({
      items,
      concurrency: 2,
      workerFactory: async (item, lease) => {
        seen.push({ id: item.id, workerId: lease.workerId, attempt: lease.attempt });
        const model = createFakeModel([
          { content: [{ type: "text", text: `done-${item.id}` }] },
        ]);
        return {
          session: new AgentSession({ model, tools: [] }),
          prompt: `do ${item.id}`,
        };
      },
    });

    const res = await queue.start();
    expect(res.totalItems).toBe(5);
    expect(res.completed).toBe(5);
    expect(seen.length).toBe(5);
    expect(seen.every((s) => s.attempt === 1)).toBe(true);
  });

  it("maxAttempts: 2 retries failed items", async () => {
    const items: Item[] = [{ id: "ok" }, { id: "bad" }];
    const attempts = new Map<string, number>();

    const queue = new LeaseQueue<Item>({
      items,
      concurrency: 1,
      maxAttempts: 2,
      workerFactory: async (item) => {
        const prev = attempts.get(item.id) ?? 0;
        attempts.set(item.id, prev + 1);
        if (item.id === "bad") {
          throw new Error("factory throws");
        }
        const model = createFakeModel([
          { content: [{ type: "text", text: "ok" }] },
        ]);
        return {
          session: new AgentSession({ model, tools: [] }),
          prompt: "go",
        };
      },
    });

    const res = await queue.start();
    expect(res.completed).toBe(1);
    expect(res.failed).toBe(1);
    expect(attempts.get("bad")).toBe(2);
  });

  it("onItemComplete receives error for thrown workerFactory", async () => {
    const errSeen: Error[] = [];
    const queue = new LeaseQueue<Item>({
      items: [{ id: "x" }],
      concurrency: 1,
      maxAttempts: 1,
      workerFactory: async () => {
        throw new Error("deliberate");
      },
      onItemComplete: (_item, _status, _summary, err) => {
        if (err) errSeen.push(err);
      },
    });
    const res = await queue.start();
    expect(res.failed).toBe(1);
    expect(errSeen).toHaveLength(1);
    expect(errSeen[0]?.message).toBe("deliberate");
  });

  it("releaseLease conflict marks item as conflicted", async () => {
    const queue = new LeaseQueue<Item>({
      items: [{ id: "x" }],
      concurrency: 1,
      workerFactory: async (_item, _lease, releaseCtx) => {
        // 必须立刻调 releaseLease，否则 worker 跑完正常 → done
        releaseCtx.releaseLease("conflict");
        const model = createFakeModel([
          { content: [{ type: "text", text: "ok" }] },
        ]);
        return {
          session: new AgentSession({ model, tools: [] }),
          prompt: "go",
        };
      },
    });
    const res = await queue.start();
    expect(res.conflicted).toBe(1);
  });

  it("aborted mid-flight: 未派发的 item 必给 skipped 终态(不静默消失)", async () => {
    // 5 items / 并发 2:abort 时 2 个 in-flight、3 个从未派发。#31 要求残留的 3 个也得终态。
    const statuses: string[] = [];
    const items: Item[] = Array.from({ length: 5 }, (_, i) => ({ id: `i${i}` }));
    const ac = new AbortController();
    const queue = new LeaseQueue<Item>({
      items,
      concurrency: 2,
      workerFactory: async (item) => {
        await new Promise<void>((r) => setTimeout(r, 50)); // 让 abort 能在派发后、跑完前触发
        const model = createFakeModel([{ content: [{ type: "text", text: `d-${item.id}` }] }]);
        return { session: new AgentSession({ model, tools: [] }), prompt: "go" };
      },
      onItemComplete: (_item, status) => statuses.push(status),
    });
    setTimeout(() => ac.abort(), 20);
    const res = await queue.start(ac.signal);

    // 守恒:每个 item 恰一条终态。
    expect(res.totalItems).toBe(5);
    expect(res.completed + res.failed + res.conflicted + res.skipped).toBe(5);
    expect(res.skipped).toBe(3); // 并发 2 先派发 2,剩 3 个从未派发 → skipped
    expect(statuses).toHaveLength(5); // onItemComplete 为每个 item 触发(含 skipped),无静默消失
    expect(statuses.filter((s) => s === "skipped")).toHaveLength(3);
  });

  it("abort × retry 交错(maxAttempts>1):回退重试的 item 与未派发的都给 skipped、各恰一次", async () => {
    // 钉死「abort 时回退重试的 item 也给终态」这条注释承诺、却最易漏测的路径。
    // 并发 1 / maxAttempts 3:i0 跑时 abort → 其 run 以 aborted 收尾(reason!=done)→ attempt1<3 → 回退进 pending;
    // 下一轮 loop 见 aborted 退出 → i0(回退)+ i1/i2(从未派发)都由末尾 sweep finalize 成 skipped。
    const statuses: string[] = [];
    const ac = new AbortController();
    let firstCall = true;
    const queue = new LeaseQueue<Item>({
      items: [{ id: "i0" }, { id: "i1" }, { id: "i2" }],
      concurrency: 1,
      maxAttempts: 3,
      workerFactory: async (item) => {
        if (firstCall) {
          firstCall = false;
          ac.abort(); // i0 跑时触发:其 session.run 以 aborted 收尾 → status error → 回退重试
        }
        const model = createFakeModel([{ content: [{ type: "text", text: `d-${item.id}` }] }]);
        return { session: new AgentSession({ model, tools: [] }), prompt: "go" };
      },
      onItemComplete: (_item, status) => statuses.push(status),
    });
    const res = await queue.start(ac.signal);
    expect(res.completed + res.failed + res.conflicted + res.skipped).toBe(3); // 守恒
    expect(res.skipped).toBe(3); // i0(回退)+ i1/i2(未派发)
    expect(statuses).toHaveLength(3); // 每个 item 恰 finalize 一次,无双计/漏计
    expect(statuses.every((s) => s === "skipped")).toBe(true);
  });

  it("pre-aborted signal:全部 item 直接 skipped、不调 workerFactory、onItemComplete 全触发", async () => {
    const statuses: string[] = [];
    const ac = new AbortController();
    ac.abort();
    const queue = new LeaseQueue<Item>({
      items: [{ id: "a" }, { id: "b" }],
      concurrency: 2,
      workerFactory: async () => {
        throw new Error("workerFactory must not run under pre-aborted signal");
      },
      onItemComplete: (_item, status) => statuses.push(status),
    });
    const res = await queue.start(ac.signal);
    expect(res.completed).toBe(0);
    expect(res.skipped).toBe(2);
    expect(statuses).toEqual(["skipped", "skipped"]);
  });

  it("混合终态:abort 时部分 item 真完成、部分失败、剩余 skipped,三类共存且守恒", async () => {
    // 钉死非退化守恒(并非全 skipped):并发 1 串行下,i0 正常 done、i1 在跑时 abort 收尾成 error(failed),
    // i2/i3 从未派发 → sweep skipped。completed≥1 && skipped≥1 同时成立,且四类之和仍 === totalItems。
    const statuses: LeaseStatus[] = [];
    const ac = new AbortController();
    let call = 0;
    const queue = new LeaseQueue<Item>({
      items: [{ id: "i0" }, { id: "i1" }, { id: "i2" }, { id: "i3" }],
      concurrency: 1, // 串行:i0 先跑完,再派 i1
      maxAttempts: 1, // i1 abort 收尾后不重试 → 直接 error(failed)
      workerFactory: async (item) => {
        call++;
        if (call === 2) ac.abort(); // 第 2 次派发(i1)时 abort:i0 已 done,i1 以 aborted 收尾
        const model = createFakeModel([{ content: [{ type: "text", text: `d-${item.id}` }] }]);
        return { session: new AgentSession({ model, tools: [] }), prompt: "go" };
      },
      onItemComplete: (_item, status) => statuses.push(status),
    });
    const res = await queue.start(ac.signal);
    expect(res.totalItems).toBe(4);
    expect(res.completed).toBe(1); // i0
    expect(res.failed).toBe(1); // i1(abort 收尾,maxAttempts 1 不重试)
    expect(res.skipped).toBe(2); // i2/i3 从未派发
    expect(res.completed + res.failed + res.conflicted + res.skipped).toBe(4); // 守恒
    expect(res.completed).toBeGreaterThanOrEqual(1);
    expect(res.skipped).toBeGreaterThanOrEqual(1);
    expect(statuses).toHaveLength(4); // 每个 item 恰 finalize 一次
    expect(statuses.filter((s) => s === "done")).toHaveLength(1);
    expect(statuses.filter((s) => s === "skipped")).toHaveLength(2);
  });

  it("conflict × abort 交错:worker 已 releaseLease('conflict') 的 item 终态是 conflict,不被 sweep 误判 skipped", async () => {
    // i0 在 worker 内主动 releaseLease('conflict') 并 abort → 其终态应由 worker 裁成 conflict(优先于 sweep);
    // 未派发的 i1/i2 才进 sweep 成 skipped。验证 conflict 与 skipped 互不串味、守恒成立。
    const statuses: LeaseStatus[] = [];
    const ac = new AbortController();
    const queue = new LeaseQueue<Item>({
      items: [{ id: "i0" }, { id: "i1" }, { id: "i2" }],
      concurrency: 1,
      maxAttempts: 1,
      workerFactory: async (item, _lease, ctx) => {
        if (item.id === "i0") {
          ctx.releaseLease("conflict"); // worker 主动裁定 conflict
          ac.abort(); // 同时 abort:i1/i2 将从未派发
        }
        const model = createFakeModel([{ content: [{ type: "text", text: `d-${item.id}` }] }]);
        return { session: new AgentSession({ model, tools: [] }), prompt: "go" };
      },
      onItemComplete: (_item, status) => statuses.push(status),
    });
    const res = await queue.start(ac.signal);
    expect(res.conflicted).toBe(1); // i0:worker 裁定 conflict 优先,不被末尾 sweep 改写
    expect(res.skipped).toBe(2); // i1/i2 从未派发
    expect(res.completed + res.failed + res.conflicted + res.skipped).toBe(3); // 守恒
    expect(statuses[0]).toBe("conflict"); // i0 由 worker 先 finalize 成 conflict
    expect(statuses.filter((s) => s === "skipped")).toHaveLength(2);
  });

  it("空 items + 已 abort:直接全零返回,不调 workerFactory", async () => {
    // LeaseQueue 此前完全没有空 items 用例。空 + 已 abort 是 sweep 与 workerCount=0 的退化边界。
    const ac = new AbortController();
    ac.abort();
    const onComplete = vi.fn();
    const queue = new LeaseQueue<Item>({
      items: [],
      concurrency: 2,
      workerFactory: async () => {
        throw new Error("workerFactory must not run with empty items");
      },
      onItemComplete: onComplete,
    });
    const res = await queue.start(ac.signal);
    expect(res).toEqual({
      totalItems: 0,
      completed: 0,
      failed: 0,
      conflicted: 0,
      skipped: 0,
    });
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("throws on bad concurrency", () => {
    expect(() =>
      new LeaseQueue<Item>({
        items: [],
        concurrency: 0,
        workerFactory: async () => {
          const model = createFakeModel([]);
          return {
            session: new AgentSession({ model, tools: [] }),
            prompt: "x",
          };
        },
      }),
    ).toThrow();
  });
});
