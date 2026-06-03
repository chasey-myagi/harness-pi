import { describe, it, expect } from "vitest";
import { AgentSession, createUserMessage } from "@harness-pi/core";
import { createTestContext, createFakeModel } from "@harness-pi/core/testing";
import type { Message } from "@mariozechner/pi-ai";
import { autoCompaction, estimateTokensByChars } from "../auto-compaction.js";

function textOf(m: Message): string {
  return typeof m.content === "string"
    ? m.content
    : m.content.map((b) => ("text" in b ? b.text : "")).join("");
}
const m = (t: string): Message => createUserMessage(t);
const grow = (n: number) => Array.from({ length: n }, (_, i) => m(String(i + 1)));

describe("autoCompaction", () => {
  it("compacts once estimated tokens exceed the threshold", async () => {
    let early: Message[] | null = null;
    const compact = autoCompaction({
      maxContextTokens: 100,
      triggerRatio: 0.5, // threshold = 50
      keepRecent: 2,
      estimateTokens: (msgs) => msgs.length * 20, // 5 msgs => 100 > 50
      summarize: (e) => {
        early = e;
        return `SUM:${e.length}`;
      },
    });
    const { ctx } = createTestContext();
    const view = await compact.transformMessagesBeforeLlm!(grow(5), ctx);

    expect(view).toBeDefined();
    expect(view!.length).toBe(3); // summary + 2 tail
    expect(early!.length).toBe(3); // 5 - keepRecent(2)
    expect(textOf(view![0]!)).toContain("SUM:3");
    expect(view!.slice(1).map(textOf)).toEqual(["4", "5"]);
  });

  it("does not compact below the token threshold (returns undefined, summarize not called)", async () => {
    let calls = 0;
    const compact = autoCompaction({
      maxContextTokens: 100,
      triggerRatio: 0.5, // threshold 50
      keepRecent: 2,
      estimateTokens: () => 10, // < 50
      summarize: () => {
        calls++;
        return "S";
      },
    });
    const { ctx } = createTestContext();
    expect(await compact.transformMessagesBeforeLlm!(grow(8), ctx)).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("default estimator counts message text (chars/4) and triggers on big messages", async () => {
    const big = (n: number) => Array.from({ length: n }, () => m("x".repeat(100)));
    // 5 * 100 chars = 500 chars ~= 125 tokens; threshold = 100 * 0.8 = 80 -> triggers
    const compact = autoCompaction({
      maxContextTokens: 100,
      keepRecent: 2,
      summarize: (e) => `S${e.length}`,
    });
    const { ctx } = createTestContext();
    expect(estimateTokensByChars(big(5))).toBeGreaterThan(80);
    const view = await compact.transformMessagesBeforeLlm!(big(5), ctx);
    expect(view).toBeDefined();
    expect(view!.length).toBe(3);
  });

  it("caches the summary by covered prefix until it grows by resummarizeEvery", async () => {
    let calls = 0;
    const compact = autoCompaction({
      maxContextTokens: 1,
      triggerRatio: 1,
      keepRecent: 2,
      resummarizeEvery: 2,
      estimateTokens: () => 999, // always over threshold -> always evaluate
      summarize: (e) => {
        calls++;
        return `S${e.length}`;
      },
    });
    const { ctx } = createTestContext();

    const v1 = await compact.transformMessagesBeforeLlm!(grow(5), ctx); // cover 3 -> summarize
    expect(calls).toBe(1);
    expect(textOf(v1![0]!)).toContain("S3");

    await compact.transformMessagesBeforeLlm!(grow(6), ctx); // cover 4, 4-3=1 < 2 -> reuse
    expect(calls).toBe(1);

    const v3 = await compact.transformMessagesBeforeLlm!(grow(7), ctx); // cover 5, 5-3=2 >= 2 -> recompute
    expect(calls).toBe(2);
    expect(textOf(v3![0]!)).toContain("S5");
  });

  it("rejects invalid options at construction", () => {
    expect(() => autoCompaction({ maxContextTokens: 0, summarize: () => "" })).toThrow(/maxContextTokens/);
    expect(() => autoCompaction({ maxContextTokens: 100, triggerRatio: 0, summarize: () => "" })).toThrow(/triggerRatio/);
    expect(() => autoCompaction({ maxContextTokens: 100, triggerRatio: 1.5, summarize: () => "" })).toThrow(/triggerRatio/);
    expect(() => autoCompaction({ maxContextTokens: 100, keepRecent: 0, summarize: () => "" })).toThrow(/keepRecent/);
    expect(() => autoCompaction({ maxContextTokens: 100, resummarizeEvery: 0, summarize: () => "" })).toThrow(/resummarizeEvery/);
  });

  it("abortOnOverflow: aborts with a compaction: prefix only when enabled", () => {
    const off = autoCompaction({ maxContextTokens: 100, summarize: () => "" });
    const h1 = createTestContext();
    off.onContextOverflow!({ turnIdx: 1, stopReason: "length", messageCount: 50 }, h1.ctx);
    expect(h1.abortReasons).toEqual([]);

    const on = autoCompaction({ maxContextTokens: 100, summarize: () => "", abortOnOverflow: true });
    const h2 = createTestContext();
    on.onContextOverflow!({ turnIdx: 3, stopReason: "error", messageCount: 99 }, h2.ctx);
    expect(h2.abortReasons).toHaveLength(1);
    expect(h2.abortReasons[0]).toMatch(/^compaction:/);
  });

  it("end-to-end: the model sees the token-compacted view while full history persists", async () => {
    const initial = [m("h1"), m("a1"), m("h2"), m("a2"), m("h3"), m("a3")]; // 6
    const fake = createFakeModel([{ content: [{ type: "text", text: "ok" }], stopReason: "stop" }]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      initialMessages: initial,
      hooks: [
        autoCompaction({
          maxContextTokens: 100,
          triggerRatio: 0.8, // threshold 80
          keepRecent: 2,
          estimateTokens: (msgs) => msgs.length * 50, // 7 msgs * 50 = 350 > 80
          summarize: () => "RECAP",
        }),
      ],
    });
    await session.run("go"); // view = 6 initial + "go" = 7 -> compact

    const view = fake.getCalls()[0]!.messages;
    expect(view.length).toBe(3); // [summary, "a3", "go"]
    expect(textOf(view[0]!)).toContain("RECAP");
    expect(textOf(view[2]!)).toBe("go");
    expect(session.messages.length).toBe(8); // full history intact (6 + "go" + assistant)
    fake.teardown();
  });
});
