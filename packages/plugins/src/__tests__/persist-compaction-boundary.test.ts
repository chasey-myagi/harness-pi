/**
 * persistCompactionBoundary controller integration —— C1 redesign (docs/09 §4.2).
 *
 * 端到端：跑几个 turn → shouldCompact 触发 → 控制器**返回** summary → 内核 in-band 串行落 boundary →
 * AgentSession.resume 从 boundary 重建出 [summary, ...post-boundary]（而非全量）。
 *
 * 核心回归（锁住上一版 detached 写的 data-loss / store-corruption）：超时的 summarize 不致 boundary
 * 乱序落在 terminal 之后、不丢已完成 turn、store 顺序单调、run 不被杀。见最后两个用例。
 */

import { describe, it, expect } from "vitest";
import {
  AgentSession,
  MemorySessionStore,
  createUserMessage,
  type HarnessTool,
  type Message,
} from "@harness-pi/core";
import { createFakeModel } from "@harness-pi/core/testing";
import { persistCompactionBoundary } from "../controllers/index.js";

const noopTool: HarnessTool = {
  name: "noop",
  description: "noop",
  parameters: { type: "object", properties: {} } as never,
  async execute() {
    return { content: [{ type: "text", text: "ok" }] };
  },
};

const roles = (msgs: ReadonlyArray<Message>) => msgs.map((m) => m.role);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("persistCompactionBoundary controller (return-based)", () => {
  it("triggers a boundary → resume rebuilds [summary, ...post-boundary], not the full history", async () => {
    const store = new MemorySessionStore();
    // turn 0: tool call (assistant + toolResult). turn 1: text → done.
    const fake = createFakeModel([
      { content: [{ type: "toolCall", name: "noop", arguments: {} }] },
      { content: [{ type: "text", text: "final" }] },
    ]);
    const summary = createUserMessage("SUMMARY-OF-PREFIX");
    const hook = persistCompactionBoundary({
      // only compact after turn 0's flush (exactly 3 persisted: user + assistant + toolResult);
      // turn 1's flush (4 persisted) won't re-trigger, leaving turn-1 messages after the boundary.
      shouldCompact: ({ persistedCount }) => persistedCount === 3,
      summarize: () => summary,
    });
    const session = new AgentSession({
      model: fake,
      tools: [noopTool],
      store,
      hooks: [hook],
    });
    await session.run("go");

    // live session keeps the full history (HWM unaffected)
    expect(roles(session.messages)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);

    const path = await store.getPathToLeaf(session.id);
    expect(path.filter((e) => e.entry.kind === "compaction_boundary")).toHaveLength(1);

    // resume drops the pre-boundary prefix, keeps summary + post-boundary turn-1 assistant
    const fake2 = createFakeModel([{ content: [{ type: "text", text: "z" }] }]);
    const resumed = await AgentSession.resume(store, session.id, {
      model: fake2,
      tools: [noopTool],
    });
    expect(roles(resumed.messages)).toEqual(["user", "assistant"]);
    expect(resumed.messages[0]).toBe(summary);
    fake.teardown();
    fake2.teardown();
  });

  it("shouldCompact=false never writes a boundary (resume == full history)", async () => {
    const store = new MemorySessionStore();
    const fake = createFakeModel([
      { content: [{ type: "toolCall", name: "noop", arguments: {} }] },
      { content: [{ type: "text", text: "final" }] },
    ]);
    const hook = persistCompactionBoundary({
      shouldCompact: () => false,
      summarize: () => createUserMessage("never"),
    });
    const session = new AgentSession({
      model: fake,
      tools: [noopTool],
      store,
      hooks: [hook],
    });
    await session.run("go");

    const path = await store.getPathToLeaf(session.id);
    expect(path.filter((e) => e.entry.kind === "compaction_boundary")).toHaveLength(0);
    fake.teardown();
  });

  it("shouldCompact receives only the flushed prefix (length === persistedCount)", async () => {
    const store = new MemorySessionStore();
    const fake = createFakeModel([
      { content: [{ type: "toolCall", name: "noop", arguments: {} }] },
      { content: [{ type: "text", text: "final" }] },
    ]);
    let seen: { persistedCount: number; len: number } | undefined;
    const hook = persistCompactionBoundary({
      shouldCompact: ({ persistedCount, messages }) => {
        seen = { persistedCount, len: messages.length };
        return false;
      },
      summarize: () => createUserMessage("x"),
    });
    const session = new AgentSession({ model: fake, tools: [noopTool], store, hooks: [hook] });
    await session.run("go");

    expect(seen).toBeDefined();
    expect(seen!.len).toBe(seen!.persistedCount); // 传入的是已持久化前缀,非全量 ctx.messages
    fake.teardown();
  });

  it("minTurnsBetween throttles: not every qualifying turn writes a boundary", async () => {
    const store = new MemorySessionStore();
    // three turns, each a tool call then the loop ends at maxTurns.
    const fake = createFakeModel([
      { content: [{ type: "toolCall", name: "noop", arguments: {} }] },
      { content: [{ type: "toolCall", name: "noop", arguments: {} }] },
      { content: [{ type: "toolCall", name: "noop", arguments: {} }] },
    ]);
    let summarizeCalls = 0;
    const hook = persistCompactionBoundary({
      shouldCompact: () => true, // every turn qualifies
      summarize: () => {
        summarizeCalls++;
        return createUserMessage(`S${summarizeCalls}`);
      },
      minTurnsBetween: 2,
    });
    const session = new AgentSession({
      model: fake,
      tools: [noopTool],
      store,
      hooks: [hook],
      maxTurns: 3,
    });
    await session.run("go");

    // turns flushed at idx 0,1,2. minTurnsBetween=2: boundary at turn 0 (first),
    // then turn 1 skipped (1-0 < 2), turn 2 allowed (2-0 >= 2) → 2 boundaries, 2 summarize calls.
    const boundaries = (await store.getPathToLeaf(session.id)).filter(
      (e) => e.entry.kind === "compaction_boundary",
    );
    expect(boundaries).toHaveLength(2);
    expect(summarizeCalls).toBe(2);
    fake.teardown();
  });

  it("throttle high-water-mark advances before the await, so a failing summarize can't defeat minTurnsBetween", async () => {
    // 节流高水位若在 await 之后才 set,summarize 抛错会让它漏更新 → 每个 qualifying turn 都重新触发。
    // 控制器「先提交节流、再做 async 慢活」。summarize 总抛错(fire-and-observe,不杀 run):
    //   set 先行 → 节流照常 → 4 个 qualifying turn 只调 2 次 summarize。
    const store = new MemorySessionStore();
    const fake = createFakeModel([
      { content: [{ type: "toolCall", name: "noop", arguments: {} }] },
      { content: [{ type: "toolCall", name: "noop", arguments: {} }] },
      { content: [{ type: "toolCall", name: "noop", arguments: {} }] },
      { content: [{ type: "toolCall", name: "noop", arguments: {} }] },
    ]);
    let calls = 0;
    const hook = persistCompactionBoundary({
      shouldCompact: () => true,
      summarize: () => {
        calls++;
        throw new Error("summarize boom");
      },
      minTurnsBetween: 2,
    });
    const session = new AgentSession({
      model: fake,
      tools: [noopTool],
      store,
      hooks: [hook],
      maxTurns: 4,
      hookFailureSink: () => {}, // swallow recorded summarize failure
    });
    await session.run("go"); // summarize 抛错被 fire-and-observe 吞,run 不被杀

    // turns 0,1,2,3;minTurnsBetween=2 → 触发于 0 与 2(2 次),即使 summarize 每次抛错。
    expect(calls).toBe(2);
    fake.teardown();
  });

  it("rejects minTurnsBetween < 1 at construction", () => {
    expect(() =>
      persistCompactionBoundary({
        shouldCompact: () => true,
        summarize: () => createUserMessage("x"),
        minTurnsBetween: 0,
      }),
    ).toThrow(/minTurnsBetween/);
  });

  it("async (LLM-latency) summarize beyond the 100ms event default still writes a boundary", async () => {
    // onAfterFlush 走 event 类、dispatcher 默认超时仅 100ms;summarize 调 LLM 是秒级。控制器把 hook
    // timeout 放宽(默认 60s),否则真 summarize 必超时、其返回被丢弃 → 零 boundary。这里 ~150ms async
    // summarize:>100ms(旧默认会超时)、远 < 放宽后默认 → boundary 必落。
    const store = new MemorySessionStore();
    const fake = createFakeModel([
      { content: [{ type: "toolCall", name: "noop", arguments: {} }] },
      { content: [{ type: "text", text: "final" }] },
    ]);
    const summary = createUserMessage("ASYNC-SUMMARY");
    const hook = persistCompactionBoundary({
      shouldCompact: ({ persistedCount }) => persistedCount === 3,
      summarize: () => new Promise<Message>((r) => setTimeout(() => r(summary), 150)),
    });
    const session = new AgentSession({ model: fake, tools: [noopTool], store, hooks: [hook] });
    const result = await session.run("go");

    expect(result.reason).toBe("done");
    const boundaries = (await store.getPathToLeaf(session.id)).filter(
      (e) => e.entry.kind === "compaction_boundary",
    );
    expect(boundaries).toHaveLength(1);
    fake.teardown();
  });

  /* ───────────────── 核心回归：超时不致数据丢失 / 乱序 ───────────────── */

  it("REGRESSION: a timed-out summarize loses no data, leaves no out-of-order boundary, doesn't kill the run", async () => {
    // 上一版 detached 设计在这里会失败:hook 超时 → detached summarize+append 仍在飞 → boundary 乱序
    // 落在后续 turn / terminal 之后 → resume 把它当「丢弃之前一切」→ 静默删已完成 turn。
    // 本设计:超时的 summarize 返回被 dispatcher race 丢弃 → 控制器返回到不了内核 → 不写 boundary。
    const store = new MemorySessionStore();
    // turn 0: tool call (3 persisted). turn 1: text → done (4 persisted).
    const fake = createFakeModel([
      { content: [{ type: "toolCall", name: "noop", arguments: {} }] },
      { content: [{ type: "text", text: "final" }] },
    ]);
    let summarizeStarted = 0;
    const failures: string[] = [];
    const hook = persistCompactionBoundary({
      shouldCompact: ({ persistedCount }) => persistedCount === 3, // 只 turn 0 触发
      // 慢 summarize(80ms)远超下方 30ms hook timeout → 被 race 丢弃。
      summarize: async () => {
        summarizeStarted++;
        await sleep(80);
        return createUserMessage("SLOW-SHOULD-NEVER-LAND");
      },
      timeout: 30, // 小超时,故意让 summarize 来不及完成
    });
    const session = new AgentSession({
      model: fake,
      tools: [noopTool],
      store,
      hooks: [hook],
      hookFailureSink: (info) => failures.push(`${info.method}:${info.errorMessage}`),
    });
    const result = await session.run("go");

    // run 没被超时杀掉(fire-and-observe)。
    expect(result.reason).toBe("done");
    // summarize 确实被启动过(证明触发逻辑生效),且 dispatcher 记到一次 onAfterFlush 超时。
    expect(summarizeStarted).toBe(1);
    expect(failures.some((f) => /onAfterFlush/.test(f))).toBe(true);

    // 即使等到远超 slow summarize 的 80ms,也没有迟到的 detached 写偷偷落进 store。
    await sleep(120);
    const path = await store.getPathToLeaf(session.id);
    // 关键:超时 → 零 boundary 落盘。
    expect(path.filter((e) => e.entry.kind === "compaction_boundary")).toHaveLength(0);
    // store 顺序单调(无并发损坏:没有两条 appendEntry 并发同 session 撞号)。
    const seqs = path.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, c) => a - c));
    // terminal 之后没有任何 entry(乱序的 boundary 本会落在这里)。
    expect(path[path.length - 1]!.entry.kind).toBe("terminal");

    // resume 不丢任何已完成 turn:全量重建。
    const fake2 = createFakeModel([{ content: [{ type: "text", text: "z" }] }]);
    const resumed = await AgentSession.resume(store, session.id, {
      model: fake2,
      tools: [noopTool],
    });
    expect(roles(resumed.messages)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    fake.teardown();
    fake2.teardown();
  });

  it("REGRESSION: even with throttle set before the slow await, a timed-out turn writes nothing and resume is whole", async () => {
    // 多 turn:turn 0 慢 summarize 被超时丢弃(无 boundary),turn 1 正常完成。验证超时的 turn 既不破坏
    // store 顺序、也不阻断后续 turn 的正常 boundary;resume 完整。
    const store = new MemorySessionStore();
    const fake = createFakeModel([
      { content: [{ type: "toolCall", name: "noop", arguments: {} }] },
      { content: [{ type: "text", text: "final" }] },
    ]);
    const fastSummary = createUserMessage("FAST");
    const hook = persistCompactionBoundary({
      shouldCompact: () => true,
      summarize: async (flushed) => {
        // turn 0 的前缀有 3 条(含 toolResult)→ 慢;turn 1 前缀 4 条 → 快。
        if (flushed.length === 3) {
          await sleep(80); // 被 30ms timeout 丢弃
          return createUserMessage("SLOW");
        }
        return fastSummary;
      },
      timeout: 30,
      minTurnsBetween: 1,
    });
    const session = new AgentSession({
      model: fake,
      tools: [noopTool],
      store,
      hooks: [hook],
      hookFailureSink: () => {},
    });
    await session.run("go");
    await sleep(120);

    const path = await store.getPathToLeaf(session.id);
    // 仅 turn 1 的 fast boundary 落盘(turn 0 超时被丢)。
    const boundaries = path
      .filter((e) => e.entry.kind === "compaction_boundary")
      .map((e) => (e.entry as { kind: "compaction_boundary"; summary: Message }).summary);
    expect(boundaries).toEqual([fastSummary]);
    // 顺序单调,terminal 收尾。
    const seqs = path.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, c) => a - c));
    expect(path[path.length - 1]!.entry.kind).toBe("terminal");

    // resume:turn-1 的 fast boundary 覆盖全部前缀 → [summary]（turn 1 assistant 在 boundary 之前 flush）。
    const fake2 = createFakeModel([{ content: [{ type: "text", text: "z" }] }]);
    const resumed = await AgentSession.resume(store, session.id, {
      model: fake2,
      tools: [noopTool],
    });
    expect(resumed.messages[0]).toBe(fastSummary);
    fake.teardown();
    fake2.teardown();
  });
});
