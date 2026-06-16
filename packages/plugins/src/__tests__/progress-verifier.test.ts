/**
 * progressVerifier 单测 —— 跑真实 AgentSession + fake LLM。
 *
 * 覆盖：
 *   1. 目标达成即停（reached=true）→ abortReason 含 "goal reached"
 *   2. 连续 N turn 无进展即停（hasProgress=false × N）→ abortReason 含 "no progress"
 *   3. 进展重置计数（中途插入 hasProgress:true → 计数归零 → 再无进展才停）
 *   4. judge 抛错：中性处理（不累计无进展、不停止），session 继续正常结束
 *   5. onStall 回调被调用，且 onStall 调 ctx.abort() 时插件不二次停止
 *   6. hasProgress 省略时默认 true（乐观），不会意外累计无进展
 *   7. 配置校验：noProgressThreshold <= 0 / timeoutMs <= 0 抛错
 *   8. 默认 timeout 宽松（event 类 100ms 太短，默认 30s）
 *   9. 两个 session 各自独立状态
 *
 * ---
 * 内核 turn 模型：`onTurnEnd` 每次内层 turn（LLM call + tool batch）结束各触发一次。
 * 驱动多 turn 的方式：fake model 返回 toolCall response → 执行 noop tool → 继续下一 turn。
 * 最后一个 response 为 text（或 auto-fallback），结束循环。
 */

import { describe, it, expect, vi } from "vitest";
import { AgentSession, Type, type HarnessTool } from "@harness-pi/core";
import { createFakeModel } from "@harness-pi/core/testing";
import { progressVerifier } from "../index.js";

// 最简 noop tool，供 fake model 的 toolCall response 使用（驱动多 turn）。
const noopTool: HarnessTool = {
  name: "noop",
  description: "no-op tool for driving multi-turn sessions in tests",
  parameters: Type.Object({}),
  async execute() {
    return { content: [{ type: "text", text: "noop" }] };
  },
};

/** 返回 N-1 个 toolCall response + 留 1 个 auto-fallback，共 N 次 onTurnEnd。 */
function multiTurnModel(n: number) {
  const scripted = Array.from({ length: n - 1 }, () => ({
    content: [{ type: "toolCall" as const, name: "noop", arguments: {} }],
  }));
  return createFakeModel(scripted);
}

describe("progressVerifier", () => {
  it("throws if noProgressThreshold <= 0", () => {
    expect(() =>
      progressVerifier({ judge: () => ({ reached: false }), noProgressThreshold: 0 }),
    ).toThrow();
    expect(() =>
      progressVerifier({ judge: () => ({ reached: false }), noProgressThreshold: -1 }),
    ).toThrow();
  });

  it("throws if timeoutMs <= 0", () => {
    expect(() =>
      progressVerifier({ judge: () => ({ reached: false }), timeoutMs: 0 }),
    ).toThrow();
  });

  it("sets a generous default timeout (event-class 100ms is too short for LLM judge calls)", () => {
    expect(progressVerifier({ judge: () => ({ reached: false }) }).timeout).toBe(30_000);
    expect(
      progressVerifier({ judge: () => ({ reached: false }), timeoutMs: 5_000 }).timeout,
    ).toBe(5_000);
  });

  it("stops immediately when judge returns reached=true (goal achieved)", async () => {
    const model = createFakeModel([
      { content: [{ type: "text", text: "goal done" }] },
    ]);

    let judgeCalls = 0;
    const session = new AgentSession({
      model,
      tools: [],
      hooks: [
        progressVerifier({
          judge: () => {
            judgeCalls++;
            return { reached: true, message: "issue closed" };
          },
        }),
      ],
    });
    const summary = await session.run("go");

    expect(judgeCalls).toBe(1);
    expect(summary.reason).toBe("aborted");
    expect(summary.abortReason).toContain("progressVerifier");
    expect(summary.abortReason).toContain("goal reached");
    expect(summary.abortReason).toContain("issue closed");
  });

  it("goal reached with default message (no message field)", async () => {
    const model = createFakeModel([
      { content: [{ type: "text", text: "fin" }] },
    ]);

    const session = new AgentSession({
      model,
      tools: [],
      hooks: [
        progressVerifier({
          judge: () => ({ reached: true }),
        }),
      ],
    });
    const summary = await session.run("go");

    expect(summary.reason).toBe("aborted");
    expect(summary.abortReason).toBe("progressVerifier: goal reached");
  });

  it("stops after N consecutive no-progress turns (hasProgress=false)", async () => {
    // threshold=3, 需要 3 次 onTurnEnd：2 个 toolCall + 1 个 auto-fallback。
    const model = multiTurnModel(3);
    const judgeResults = vi.fn(() => ({ reached: false, hasProgress: false as const }));

    const session = new AgentSession({
      model,
      tools: [noopTool],
      hooks: [
        progressVerifier({
          judge: judgeResults,
          noProgressThreshold: 3,
        }),
      ],
      maxTurns: 20,
    });
    const summary = await session.run("go");

    expect(judgeResults).toHaveBeenCalledTimes(3);
    expect(summary.reason).toBe("aborted");
    expect(summary.abortReason).toContain("progressVerifier");
    expect(summary.abortReason).toContain("no progress");
    expect(summary.turns).toBe(3);
  });

  it("resets no-progress counter when hasProgress=true, then stops only after N fresh no-progress turns", async () => {
    // turn 0: no-progress (count=1)
    // turn 1: has progress (count=0)
    // turn 2: no-progress (count=1)
    // turn 3: no-progress (count=2, threshold=2) → stop
    // 需要 4 次 onTurnEnd → 3 个 toolCall + 1 auto-fallback。
    const model = multiTurnModel(4);
    let callIdx = 0;
    const judge = vi.fn(() => {
      callIdx++;
      if (callIdx === 2) return { reached: false, hasProgress: true as const };
      return { reached: false, hasProgress: false as const };
    });

    const session = new AgentSession({
      model,
      tools: [noopTool],
      hooks: [
        progressVerifier({
          judge,
          noProgressThreshold: 2,
        }),
      ],
      maxTurns: 20,
    });
    const summary = await session.run("go");

    expect(judge).toHaveBeenCalledTimes(4);
    expect(summary.reason).toBe("aborted");
    expect(summary.abortReason).toContain("no progress");
    expect(summary.turns).toBe(4);
  });

  it("treats judge throw as neutral (no count change), session continues until goal reached", async () => {
    // turn 0: judge throws（中性，不计数）
    // turn 1: judge throws（中性，不计数）
    // turn 2: reached:true → abort
    // 需要 3 次 onTurnEnd → multiTurnModel(3)。
    const model = multiTurnModel(3);

    let callIdx = 0;
    const session = new AgentSession({
      model,
      tools: [noopTool],
      hooks: [
        progressVerifier({
          judge: () => {
            callIdx++;
            if (callIdx <= 2) throw new Error("judge transient error");
            return { reached: true };
          },
          noProgressThreshold: 2, // 若抛错被计数，2 次就停；中性则不触发
        }),
      ],
    });
    const summary = await session.run("go");

    // 中性处理：抛错不累计，第 3 次 reached:true 才停。
    expect(callIdx).toBe(3);
    expect(summary.reason).toBe("aborted");
    expect(summary.abortReason).toContain("goal reached");
  });

  it("calls onStall callback when no-progress threshold is reached", async () => {
    // threshold=2, 需要 2 次 onTurnEnd → multiTurnModel(2)。
    const model = multiTurnModel(2);
    const onStall = vi.fn();

    const session = new AgentSession({
      model,
      tools: [noopTool],
      hooks: [
        progressVerifier({
          judge: () => ({ reached: false, hasProgress: false }),
          noProgressThreshold: 2,
          onStall,
        }),
      ],
      maxTurns: 20,
    });
    const summary = await session.run("go");

    expect(onStall).toHaveBeenCalledTimes(1);
    expect(onStall).toHaveBeenCalledWith(
      expect.any(Object), // ctx
      { consecutiveNoProgress: 2 },
    );
    // onStall 没有 abort，插件用默认原因停止。
    expect(summary.reason).toBe("aborted");
    expect(summary.abortReason).toContain("no progress");
  });

  it("onStall that calls ctx.abort() with custom reason: plugin does not double-stop", async () => {
    // threshold=1, 1 次 onTurnEnd → 1 auto-fallback。
    const model = createFakeModel([]);

    const session = new AgentSession({
      model,
      tools: [],
      hooks: [
        progressVerifier({
          judge: () => ({ reached: false, hasProgress: false }),
          noProgressThreshold: 1,
          onStall: (ctx) => {
            ctx.abort("custom escalation reason");
          },
        }),
      ],
      maxTurns: 20,
    });
    const summary = await session.run("go");

    expect(summary.reason).toBe("aborted");
    // onStall 提供的 custom reason 生效（而非插件默认的 "no progress"）。
    expect(summary.abortReason).toContain("custom escalation reason");
  });

  it("hasProgress omitted defaults to true (optimistic), stall counter does not accumulate", async () => {
    // judge 每次只返回 { reached: false }（不含 hasProgress），视为有进展。
    // session 跑完自然结束（3 turns），不因无进展被停止。
    const model = multiTurnModel(3);

    const session = new AgentSession({
      model,
      tools: [noopTool],
      hooks: [
        progressVerifier({
          judge: () => ({ reached: false }), // hasProgress omitted → true
          noProgressThreshold: 2,
        }),
      ],
    });
    const summary = await session.run("go");

    // session 自然结束（not aborted by progressVerifier）。
    expect(summary.reason).toBe("done");
    expect(summary.turns).toBe(3);
  });

  it("state is isolated between two sessions", async () => {
    // Session A: threshold=1（第 1 turn 停）→ 1 auto-fallback
    // Session B: threshold=3（第 3 turn 停）→ multiTurnModel(3)
    function makeSession(threshold: number, n: number) {
      return new AgentSession({
        model: n === 1 ? createFakeModel([]) : multiTurnModel(n),
        tools: [noopTool],
        hooks: [
          progressVerifier({
            judge: () => ({ reached: false, hasProgress: false }),
            noProgressThreshold: threshold,
          }),
        ],
        maxTurns: 20,
      });
    }

    const [sumA, sumB] = await Promise.all([
      makeSession(1, 1).run("go"),
      makeSession(3, 3).run("go"),
    ]);

    expect(sumA.turns).toBe(1);
    expect(sumB.turns).toBe(3);
    expect(sumA.reason).toBe("aborted");
    expect(sumB.reason).toBe("aborted");
  });
});
