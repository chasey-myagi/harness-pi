/**
 * LifecycleRestart 的**持久化 resume 模式**测试（docs/09 §6 Phase 2「lifecycleRestart 从 store resume」）。
 *
 * 既有 LifecycleRestart 靠内存搬历史（[...session.messages]）——只能同进程恢复。resume 模式改为每次从
 * 注入的 SessionStore 用 AgentSession.resume() 重建，能跨**进程崩溃**恢复（in-memory carry 做不到）。
 */

import { describe, it, expect, vi } from "vitest";
import { AgentSession, MemorySessionStore, Type, type HarnessTool } from "@harness-pi/core";
import { createFakeModel } from "@harness-pi/core/testing";
import { LifecycleRestart } from "../controllers/lifecycle-restart.js";
import { watchdog } from "../watchdog.js";

const slowTool: HarnessTool = {
  name: "slow",
  description: "slow",
  parameters: Type.Object({}),
  async execute() {
    await new Promise<void>((r) => setTimeout(r, 100));
    return { content: [{ type: "text", text: "ok" }] };
  },
};

describe("LifecycleRestart — durable resume mode", () => {
  it("validates exactly one of {sessionFactory, resume} is given", () => {
    const store = new MemorySessionStore();
    const model = createFakeModel([]);
    expect(() => new LifecycleRestart({} as never)).toThrow(/sessionFactory.*resume|resume.*sessionFactory/i);
    expect(
      () =>
        new LifecycleRestart({
          sessionFactory: () => new AgentSession({ model, tools: [] }),
          resume: { store, sessionId: "s", deps: { model, tools: [] } },
        } as never),
    ).toThrow(/sessionFactory.*resume|resume.*sessionFactory/i);
    model.teardown();
  });

  it("fresh sessionId: starts fresh (run prompt), persists to store, no retry", async () => {
    const model = createFakeModel([{ content: [{ type: "text", text: "done" }], stopReason: "stop" }]);
    const store = new MemorySessionStore();
    const ctrl = new LifecycleRestart({
      resume: { store, sessionId: "fresh", deps: { model, tools: [] } },
    });
    const res = await ctrl.run("hi");
    expect(res.reason).toBe("done");
    expect(res.retries).toBe(0);
    const path = await store.getPathToLeaf("fresh");
    expect(path.length).toBeGreaterThan(0); // 落盘了
    // 喂给 model 的 context 含新 prompt（走的是 run("hi") 而非 continue）。
    expect(JSON.stringify(model.getCalls())).toContain("hi");
    model.teardown();
  });

  it("retryable abort: rebuilds from the STORE and continues to done", async () => {
    // turn1 调 slow tool → watchdog 20ms 超时 abort（可重试）；resume + continue 后出 "recovered" → done。
    const model = createFakeModel([
      { content: [{ type: "toolCall", name: "slow", arguments: {} }] },
      { content: [{ type: "text", text: "recovered" }], stopReason: "stop" },
    ]);
    const store = new MemorySessionStore();
    const ctrl = new LifecycleRestart({
      maxRetries: 1,
      retryDelayMs: 0,
      resume: {
        store,
        sessionId: "retry",
        deps: { model, tools: [slowTool], hooks: [watchdog({ turnTimeoutMs: 20 })] },
      },
    });
    // spy：证明每次（重）启都**重新从 store 读**（AgentSession.resume 内部 getPathToLeaf），而非内存搬历史。
    const getPathSpy = vi.spyOn(store, "getPathToLeaf");
    const res = await ctrl.run("hi");
    expect(res.reason).toBe("done");
    expect(res.retries).toBe(1);
    // 首跑 resume + 1 次重试 resume = 对 "retry" 读 store 恰好 2 次（attempts+1）——内存搬历史只会读 0 次。
    const resumeReads = getPathSpy.mock.calls.filter((c) => c[0] === "retry").length;
    expect(resumeReads).toBe(2);
    getPathSpy.mockRestore();
    // 续跑经 store 重建：最终 lineage 既含最初 "hi" 又含 "recovered"——历史是从落盘续上的，不是从头重跑。
    const dump = JSON.stringify(await store.getPathToLeaf("retry"));
    expect(dump).toContain("hi");
    expect(dump).toContain("recovered");
    model.teardown();
  });

  it("resume mode: exhausts maxRetries and returns the last aborted summary", async () => {
    // 每个 turn 都调 slow tool → watchdog 必 abort。maxRetries=2 → 首跑 + 2 重试全 abort → retries===2、仍 aborted。
    const model = createFakeModel(
      Array.from({ length: 5 }, () => ({
        content: [{ type: "toolCall" as const, name: "slow", arguments: {} }],
      })),
    );
    const store = new MemorySessionStore();
    const ctrl = new LifecycleRestart({
      maxRetries: 2,
      retryDelayMs: 0,
      resume: {
        store,
        sessionId: "exhaust",
        deps: { model, tools: [slowTool], hooks: [watchdog({ turnTimeoutMs: 20 })] },
      },
    });
    const res = await ctrl.run("hi");
    expect(res.reason).toBe("aborted");
    expect(res.retries).toBe(2); // 用尽 maxRetries
    model.teardown();
  });

  it("resume mode: a non-retryable abort stops immediately (no restart)", async () => {
    // watchdog abort 但 isRetryable 判否 → 一次都不重启。
    const model = createFakeModel([
      { content: [{ type: "toolCall", name: "slow", arguments: {} }] },
    ]);
    const store = new MemorySessionStore();
    const ctrl = new LifecycleRestart({
      maxRetries: 3,
      retryDelayMs: 0,
      isRetryable: () => false, // 显式判所有 abort 不可重试
      resume: {
        store,
        sessionId: "noretry",
        deps: { model, tools: [slowTool], hooks: [watchdog({ turnTimeoutMs: 20 })] },
      },
    });
    const res = await ctrl.run("hi");
    expect(res.reason).toBe("aborted");
    expect(res.retries).toBe(0); // 立即停，不重启
    model.teardown();
  });

  it("cold-start recovery: resumes a session it never created in-process (continue, not re-run prompt)", async () => {
    const store = new MemorySessionStore();

    // 「上一进程」：一个独立 AgentSession 落盘了历史，然后（模拟）进程没了。
    const m1 = createFakeModel([{ content: [{ type: "text", text: "first answer" }], stopReason: "stop" }]);
    const prior = new AgentSession({ model: m1, tools: [], sessionId: "cold", store });
    await prior.run("original question");
    const seeded = await store.getPathToLeaf("cold");
    m1.teardown();

    // 「新进程」：只拿 store+sessionId，没有 prior session 对象。resume 模式应 continue（不把新 prompt 当新消息）。
    const m2 = createFakeModel([{ content: [{ type: "text", text: "continued" }], stopReason: "stop" }]);
    const ctrl = new LifecycleRestart({
      resume: { store, sessionId: "cold", deps: { model: m2, tools: [] } },
    });
    const res = await ctrl.run("IGNORED-because-session-exists");
    expect(res.reason).toBe("done");

    const fed = JSON.stringify(m2.getCalls());
    expect(fed).toContain("original question"); // 喂回了落盘历史 → 确系从 store 恢复
    expect(fed).not.toContain("IGNORED"); // 冷启动走 continue，没把新 prompt 追加进去
    const after = await store.getPathToLeaf("cold");
    expect(after.length).toBeGreaterThan(seeded.length); // 续上并追加了新消息
    m2.teardown();
  });

  it("does not regress the in-memory sessionFactory path", async () => {
    const model = createFakeModel([{ content: [{ type: "text", text: "ok" }], stopReason: "stop" }]);
    const ctrl = new LifecycleRestart({
      sessionFactory: (im) =>
        new AgentSession({ model, tools: [], ...(im ? { initialMessages: im } : {}) }),
    });
    const res = await ctrl.run("hi");
    expect(res.reason).toBe("done");
    expect(res.retries).toBe(0);
    model.teardown();
  });
});
