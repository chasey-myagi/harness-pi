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
    });
    setTimeout(() => ac.abort(), 20);
    const res = await pool.start(ac.signal);
    // 关键：start() 返回时，inflight 一定是 0（已 drain）
    expect(inflight.count).toBe(0);
    // result 反映已完成的 group 数（应该是当时 in-flight 的 3 个）
    expect(res.completedGroups + res.failedGroups).toBe(inflight.peak);
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
