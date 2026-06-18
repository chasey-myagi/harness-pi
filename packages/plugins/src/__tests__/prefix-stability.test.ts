/**
 * prefix-stability.test.ts — prompt-cache 前缀稳定性回归门。
 *
 * 两道门：
 *  [GREEN] 默认配置（trim 关）：durable prefix hash + 消息历史跨 turn 全程稳定。
 *  [RED]   故意开 trimHistory：消息历史被改写 → cache 破坏，用 it.fails 钉死已知破坏。
 *
 * 测试原则：
 *  - 不依赖真实 provider，全程使用 createFakeModel。
 *  - 只做断言，零行为变更，不碰 prefix-shape.ts 内核。
 *  - 「durable prefix」= model + systemPrompt + tools（prefix-shape 跟踪的三元组）。
 *    trimHistory 只改写消息历史，不影响 durable prefix hash；但改写历史本身就破坏了
 *    provider 侧的 prompt-cache（provider 缓存的是完整 prompt bytes，包括 messages）。
 */

import { describe, it, expect } from "vitest";
import { AgentSession, MemorySessionStore, Type, type HarnessTool, type Hook, type HookContext } from "@harness-pi/core";
import { createFakeModel } from "@harness-pi/core/testing";
import type { Context } from "@earendil-works/pi-ai";
import {
  prefixShape,
  getPrefixShapeState,
  type PrefixChangeReason,
} from "../prefix-shape.js";
import { trimHistory } from "../trim-history.js";
import { autoCompaction } from "../auto-compaction.js";

const echoTool: HarnessTool = {
  name: "echo",
  description: "echo tool",
  parameters: Type.Object({ msg: Type.String() }),
  async execute(args) {
    return { content: [{ type: "text", text: `echoed: ${args["msg"]}` }] };
  },
};

/** 3 次 tool call + 1 次 text 应答 = 4 次 LLM call，足够触发 trimHistory(keepRecent:1) 改写。 */
function threeToolCallScript() {
  return [
    { content: [{ type: "toolCall" as const, name: "echo", arguments: { msg: "1" } }], stopReason: "toolUse" as const },
    { content: [{ type: "toolCall" as const, name: "echo", arguments: { msg: "2" } }], stopReason: "toolUse" as const },
    { content: [{ type: "toolCall" as const, name: "echo", arguments: { msg: "3" } }], stopReason: "toolUse" as const },
    { content: [{ type: "text" as const, text: "done" }], stopReason: "stop" as const },
  ];
}

/** 收集每次 LLM call 结束时 prefixShape 记录的 hash + changeReason。 */
function makePrefixProbe() {
  const records: { prefixHash: string; changeReason: PrefixChangeReason }[] = [];
  const hook: Hook = {
    name: "prefix-probe",
    onLlmEnd(_input, ctx: HookContext) {
      const d = getPrefixShapeState(ctx);
      if (d) records.push({ prefixHash: d.prefixHash, changeReason: d.changeReason });
    },
  };
  return { records, hook };
}

/**
 * 验证 getCalls() 序列满足「追加不变」性质：
 * 每次 LLM call 的 messages 是上一次的严格超集（只 append，不改写历史）。
 */
function assertMessagesAppendOnly(calls: ReadonlyArray<Context>) {
  for (let i = 1; i < calls.length; i++) {
    const prev = calls[i - 1]!.messages;
    const curr = calls[i]!.messages;
    // 新 call 必然比上一 call 的 messages 多（model 应答 + tool result 追加了进去）
    expect(curr.length).toBeGreaterThan(prev.length);
    // prev 的所有 messages 在 curr 的对应位置完全相同（深度相等）
    expect(curr.slice(0, prev.length)).toEqual(prev);
  }
}

/* ────────────── [GREEN] 默认配置（trim 关）── ────────────── */

describe("[GREEN] 默认配置（trim 关）：durable prefix hash + 消息历史稳定", () => {
  it("durable prefix hash 跨 turn 不变（除首 turn first_turn 外均为 stable）", async () => {
    const { records, hook: probe } = makePrefixProbe();
    const fake = createFakeModel(threeToolCallScript());

    const session = new AgentSession({
      model: fake,
      tools: [echoTool],
      hooks: [prefixShape(), probe],
    });
    await session.run("go");

    // 3 次 tool call + 1 次 text = 4 次 LLM call → 4 条记录
    expect(records.length).toBe(4);
    // 首 turn 允许 first_turn
    expect(records[0]!.changeReason).toBe("first_turn");
    // 后续 3 turn：model / systemPrompt / tools 均未变 → hash 完全相同
    const baseHash = records[0]!.prefixHash;
    for (let i = 1; i < records.length; i++) {
      expect(records[i]!.changeReason).toBe("stable");
      expect(records[i]!.prefixHash).toBe(baseHash);
    }

    fake.teardown();
  });

  it("消息历史追加不变：每次 LLM call 的 messages 只新增、不改写旧条目", async () => {
    const fake = createFakeModel(threeToolCallScript());

    const session = new AgentSession({
      model: fake,
      tools: [echoTool],
      hooks: [prefixShape()],
    });
    await session.run("go");

    const calls = fake.getCalls();
    expect(calls.length).toBe(4);
    assertMessagesAppendOnly(calls);

    fake.teardown();
  });

  it("durable prefix hash 在 5 turn 长会话中保持同一值（压力 coverage）", async () => {
    const { records, hook: probe } = makePrefixProbe();
    const fake = createFakeModel([
      { content: [{ type: "toolCall" as const, name: "echo", arguments: { msg: "a" } }], stopReason: "toolUse" as const },
      { content: [{ type: "toolCall" as const, name: "echo", arguments: { msg: "b" } }], stopReason: "toolUse" as const },
      { content: [{ type: "toolCall" as const, name: "echo", arguments: { msg: "c" } }], stopReason: "toolUse" as const },
      { content: [{ type: "toolCall" as const, name: "echo", arguments: { msg: "d" } }], stopReason: "toolUse" as const },
      { content: [{ type: "text" as const, text: "done" }], stopReason: "stop" as const },
    ]);

    const session = new AgentSession({
      model: fake,
      tools: [echoTool],
      hooks: [prefixShape(), probe],
    });
    await session.run("go");

    expect(records.length).toBe(5);
    const baseHash = records[0]!.prefixHash;
    const stableReasons = records.slice(1).map((r) => r.changeReason);
    expect(stableReasons).toEqual(["stable", "stable", "stable", "stable"]);
    for (const r of records) {
      expect(r.prefixHash).toBe(baseHash);
    }

    fake.teardown();
  });
});

/* ────────────── [RED] 故意开 trimHistory（钉死已知破坏）── ────────────── */

describe("[RED] 故意开 trimHistory：消息历史被改写（钉死已知 cache 破坏）", () => {
  /**
   * 注意：trimHistory 不改 durable prefix（model/systemPrompt/tools），所以 prefixShape 报 stable。
   * 但 trimHistory 会把旧 toolResult 内容替换成占位符，导致第 3 次 LLM call 送出的
   * messages[2]（第 1 个 toolResult）内容与第 2 次 call 时不同——破坏了 provider 的 prompt cache。
   *
   * it.fails：断言「追加不变」在此场景下**失败**——这正是已知破坏的文档。
   * 若将来修复了 trimHistory 的 cache 问题，此测试会变绿（it.fails 报 unexpected-pass），
   * 提醒维护者把这个 it.fails 移除或改写为正常测试。
   */
  it.fails("trimHistory 改写旧 toolResult，「消息历史追加不变」断言失败（已知 cache 破坏）", async () => {
    const fake = createFakeModel(threeToolCallScript());

    const session = new AgentSession({
      model: fake,
      tools: [echoTool],
      // keepRecent:1 → 3 次 toolResult 时第 1 条被替换为占位符
      hooks: [trimHistory({ keepRecent: 1 }), prefixShape()],
    });
    await session.run("go");

    const calls = fake.getCalls();
    // 此断言在有 trimHistory 时**失败**：第 3 次 call 的 messages[2] 已被 trim 改写
    assertMessagesAppendOnly(calls);

    fake.teardown();
  });

  it("trimHistory 不改 durable prefix hash（trim 只影响 messages，不影响 model/system/tools）", async () => {
    // durable prefix hash 与 trimHistory 无关——单独测以防未来误改破坏此不变量
    const { records, hook: probe } = makePrefixProbe();
    const fake = createFakeModel(threeToolCallScript());

    const session = new AgentSession({
      model: fake,
      tools: [echoTool],
      hooks: [trimHistory({ keepRecent: 1 }), prefixShape(), probe],
    });
    await session.run("go");

    expect(records.length).toBe(4);
    expect(records[0]!.changeReason).toBe("first_turn");
    const baseHash = records[0]!.prefixHash;
    for (let i = 1; i < records.length; i++) {
      expect(records[i]!.changeReason).toBe("stable");
      expect(records[i]!.prefixHash).toBe(baseHash);
    }

    fake.teardown();
  });
});

/* ────────────── [GREEN] autoCompaction: boundary 稳定性 ────────────── */

describe("[GREEN] autoCompaction: boundary 后 prefix 稳定（切片1 回归门）", () => {
  /**
   * 脚本设计：5 次 LLM call（4 次 toolUse + 1 次 text）。
   * keepRecent=2, maxContextTokens=1（总是超阈值）, resummarizeEvery=100（测试范围内不重算）。
   *
   * turn 0: 仅 user_prompt（1条）→ 未达 keepRecent=2，不压缩。
   * turn 1: [user, assistant0, toolResult0]（3条）→ 触发压缩，boundary turn（允许前缀跳变）。
   * turn 2+: 内核投影 [summaryMsg, _messages[K..]] → 同一 summaryMsg 对象 → prefix 不变。
   */
  function fiveCallScript() {
    return [
      { content: [{ type: "toolCall" as const, name: "echo", arguments: { msg: "1" } }], stopReason: "toolUse" as const },
      { content: [{ type: "toolCall" as const, name: "echo", arguments: { msg: "2" } }], stopReason: "toolUse" as const },
      { content: [{ type: "toolCall" as const, name: "echo", arguments: { msg: "3" } }], stopReason: "toolUse" as const },
      { content: [{ type: "toolCall" as const, name: "echo", arguments: { msg: "4" } }], stopReason: "toolUse" as const },
      { content: [{ type: "text" as const, text: "done" }], stopReason: "stop" as const },
    ];
  }

  it("boundary turn 放行前缀跳变，其余 turn messages 历史追加不变", async () => {
    const fake = createFakeModel(fiveCallScript());

    const session = new AgentSession({
      model: fake,
      tools: [echoTool],
      hooks: [autoCompaction({
        maxContextTokens: 1,
        triggerRatio: 1,
        keepRecent: 2,
        resummarizeEvery: 100,
        tokenCounter: { estimate: () => 999 },
        summarize: async () => "summary",
      })],
    });
    await session.run("go");

    const calls = fake.getCalls();
    expect(calls.length).toBe(5);

    // 统计前缀跳变次数（messages[0] 改变的 call）
    let boundaryCallIdx = -1;
    for (let i = 1; i < calls.length; i++) {
      const prev = calls[i - 1]!.messages;
      const curr = calls[i]!.messages;
      // 前缀跳变 = messages[0] 不同
      const firstMsgChanged = JSON.stringify(curr[0]) !== JSON.stringify(prev[0]);
      if (firstMsgChanged) {
        expect(boundaryCallIdx).toBe(-1); // 只允许一次 boundary 跳变
        boundaryCallIdx = i;
      }
    }

    // 必须有一次 boundary（压缩确实触发了）
    expect(boundaryCallIdx).toBeGreaterThan(0);

    // boundary 之后：所有 call 追加不变
    for (let i = boundaryCallIdx + 1; i < calls.length; i++) {
      const prev = calls[i - 1]!.messages;
      const curr = calls[i]!.messages;
      expect(curr.length).toBeGreaterThan(prev.length);
      expect(curr.slice(0, prev.length)).toEqual(prev);
    }

    fake.teardown();
  });

  it("boundary 之后的多 turn 中 messages[0]（summary）是同一对象引用（bytes 绝对稳定）", async () => {
    const fake = createFakeModel(fiveCallScript());

    const session = new AgentSession({
      model: fake,
      tools: [echoTool],
      hooks: [autoCompaction({
        maxContextTokens: 1,
        triggerRatio: 1,
        keepRecent: 2,
        resummarizeEvery: 100,
        tokenCounter: { estimate: () => 999 },
        summarize: async () => "STABLE-SUMMARY",
      })],
    });
    await session.run("go");

    const calls = fake.getCalls();

    // 找到 boundary 之后（有 summaryMsg 的那批 call）
    const postBoundaryCalls = calls.filter((c) =>
      typeof c.messages[0]?.content === "string"
        ? c.messages[0].content.includes("STABLE-SUMMARY")
        : Array.isArray(c.messages[0]?.content)
          ? c.messages[0].content.some((b: { type: string; text?: string }) => b.type === "text" && b.text?.includes("STABLE-SUMMARY"))
          : false
    );

    expect(postBoundaryCalls.length).toBeGreaterThanOrEqual(2); // 至少 2 个 turn 共享同一 summary

    // 验证同一对象引用（=== 严格相等）
    const firstSummaryMsg = postBoundaryCalls[0]!.messages[0]!;
    for (let i = 1; i < postBoundaryCalls.length; i++) {
      expect(postBoundaryCalls[i]!.messages[0]).toBe(firstSummaryMsg); // 引用相同
    }

    fake.teardown();
  });

  it("autoCompaction + store: resume() 重建的首条消息与 live 投影 messages[0] 深度相等（两套合一）", async () => {
    const store = new MemorySessionStore();
    const sessionId = "boundary-resume-parity";

    const fake = createFakeModel([
      { content: [{ type: "toolCall" as const, name: "echo", arguments: { msg: "1" } }], stopReason: "toolUse" as const },
      { content: [{ type: "toolCall" as const, name: "echo", arguments: { msg: "2" } }], stopReason: "toolUse" as const },
      { content: [{ type: "text" as const, text: "done" }], stopReason: "stop" as const },
    ]);

    const session = new AgentSession({
      model: fake,
      tools: [echoTool],
      store,
      sessionId,
      hooks: [autoCompaction({
        maxContextTokens: 1,
        triggerRatio: 1,
        keepRecent: 2,
        resummarizeEvery: 100,
        tokenCounter: { estimate: () => 999 },
        summarize: async () => "boundary-summary-text",
      })],
    });
    await session.run("go");

    // live session 最后几次 LLM call 的 messages[0] = summaryMsg
    const allCalls = fake.getCalls();
    const liveFirstMsg = allCalls.at(-1)!.messages[0];
    expect(liveFirstMsg).toBeDefined();

    // resume from store
    const fake2 = createFakeModel([]); // 不再需要新的 LLM call
    const resumed = await AgentSession.resume(store, sessionId, {
      model: fake2,
      tools: [echoTool],
    });

    // resume 重建的 messages[0] 应与 live 投影 messages[0] 深度相等
    expect(resumed.messages[0]).toEqual(liveFirstMsg);
    // 且内容含 boundary-summary-text
    const content = resumed.messages[0]?.content;
    const text = typeof content === "string" ? content : JSON.stringify(content);
    expect(text).toContain("boundary-summary-text");

    fake.teardown();
    fake2.teardown();
  });
});
