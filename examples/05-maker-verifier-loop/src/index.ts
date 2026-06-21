/**
 * Example 05: maker-verifier loop —— 用现成 hook 拼一条「生成者 / 验证者分离」循环。
 *
 * 剧情（fake model 离线确定性演示）：
 *   maker 写一个「取列表首元素」函数 → 先交了个崩在空列表上的版本 → 独立 reviewer 判 FAIL（指出
 *   gap）→ turnEndGuard 回灌 gap、强制 maker 返工 → maker 补上空列表处理、重交 → reviewer 判 PASS
 *   → loop 停。全程没有任何内置 `/goal` 命令，护栏全是 @harness-pi/plugins 现成件。
 */
import { createFakeModel } from "@harness-pi/core/testing";
import { runMakerVerifierLoop } from "./maker-verifier.js";

const V1_BUGGY = "def first(xs): return xs[0]";
const V2_FIXED = "def first(xs): return xs[0] if xs else None";

async function main(): Promise<void> {
  // maker：先交崩版（v1）→ 被打回后交修复版（v2）。每次「想停」都以纯文本结束本回合 → 触发 turnEndGuard。
  // usage 给真实量级（>500 token/轮）：否则 tokenBudget 的「递减收益」检测会把 fake 的 ~0 token 误判为
  // 无进展、提前熔断（fake-model 假象）。真 provider 自带真实 usage，无需手设。
  const usage = { input: 600, output: 2000 };
  const makerModel = createFakeModel([
    { content: [{ type: "toolCall", name: "submit", arguments: { solution: V1_BUGGY } }], stopReason: "toolUse", usage },
    { content: [{ type: "text", text: "Submitted. I think it's done." }], usage },
    { content: [{ type: "toolCall", name: "submit", arguments: { solution: V2_FIXED } }], stopReason: "toolUse", usage },
    { content: [{ type: "text", text: "Fixed the empty-list case and resubmitted. Done." }], usage },
  ]);

  // reviewer：同一 model 实例，response 队列驱动两轮 review —— 第 1 轮 FAIL（指出 gap）、第 2 轮 PASS。
  const reviewerModel = createFakeModel([
    { content: [{ type: "text", text: "FAIL: crashes on the empty list instead of returning None" }] },
    { content: [{ type: "text", text: "PASS" }] },
  ]);

  const result = await runMakerVerifierLoop({
    makerModel,
    reviewerModel,
    task: "Write a Python function `first(xs)` that returns the first element of a list. Submit it for review.",
    stopCondition: "the function must handle the empty list (return None instead of crashing)",
    maxReworks: 3,
  });

  console.log("=== maker-verifier loop 结果 ===");
  console.log(`maker 终态:        ${result.reason}`);
  console.log(`reviewer 放行:     ${result.passed}`);
  console.log(`被强制返工次数:    ${result.reworks}`);
  console.log(`最终提交的解:      ${result.finalSolution}`);
  console.log(
    result.passed && result.reworks === 1
      ? "\n✓ 独立 reviewer 打回了第一版、强制返工一次、第二版放行——maker-verifier 闭环成立。"
      : "\n✗ 与预期剧情不符。",
  );
}

main().catch((err) => {
  console.error("[05-maker-verifier-loop] 失败:", err);
  process.exit(1);
});
