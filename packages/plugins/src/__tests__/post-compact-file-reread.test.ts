import { describe, it, expect } from "vitest";
import { AgentSession, createUserMessage } from "@harness-pi/core";
import type { HookContext, Message } from "@harness-pi/core";
import { createFakeModel } from "@harness-pi/core/testing";
import {
  postCompactFileReread,
  POST_COMPACT_PENDING_KEY,
} from "../post-compact-file-reread.js";
import { compactSummarize } from "../compact-summarize.js";

/** assistant message carrying a single tool call (read/edit/write 等)。 */
function toolCallMsg(name: string, args: Record<string, unknown>): Message {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: `c-${name}-${JSON.stringify(args)}`, name, arguments: args }],
    api: "x" as never,
    provider: "p",
    model: "m",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: 0,
  };
}

/**
 * 最小 fake HookContext，只实现 postCompactFileReread 实际用到的面：state / messages / log。
 * 不碰 core 的 createTestContext（它把 messages 钉死成 []），但用真实的 Map 语义。
 */
function fakeCtx(messages: Message[], opts: { pending?: number } = {}): HookContext {
  const map = new Map<string, unknown>();
  if (opts.pending !== undefined) map.set(POST_COMPACT_PENDING_KEY, opts.pending);
  return {
    sessionId: "test",
    turnIdx: 1,
    messages,
    state: {
      get: (k: string) => map.get(k),
      set: (k: string, v: unknown) => void map.set(k, v),
      has: (k: string) => map.has(k),
      delete: (k: string) => map.delete(k),
      get size() {
        return map.size;
      },
      clear: () => map.clear(),
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  } as unknown as HookContext;
}

describe("postCompactFileReread", () => {
  it("does nothing when no compaction is pending (regression: default off / no flag → zero injection)", async () => {
    let providerCalls = 0;
    const hook = postCompactFileReread({
      fileContentProvider: async () => {
        providerCalls++;
        return "X";
      },
    });
    const ctx = fakeCtx([toolCallMsg("read", { path: "/a.ts" })]); // 有路径但无 pending 标记
    const out = await hook.onTurnStart!({ turnIdx: 1 }, ctx);

    expect(out).toBeUndefined();
    expect(providerCalls).toBe(0); // 没压缩 → 根本不解析
  });

  it("UTF-8 截断落在码点边界、不产生 U+FFFD（#98 回归）", async () => {
    // maxBytes=5，中文每字 3 bytes："日本語…" → 码点边界截断保留 "日"(3 bytes)，
    // 不切到 "本" 中间（原字节级 Buffer.subarray 会切第 2 字、末尾产生替换字符 U+FFFD）。
    const hook = postCompactFileReread({
      maxBytes: 5,
      fileContentProvider: async () => "日本語テスト",
    });
    const ctx = fakeCtx([toolCallMsg("read", { path: "/a.ts" })], { pending: 0 });
    const out = await hook.onTurnStart!({ turnIdx: 1 }, ctx);

    expect(out).toBeDefined();
    const text = out!.additionalContext!;
    expect(text).not.toContain("�"); // 无替换字符
    expect(text).toContain("日"); // 第 1 字保留（3 ≤ 5）
    expect(text).not.toContain("本"); // 第 2 字累计 6 > 5，码点边界截掉
    expect(text).toContain("[truncated to 5 bytes]");
  });

  it("resolves referenced paths and injects their current content after compaction", async () => {
    const fs: Record<string, string> = { "/a.ts": "AAA", "/b.ts": "BBB" };
    const hook = postCompactFileReread({
      fileContentProvider: async (p) => fs[p] ?? null,
    });
    const ctx = fakeCtx(
      [toolCallMsg("read", { path: "/a.ts" }), toolCallMsg("edit", { path: "/b.ts", oldText: "x", newText: "y" })],
      { pending: 0 },
    );
    const out = await hook.onTurnStart!({ turnIdx: 1 }, ctx);

    expect(out).toBeDefined();
    const text = (out as { additionalContext: string }).additionalContext;
    expect(text).toContain('/a.ts');
    expect(text).toContain("AAA");
    expect(text).toContain('/b.ts');
    expect(text).toContain("BBB");
    // 消费即清：标记被删，下一 turn 不再注入。
    expect(ctx.state.has(POST_COMPACT_PENDING_KEY)).toBe(false);
  });

  it("clears the pending flag so a second turn injects nothing", async () => {
    const hook = postCompactFileReread({ fileContentProvider: async () => "C" });
    const ctx = fakeCtx([toolCallMsg("read", { path: "/a.ts" })], { pending: 0 });

    const first = await hook.onTurnStart!({ turnIdx: 1 }, ctx);
    expect(first).toBeDefined();
    const second = await hook.onTurnStart!({ turnIdx: 2 }, ctx);
    expect(second).toBeUndefined(); // 标记已被消费
  });

  it("skips a file when the provider returns null", async () => {
    const hook = postCompactFileReread({
      fileContentProvider: async (p) => (p === "/keep.ts" ? "KEPT" : null),
    });
    const ctx = fakeCtx(
      [toolCallMsg("read", { path: "/gone.ts" }), toolCallMsg("read", { path: "/keep.ts" })],
      { pending: 0 },
    );
    const out = await hook.onTurnStart!({ turnIdx: 1 }, ctx);
    const text = (out as { additionalContext: string }).additionalContext;
    expect(text).toContain("KEPT");
    expect(text).not.toContain("/gone.ts");
  });

  it("returns nothing when every referenced file resolves to null", async () => {
    const hook = postCompactFileReread({ fileContentProvider: async () => null });
    const ctx = fakeCtx([toolCallMsg("read", { path: "/a.ts" })], { pending: 0 });
    expect(await hook.onTurnStart!({ turnIdx: 1 }, ctx)).toBeUndefined();
  });

  it("recovers from a provider throw: skips the failing file, still injects siblings (#98)", async () => {
    // provider 对某个 path 抛错不该拖垮整个 turn——记一笔、跳过该文件，兄弟文件照常注入、onTurnStart 不 reject。
    const hook = postCompactFileReread({
      fileContentProvider: async (p) => {
        if (p === "/boom.ts") throw new Error("read failed");
        return "OK_BODY";
      },
    });
    const ctx = fakeCtx(
      [toolCallMsg("read", { path: "/boom.ts" }), toolCallMsg("read", { path: "/good.ts" })],
      { pending: 0 },
    );
    const out = await hook.onTurnStart!({ turnIdx: 1 }, ctx); // 不 reject
    const text = (out as { additionalContext: string }).additionalContext;
    expect(text).toContain("OK_BODY"); // 好文件仍注入
    expect(text).not.toContain("/boom.ts"); // 抛错文件被跳过
    expect(text).not.toContain("read failed");
  });

  it("bounds the number of files to maxFiles (most-recently-referenced first)", async () => {
    const calls: string[] = [];
    const hook = postCompactFileReread({
      maxFiles: 2,
      fileContentProvider: async (p) => {
        calls.push(p);
        return p;
      },
    });
    // 引用顺序 a,b,c → 倒序收集 = c,b,a → maxFiles 2 取 c,b。
    const ctx = fakeCtx(
      [
        toolCallMsg("read", { path: "/a.ts" }),
        toolCallMsg("read", { path: "/b.ts" }),
        toolCallMsg("read", { path: "/c.ts" }),
      ],
      { pending: 0 },
    );
    const out = await hook.onTurnStart!({ turnIdx: 1 }, ctx);
    const text = (out as { additionalContext: string }).additionalContext;
    expect(calls.sort()).toEqual(["/b.ts", "/c.ts"]); // 只解析了最近两个
    expect(text).not.toContain("/a.ts");
  });

  it("truncates each file to maxBytes and labels the truncation", async () => {
    const hook = postCompactFileReread({
      maxBytes: 10,
      fileContentProvider: async () => "0123456789ABCDEF", // 16 bytes
    });
    const ctx = fakeCtx([toolCallMsg("read", { path: "/big.ts" })], { pending: 0 });
    const out = await hook.onTurnStart!({ turnIdx: 1 }, ctx);
    const text = (out as { additionalContext: string }).additionalContext;
    expect(text).toContain("0123456789");
    expect(text).not.toContain("ABCDEF"); // 超出 10 字节被切
    expect(text).toContain("truncated to 10 bytes");
  });

  it("dedups repeated references to the same path", async () => {
    let calls = 0;
    const hook = postCompactFileReread({
      fileContentProvider: async () => {
        calls++;
        return "X";
      },
    });
    const ctx = fakeCtx(
      [toolCallMsg("read", { path: "/a.ts" }), toolCallMsg("edit", { path: "/a.ts", oldText: "x", newText: "y" })],
      { pending: 0 },
    );
    await hook.onTurnStart!({ turnIdx: 1 }, ctx);
    expect(calls).toBe(1); // 同一路径只解析一次
  });

  it("ignores tool calls not in toolNames and missing path args", async () => {
    let calls = 0;
    const hook = postCompactFileReread({
      fileContentProvider: async () => {
        calls++;
        return "X";
      },
    });
    const ctx = fakeCtx(
      [
        toolCallMsg("bash", { command: "ls" }), // 非文件工具
        toolCallMsg("read", { offset: 1 }), // read 但没 path
      ],
      { pending: 0 },
    );
    const out = await hook.onTurnStart!({ turnIdx: 1 }, ctx);
    expect(out).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("rejects invalid bounds at construction", () => {
    expect(() => postCompactFileReread({ fileContentProvider: async () => "", maxFiles: 0 })).toThrow(/maxFiles/);
    expect(() => postCompactFileReread({ fileContentProvider: async () => "", maxBytes: 0 })).toThrow(/maxBytes/);
  });

  it("end-to-end: compaction sets the flag, reread injects current file content on the next turn", async () => {
    // turn0/turn1：模型连发 read /f.ts toolCall（保持 loop 存活）；turn1 的 LLM call 时消息数 > maxMessages
    // → compaction 改写 view + set flag；turn2 的 onTurnStart：reread 注入 /f.ts 的"当前"内容，模型本轮 view 应见到它。
    const fake = createFakeModel([
      { content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "/f.ts" } }], stopReason: "toolUse" },
      { content: [{ type: "toolCall", id: "t2", name: "read", arguments: { path: "/f.ts" } }], stopReason: "toolUse" },
      { content: [{ type: "text", text: "done" }], stopReason: "stop" },
    ]);
    const readTool = {
      name: "read",
      label: "read",
      description: "read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } } as never,
      execute: async () => ({ content: [{ type: "text" as const, text: "OLD_CONTENT" }] }),
    };
    const session = new AgentSession({
      model: fake,
      tools: [readTool as never],
      initialMessages: [createUserMessage("p1"), createUserMessage("p2"), createUserMessage("p3")],
      hooks: [
        compactSummarize({ maxMessages: 4, keepRecent: 2, summarize: () => "RECAP" }),
        postCompactFileReread({ fileContentProvider: async (p) => (p === "/f.ts" ? "FRESH_CONTENT" : null) }),
      ],
    });
    await session.run("go");

    // 找一帧 view 含 FRESH_CONTENT（reread 注入的 attachment）。
    const sawFresh = fake
      .getCalls()
      .some((c) => c.messages.some((m) => JSON.stringify(m).includes("FRESH_CONTENT")));
    expect(sawFresh).toBe(true);
    fake.teardown();
  });

  it("regression: compaction marks reread ONLY on re-summarize turns, not every over-threshold turn", async () => {
    // 锁住 blocker 回归：messages 是 append-only 原始 _messages，一旦越阈值就**永久**在阈值之上。
    // 若 marker 每个越界 turn 都置位（旧 bug：set 在重算分支外），postCompactFileReread 会每 turn 重读重注入，
    // 把刚省下的 token 又灌回去。正确契约：marker 只在「本 turn 真跑了一次新总结」时置位。
    let summarizeCalls = 0;
    const hook = compactSummarize({
      maxMessages: 4,
      keepRecent: 2,
      resummarizeEvery: 3, // 想覆盖的前缀每增长 ≥3 条才重算
      summarize: () => {
        summarizeCalls++;
        return "RECAP";
      },
    });
    const mkMsgs = (n: number) =>
      Array.from({ length: n }, (_, i) => createUserMessage(`m${i}`));
    const map = new Map<string, unknown>();
    const ctx = {
      turnIdx: 0,
      state: {
        get: (k: string) => map.get(k),
        set: (k: string, v: unknown) => void map.set(k, v),
        has: (k: string) => map.has(k),
        delete: (k: string) => map.delete(k),
      },
    } as unknown as HookContext;
    const transform = hook.transformMessagesBeforeLlm!;

    // turn A：6 条（>4），cache 空 → 重算 → 置标记。
    await transform(mkMsgs(6), ctx);
    expect(summarizeCalls).toBe(1);
    expect(map.has(POST_COMPACT_PENDING_KEY)).toBe(true);
    map.delete(POST_COMPACT_PENDING_KEY); // 模拟 reread 在下一 turn 消费即清

    // turn B：7 条（仍 >4，targetCover=5；5-4=1 < 3）→ cache 命中、不重算 → **不**置标记。
    await transform(mkMsgs(7), ctx);
    expect(summarizeCalls).toBe(1);
    expect(map.has(POST_COMPACT_PENDING_KEY)).toBe(false); // 关键：cache-hit 越界 turn 不触发 reread

    // turn C：8 条（targetCover=6；6-4=2 < 3）→ 仍 cache 命中、不置标记。
    await transform(mkMsgs(8), ctx);
    expect(map.has(POST_COMPACT_PENDING_KEY)).toBe(false);

    // turn D：10 条（targetCover=8；8-4=4 ≥ 3）→ 重算 → 重新置标记。
    await transform(mkMsgs(10), ctx);
    expect(summarizeCalls).toBe(2);
    expect(map.has(POST_COMPACT_PENDING_KEY)).toBe(true);
  });
});
