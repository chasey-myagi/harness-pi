/**
 * onAfterFlush 内核 seam（C1 redesign，docs/09 §4.2）。
 *
 * collect-return 语义：hook **返回** `{ compactionBoundary }`，内核在 _flushToStore 之后 in-band、
 * awaited、串行地把它 append 进 store。hook **没有**任何「可调用写能力」——这是上一版 detached
 * 写设计被 review 抓出 data-loss / store-corruption 后的重做。核心回归（超时的 summarize 不致数据
 * 丢失/乱序）见最后两个用例。
 */

import { describe, it, expect } from "vitest";
import { AgentSession } from "../session.js";
import { MemorySessionStore } from "../session-store.js";
import { createFakeModel } from "../testing.js";
import { createUserMessage } from "../types.js";
import type { Hook, OnAfterFlushInput } from "../hook.js";
import type { Message } from "@earendil-works/pi-ai";

const noopTool = {
  name: "noop",
  description: "noop",
  parameters: { type: "object", properties: {} } as never,
  async execute() {
    return { content: [{ type: "text" as const, text: "ok" }] };
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("onAfterFlush kernel seam (C1 redesign)", () => {
  it("fires after each turn's flush with the correct turnIdx and persistedCount", async () => {
    const store = new MemorySessionStore();
    // two turns: turn 0 makes a tool call (assistant + toolResult), turn 1 finishes.
    const fake = createFakeModel([
      { content: [{ type: "toolCall", name: "noop", arguments: {} }] },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const seen: Array<{ turnIdx: number; persistedCount: number }> = [];
    const observer: Hook = {
      name: "observer",
      onAfterFlush(input: OnAfterFlushInput) {
        seen.push({ turnIdx: input.turnIdx, persistedCount: input.persistedCount });
      },
    };
    const session = new AgentSession({
      model: fake,
      tools: [noopTool],
      store,
      hooks: [observer],
    });

    await session.run("go");

    // turn 0: user + assistant(toolCall) + toolResult = 3 persisted; turn 1: + assistant(text) = 4.
    expect(seen).toEqual([
      { turnIdx: 0, persistedCount: 3 },
      { turnIdx: 1, persistedCount: 4 },
    ]);
    const msgEntries = (await store.getPathToLeaf(session.id)).filter(
      (e) => e.entry.kind === "message",
    );
    expect(msgEntries).toHaveLength(4);
    fake.teardown();
  });

  it("a returned compactionBoundary is written by the kernel WITHOUT touching the HWM / session.messages", async () => {
    const store = new MemorySessionStore();
    const fake = createFakeModel([{ content: [{ type: "text", text: "a1" }] }]);
    const summary = createUserMessage("SUMMARY");
    const boundaryHook: Hook = {
      name: "boundary-writer",
      onAfterFlush() {
        return { compactionBoundary: summary };
      },
    };
    const session = new AgentSession({
      model: fake,
      tools: [],
      store,
      hooks: [boundaryHook],
    });

    await session.run("q1");

    // live session keeps the full history (HWM unaffected: boundary is a store-only entry)
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);

    const path = await store.getPathToLeaf(session.id);
    expect(path.filter((e) => e.entry.kind === "compaction_boundary")).toHaveLength(1);
    // none of the messages were re-appended / duplicated
    expect(path.filter((e) => e.entry.kind === "message")).toHaveLength(2);
    fake.teardown();
  });

  it("the kernel writes the boundary in-band BEFORE the terminal entry (ordering)", async () => {
    const store = new MemorySessionStore();
    const fake = createFakeModel([{ content: [{ type: "text", text: "a" }] }]);
    const summary = createUserMessage("SUMMARY");
    const session = new AgentSession({
      model: fake,
      tools: [],
      store,
      hooks: [
        {
          name: "b",
          onAfterFlush: () => ({ compactionBoundary: summary }),
        },
      ],
    });
    await session.run("q");

    const path = await store.getPathToLeaf(session.id);
    const kinds = path.map((e) => e.entry.kind);
    // boundary must precede terminal; seq must be strictly monotone (single serial chain).
    const bIdx = kinds.indexOf("compaction_boundary");
    const tIdx = kinds.indexOf("terminal");
    expect(bIdx).toBeGreaterThanOrEqual(0);
    expect(tIdx).toBeGreaterThanOrEqual(0);
    expect(bIdx).toBeLessThan(tIdx);
    const seqs = path.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, c) => a - c));
    fake.teardown();
  });

  it("multiple hooks returning boundaries are appended in registration order", async () => {
    const store = new MemorySessionStore();
    const fake = createFakeModel([{ content: [{ type: "text", text: "a" }] }]);
    const s1 = createUserMessage("S1");
    const s2 = createUserMessage("S2");
    const session = new AgentSession({
      model: fake,
      tools: [],
      store,
      hooks: [
        { name: "h1", onAfterFlush: () => ({ compactionBoundary: s1 }) },
        { name: "h2", onAfterFlush: () => ({ compactionBoundary: s2 }) },
      ],
    });
    await session.run("q");

    const boundaries = (await store.getPathToLeaf(session.id))
      .filter((e) => e.entry.kind === "compaction_boundary")
      .map((e) => (e.entry as { kind: "compaction_boundary"; summary: Message }).summary);
    expect(boundaries).toEqual([s1, s2]);
    fake.teardown();
  });

  it("does not fire when there is no store (parity with 0.2.1)", async () => {
    const fake = createFakeModel([{ content: [{ type: "text", text: "a" }] }]);
    let fired = false;
    const observer: Hook = {
      name: "observer",
      onAfterFlush() {
        fired = true;
      },
    };
    const session = new AgentSession({ model: fake, tools: [], hooks: [observer] }); // no store
    const summary = await session.run("hi");
    expect(summary.reason).toBe("done");
    expect(fired).toBe(false);
    fake.teardown();
  });

  it("is fire-and-observe: a throwing onAfterFlush hook does NOT kill the run, and writes no boundary", async () => {
    const store = new MemorySessionStore();
    const fake = createFakeModel([{ content: [{ type: "text", text: "a" }] }]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      store,
      hooks: [{ name: "exploder", onAfterFlush: () => { throw new Error("boom"); } }],
      hookFailureSink: () => {}, // swallow the recorded failure
    });
    const summary = await session.run("q");
    expect(summary.reason).toBe("done");
    const path = await store.getPathToLeaf(session.id);
    // messages still persisted despite the hook throwing; no boundary from a throwing hook.
    expect(path.filter((e) => e.entry.kind === "message")).toHaveLength(2);
    expect(path.filter((e) => e.entry.kind === "compaction_boundary")).toHaveLength(0);
    fake.teardown();
  });

  it("a returned boundary makes resume rebuild [summary, ...post-boundary]", async () => {
    const store = new MemorySessionStore();
    // turn 0 tool call, turn 1 text. Return the boundary after turn 0's flush.
    const fake = createFakeModel([
      { content: [{ type: "toolCall", name: "noop", arguments: {} }] },
      { content: [{ type: "text", text: "final" }] },
    ]);
    const summary: Message = createUserMessage("BOUNDARY-SUMMARY");
    const oneShot: Hook = {
      name: "one-shot-boundary",
      onAfterFlush(input: OnAfterFlushInput) {
        if (input.turnIdx === 0) return { compactionBoundary: summary };
      },
    };
    const session = new AgentSession({
      model: fake,
      tools: [noopTool],
      store,
      hooks: [oneShot],
    });
    await session.run("go");

    const fake2 = createFakeModel([{ content: [{ type: "text", text: "z" }] }]);
    const resumed = await AgentSession.resume(store, session.id, {
      model: fake2,
      tools: [noopTool],
    });
    // resume drops the pre-boundary prefix (user + assistant(toolCall) + toolResult),
    // keeps summary + the post-boundary turn-1 assistant message.
    expect(resumed.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(resumed.messages[0]).toBe(summary);
    fake.teardown();
    fake2.teardown();
  });

  /* ───────────────── 核心回归：超时不致数据丢失 / 乱序 ───────────────── */

  it("REGRESSION: a timed-out slow summarize produces NO boundary, NO out-of-order write, NO data loss", async () => {
    // 上一版 detached 设计：hook 超时 → fireEvent 立即 resolve、loop 进下一轮，detached 的
    // append 仍在飞，乱序落在后续 turn / terminal 之后 → resume 把它当「丢弃之前一切」→ 静默删
    // 已完成 turn。本设计：超时的 hook 返回被 race 丢弃 → 内核拿不到 boundary → 不写。
    const store = new MemorySessionStore();
    // turn 0: tool call (3 persisted). turn 1: text → done (4 persisted).
    const fake = createFakeModel([
      { content: [{ type: "toolCall", name: "noop", arguments: {} }] },
      { content: [{ type: "text", text: "final" }] },
    ]);
    const slowSummary = createUserMessage("SLOW-SHOULD-NEVER-LAND");
    const failures: string[] = [];
    const slowHook: Hook = {
      name: "slow-boundary",
      timeout: 30, // hook 超时阈值
      async onAfterFlush(input: OnAfterFlushInput) {
        if (input.turnIdx === 0) {
          await sleep(80); // 远超 30ms → 被 dispatcher race 丢弃
          return { compactionBoundary: slowSummary };
        }
      },
    };
    const session = new AgentSession({
      model: fake,
      tools: [noopTool],
      store,
      hooks: [slowHook],
      hookFailureSink: (info) => failures.push(`${info.method}:${info.errorMessage}`),
    });
    const result = await session.run("go");

    // run 不被超时杀掉（fire-and-observe）
    expect(result.reason).toBe("done");
    // dispatcher 记录了一次 timeout（observe，不杀 run）
    expect(failures.some((f) => /onAfterFlush/.test(f))).toBe(true);

    const path = await store.getPathToLeaf(session.id);
    // 关键：超时的 boundary 绝不落盘 —— store 里零 compaction_boundary。
    expect(path.filter((e) => e.entry.kind === "compaction_boundary")).toHaveLength(0);
    // seq 单调（无并发损坏迹象：没有两条 appendEntry 并发同 session 撞号）。
    const seqs = path.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, c) => a - c));

    // 即使等待远超 slow summarize 的 80ms，仍然没有迟到的 detached 写偷偷落进 store。
    await sleep(120);
    const path2 = await store.getPathToLeaf(session.id);
    expect(path2.filter((e) => e.entry.kind === "compaction_boundary")).toHaveLength(0);

    // resume 不丢任何已完成 turn：全量 [user, assistant(toolCall), toolResult, assistant]。
    const fake2 = createFakeModel([{ content: [{ type: "text", text: "z" }] }]);
    const resumed = await AgentSession.resume(store, session.id, {
      model: fake2,
      tools: [noopTool],
    });
    expect(resumed.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    fake.teardown();
    fake2.teardown();
  });

  it("REGRESSION: a slow hook on turn 0 cannot reorder a boundary AFTER turn 1's messages", async () => {
    // 上一版：turn-0 的 detached append 与 turn-1 的 _flushToStore 并发同 session → 链损坏 / 乱序。
    // 本设计：内核在「下一轮 flush 之前」就已 await 完 boundary 写，串行 in-band，故即使 hook 极慢
    // 也只是被超时丢弃，永远不会出现 boundary 排在后续 turn 消息之后。
    const store = new MemorySessionStore();
    const fake = createFakeModel([
      { content: [{ type: "toolCall", name: "noop", arguments: {} }] },
      { content: [{ type: "text", text: "final" }] },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [noopTool],
      store,
      hooks: [
        {
          name: "slow",
          timeout: 25,
          async onAfterFlush(input: OnAfterFlushInput) {
            if (input.turnIdx === 0) {
              await sleep(70);
              return { compactionBoundary: createUserMessage("LATE") };
            }
          },
        },
      ],
      hookFailureSink: () => {},
    });
    await session.run("go");
    await sleep(120);

    const path = await store.getPathToLeaf(session.id);
    // turn-1 的 assistant(text) 是最后一条 message；它之后只能是 terminal，绝不能有迟到 boundary。
    const kinds = path.map((e) => e.entry.kind);
    const lastMsgIdx = kinds.lastIndexOf("message");
    const after = kinds.slice(lastMsgIdx + 1);
    expect(after).not.toContain("compaction_boundary");
    fake.teardown();
  });
});
