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

// usage 给真实量级：fake 的 ~0 token 会被 tokenBudget 的「递减收益」检测误判为无进展、提前熔断。
const USAGE = { input: 600, output: 2000 };

describe("maker-verifier loop（现成 hook 拼装）", () => {
  it("独立 reviewer 打回首版 → 强制返工一次 → 修复版放行", async () => {
    const makerModel = createFakeModel([
      { content: [{ type: "toolCall", name: "submit", arguments: { solution: V1_BUGGY } }], stopReason: "toolUse", usage: USAGE },
      { content: [{ type: "text", text: "Submitted. Done." }], usage: USAGE },
      { content: [{ type: "toolCall", name: "submit", arguments: { solution: V2_FIXED } }], stopReason: "toolUse", usage: USAGE },
      { content: [{ type: "text", text: "Fixed and resubmitted. Done." }], usage: USAGE },
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
        usage: USAGE,
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
});
