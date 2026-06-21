/**
 * 集成测试：证明用现成 hook 拼出的 maker-verifier loop **真能跑通**完整闭环——
 * 独立 reviewer 打回首版 → turnEndGuard 强制返工 → 修复版被放行。纯 domain-free（toy submit + fake model）。
 *
 * 这是 #111「Loop Engineering substrate」的可执行佐证：loop 的护栏是零件、不是内置命令。
 */
import { describe, it, expect } from "vitest";
import { createFakeModel } from "@harness-pi/core/testing";
import { runMakerVerifierLoop } from "../maker-verifier.js";

const V1_BUGGY = "def first(xs): return xs[0]";
const V2_FIXED = "def first(xs): return xs[0] if xs else None";

describe("maker-verifier loop（现成 hook 拼装）", () => {
  it("独立 reviewer 打回首版 → 强制返工一次 → 修复版放行", async () => {
    const makerModel = createFakeModel([
      { content: [{ type: "toolCall", name: "submit", arguments: { solution: V1_BUGGY } }], stopReason: "toolUse" },
      { content: [{ type: "text", text: "Submitted. Done." }] },
      { content: [{ type: "toolCall", name: "submit", arguments: { solution: V2_FIXED } }], stopReason: "toolUse" },
      { content: [{ type: "text", text: "Fixed and resubmitted. Done." }] },
    ]);
    const reviewerModel = createFakeModel([
      { content: [{ type: "text", text: "FAIL: crashes on the empty list" }] },
      { content: [{ type: "text", text: "PASS" }] },
    ]);

    const result = await runMakerVerifierLoop({
      makerModel,
      reviewerModel,
      task: "Write first(xs) and submit it.",
      stopCondition: "must handle the empty list",
      maxReworks: 3,
    });

    expect(result.passed).toBe(true); // reviewer 最终放行
    expect(result.reworks).toBe(1); // 恰好被强制返工一次
    expect(result.reason).toBe("done"); // 正常停止（不是预算/上限兜底）
    expect(result.finalSolution).toBe(V2_FIXED); // maker 确实改了解（v1 → v2）
  });

  it("达 maxReworks 上限仍 FAIL → 放行停止、passed=false、不无限转", async () => {
    // reviewer 永远 FAIL；maker 每轮想停（纯文本）。maxReworks=2 → 强制 2 次后第 3 次 check 放行停止。
    const makerModel = createFakeModel(
      Array.from({ length: 4 }, () => ({
        content: [{ type: "text" as const, text: "I think it's done." }],
      })),
    );
    const reviewerModel = createFakeModel(
      Array.from({ length: 5 }, () => ({
        content: [{ type: "text" as const, text: "FAIL: still not good enough" }],
      })),
    );

    const result = await runMakerVerifierLoop({
      makerModel,
      reviewerModel,
      task: "do the thing",
      stopCondition: "impossible bar",
      maxReworks: 2,
    });

    expect(result.passed).toBe(false); // 从未放行
    expect(result.reworks).toBe(2); // 恰好强制到上限
    expect(result.reason).toBe("done"); // 上限后放行停止——有界，不无限空转
  });

  it("maxReworks≥内核默认 maxContinuations(5) 时仍能等到最终 PASS（回归 codex P2-A）", async () => {
    // 内核在 fire onContinuationCheck 前先查 maxContinuations。若不把它从 maxReworks 抬高，
    // maxReworks=5 会在第 6 次 check 前以 max_continuations 退出、reviewer 等不到最后那次 PASS。
    const makerModel = createFakeModel([]); // 每轮自动补文本响应（想停）→ 触发 check
    const reviewerModel = createFakeModel([
      ...Array.from({ length: 5 }, () => ({ content: [{ type: "text" as const, text: "FAIL: not yet" }] })),
      { content: [{ type: "text" as const, text: "PASS" }] }, // 第 6 次 check 放行
    ]);

    const result = await runMakerVerifierLoop({
      makerModel,
      reviewerModel,
      task: "do the thing",
      stopCondition: "high bar",
      maxReworks: 5,
    });

    expect(result.passed).toBe(true); // 第 6 次 check 拿到 PASS（没被 max_continuations 截断）
    expect(result.reworks).toBe(5); // 强制返工 5 次
    expect(result.reason).toBe("done");
  });
});
