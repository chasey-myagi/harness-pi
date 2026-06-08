import { describe, it, expect } from "vitest";
import { AgentSession, createUserMessage } from "@harness-pi/core";
import { createTestContext, createFakeModel } from "@harness-pi/core/testing";
import type { Message } from "@earendil-works/pi-ai";
import { microcompact } from "../microcompact.js";

function textOf(m: Message): string {
  return typeof m.content === "string"
    ? m.content
    : m.content.map((b) => ("text" in b ? b.text : "")).join("");
}

/** 造一条 toolResult message。 */
function tr(toolName: string, text: string, ts = 0): Message {
  return {
    role: "toolResult",
    toolCallId: `c-${Math.random()}`,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: ts,
  };
}

describe("microcompact", () => {
  it("keeps the most recent N tool results verbatim, clears older whitelisted ones with a named placeholder", () => {
    // 20 条 'read' 的 toolResult，keepRecent=5；triggerTokens 极小确保触发、targetTokens 极小确保清到最多。
    const msgs: Message[] = Array.from({ length: 20 }, (_, i) =>
      tr("read", `RESULT_${i}_` + "x".repeat(40)),
    );
    const compact = microcompact({
      compactableTools: ["read"],
      triggerTokens: 1,
      targetTokens: 1,
      keepRecent: 5,
    });
    const { ctx } = createTestContext();
    const view = compact.transformMessagesBeforeLlm!(msgs, ctx) as Message[];

    expect(view).toBeDefined();
    // 最近 5 条原文保留
    for (let i = 15; i < 20; i++) {
      expect(textOf(view[i]!)).toBe(textOf(msgs[i]!));
    }
    // 其余 15 条被占位符替换，且占位符含工具名
    for (let i = 0; i < 15; i++) {
      const t = textOf(view[i]!);
      expect(t).toContain("microcompact");
      expect(t).toContain("read"); // 工具名
      expect(t).not.toContain("RESULT_"); // 原文已清
    }
  });

  it("triggers on token volume even with few-but-huge results", () => {
    // 只有 3 条，但单条巨大：按条数测不出，按体积能触发。keepRecent=1 → 留最后 1 条。
    const msgs: Message[] = [
      tr("read", "A".repeat(4000)),
      tr("read", "B".repeat(4000)),
      tr("read", "C".repeat(40)), // 最近，保留
    ];
    const compact = microcompact({
      compactableTools: new Set(["read"]),
      triggerTokens: 500, // 估算 (4000+4000)/4 ≈ 2000 > 500 → 触发
      targetTokens: 100,
      keepRecent: 1,
    });
    const { ctx } = createTestContext();
    const view = compact.transformMessagesBeforeLlm!(msgs, ctx) as Message[];

    expect(view).toBeDefined();
    expect(textOf(view[0]!)).toContain("microcompact"); // 巨大旧条被清
    expect(textOf(view[1]!)).toContain("microcompact");
    expect(textOf(view[2]!)).toBe("C".repeat(40)); // 最近 1 条原文保留
  });

  it("stops clearing once target volume is reached (does not clear everything)", () => {
    // 5 条各 ~1000 tokens（estimateTokensByChars ≈ chars/4），keepRecent=0。总 ≈ 5000。
    // trigger=3000（5000 > 3000 → 触发）；target=3000 → 从最旧逐条清并重估，降到 ≤3000 即停。
    // 契约 = 「清到目标即停、绝不全清」；断言**不耦合估算器精确算术**（清了几条随 rounding 可能微变，
    // 真正的不变量是 0 < cleared < 5、且最近一条（早停必发生在清到它之前）幸存。）
    const msgs: Message[] = Array.from({ length: 5 }, () => tr("read", "z".repeat(4000)));
    const compact = microcompact({
      compactableTools: ["read"],
      triggerTokens: 3000, // 低于总体积 → 触发
      targetTokens: 3000, // 清到 ≤3000 即停
      keepRecent: 0,
    });
    const { ctx } = createTestContext();
    const view = compact.transformMessagesBeforeLlm!(msgs, ctx) as Message[];

    expect(view).toBeDefined();
    const clearedCount = view.filter((m) => textOf(m).includes("microcompact")).length;
    expect(clearedCount).toBeGreaterThan(0); // 触发并清了一些
    expect(clearedCount).toBeLessThan(5); // 但绝不全清——「清到目标为止」语义
    expect(textOf(view[4]!)).toBe("z".repeat(4000)); // 最近一条必然幸存（早停发生在清到它之前），精确比对
  });

  it("leaves non-whitelisted tool results, assistant reasoning and user messages untouched", () => {
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: "thinking about it" }],
      api: "x",
      provider: "x",
      model: "x",
      usage: {},
      stopReason: "stop",
      timestamp: 0,
    } as unknown as Message;
    const msgs: Message[] = [
      createUserMessage("user question " + "q".repeat(2000)),
      assistant,
      tr("bash", "BASH_OUTPUT " + "b".repeat(2000)), // 非白名单
      tr("read", "READ_OUTPUT " + "r".repeat(2000)), // 白名单、旧
      tr("read", "RECENT"), // 最近，保留
    ];
    const compact = microcompact({
      compactableTools: ["read"],
      triggerTokens: 1,
      targetTokens: 1,
      keepRecent: 1,
    });
    const { ctx } = createTestContext();
    const view = compact.transformMessagesBeforeLlm!(msgs, ctx) as Message[];

    expect(view).toBeDefined();
    expect(textOf(view[0]!)).toContain("user question"); // user 不动
    expect(textOf(view[1]!)).toBe("thinking about it"); // assistant 不动
    expect(textOf(view[2]!)).toContain("BASH_OUTPUT"); // 非白名单 toolResult 不动
    expect(textOf(view[3]!)).toContain("microcompact"); // 白名单旧条被清
    expect(textOf(view[3]!)).toContain("read");
    expect(textOf(view[4]!)).toBe("RECENT"); // 最近保留
  });

  it("gapMinutes: clears aggressively when the cache is cold even if volume is small", () => {
    // 体积很小（不会按 token 触发），但最后一条 timestamp 距 now 超过 gapMinutes → 仍清白名单旧条。
    const t0 = 1_000_000;
    const msgs: Message[] = [
      tr("read", "old1", t0),
      tr("read", "old2", t0),
      tr("read", "recent", t0 + 1000),
    ];
    const compact = microcompact({
      compactableTools: ["read"],
      triggerTokens: 1_000_000, // 极大 → 绝不会按体积触发
      keepRecent: 1,
      gapMinutes: 5,
      now: () => t0 + 6 * 60_000, // 距最后一条 timestamp(t0+1000) 约 6 分钟 > 5
    });
    const { ctx } = createTestContext();
    const view = compact.transformMessagesBeforeLlm!(msgs, ctx) as Message[];

    expect(view).toBeDefined();
    expect(textOf(view[0]!)).toContain("microcompact"); // gap 触发，旧条被清
    expect(textOf(view[1]!)).toContain("microcompact");
    expect(textOf(view[2]!)).toBe("recent"); // 最近保留
  });

  it("gapMinutes (cold cache) clears ALL clearable, ignoring the targetTokens early-stop", () => {
    // 区分 cold-cache 路径与 volume 路径:triggerTokens 极大 → volume 永不触发(只有 cold 路径会动);
    // targetTokens=3000(若 cold 误用了体积早停,会停在 ~3 条);keepRecent=0(5 条全可清);gap 超阈值 → cold。
    // cold 路径**无早停**,应把 5 条全清。防回归:若给 cold 加上 targetTokens 早停(或从 volume 去掉),清的就不足 5。
    const t0 = 1_000_000;
    const msgs: Message[] = Array.from({ length: 5 }, () => tr("read", "z".repeat(4000), t0));
    const compact = microcompact({
      compactableTools: ["read"],
      triggerTokens: 1_000_000, // volume 路径永不触发
      targetTokens: 3000, // 若 cold 误用早停会停在 ~3 条
      keepRecent: 0,
      gapMinutes: 5,
      now: () => t0 + 6 * 60_000, // 距末条 6 分钟 > 5 → cold
    });
    const { ctx } = createTestContext();
    const view = compact.transformMessagesBeforeLlm!(msgs, ctx) as Message[];

    expect(view).toBeDefined();
    const cleared = view.filter((m) => textOf(m).includes("microcompact")).length;
    expect(cleared).toBe(5); // cold 路径全清,不受 targetTokens 早停约束
  });

  it("keepRecent ranks by toolResult position, skipping interspersed non-whitelisted results", () => {
    // 布局:read(旧) / bash(非白名单,夹中间) / read(旧) / read(最近)。keepRecent=1 只保护最近 1 条 toolResult。
    // 证明 keepRecent 按 toolResult 序位(非 raw index)算,夹中间的 bash 既不被清、也不占保护名额。
    const msgs: Message[] = [
      tr("read", "OLD1 " + "x".repeat(2000)),
      tr("bash", "BASH " + "b".repeat(2000)), // 非白名单
      tr("read", "OLD2 " + "y".repeat(2000)),
      tr("read", "RECENT"), // 最近 toolResult,keepRecent=1 保护
    ];
    const compact = microcompact({
      compactableTools: ["read"],
      triggerTokens: 1,
      targetTokens: 1,
      keepRecent: 1,
    });
    const { ctx } = createTestContext();
    const view = compact.transformMessagesBeforeLlm!(msgs, ctx) as Message[];

    expect(view).toBeDefined();
    expect(textOf(view[0]!)).toContain("microcompact"); // OLD1 清
    expect(textOf(view[1]!)).toContain("BASH"); // 非白名单 toolResult 不动
    expect(textOf(view[2]!)).toContain("microcompact"); // OLD2 清(夹中间的 bash 没让它逃过保护名额)
    expect(textOf(view[3]!)).toBe("RECENT"); // 最近保留
  });

  it("gapMinutes: does NOT trigger when within the gap window and volume small", () => {
    const t0 = 1_000_000;
    const msgs: Message[] = [tr("read", "a", t0), tr("read", "b", t0), tr("read", "c", t0)];
    const compact = microcompact({
      compactableTools: ["read"],
      triggerTokens: 1_000_000,
      keepRecent: 1,
      gapMinutes: 5,
      now: () => t0 + 2 * 60_000, // 才 2 分钟 < 5
    });
    const { ctx } = createTestContext();
    expect(compact.transformMessagesBeforeLlm!(msgs, ctx)).toBeUndefined();
  });

  it("returns undefined (no-op) when below the trigger volume and no gap configured", () => {
    const msgs: Message[] = [tr("read", "tiny"), tr("read", "small")];
    const compact = microcompact({
      compactableTools: ["read"],
      triggerTokens: 1_000_000,
      keepRecent: 1,
    });
    const { ctx } = createTestContext();
    expect(compact.transformMessagesBeforeLlm!(msgs, ctx)).toBeUndefined();
  });

  it("returns undefined when over volume but nothing is clearable (all within keepRecent)", () => {
    const msgs: Message[] = [tr("read", "x".repeat(4000)), tr("read", "y".repeat(4000))];
    const compact = microcompact({
      compactableTools: ["read"],
      triggerTokens: 1, // 触发
      keepRecent: 5, // 但全在保留窗口内
    });
    const { ctx } = createTestContext();
    expect(compact.transformMessagesBeforeLlm!(msgs, ctx)).toBeUndefined();
  });

  it("is view-only: does not mutate the input messages array nor its elements", () => {
    const original = tr("read", "ORIGINAL " + "x".repeat(4000));
    const msgs: Message[] = [original, tr("read", "RECENT")];
    const before = JSON.stringify(msgs);
    const compact = microcompact({
      compactableTools: ["read"],
      triggerTokens: 1,
      targetTokens: 1,
      keepRecent: 1,
    });
    const { ctx } = createTestContext();
    const view = compact.transformMessagesBeforeLlm!(msgs, ctx) as Message[];

    expect(textOf(view[0]!)).toContain("microcompact"); // view 改了
    expect(JSON.stringify(msgs)).toBe(before); // 原数组与元素未被改
    expect(textOf(msgs[0]!)).toContain("ORIGINAL"); // 原 toolResult content 仍是原文
    expect(view).not.toBe(msgs); // 是新数组
  });

  it("placeholder reports the original content char count", () => {
    const body = "y".repeat(4000);
    const msgs: Message[] = [tr("read", body), tr("read", "recent")];
    const compact = microcompact({
      compactableTools: ["read"],
      triggerTokens: 1,
      targetTokens: 1,
      keepRecent: 1,
    });
    const { ctx } = createTestContext();
    const view = compact.transformMessagesBeforeLlm!(msgs, ctx) as Message[];
    expect(textOf(view[0]!)).toContain(`~${body.length} chars`);
  });

  it("accepts a custom placeholderText", () => {
    const msgs: Message[] = [tr("read", "x".repeat(4000)), tr("read", "recent")];
    const compact = microcompact({
      compactableTools: ["read"],
      triggerTokens: 1,
      targetTokens: 1,
      keepRecent: 1,
      placeholderText: (tool, chars) => `CLEARED(${tool}/${chars})`,
    });
    const { ctx } = createTestContext();
    const view = compact.transformMessagesBeforeLlm!(msgs, ctx) as Message[];
    expect(textOf(view[0]!)).toBe(`CLEARED(read/4000)`);
  });

  it("rejects invalid options at construction", () => {
    expect(() => microcompact({ compactableTools: ["read"], triggerTokens: 0 })).toThrow(
      /triggerTokens/,
    );
    expect(() =>
      microcompact({ compactableTools: ["read"], triggerTokens: 100, targetTokens: 0 }),
    ).toThrow(/targetTokens/);
    expect(() =>
      microcompact({ compactableTools: ["read"], triggerTokens: 100, targetTokens: 200 }),
    ).toThrow(/targetTokens/); // > triggerTokens
    expect(() =>
      microcompact({ compactableTools: ["read"], triggerTokens: 100, gapMinutes: 0 }),
    ).toThrow(/gapMinutes/);
  });

  it("end-to-end: the model sees the microcompacted view while full history persists", async () => {
    const initial: Message[] = [
      tr("read", "FILE_A " + "a".repeat(4000)),
      tr("read", "FILE_B " + "b".repeat(4000)),
      tr("read", "FILE_C"), // 最近，保留
    ];
    const fake = createFakeModel([{ content: [{ type: "text", text: "ok" }], stopReason: "stop" }]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      initialMessages: initial,
      hooks: [
        microcompact({
          compactableTools: ["read"],
          triggerTokens: 100, // 大体积 → 触发
          targetTokens: 1, // 尽量清
          keepRecent: 1,
        }),
      ],
    });
    await session.run("go");

    const view = fake.getCalls()[0]!.messages;
    // view 里旧的两条 read 被占位符替换，FILE_C + "go" 原文在
    expect(textOf(view[0]!)).toContain("microcompact");
    expect(textOf(view[1]!)).toContain("microcompact");
    expect(textOf(view[2]!)).toBe("FILE_C");
    // 完整原始历史未被破坏：session.messages 里旧 read 仍是原文。
    expect(textOf(session.messages[0]!)).toContain("FILE_A");
    expect(textOf(session.messages[1]!)).toContain("FILE_B");
    fake.teardown();
  });
});
