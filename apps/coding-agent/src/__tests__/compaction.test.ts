import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeModel } from "@harness-pi/core/testing";
import { createUserMessage } from "@harness-pi/core";
import { createModelSummarizer } from "../compaction.js";
import { createCodingAgent, runAgentPrompt } from "../agent.js";

const dirs: string[] = [];
async function repo(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "hpi-compact-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe("createModelSummarizer", () => {
  it("calls the model once and returns the assistant text as the summary", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "BRIEFING: user wants X; touched a.ts" }], stopReason: "stop" },
    ]);
    const summarize = createModelSummarizer(fake);
    const early = [createUserMessage("do X"), createUserMessage("also Y")];

    const summary = await summarize(early);

    expect(summary).toBe("BRIEFING: user wants X; touched a.ts");
    const calls = fake.getCalls();
    expect(calls).toHaveLength(1); // 一次性 complete
    fake.teardown();
  });

  it("feeds the early messages plus a summary instruction, with no tools", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "sum" }], stopReason: "stop" },
    ]);
    const summarize = createModelSummarizer(fake);

    await summarize([createUserMessage("remember marker-7")]);

    const ctx = fake.getCalls()[0]!;
    const sent = JSON.stringify(ctx.messages);
    expect(sent).toContain("remember marker-7"); // 早期消息进了上下文
    expect(sent).toMatch(/summariz/i); // 附了总结指令
    expect(ctx.tools).toEqual([]); // 总结调用不带工具
    fake.teardown();
  });

  it("concatenates multiple text blocks", async () => {
    const fake = createFakeModel([
      {
        content: [
          { type: "text", text: "part A. " },
          { type: "text", text: "part B." },
        ],
        stopReason: "stop",
      },
    ]);
    const summarize = createModelSummarizer(fake);
    expect(await summarize([createUserMessage("x")])).toBe("part A. part B.");
    fake.teardown();
  });

  it("THROWS on a failed completion (provider error resolves, not throws) so compaction fail-opens", async () => {
    // pi-ai complete() 在 provider 报错时 resolve 出 stopReason:"error"+空 content（不抛）。
    // 若静默返回 ""，compactSummarize 会缓存空摘要并替换早期上下文 → 无声丢历史。必须抛。
    const fake = createFakeModel([{ content: [], throwError: new Error("rate limited") }]);
    const summarize = createModelSummarizer(fake);
    await expect(summarize([createUserMessage("x")])).rejects.toThrow(/summarize failed/i);
    fake.teardown();
  });

  it("THROWS on an empty-but-ok completion (empty summary would wipe context)", async () => {
    const fake = createFakeModel([{ content: [], stopReason: "stop" }]);
    const summarize = createModelSummarizer(fake);
    await expect(summarize([createUserMessage("x")])).rejects.toThrow(/summarize failed/i);
    fake.teardown();
  });
});

describe("createCodingAgent compaction wiring", () => {
  it("no compaction option → getCompactionState undefined, requestCompaction is a no-op", async () => {
    const cwd = await repo();
    const fake = createFakeModel([]);
    const agent = createCodingAgent({ cwd, model: fake });
    expect(agent.getCompactionState()).toBeUndefined();
    expect(() => agent.requestCompaction()).not.toThrow();
    await agent.close();
    fake.teardown();
  });

  it("compaction:{} starts disabled (sentinel threshold); requestCompaction enables it", async () => {
    const cwd = await repo();
    const fake = createFakeModel([]);
    const agent = createCodingAgent({ cwd, model: fake, compaction: {} });
    expect(agent.getCompactionState()?.enabled).toBe(false);

    agent.requestCompaction();
    const after = agent.getCompactionState()!;
    expect(after.enabled).toBe(true);
    expect(after.maxMessages).toBe(after.keepRecent + 1); // 降到最低有效阈值
    await agent.close();
    fake.teardown();
  });

  it("crossing the threshold fires the compaction listener (hook→summarize→listener wired end-to-end)", async () => {
    const cwd = await repo();
    const fake = createFakeModel([]); // 空队列:每次 LLM/summary 调用都拿 fallback 文本
    const agent = createCodingAgent({
      cwd,
      model: fake,
      compaction: { maxMessages: 3, keepRecent: 2 },
    });
    let covered = 0;
    agent.setCompactionListener((n) => {
      covered = n;
    });
    // 第 3 轮的 LLM 调用前,历史已是 [u,a,u,a,u] = 5 条 > 3 → compactSummarize 触发。
    await runAgentPrompt(agent, "one");
    await runAgentPrompt(agent, "two");
    await runAgentPrompt(agent, "three");
    expect(covered).toBe(3); // 被压条数 = 5 - keepRecent(2) = 3

    // 强断言:不只是"summarize 跑了",而是 LLM 真的看到了压缩后的视图(更少的消息 + 摘要消息)。
    // getCalls() 含 summarize 调用 + 各主 turn 调用;找那个看到压缩视图的主 turn。
    const compactedCall = fake
      .getCalls()
      .find((c) => JSON.stringify(c.messages).includes("compacted summary of 3 earlier messages"));
    expect(compactedCall).toBeDefined();
    expect(compactedCall!.messages).toHaveLength(3); // [summary, ...保留的 keepRecent+尾巴] = 1 + (5-3)
    await agent.close();
    fake.teardown();
  });
});
