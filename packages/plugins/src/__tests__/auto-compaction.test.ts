import { describe, it, expect } from "vitest";
import { AgentSession, createUserMessage } from "@harness-pi/core";
import { createTestContext, createFakeModel } from "@harness-pi/core/testing";
import type { Message, Tool } from "@earendil-works/pi-ai";
import {
  autoCompaction,
  estimateTokensByChars,
  estimateRequestTokens,
} from "../auto-compaction.js";

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
      tokenCounter: { estimate: ({ messages }) => messages.length * 20 }, // 5 msgs => 100 > 50
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
      tokenCounter: { estimate: () => 10 }, // < 50
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

  it("default estimator counts CJK codepoints as ~1 token each (much higher than chars/4)", () => {
    // 50 个 CJK 字（无 ASCII）：新公式 ≈ 50 token；旧的 chars/4 只会给 ≈ 13，4× 低估（issue #14 的安全 bug）。
    const cjk = "你好世界，这是一段中文。".repeat(5); // 12 字/段 * 5 = 60 码点（含全角逗号/句号）
    const est = estimateTokensByChars([m(cjk)]);
    const charsOver4 = Math.ceil(cjk.length / 4);
    expect(est).toBe(cjk.length); // 每个 CJK 码点 ≈ 1 token
    expect(est).toBeGreaterThan(charsOver4 * 3); // 远高于 chars/4
  });

  it("default estimator counts an image block as a flat conservative estimate (not tiny ref nor huge base64)", () => {
    // 短 ref 风格的 image 块（data 很短）：按字符数会被严重低估；扁平估值兜底 ≈ 1000。
    const imageMsg: Message = {
      role: "user",
      content: [{ type: "image", data: "abc", mimeType: "image/png" }],
      timestamp: 0,
    };
    const est = estimateTokensByChars([imageMsg]);
    expect(est).toBe(1000); // 扁平、保守

    // 内联 base64（data 极长）：若按 data 字符数会疯狂高估；仍是扁平 1000，不随 data 长度膨胀。
    const inlineMsg: Message = {
      role: "user",
      content: [{ type: "image", data: "A".repeat(50_000), mimeType: "image/png" }],
      timestamp: 0,
    };
    expect(estimateTokensByChars([inlineMsg])).toBe(1000);
  });

  it("counts astral (surrogate-pair) CJK as ~1 token/codepoint, not 2 ASCII chars", () => {
    // 𠀀 = U+20000 (CJK Ext B): .length === 2 (a surrogate pair). Iterating by code POINT must
    // count it as one CJK token; the pre-fix .length/regex path counted it as 2 ASCII → undercount.
    const astral = "\u{20000}".repeat(10);
    expect(astral.length).toBe(20); // 20 UTF-16 code units…
    expect([...astral].length).toBe(10); // …but 10 code points
    expect(estimateTokensByChars([m(astral)])).toBe(10); // 10 CJK code points ≈ 10 tokens
  });

  it("counts CJK + ASCII mixed in one text with consistent code-point units", () => {
    // 你好(2 CJK) + " hello "(7 non-CJK) + 世界(2 CJK) + " world"(6 non-CJK)
    // = 4 CJK + ceil(13/4)=4  → 8
    expect(estimateTokensByChars([m("你好 hello 世界 world")])).toBe(8);
  });

  it("adds an image block and a text block in the same message", () => {
    const msg: Message = {
      role: "user",
      content: [
        { type: "image", data: "abc", mimeType: "image/png" },
        { type: "text", text: "caption" }, // 7 ASCII → ceil(7/4) = 2
      ],
      timestamp: 0,
    };
    expect(estimateTokensByChars([msg])).toBe(1002); // 1000 (image) + 2 (text)
  });

  it("counts multiple images per-image (not per-message)", () => {
    const msg: Message = {
      role: "user",
      content: [
        { type: "image", data: "a", mimeType: "image/png" },
        { type: "image", data: "b", mimeType: "image/png" },
        { type: "image", data: "c", mimeType: "image/png" },
      ],
      timestamp: 0,
    };
    expect(estimateTokensByChars([msg])).toBe(3000); // 3 × IMAGE_TOKENS
  });

  it("counts non-text / non-image blocks (e.g. toolCall) via their JSON length", () => {
    const big = {
      role: "assistant",
      content: [{ type: "toolCall", id: "t1", name: "foo", arguments: { x: "y".repeat(40) } }],
      timestamp: 0,
    } as unknown as Message;
    const small = {
      role: "assistant",
      content: [{ type: "toolCall", id: "t1", name: "foo", arguments: { x: "y" } }],
      timestamp: 0,
    } as unknown as Message;
    // the block IS counted (not skipped) and scales with its serialized size
    expect(estimateTokensByChars([small])).toBeGreaterThan(0);
    expect(estimateTokensByChars([big])).toBeGreaterThan(estimateTokensByChars([small]));
  });

  it("handles empty / whitespace / empty-content messages deterministically (no throw)", () => {
    expect(estimateTokensByChars([m("")])).toBe(0);
    expect(estimateTokensByChars([m("   ")])).toBe(1); // ceil(3/4)
    const emptyContent: Message = { role: "user", content: [], timestamp: 0 };
    expect(estimateTokensByChars([emptyContent])).toBe(0);
  });

  it("does not compact when messages.length === keepRecent (nothing to compress, no summarize)", async () => {
    let calls = 0;
    const compact = autoCompaction({
      maxContextTokens: 1,
      triggerRatio: 1,
      keepRecent: 3,
      tokenCounter: { estimate: () => 999 }, // over threshold → would compact if it could
      summarize: () => {
        calls++;
        return "S";
      },
    });
    const { ctx } = createTestContext();
    // exactly keepRecent messages: the tail IS everything → nothing to summarize
    expect(await compact.transformMessagesBeforeLlm!(grow(3), ctx)).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("caches the summary by covered prefix until it grows by resummarizeEvery", async () => {
    let calls = 0;
    const compact = autoCompaction({
      maxContextTokens: 1,
      triggerRatio: 1,
      keepRecent: 2,
      resummarizeEvery: 2,
      tokenCounter: { estimate: () => 999 }, // always over threshold -> always evaluate
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
          tokenCounter: { estimate: ({ messages }) => messages.length * 50 }, // 7 msgs * 50 = 350 > 80
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

  it("end-to-end: a summarize() failure degrades to NO compaction (kernel pipe fail-open), run still completes", async () => {
    // #13: summarize 抛错 → transform 被内核 fail-open 吞掉 → 模型收到未压缩全量、run 不中断、history 不变。
    const initial = [m("h1"), m("a1"), m("h2"), m("a2"), m("h3"), m("a3")]; // 6
    const fake = createFakeModel([
      { content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      initialMessages: initial,
      hooks: [
        autoCompaction({
          maxContextTokens: 100,
          triggerRatio: 0.8, // threshold 80
          keepRecent: 2,
          tokenCounter: { estimate: ({ messages }) => messages.length * 50 }, // 7 msgs * 50 = 350 > 80 → 会尝试压缩
          summarize: () => {
            throw new Error("summary backend down");
          },
        }),
      ],
    });
    const summary = await session.run("go");

    expect(summary.reason).toBe("done"); // 压缩失败不杀 run（不是 "error"）
    // fail-open：模型收到未压缩全量（6 初始 + "go" = 7），而不是压缩后的视图。
    expect(fake.getCalls()[0]!.messages.length).toBe(7);
    expect(textOf(fake.getCalls()[0]!.messages[6]!)).toBe("go");
    // 完整历史未被破坏：6 初始 + "go" + assistant = 8。
    expect(session.messages.length).toBe(8);
    fake.teardown();
  });

  it("X1: triggers earlier when tools are big (messages small but tool schema large)", async () => {
    // 仅 2 条小消息：messages-only 估算远低于阈值、绝不触发；但带上大 tool schema 的请求级估算越过阈值 → 触发。
    // 这正是 D0 53-vs-381 低估 7x 的修复方向：tool schema 每请求随发，必须计入。
    const messages = [m("hi"), m("ok"), m("more"), m("again")]; // 小
    const bigTool: Tool = {
      name: "submit_evidence",
      description: "Submit structured evidence. ".repeat(40),
      parameters: {
        type: "object",
        properties: {
          questionId: { type: "string", description: "the question id ".repeat(20) },
          evidence: { type: "string", description: "the evidence body ".repeat(20) },
        },
        required: ["questionId", "evidence"],
      },
    } as Tool;

    // 阈值卡在「messages-only 之上、含 tools 之下」之间。
    const messagesOnly = estimateTokensByChars(messages);
    const withTools = estimateRequestTokens({ messages, tools: [bigTool] });
    expect(withTools).toBeGreaterThan(messagesOnly); // sanity：tools 确实抬高了估值
    const threshold = (messagesOnly + withTools) / 2;

    let summarized = false;
    const compact = autoCompaction({
      maxContextTokens: threshold,
      triggerRatio: 1, // threshold = maxContextTokens
      keepRecent: 1,
      summarize: () => {
        summarized = true;
        return "RECAP";
      },
    });

    // ctx 暴露 bigTool：autoCompaction 经 ctx.config.tools 把它计入 → 触发。
    const { ctx } = createTestContext({ config: { tools: [bigTool] } });
    const view = await compact.transformMessagesBeforeLlm!(messages, ctx);
    expect(view).toBeDefined(); // 改进估算触发了
    expect(summarized).toBe(true);

    // 对照：同样 messages、同样阈值，但 ctx 没有 tools（messages-only 等价）→ 不触发。
    let summarized2 = false;
    const compact2 = autoCompaction({
      maxContextTokens: threshold,
      triggerRatio: 1,
      keepRecent: 1,
      summarize: () => {
        summarized2 = true;
        return "RECAP";
      },
    });
    const { ctx: ctxNoTools } = createTestContext(); // config.tools = []
    expect(await compact2.transformMessagesBeforeLlm!(messages, ctxNoTools)).toBeUndefined();
    expect(summarized2).toBe(false);
  });

  it("X1: a custom tokenCounter overrides the default", async () => {
    const calls: number[] = [];
    const compact = autoCompaction({
      maxContextTokens: 100,
      triggerRatio: 1, // threshold 100
      keepRecent: 1,
      tokenCounter: {
        estimate: ({ messages }) => {
          calls.push(messages.length);
          return 200; // 永远超阈值 → 触发
        },
      },
      summarize: () => "RECAP",
    });
    const { ctx } = createTestContext();
    const view = await compact.transformMessagesBeforeLlm!(grow(5), ctx);
    expect(view).toBeDefined();
    expect(calls.length).toBeGreaterThan(0); // 注入的 counter 真的被调用
  });

  // ───────────────── X2(#57): per-model 有效窗口 + 分层 buffer ─────────────────

  const modelCfg = (contextWindow: number, maxTokens: number) => ({
    model: { id: "m", provider: "p", contextWindow, maxTokens },
  });

  it("X2: window mode threshold = contextWindow − reserveForOutput − safetyBuffer", async () => {
    // contextWindow=10000, reserveForOutput=4096(默认 min(maxTokens,4096)), safetyBuffer=500 → 阈值 5404。
    let summarized = false;
    const compact = autoCompaction({
      // 不给 maxContextTokens → 走窗口路径
      keepRecent: 1,
      safetyBuffer: 500,
      tokenCounter: { estimate: () => 5405 }, // 5404 < 5405 → 越界 → 触发
      summarize: () => {
        summarized = true;
        return "RECAP";
      },
    });
    const { ctx } = createTestContext({ config: modelCfg(10_000, 8000) }); // maxTokens=8000 → reserve=min(8000,4096)=4096
    const view = await compact.transformMessagesBeforeLlm!(grow(3), ctx);
    expect(view).toBeDefined();
    expect(summarized).toBe(true);
  });

  it("X2: window mode does NOT trigger at or below the effective window", async () => {
    // 阈值 = 10000 − 4096 − 0 = 5904。估算正好 = 5904（边界，<= 不触发）。
    let calls = 0;
    const compact = autoCompaction({
      keepRecent: 1,
      tokenCounter: { estimate: () => 5904 },
      summarize: () => {
        calls++;
        return "S";
      },
    });
    const { ctx } = createTestContext({ config: modelCfg(10_000, 4096) });
    expect(await compact.transformMessagesBeforeLlm!(grow(5), ctx)).toBeUndefined();
    expect(calls).toBe(0);

    // 阈值 + 1 → 触发。
    const compact2 = autoCompaction({
      keepRecent: 1,
      tokenCounter: { estimate: () => 5905 },
      summarize: () => "S",
    });
    expect(await compact2.transformMessagesBeforeLlm!(grow(5), ctx)).toBeDefined();
  });

  it("X2: reserveForOutput / safetyBuffer overrides lower the effective window", async () => {
    // 显式 reserveForOutput=1000, safetyBuffer=2000 → 阈值 = 10000 − 1000 − 2000 = 7000。
    const compact = autoCompaction({
      keepRecent: 1,
      reserveForOutput: 1000,
      safetyBuffer: 2000,
      tokenCounter: { estimate: () => 7000 }, // == 阈值 → 不触发
      summarize: () => "S",
    });
    const { ctx } = createTestContext({ config: modelCfg(10_000, 4096) });
    expect(await compact.transformMessagesBeforeLlm!(grow(5), ctx)).toBeUndefined();

    const compact2 = autoCompaction({
      keepRecent: 1,
      reserveForOutput: 1000,
      safetyBuffer: 2000,
      tokenCounter: { estimate: () => 7001 }, // 越界 1 → 触发
      summarize: () => "S",
    });
    expect(await compact2.transformMessagesBeforeLlm!(grow(5), ctx)).toBeDefined();
  });

  it("X2: reserveForOutput defaults to min(model.maxTokens, 4096)", async () => {
    // maxTokens=2000 < 4096 → reserve=2000 → 阈值 = 10000 − 2000 = 8000。
    const compactSmall = autoCompaction({
      keepRecent: 1,
      tokenCounter: { estimate: () => 8001 },
      summarize: () => "S",
    });
    const { ctx: ctxSmall } = createTestContext({ config: modelCfg(10_000, 2000) });
    expect(await compactSmall.transformMessagesBeforeLlm!(grow(5), ctxSmall)).toBeDefined(); // 8001 > 8000

    const compactSmall2 = autoCompaction({
      keepRecent: 1,
      tokenCounter: { estimate: () => 8000 },
      summarize: () => "S",
    });
    expect(await compactSmall2.transformMessagesBeforeLlm!(grow(5), ctxSmall)).toBeUndefined(); // 8000 == 阈值

    // maxTokens=100000 > 4096 → reserve 封顶 4096 → 阈值 = 10000 − 4096 = 5904。
    const compactBig = autoCompaction({
      keepRecent: 1,
      tokenCounter: { estimate: () => 5905 },
      summarize: () => "S",
    });
    const { ctx: ctxBig } = createTestContext({ config: modelCfg(10_000, 100_000) });
    expect(await compactBig.transformMessagesBeforeLlm!(grow(5), ctxBig)).toBeDefined(); // 5905 > 5904
  });

  it("X2: explicit maxContextTokens takes priority over the window path (backward compat)", async () => {
    // 即便 ctx 暴露了 contextWindow，给了 maxContextTokens 就走百分比路径，窗口路径被忽略。
    // maxContextTokens=100, triggerRatio=1 → 阈值 100；窗口阈值会是 10000−4096=5904（若误用窗口路径则不触发）。
    let summarized = false;
    const compact = autoCompaction({
      maxContextTokens: 100,
      triggerRatio: 1,
      keepRecent: 1,
      tokenCounter: { estimate: () => 200 }, // > 100(百分比) 但 < 5904(窗口) → 只有走百分比才触发
      summarize: () => {
        summarized = true;
        return "S";
      },
    });
    const { ctx } = createTestContext({ config: modelCfg(10_000, 4096) });
    const view = await compact.transformMessagesBeforeLlm!(grow(5), ctx);
    expect(view).toBeDefined(); // 走了百分比路径
    expect(summarized).toBe(true);
  });

  it("X2: contextWindow unavailable (0) and no maxContextTokens → no compaction (no threshold)", async () => {
    let calls = 0;
    const compact = autoCompaction({
      keepRecent: 1,
      tokenCounter: { estimate: () => 999_999 }, // 巨大，但算不出阈值
      summarize: () => {
        calls++;
        return "S";
      },
    });
    const { ctx } = createTestContext({ config: modelCfg(0, 0) }); // contextWindow=0
    expect(await compact.transformMessagesBeforeLlm!(grow(5), ctx)).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("X2: rejects negative reserveForOutput / safetyBuffer; allows omitting maxContextTokens", () => {
    expect(() =>
      autoCompaction({ reserveForOutput: -1, summarize: () => "" }),
    ).toThrow(/reserveForOutput/);
    expect(() =>
      autoCompaction({ safetyBuffer: -1, summarize: () => "" }),
    ).toThrow(/safetyBuffer/);
    // maxContextTokens 显式给 0 仍报错（区分「缺省」与「非法显式值」）。
    expect(() => autoCompaction({ maxContextTokens: 0, summarize: () => "" })).toThrow(
      /maxContextTokens/,
    );
    // 完全不给 maxContextTokens（窗口模式）→ 构造不报错。
    expect(() => autoCompaction({ summarize: () => "" })).not.toThrow();
  });

  it("X2 end-to-end: window mode from a real session's model.contextWindow", async () => {
    // fake model: contextWindow=200000, maxTokens=4096 → 阈值 = 200000 − 4096 = 195904。
    // 注入一个超大 estimate(走 tokenCounter)，让请求体积越过窗口阈值 → 真 session 触发压缩。
    const initial = [m("h1"), m("a1"), m("h2"), m("a2"), m("h3"), m("a3")]; // 6
    const fake = createFakeModel([{ content: [{ type: "text", text: "ok" }], stopReason: "stop" }]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      initialMessages: initial,
      hooks: [
        autoCompaction({
          // 不给 maxContextTokens → 用 model.contextWindow
          keepRecent: 2,
          tokenCounter: { estimate: () => 200_000 }, // > 195904 → 触发
          summarize: () => "RECAP",
        }),
      ],
    });
    await session.run("go");

    const view = fake.getCalls()[0]!.messages;
    expect(view.length).toBe(3); // [summary, "a3", "go"]
    expect(textOf(view[0]!)).toContain("RECAP");
    expect(session.messages.length).toBe(8); // full history intact
    fake.teardown();
  });
});
