import { describe, it, expect } from "vitest";
import { AgentSession, createUserMessage } from "@harness-pi/core";
import { createTestContext, createFakeModel } from "@harness-pi/core/testing";
import type { Message } from "@earendil-works/pi-ai";
import { compactSummarize } from "../compact-summarize.js";

function textOf(m: Message): string {
  return typeof m.content === "string"
    ? m.content
    : m.content.map((b) => ("text" in b ? b.text : "")).join("");
}
const m = (t: string): Message => createUserMessage(t);

describe("compactSummarize", () => {
  it("replaces early messages with a summary and keeps the recent tail", async () => {
    const compact = compactSummarize({
      maxMessages: 4,
      keepRecent: 2,
      summarize: (early) => `SUM:${early.length}`,
    });
    const msgs = [m("1"), m("2"), m("3"), m("4"), m("5")]; // 5 > 4 → compact
    const { ctx } = createTestContext();
    const view = await compact.transformMessagesBeforeLlm!(msgs, ctx);

    expect(view).toBeDefined();
    expect(view!.length).toBe(3); // summary + 2 tail
    expect(textOf(view![0]!)).toContain("SUM:3"); // 早期 5-2=3 条被总结
    expect(textOf(view![1]!)).toBe("4");
    expect(textOf(view![2]!)).toBe("5");
  });

  it("does not compact when at or below the threshold (returns undefined = unchanged)", async () => {
    let calls = 0;
    const compact = compactSummarize({
      maxMessages: 4,
      keepRecent: 2,
      summarize: () => {
        calls++;
        return "S";
      },
    });
    const { ctx } = createTestContext();
    expect(await compact.transformMessagesBeforeLlm!([m("1"), m("2"), m("3"), m("4")], ctx)).toBeUndefined();
    expect(calls).toBe(0); // 没超阈值 → 不调 summarize
  });

  it("re-summarizes only when the covered prefix grows by resummarizeEvery (caches otherwise)", async () => {
    let calls = 0;
    const compact = compactSummarize({
      maxMessages: 4,
      keepRecent: 2,
      resummarizeEvery: 2,
      summarize: (early) => {
        calls++;
        return `S${early.length}`;
      },
    });
    const { ctx } = createTestContext();
    const grow = (n: number) => Array.from({ length: n }, (_, i) => m(String(i + 1)));

    const v1 = await compact.transformMessagesBeforeLlm!(grow(5), ctx); // targetCover 3 → summarize
    expect(calls).toBe(1);
    expect(textOf(v1![0]!)).toContain("S3");

    const v2 = await compact.transformMessagesBeforeLlm!(grow(6), ctx); // targetCover 4, 4-3=1 < 2 → reuse
    expect(calls).toBe(1);
    expect(textOf(v2![0]!)).toContain("S3"); // 仍是覆盖 3 的旧 summary
    expect(v2!.length).toBe(4); // [summary] + msgs[3..5] = 1 + 3
    // 内容与顺序：slice 起点 = coveredCount(3)，故 "4" 是被夹带的未总结早期消息、"5"/"6" 才是 tail。
    expect(v2!.slice(1).map(textOf)).toEqual(["4", "5", "6"]);

    const v3 = await compact.transformMessagesBeforeLlm!(grow(7), ctx); // targetCover 5, 5-3=2 >= 2 → re-summarize
    expect(calls).toBe(2);
    expect(textOf(v3![0]!)).toContain("S5");
  });

  it("preserves the recent tail verbatim, including non-user roles", async () => {
    const compact = compactSummarize({ maxMessages: 3, keepRecent: 2, summarize: () => "S" });
    const assistant: Message = {
      role: "assistant",
      content: [{ type: "text", text: "thinking" }],
      api: "x" as never,
      provider: "p",
      model: "mdl",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: 0,
    };
    const toolResult: Message = {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "echo",
      content: [{ type: "text", text: "tool-out" }],
      isError: false,
      timestamp: 0,
    };
    const { ctx } = createTestContext();
    const view = await compact.transformMessagesBeforeLlm!([m("1"), m("2"), assistant, toolResult], ctx);
    expect(view!.length).toBe(3); // summary + 2 tail
    expect(view![1]).toBe(assistant); // 原样引用，未改
    expect(view![2]).toBe(toolResult);
  });

  it("rejects invalid options at construction", () => {
    expect(() => compactSummarize({ maxMessages: 4, keepRecent: 0, summarize: () => "" })).toThrow(/keepRecent/);
    expect(() => compactSummarize({ maxMessages: 2, keepRecent: 2, summarize: () => "" })).toThrow(/maxMessages/);
    expect(() => compactSummarize({ maxMessages: 4, keepRecent: 2, resummarizeEvery: 0, summarize: () => "" })).toThrow(/resummarizeEvery/);
  });

  it("propagates a summarize() error and does not pollute the cache", async () => {
    let calls = 0;
    const compact = compactSummarize({
      maxMessages: 4,
      keepRecent: 2,
      summarize: (early) => {
        calls++;
        if (calls === 1) throw new Error("LLM timeout");
        return `OK:${early.length}`;
      },
    });
    const { ctx } = createTestContext();
    const grow = (n: number) => Array.from({ length: n }, (_, i) => m(String(i + 1)));

    // 第一次 summarize 抛错 → transform reject（错误冒泡，由内核 pipe fail-open 处理）。
    await expect(compact.transformMessagesBeforeLlm!(grow(5), ctx)).rejects.toThrow(/LLM timeout/);
    // cache 未被脏写：下一次成功调用从头算（calls 来到 2、summary 反映本次覆盖数），不是复用半个坏 cache。
    const v = await compact.transformMessagesBeforeLlm!(grow(5), ctx);
    expect(calls).toBe(2);
    expect(textOf(v![0]!)).toContain("OK:3");
  });

  it("end-to-end: a summarize() failure degrades to NO compaction (kernel pipe fail-open), run still completes", async () => {
    // 揭示真实语义：transform hook 抛错被内核 fail-open 吞掉 → 模型收到未压缩的全量消息，run 不中断。
    const initial = [m("h1"), m("a1"), m("h2"), m("a2"), m("h3"), m("a3")]; // 6 条
    const fake = createFakeModel([
      { content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      initialMessages: initial,
      hooks: [
        compactSummarize({
          maxMessages: 4,
          keepRecent: 2,
          summarize: () => {
            throw new Error("summary backend down");
          },
        }),
      ],
    });
    const summary = await session.run("go");

    expect(summary.reason).toBe("done"); // 压缩失败不杀 run
    // fail-open：模型收到未压缩全量（6 初始 + "go" = 7），而不是压缩后的 3 条。
    expect(fake.getCalls()[0]!.messages.length).toBe(7);
    fake.teardown();
  });

  it("default wrap embeds the covered count; a custom summaryText overrides it", async () => {
    const { ctx } = createTestContext();
    const msgs = [m("1"), m("2"), m("3"), m("4"), m("5")]; // targetCover 3

    const dflt = compactSummarize({ maxMessages: 4, keepRecent: 2, summarize: () => "BODY" });
    const v1 = await dflt.transformMessagesBeforeLlm!(msgs, ctx);
    expect(textOf(v1![0]!)).toContain("3 earlier messages"); // coveredCount 填进默认 wrap
    expect(textOf(v1![0]!)).toContain("BODY");

    const custom = compactSummarize({
      maxMessages: 4,
      keepRecent: 2,
      summarize: () => "BODY",
      summaryText: (s, n) => `<<${n}|${s}>>`,
    });
    const v2 = await custom.transformMessagesBeforeLlm!(msgs, ctx);
    expect(textOf(v2![0]!)).toBe("<<3|BODY>>");
  });

  it("end-to-end: the model sees the compacted view while full history persists", async () => {
    const initial = [m("h1"), m("a1"), m("h2"), m("a2"), m("h3"), m("a3")]; // 6 条历史
    const fake = createFakeModel([
      { content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      initialMessages: initial,
      hooks: [compactSummarize({ maxMessages: 4, keepRecent: 2, summarize: () => "RECAP" })],
    });
    await session.run("go"); // _messages = 6 + "go" = 7 > 4 → 压缩 view

    const view = fake.getCalls()[0]!.messages;
    // targetCover = 7 - 2 = 5 → view = [summary, msgs[5], msgs[6]] = [RECAP, "a3", "go"]
    expect(view.length).toBe(3);
    expect(textOf(view[0]!)).toContain("RECAP");
    expect(textOf(view[2]!)).toBe("go");
    // 完整历史未被破坏：6 初始 + "go" + assistant = 8 条仍在 session.messages。
    expect(session.messages.length).toBe(8);
    fake.teardown();
  });
});
