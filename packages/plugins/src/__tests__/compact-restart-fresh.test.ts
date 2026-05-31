/**
 * compactRestartFresh 策略插件测试（docs/09 §4.2）。
 * 验证 overflow → ctx.abort("compaction:…") → fresh 重跑同一 prompt 的闭环，
 * 以及「只重启 compaction-class abort」「初始 prompt 过大时不假装恢复」等边界。
 */

import { describe, it, expect } from "vitest";
import { AgentSession, Type, type Hook, type HarnessTool } from "@harness-pi/core";
import { createFakeModel, type FakeModel } from "@harness-pi/core/testing";
import {
  compactOnOverflow,
  CompactRestartFresh,
  isCompactionRestart,
  COMPACTION_OVERFLOW_REASON,
} from "../controllers/index.js";

/** 用给定 model + hooks（+ 可选 tools）造 fresh session 的工厂。 */
function factoryFor(model: FakeModel, hooks: Hook[], tools: HarnessTool[] = []) {
  return () => new AgentSession({ model, tools, hooks });
}

describe("CompactRestartFresh", () => {
  it("happy path: no overflow → no restart", async () => {
    const model = createFakeModel([
      { content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ]);
    const ctrl = new CompactRestartFresh({
      sessionFactory: factoryFor(model, [compactOnOverflow()]),
    });
    const res = await ctrl.run("solve it");

    expect(res.reason).toBe("done");
    expect(res.restarts).toBe(0);
    model.teardown();
  });

  it("overflow (length) → aborts, then fresh re-run succeeds", async () => {
    // run 1 截断 → compactOnOverflow ctx.abort → CompactRestartFresh fresh 重跑 → run 2 成功。
    const model = createFakeModel([
      { content: [{ type: "text", text: "truncated" }], stopReason: "length" },
      { content: [{ type: "text", text: "recovered" }], stopReason: "stop" },
    ]);
    const ctrl = new CompactRestartFresh({
      sessionFactory: factoryFor(model, [compactOnOverflow()]),
    });
    const res = await ctrl.run("solve it");

    expect(res.reason).toBe("done");
    expect(res.restarts).toBe(1);
    model.teardown();
  });

  it("overflow surfaced as an error stopReason also triggers restart", async () => {
    const model = createFakeModel([
      { content: [], throwError: new Error("maximum context length exceeded") },
      { content: [{ type: "text", text: "recovered" }], stopReason: "stop" },
    ]);
    const ctrl = new CompactRestartFresh({
      sessionFactory: factoryFor(model, [compactOnOverflow()]),
    });
    const res = await ctrl.run("solve it");

    expect(res.reason).toBe("done");
    expect(res.restarts).toBe(1);
    model.teardown();
  });

  it("persistent overflow stops after maxRestarts and returns the aborted summary (no fake recovery)", async () => {
    const model = createFakeModel(
      Array.from({ length: 6 }, () => ({
        content: [{ type: "text" as const, text: "x" }],
        stopReason: "length" as const,
      })),
    );
    const ctrl = new CompactRestartFresh({
      sessionFactory: factoryFor(model, [compactOnOverflow()]),
      maxRestarts: 2,
    });
    const res = await ctrl.run("oversized");

    expect(res.restarts).toBe(2);
    expect(res.reason).toBe("aborted");
    expect(res.abortReason).toBe(COMPACTION_OVERFLOW_REASON);
    model.teardown();
  });

  it("does NOT restart on a non-compaction abort", async () => {
    // overflow hook 用非 compaction reason abort → 控制器不认 → 不重启。
    const model = createFakeModel([
      { content: [{ type: "text", text: "t" }], stopReason: "length" },
    ]);
    const manualAbort: Hook = {
      name: "manual",
      onContextOverflow: (_i, ctx) => ctx.abort("manual:stop"),
    };
    const ctrl = new CompactRestartFresh({
      sessionFactory: factoryFor(model, [manualAbort]),
    });
    const res = await ctrl.run("p");

    expect(res.restarts).toBe(0);
    expect(res.reason).toBe("aborted");
    expect(res.abortReason).toBe("manual:stop");
    model.teardown();
  });

  it("honors a custom compaction abort reason", async () => {
    const model = createFakeModel([
      { content: [{ type: "text", text: "t" }], stopReason: "length" },
      { content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ]);
    const ctrl = new CompactRestartFresh({
      sessionFactory: factoryFor(model, [
        compactOnOverflow({ reason: "compaction:summarize-failed" }),
      ]),
    });
    const res = await ctrl.run("p");

    expect(res.reason).toBe("done");
    expect(res.restarts).toBe(1);
    model.teardown();
  });

  it("restart uses a FRESH session — drops the overflowing trace (unlike carry-history restart)", async () => {
    // 这是 compactRestartFresh 区别于 LifecycleRestart 的全部理由，必须用断言钉住、不能只靠注释。
    // run1：turn0 用工具 → turn1 截断 → abort（trace 已累积）。run2：fresh，只剩 user prompt。
    const echo: HarnessTool = {
      name: "echo",
      description: "echo",
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text", text: "r" }] };
      },
    };
    const model = createFakeModel([
      { content: [{ type: "toolCall", name: "echo", arguments: {} }] }, // run1 turn0
      { content: [{ type: "text", text: "x" }], stopReason: "length" }, // run1 turn1 → overflow → abort
      { content: [{ type: "text", text: "done" }], stopReason: "stop" }, // run2 (fresh) turn0
    ]);
    const ctrl = new CompactRestartFresh({
      sessionFactory: factoryFor(model, [compactOnOverflow()], [echo]),
    });
    const res = await ctrl.run("solve it");

    expect(res.reason).toBe("done");
    expect(res.restarts).toBe(1);

    const calls = model.getCalls();
    // run1 turn1 的 LLM 调用应已带上累积 trace（user + assistant(toolCall) + toolResult）。
    expect(calls[1]!.messages.length).toBeGreaterThan(1);
    // run2（最后一次调用）是 fresh：context 只含 user prompt，越界 trace 被丢掉。
    const restartCall = calls[calls.length - 1]!;
    expect(restartCall.messages).toHaveLength(1);
    expect(restartCall.messages[0]!.role).toBe("user");
    model.teardown();
  });

  it("maxRestarts: 0 never restarts — returns the first aborted summary", async () => {
    const model = createFakeModel(
      Array.from({ length: 3 }, () => ({
        content: [{ type: "text" as const, text: "x" }],
        stopReason: "length" as const,
      })),
    );
    const ctrl = new CompactRestartFresh({
      sessionFactory: factoryFor(model, [compactOnOverflow()]),
      maxRestarts: 0,
    });
    const res = await ctrl.run("p");

    expect(res.restarts).toBe(0);
    expect(res.reason).toBe("aborted");
    expect(res.abortReason).toBe(COMPACTION_OVERFLOW_REASON);
    model.teardown();
  });

  it("stops restarting when the external signal is aborted", async () => {
    // 即便是 compaction-class abort（本会重启），外部 signal 一旦 abort 就不再重启。
    const ac = new AbortController();
    const model = createFakeModel(
      Array.from({ length: 5 }, () => ({
        content: [{ type: "text" as const, text: "x" }],
        stopReason: "length" as const,
      })),
    );
    const abortBoth: Hook = {
      name: "abort-both",
      onContextOverflow: (_i, ctx) => {
        ctx.abort(COMPACTION_OVERFLOW_REASON); // 内部 abort 先发，reason 固定（首个 abort 胜出）
        ac.abort(); // 同时 abort 外部 signal
      },
    };
    const ctrl = new CompactRestartFresh({
      sessionFactory: factoryFor(model, [abortBoth]),
    });
    const res = await ctrl.run("p", { signal: ac.signal });

    expect(res.restarts).toBe(0); // signal aborted → while 守卫拦下重启
    expect(res.reason).toBe("aborted");
    model.teardown();
  });

  it("rejects negative maxRestarts at construction", () => {
    const model = createFakeModel([]);
    expect(
      () =>
        new CompactRestartFresh({
          sessionFactory: factoryFor(model, [compactOnOverflow()]),
          maxRestarts: -1,
        }),
    ).toThrow(/maxRestarts/);
    model.teardown();
  });
});

describe("isCompactionRestart", () => {
  it("matches compaction:* abort reasons only", () => {
    expect(isCompactionRestart("compaction:overflow")).toBe(true);
    expect(isCompactionRestart("compaction:summarize")).toBe(true);
    expect(isCompactionRestart("watchdog:timeout")).toBe(false);
    expect(isCompactionRestart("onUserPromptSubmit halted")).toBe(false);
    expect(isCompactionRestart(undefined)).toBe(false);
  });
});
