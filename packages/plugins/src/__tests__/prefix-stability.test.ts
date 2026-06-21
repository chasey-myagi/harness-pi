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

  it("autoCompaction 纯 view-only（Method A）：不向 store 写 compaction_boundary", async () => {
    const store = new MemorySessionStore();
    const sessionId = "no-boundary-in-store";

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
        summarize: async () => "should-not-be-in-store",
      })],
    });
    await session.run("go");

    // autoCompaction 是纯 view-only：不落 compaction_boundary store 条目。
    const path = await store.getPathToLeaf(sessionId);
    const hasBoundary = path.some((e) => e.entry.kind === "compaction_boundary");
    expect(hasBoundary).toBe(false);

    fake.teardown();
  });

  it("resummarizeEvery 在多 boundary 后仍精准触发（B2：_messages 坐标一致性）", async () => {
    let summarizeCalls = 0;

    const fake = createFakeModel([
      { content: [{ type: "toolCall" as const, name: "echo", arguments: { msg: "1" } }], stopReason: "toolUse" as const },
      { content: [{ type: "toolCall" as const, name: "echo", arguments: { msg: "2" } }], stopReason: "toolUse" as const },
      { content: [{ type: "toolCall" as const, name: "echo", arguments: { msg: "3" } }], stopReason: "toolUse" as const },
      { content: [{ type: "toolCall" as const, name: "echo", arguments: { msg: "4" } }], stopReason: "toolUse" as const },
      { content: [{ type: "text" as const, text: "done" }], stopReason: "stop" as const },
    ]);

    const session = new AgentSession({
      model: fake,
      tools: [echoTool],
      hooks: [autoCompaction({
        maxContextTokens: 1,
        triggerRatio: 1,
        keepRecent: 2,
        resummarizeEvery: 2,
        tokenCounter: { estimate: () => 999 },
        summarize: async () => { summarizeCalls++; return `S${summarizeCalls}`; },
      })],
    });
    await session.run("go");

    // _messages 坐标：每新增 2 条 raw message 触发一次重算。
    // 5 次 LLM call，_messages 增长：1→3→5→7→9；transformMessagesBeforeLlm 在 call 前触发：
    //   turn1(M=3): cache===null → 第1次; turn2(M=5): rawGrowth=2>=2 → 第2次;
    //   turn3(M=7): rawGrowth=2>=2 → 第3次; turn4(M=9): rawGrowth=2>=2 → 第4次.
    // view 坐标（B2 bug）：第3次延迟到 turn4(M=9) 才触发，结果只有3次。
    expect(summarizeCalls).toBe(4);

    fake.teardown();
  });
});

/* ────── [GREEN] autoCompaction + pending attachment：坐标系一致（回归 Codex High bug）────── */

/** message 的 content（string 或 block 数组）是否含某子串。 */
function msgContains(m: { content?: unknown } | undefined, s: string): boolean {
  if (!m) return false;
  const c = m.content;
  if (typeof c === "string") return c.includes(s);
  if (Array.isArray(c)) {
    return c.some(
      (b) => typeof (b as { text?: string }).text === "string" && (b as { text?: string }).text!.includes(s),
    );
  }
  return false;
}

describe("[GREEN] autoCompaction + pending attachment：boundary 后不重发已覆盖消息", () => {
  /**
   * 回归 Codex 交叉验证发现的 High bug：summary 覆盖范围（targetCover）原用含 _pendingAttachments
   * 的投影视图坐标，写给内核的 coveredCount 却用不含 pending 的 _messages 坐标，基准错位 →
   * 有 pending（onTurnStart 注入 additionalContext）触发 boundary 时，已被 summary 覆盖的旧消息
   * 会在下一 turn 投影里被重新发送（破坏 prompt-cache 前缀稳定）。
   *
   * 断言：去掉每次投影尾部的 pending 后，boundary 之后的投影满足 append-only（前缀字节稳定、
   * 不重发已覆盖消息）。坐标错位时此断言失败。
   */
  it("onTurnStart 注入 pending 时，boundary 后投影（去 pending）前缀稳定", async () => {
    const attachHook: Hook = {
      name: "attach",
      onTurnStart() {
        return { additionalContext: "ATTACH-CTX" };
      },
    };
    const fake = createFakeModel([
      { content: [{ type: "toolCall" as const, name: "echo", arguments: { msg: "1" } }], stopReason: "toolUse" as const },
      { content: [{ type: "toolCall" as const, name: "echo", arguments: { msg: "2" } }], stopReason: "toolUse" as const },
      { content: [{ type: "toolCall" as const, name: "echo", arguments: { msg: "3" } }], stopReason: "toolUse" as const },
      { content: [{ type: "text" as const, text: "done" }], stopReason: "stop" as const },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [echoTool],
      hooks: [
        autoCompaction({
          maxContextTokens: 1,
          triggerRatio: 1,
          keepRecent: 2,
          resummarizeEvery: 100,
          tokenCounter: { estimate: () => 999 },
          summarize: async () => "SUM",
        }),
        attachHook,
      ],
    });
    await session.run("go");

    const calls = fake.getCalls();
    // 去掉每次投影尾部的 pending（含 ATTACH-CTX 的 attachment message）
    const proj = calls.map((c) => c.messages.filter((m) => !msgContains(m, "ATTACH-CTX")));
    // boundary = 投影首条变成 summary "SUM" 的那次
    const boundaryIdx = proj.findIndex((m) => msgContains(m[0], "SUM"));
    expect(boundaryIdx).toBeGreaterThan(-1); // 压缩确实触发

    // boundary 之后：去 pending 投影 append-only（前缀稳定、不重发被 summary 覆盖的消息）
    for (let i = boundaryIdx + 1; i < proj.length; i++) {
      const prev = proj[i - 1]!;
      const curr = proj[i]!;
      expect(curr.length).toBeGreaterThanOrEqual(prev.length);
      expect(curr.slice(0, prev.length)).toEqual(prev);
    }

    fake.teardown();
  });
});

/* ────── [GREEN] autoCompaction 保留上游 transform（composition，回归 codex P1）────── */

describe("[GREEN] autoCompaction + 上游 transform：不还原已压缩的 tail", () => {
  /**
   * 回归 codex 交叉验证 P1：autoCompaction 在 pipe 中位于上游 transform（文档顺序 microcompact →
   * autoCompaction）之后时，本 turn 投影必须从 pipe 入参 messages（已被上游处理）切，而非从 raw
   * （原始 _messages）重建——否则上游已压缩/redact 的 tail 会被还原成原始大输出重新发给 LLM。
   */
  it("autoCompaction 不还原上游已 redact 的 tail（保留上游 transform 效果）", async () => {
    // 上游 transform：把所有 toolResult 内容替换成 REDACTED（模拟 microcompact 压 tail 的 tool 输出）
    const redactHook: Hook = {
      name: "redact",
      transformMessagesBeforeLlm(msgs) {
        return msgs.map((m) =>
          m.role === "toolResult"
            ? { ...m, content: [{ type: "text" as const, text: "REDACTED" }] }
            : m,
        );
      },
    };
    const fake = createFakeModel([
      { content: [{ type: "toolCall" as const, name: "echo", arguments: { msg: "1" } }], stopReason: "toolUse" as const },
      { content: [{ type: "toolCall" as const, name: "echo", arguments: { msg: "2" } }], stopReason: "toolUse" as const },
      { content: [{ type: "toolCall" as const, name: "echo", arguments: { msg: "3" } }], stopReason: "toolUse" as const },
      { content: [{ type: "text" as const, text: "done" }], stopReason: "stop" as const },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [echoTool],
      // 文档顺序：上游 redact 在前、autoCompaction 在后
      hooks: [
        redactHook,
        autoCompaction({
          maxContextTokens: 1,
          triggerRatio: 1,
          keepRecent: 2,
          resummarizeEvery: 100,
          tokenCounter: { estimate: () => 999 },
          summarize: async () => "SUM",
        }),
      ],
    });
    await session.run("go");

    const calls = fake.getCalls();
    // boundary 后的投影（messages[0]=SUM）：保留的 toolResult tail 必须是 REDACTED，
    // 不能还原成上游 redact 前的原始 "echoed:" 内容。
    const boundaryCalls = calls.filter((c) => msgContains(c.messages[0], "SUM"));
    expect(boundaryCalls.length).toBeGreaterThan(0);
    for (const c of boundaryCalls) {
      expect(c.messages.some((m) => msgContains(m, "echoed:"))).toBe(false);
    }

    fake.teardown();
  });
});
