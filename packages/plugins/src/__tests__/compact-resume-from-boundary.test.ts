/**
 * compactResumeFromBoundary 控制器测试（C3，docs/09 §4.2）。
 * 它是 compactRestartFresh 的兄弟：overflow → compactOnOverflow abort 后，**不**丢 trace fresh 重跑，
 * 而是写一条覆盖全量的 summary boundary、从 boundary resume + continue 续跑（保留压缩成果）。
 *
 * 经 testing.ts fake-model 驱动真 AgentSession + MemorySessionStore（core 直接导出）。验证：
 *   - overflow → 写 boundary → resume → continue → 第二段 done；restarts>=1。
 *   - resume 后的 continue 段从 boundary 起算（fake 收到的首条 message 是 summary，且 lineage 同 sessionId）。
 *   - maxRestarts 耗尽（持续 overflow）→ 返回 aborted summary、restarts===maxRestarts、不无限循环。
 *   - 复用 compactOnOverflow + isCompactionRestart（import，不重定义）。
 *   - 不挂 compactOnOverflow → overflow 不变 compaction-abort → 控制器不 resume（行为=普通 run）。
 */

import { describe, it, expect } from "vitest";
import {
  AgentSession,
  MemorySessionStore,
  createUserMessage,
  type Hook,
  type Message,
} from "@harness-pi/core";
import { createFakeModel } from "@harness-pi/core/testing";
import {
  compactOnOverflow,
  CompactResumeFromBoundary,
  isCompactionRestart,
  COMPACTION_OVERFLOW_REASON,
} from "../controllers/index.js";

describe("CompactResumeFromBoundary", () => {
  it("happy path: no overflow → no restart, behaves like a plain run", async () => {
    const store = new MemorySessionStore();
    const model = createFakeModel([
      { content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ]);
    const ctrl = new CompactResumeFromBoundary({
      store,
      sessionId: "s-happy",
      sessionOptions: { model, tools: [], hooks: [compactOnOverflow()] },
      summarize: () => createUserMessage("never"),
    });
    const res = await ctrl.run("solve it");

    expect(res.reason).toBe("done");
    expect(res.restarts).toBe(0);
    // 没 overflow → 没写 boundary。
    const path = await store.getPathToLeaf("s-happy");
    expect(path.filter((e) => e.entry.kind === "compaction_boundary")).toHaveLength(0);
    model.teardown();
  });

  it("overflow (length) → writes boundary, resumes from it, continue succeeds; restarts>=1", async () => {
    const store = new MemorySessionStore();
    // 首跑 turn0 截断 → compactOnOverflow abort。resume-continue turn0 正常 done。
    const model = createFakeModel([
      { content: [{ type: "text", text: "truncated" }], stopReason: "length" },
      { content: [{ type: "text", text: "recovered" }], stopReason: "stop" },
    ]);
    const summary = createUserMessage("SUMMARY-OF-OVERFLOWING-TRACE");
    const ctrl = new CompactResumeFromBoundary({
      store,
      sessionId: "s-recover",
      sessionOptions: { model, tools: [], hooks: [compactOnOverflow()] },
      summarize: () => summary,
    });
    const res = await ctrl.run("solve it");

    expect(res.reason).toBe("done");
    expect(res.restarts).toBe(1);

    // 恰好写了一条 boundary，summary 就是我们提供的那条。
    const path = await store.getPathToLeaf("s-recover");
    const boundaries = path
      .filter((e) => e.entry.kind === "compaction_boundary")
      .map((e) => (e.entry as { kind: "compaction_boundary"; summary: Message }).summary);
    expect(boundaries).toEqual([summary]);
    model.teardown();
  });

  it("overflow surfaced as an error stopReason also triggers a boundary + resume", async () => {
    const store = new MemorySessionStore();
    const model = createFakeModel([
      { content: [], throwError: new Error("maximum context length exceeded") },
      { content: [{ type: "text", text: "recovered" }], stopReason: "stop" },
    ]);
    const ctrl = new CompactResumeFromBoundary({
      store,
      sessionId: "s-err",
      sessionOptions: { model, tools: [], hooks: [compactOnOverflow()] },
      summarize: () => createUserMessage("S"),
    });
    const res = await ctrl.run("solve it");

    expect(res.reason).toBe("done");
    expect(res.restarts).toBe(1);
    model.teardown();
  });

  it("resume continues FROM the boundary — the continue() call sees [summary] as its first message, same lineage", async () => {
    // 这是 C3 区别于 fresh 的全部理由：保留 summary 成果、从 boundary 起算（resume → [summary]）。
    const store = new MemorySessionStore();
    const model = createFakeModel([
      { content: [{ type: "text", text: "truncated" }], stopReason: "length" }, // 首跑 → overflow
      { content: [{ type: "text", text: "recovered" }], stopReason: "stop" }, // resume-continue
    ]);
    const summary = createUserMessage("BOUNDARY-SUMMARY");
    const ctrl = new CompactResumeFromBoundary({
      store,
      sessionId: "s-from-boundary",
      sessionOptions: { model, tools: [], hooks: [compactOnOverflow()] },
      summarize: () => summary,
    });
    const res = await ctrl.run("the original prompt");

    expect(res.reason).toBe("done");
    expect(res.restarts).toBe(1);

    const calls = model.getCalls();
    // 最后一次 LLM 调用是 resume 后的 continue：context 以 boundary summary 起头（不是原 prompt）。
    const continueCall = calls[calls.length - 1]!;
    expect(continueCall.messages[0]).toBe(summary);
    // resume 出的 [summary] 覆盖全量 → continue 段 context 不再含原始 user prompt。
    expect(
      continueCall.messages.some(
        (m) => m.role === "user" && m !== summary,
      ),
    ).toBe(false);

    // 同一 lineage：所有 entry 都在同一个 sessionId 下重建。
    const resumed = await AgentSession.resume(store, "s-from-boundary", { model, tools: [] });
    expect(resumed.id).toBe("s-from-boundary");
    model.teardown();
  });

  it("persistent overflow stops after maxRestarts and returns the aborted summary (no fake recovery, no infinite loop)", async () => {
    const store = new MemorySessionStore();
    // 每段都 length-截断 → 永远 overflow。备足 response 防 fake 跑空。
    const model = createFakeModel(
      Array.from({ length: 6 }, () => ({
        content: [{ type: "text" as const, text: "x" }],
        stopReason: "length" as const,
      })),
    );
    const ctrl = new CompactResumeFromBoundary({
      store,
      sessionId: "s-persist",
      sessionOptions: { model, tools: [], hooks: [compactOnOverflow()] },
      summarize: () => createUserMessage("S"),
      maxRestarts: 2,
    });
    const res = await ctrl.run("oversized");

    expect(res.restarts).toBe(2);
    expect(res.reason).toBe("aborted");
    expect(res.abortReason).toBe(COMPACTION_OVERFLOW_REASON);
    // 恰好 maxRestarts 次 resume → maxRestarts 条 boundary，不多写（不无限循环）。
    const path = await store.getPathToLeaf("s-persist");
    expect(path.filter((e) => e.entry.kind === "compaction_boundary")).toHaveLength(2);
    model.teardown();
  });

  it("maxRestarts: 0 never resumes — returns the first aborted summary", async () => {
    const store = new MemorySessionStore();
    const model = createFakeModel(
      Array.from({ length: 3 }, () => ({
        content: [{ type: "text" as const, text: "x" }],
        stopReason: "length" as const,
      })),
    );
    const ctrl = new CompactResumeFromBoundary({
      store,
      sessionId: "s-zero",
      sessionOptions: { model, tools: [], hooks: [compactOnOverflow()] },
      summarize: () => createUserMessage("S"),
      maxRestarts: 0,
    });
    const res = await ctrl.run("p");

    expect(res.restarts).toBe(0);
    expect(res.reason).toBe("aborted");
    expect(res.abortReason).toBe(COMPACTION_OVERFLOW_REASON);
    const path = await store.getPathToLeaf("s-zero");
    expect(path.filter((e) => e.entry.kind === "compaction_boundary")).toHaveLength(0);
    model.teardown();
  });

  it("does NOT resume on a non-compaction abort (no compactOnOverflow hook → overflow stays a plain abort)", async () => {
    const store = new MemorySessionStore();
    const model = createFakeModel([
      { content: [{ type: "text", text: "t" }], stopReason: "length" },
    ]);
    // 用一个非 compaction reason 的 overflow hook（即「没装 compactOnOverflow」的等价情形）。
    const manualAbort: Hook = {
      name: "manual",
      onContextOverflow: (_i, ctx) => ctx.abort("manual:stop"),
    };
    let summarizeCalls = 0;
    const ctrl = new CompactResumeFromBoundary({
      store,
      sessionId: "s-noncompact",
      sessionOptions: { model, tools: [], hooks: [manualAbort] },
      summarize: () => {
        summarizeCalls++;
        return createUserMessage("S");
      },
    });
    const res = await ctrl.run("p");

    expect(res.restarts).toBe(0);
    expect(res.reason).toBe("aborted");
    expect(res.abortReason).toBe("manual:stop");
    // 不认 → 不 resume → 不 summarize、不写 boundary（行为=普通 run）。
    expect(summarizeCalls).toBe(0);
    const path = await store.getPathToLeaf("s-noncompact");
    expect(path.filter((e) => e.entry.kind === "compaction_boundary")).toHaveLength(0);
    model.teardown();
  });

  it("honors a custom compaction abort reason", async () => {
    const store = new MemorySessionStore();
    const model = createFakeModel([
      { content: [{ type: "text", text: "t" }], stopReason: "length" },
      { content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ]);
    const ctrl = new CompactResumeFromBoundary({
      store,
      sessionId: "s-custom",
      sessionOptions: {
        model,
        tools: [],
        hooks: [compactOnOverflow({ reason: "compaction:summarize-failed" })],
      },
      summarize: () => createUserMessage("S"),
    });
    const res = await ctrl.run("p");

    expect(res.reason).toBe("done");
    expect(res.restarts).toBe(1);
    model.teardown();
  });

  it("stops resuming when the external signal is aborted", async () => {
    const ac = new AbortController();
    const store = new MemorySessionStore();
    const model = createFakeModel(
      Array.from({ length: 5 }, () => ({
        content: [{ type: "text" as const, text: "x" }],
        stopReason: "length" as const,
      })),
    );
    const abortBoth: Hook = {
      name: "abort-both",
      onContextOverflow: (_i, ctx) => {
        ctx.abort(COMPACTION_OVERFLOW_REASON); // 内部 abort 先发（首个 abort 胜出）
        ac.abort(); // 同时 abort 外部 signal
      },
    };
    const ctrl = new CompactResumeFromBoundary({
      store,
      sessionId: "s-signal",
      sessionOptions: { model, tools: [], hooks: [abortBoth] },
      summarize: () => createUserMessage("S"),
    });
    const res = await ctrl.run("p", { signal: ac.signal });

    expect(res.restarts).toBe(0); // signal aborted → while 守卫拦下 resume
    expect(res.reason).toBe("aborted");
    model.teardown();
  });

  it("rejects negative maxRestarts at construction", () => {
    const store = new MemorySessionStore();
    const model = createFakeModel([]);
    expect(
      () =>
        new CompactResumeFromBoundary({
          store,
          sessionId: "s-neg",
          sessionOptions: { model, tools: [], hooks: [compactOnOverflow()] },
          summarize: () => createUserMessage("S"),
          maxRestarts: -1,
        }),
    ).toThrow(/maxRestarts/);
    model.teardown();
  });

  it("summarize throwing → run() rejects (propagate) and writes NO orphan boundary", async () => {
    const store = new MemorySessionStore();
    const model = createFakeModel([
      // 首跑 overflow → compactOnOverflow abort → 控制器要 summarize(此处抛错)。
      { content: [{ type: "text", text: "truncated" }], stopReason: "length" },
      { content: [{ type: "text", text: "recovered" }], stopReason: "stop" },
    ]);
    const ctrl = new CompactResumeFromBoundary({
      store,
      sessionId: "s-sumfail",
      sessionOptions: { model, tools: [], hooks: [compactOnOverflow()] },
      summarize: () => {
        throw new Error("summarize backend down");
      },
    });
    // summarize 在 appendEntry 之前抛 → run() reject(fail-loud,caller 自负 summarize 错误)。
    await expect(ctrl.run("solve it")).rejects.toThrow("summarize backend down");
    // 数据完整性:抛在写 boundary 之前 → store 无半成品 orphan compaction_boundary。
    const path = await store.getPathToLeaf("s-sumfail");
    expect(
      path.filter((e) => e.entry.kind === "compaction_boundary"),
    ).toHaveLength(0);
    model.teardown();
  });
});

describe("isCompactionRestart (reused, not redefined)", () => {
  it("matches compaction:* abort reasons only", () => {
    expect(isCompactionRestart("compaction:overflow")).toBe(true);
    expect(isCompactionRestart("watchdog:timeout")).toBe(false);
    expect(isCompactionRestart(undefined)).toBe(false);
  });
});
