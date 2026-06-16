/**
 * Example 05: progressVerifier —— 演示两种停止场景：
 *   A. 达到目标判据 → session 立即停止（"goal reached"）
 *   B. 连续 N turn 无进展 → session 超时停止（"no progress"）
 *
 * 真实使用时把 `judge` 换成调用 LLM 或检查业务状态的函数；
 * 这里用 fake model + 计数器模拟，无需 API key。
 *
 * 运行：
 *   pnpm --filter @harness-pi-example/05-progress-verifier start
 */

import { AgentSession, Type, type HarnessTool } from "@harness-pi/core";
import { createFakeModel } from "@harness-pi/core/testing";
import { progressVerifier } from "@harness-pi/plugins";

// 虚拟工具，供 fake model 调用以驱动多 turn。
const checkStatusTool: HarnessTool = {
  name: "check_status",
  description: "Check the current status of the task",
  parameters: Type.Object({}),
  async execute() {
    return { content: [{ type: "text", text: "status: pending" }] };
  },
};

// ────────────────────────────────────────────────────────
// 场景 A：判据在第 3 turn 达成 → session 在 turn 3 停止
// ────────────────────────────────────────────────────────
async function sceneA(): Promise<void> {
  console.log("\n═══ 场景 A：达标即停 ═══");

  // 模拟：turn 0/1 检查状态（tool call），turn 2 模型报告完成（text）。
  const model = createFakeModel([
    { content: [{ type: "toolCall", name: "check_status", arguments: {} }] },
    { content: [{ type: "toolCall", name: "check_status", arguments: {} }] },
    { content: [{ type: "text", text: "Task is now complete." }] },
  ]);

  let turnCount = 0;

  const session = new AgentSession({
    model,
    tools: [checkStatusTool],
    systemPrompt: "You check status and report when done.",
    hooks: [
      progressVerifier({
        // 判据：turn 2 起视为达成（模拟：第 3 次 judge 返回 reached=true）。
        judge: (_ctx, input) => {
          turnCount++;
          const reached = input.turnIdx >= 2;
          const hasProgress = !reached; // turn 0/1 有进展；turn 2 达成
          console.log(
            `  [judge] turn ${input.turnIdx}: reached=${reached}, hasProgress=${hasProgress}`,
          );
          if (reached) return { reached, hasProgress, message: "检查通过" };
          return { reached, hasProgress };
        },
        noProgressThreshold: 5, // 阈值高，不会因无进展触发
      }),
    ],
  });

  const summary = await session.run("请持续检查状态直到完成");

  console.log(`\n  turns run: ${summary.turns}`);
  console.log(`  reason: ${summary.reason}`);
  console.log(`  abortReason: ${summary.abortReason ?? "(none)"}`);
  console.log(`  judge calls: ${turnCount}`);
}

// ────────────────────────────────────────────────────────
// 场景 B：连续 3 turn 无进展 → session 停止
// ────────────────────────────────────────────────────────
async function sceneB(): Promise<void> {
  console.log("\n═══ 场景 B：无进展 N turn 后停止 ═══");

  // 模拟：3 轮 tool call，每次都返回「无进展」。
  const model = createFakeModel([
    { content: [{ type: "toolCall", name: "check_status", arguments: {} }] },
    { content: [{ type: "toolCall", name: "check_status", arguments: {} }] },
    // 第 3 个 response 会由 fake model 自动生成
  ]);

  let turnCount = 0;
  const stallCalled: number[] = [];

  const session = new AgentSession({
    model,
    tools: [checkStatusTool],
    systemPrompt: "You try to check status.",
    hooks: [
      progressVerifier({
        judge: (_ctx, input) => {
          turnCount++;
          console.log(`  [judge] turn ${input.turnIdx}: reached=false, hasProgress=false`);
          // 每次都报告「无进展」
          return { reached: false, hasProgress: false };
        },
        noProgressThreshold: 3,
        onStall: (_ctx, info) => {
          stallCalled.push(info.consecutiveNoProgress);
          console.log(
            `  [onStall] 连续无进展 ${info.consecutiveNoProgress} turn，准备停止`,
          );
        },
      }),
    ],
    maxTurns: 20,
  });

  const summary = await session.run("请检查状态");

  console.log(`\n  turns run: ${summary.turns}`);
  console.log(`  reason: ${summary.reason}`);
  console.log(`  abortReason: ${summary.abortReason ?? "(none)"}`);
  console.log(`  judge calls: ${turnCount}`);
  console.log(`  onStall calls: ${stallCalled.length}`);
}

async function main(): Promise<void> {
  await sceneA();
  await sceneB();
  console.log("\n✓ 示例运行完毕\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
