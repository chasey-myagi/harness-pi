/**
 * S4 — SubAgentRegistry：subAgent 续聊句柄的 bounded registry 行为测试。
 *
 * 全部经公共接口断言可观测行为：用 core `testing.ts` 的 fake-model + 真 `AgentSession` 当 sessionFactory，
 * 由 `subAgentTool({ onSpawn: registry.retain })` 驱动 spawn，再用 `registry.continueSubAgent` 续聊。
 * TTL/LRU 这类时间相关用 `vi.spyOn(Date, "now")` 注入确定性时钟（registry 用 Date.now() 计时），
 * 不靠真实 sleep → 无时序竞争。
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { AgentSession } from "@harness-pi/core";
import { createFakeModel, createTestContext } from "@harness-pi/core/testing";
import { subAgentTool, SubAgentRegistry } from "../controllers/index.js";

function blockText(content: unknown): string {
  return Array.isArray(content)
    ? content.map((b) => ("text" in b ? (b as { text: string }).text : "")).join("")
    : String(content ?? "");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SubAgentRegistry — continue handle", () => {
  it("resumes a retained sub-agent and the continuation sees prior context", async () => {
    // 子 fake：首轮回 "first"，续聊回 "second"。续聊时该子 session 的 messages 必含首轮 user prompt + 首轮回答，
    // 证明续聊看到了之前的上下文（不是全新会话）。
    const subFake = createFakeModel([
      { content: [{ type: "text", text: "first" }], stopReason: "stop" },
      { content: [{ type: "text", text: "second" }], stopReason: "stop" },
    ]);
    const registry = new SubAgentRegistry();
    const tool = subAgentTool({
      sessionFactory: () => new AgentSession({ model: subFake, tools: [] }),
      onSpawn: registry.retain,
    });
    const { ctx } = createTestContext();
    const spawn = await tool.execute({ task: "do the first thing" }, ctx, new AbortController().signal);
    const details = spawn.details as { subAgent?: { sessionId?: string } };
    const id = details.subAgent!.sessionId!;
    expect(registry.size).toBe(1);

    const cont = await registry.continueSubAgent(id, "now the second thing");
    expect(blockText(cont.content)).toContain("second");
    // 续聊结果 shape 与 spawn 同形：details.subAgent 含同一 sessionId。
    const contDetails = cont.details as { subAgent?: { sessionId?: string } };
    expect(contDetails.subAgent?.sessionId).toBe(id);

    // 续聊时 fake 收到的最后一个 context 应包含首轮的 user prompt + 首轮 assistant 回答 → 看见了之前上下文。
    const lastCtx = subFake.getCalls().at(-1)!;
    const ctxText = JSON.stringify(lastCtx.messages);
    expect(ctxText).toContain("do the first thing");
    expect(ctxText).toContain("first");
    expect(ctxText).toContain("now the second thing");
    subFake.teardown();
  });

  it("evicts the LRU entry once maxRetained is exceeded", async () => {
    // maxRetained=2：spawn 3 个子 session（每个独立 fake/session）。第 3 个进来时超上限 → 驱逐最久未用的（第 1 个）。
    const fakes = [0, 1, 2].map(() =>
      createFakeModel([{ content: [{ type: "text", text: "ok" }], stopReason: "stop" }]),
    );
    let i = 0;
    const registry = new SubAgentRegistry({ maxRetained: 2 });
    const tool = subAgentTool({
      sessionFactory: () => new AgentSession({ model: fakes[i++]!, tools: [] }),
      onSpawn: registry.retain,
    });
    const { ctx } = createTestContext();
    const sig = new AbortController().signal;
    const ids: string[] = [];
    for (const task of ["a", "b", "c"]) {
      const r = await tool.execute({ task }, ctx, sig);
      ids.push((r.details as { subAgent: { sessionId: string } }).subAgent.sessionId);
    }
    expect(registry.size).toBe(2);
    // 第 1 个（最久未用）被 LRU 驱逐 → 续聊报错；第 2、3 个仍在。
    await expect(registry.continueSubAgent(ids[0]!, "x")).rejects.toThrow(/no retained sub-agent/);
    // 给后两个补一条续聊脚本再验证它们仍可续。
    fakes[1]!.push({ content: [{ type: "text", text: "b2" }], stopReason: "stop" });
    fakes[2]!.push({ content: [{ type: "text", text: "c2" }], stopReason: "stop" });
    expect(blockText((await registry.continueSubAgent(ids[1]!, "x")).content)).toContain("b2");
    expect(blockText((await registry.continueSubAgent(ids[2]!, "x")).content)).toContain("c2");
    fakes.forEach((f) => f.teardown());
  });

  it("evicts entries that have outlived ttlMs", async () => {
    const now = { v: 1_000 };
    vi.spyOn(Date, "now").mockImplementation(() => now.v);
    const subFake = createFakeModel([{ content: [{ type: "text", text: "ok" }], stopReason: "stop" }]);
    const registry = new SubAgentRegistry({ ttlMs: 100 });
    const tool = subAgentTool({
      sessionFactory: () => new AgentSession({ model: subFake, tools: [] }),
      onSpawn: registry.retain,
    });
    const { ctx } = createTestContext();
    const r = await tool.execute({ task: "t" }, ctx, new AbortController().signal);
    const id = (r.details as { subAgent: { sessionId: string } }).subAgent.sessionId;
    expect(registry.size).toBe(1);

    // 时钟推进超过 ttl → 下一次 continue 前的 TTL 扫描把它驱逐 → 报「未保留」。
    now.v += 101;
    await expect(registry.continueSubAgent(id, "x")).rejects.toThrow(/no retained sub-agent/);
    expect(registry.size).toBe(0);
    subFake.teardown();
  });

  it("clears all retained sessions when the parent signal aborts (no leak)", async () => {
    const subFake = createFakeModel([
      { content: [{ type: "text", text: "1" }], stopReason: "stop" },
      { content: [{ type: "text", text: "2" }], stopReason: "stop" },
    ]);
    const parent = new AbortController();
    const registry = new SubAgentRegistry({ parentSignal: parent.signal });
    const tool = subAgentTool({
      sessionFactory: () => new AgentSession({ model: subFake, tools: [] }),
      onSpawn: registry.retain,
    });
    const { ctx } = createTestContext();
    const r = await tool.execute({ task: "a" }, ctx, new AbortController().signal);
    const id = (r.details as { subAgent: { sessionId: string } }).subAgent.sessionId;
    expect(registry.size).toBe(1);

    parent.abort();
    expect(registry.size).toBe(0); // 全清空 → 句柄不在 abort 后泄漏
    await expect(registry.continueSubAgent(id, "b")).rejects.toThrow(/no retained sub-agent/);
    subFake.teardown();
  });

  it("throws a clear error for an unknown / never-retained id", async () => {
    const registry = new SubAgentRegistry();
    await expect(registry.continueSubAgent("nope", "x")).rejects.toThrow(
      /no retained sub-agent for id "nope"/,
    );
  });
});
