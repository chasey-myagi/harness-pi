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
import { AgentSession, Type, type HarnessTool, type Hook, type HookContext } from "@harness-pi/core";
import { createFakeModel } from "@harness-pi/core/testing";
import type { Context } from "@earendil-works/pi-ai";
import {
  prefixShape,
  getPrefixShapeState,
  type PrefixChangeReason,
} from "../prefix-shape.js";
import { trimHistory } from "../trim-history.js";

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
