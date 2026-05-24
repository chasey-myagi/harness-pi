/**
 * Example 02: with plugins —— 同时挂 6 个 plugin。
 *
 * Plugins:
 *   - watchdog（每 turn 10s 上限）
 *   - trimHistory（保留最近 4 条 toolResult）
 *   - metrics + MemorySink
 *   - costTracker
 *   - sessionLog（写到 ./logs）
 *   - systemReminder（每 turn 检查 turnIdx 注 reminder）
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentSession,
  Type,
  type HarnessTool,
} from "@harness-pi/core";
import { createFakeModel } from "@harness-pi/core/testing";
import {
  watchdog,
  trimHistory,
  metrics,
  MemorySink,
  costTracker,
  getCostStats,
  sessionLog,
  systemReminder,
} from "@harness-pi/plugins";

const echoTool: HarnessTool = {
  name: "echo",
  description: "Echo back the message",
  parameters: Type.Object({ msg: Type.String() }),
  async execute(args) {
    return {
      content: [
        { type: "text", text: `echoed: ${String(args["msg"]).toUpperCase()}` },
      ],
    };
  },
};

async function main(): Promise<void> {
  const model = createFakeModel([
    {
      content: [
        { type: "toolCall", name: "echo", arguments: { msg: "one" } },
      ],
      usage: { input: 100, output: 50 },
    },
    {
      content: [
        { type: "toolCall", name: "echo", arguments: { msg: "two" } },
      ],
      usage: { input: 120, output: 60 },
    },
    {
      content: [{ type: "text", text: "All done." }],
      usage: { input: 80, output: 30 },
    },
  ]);

  const logsDir = mkdtempSync(join(tmpdir(), "harness-pi-demo-"));
  const sink = new MemorySink();

  const session = new AgentSession({
    model,
    tools: [echoTool],
    systemPrompt: "You echo what the user wants and report when done.",
    hooks: [
      watchdog({ turnTimeoutMs: 10_000 }),
      trimHistory({ keepRecent: 4 }),
      metrics({ sink }),
      costTracker({
        costModel: (_id, u) => u.input * 0.000002 + u.output * 0.00001,
      }),
      sessionLog({ dir: logsDir }),
      systemReminder({
        on: "turnStart",
        trigger: (ctx) =>
          ctx.turnIdx >= 2
            ? "You've used multiple turns — please summarize and finish."
            : null,
      }),
    ],
  });

  const summary = await session.run("echo `one`, then `two`, then summarize.");

  console.log("\n─── RunSummary ──────────────────────────────");
  console.log(JSON.stringify(summary, null, 2));

  console.log("\n─── Metric events (from MemorySink) ─────────");
  for (const e of sink.snapshot()) {
    const { kind, ts, ...rest } = e;
    void ts;
    console.log(`  ${kind}: ${JSON.stringify(rest)}`);
  }

  // 拿 cost-tracker 累计
  const stats = (() => {
    // hack: session 内的 ctx 私有；这里直接构造一个 reader plugin 不太干净。
    // 真实代码可以用 `getCostStats(ctx)` 在 hook 里取。这里 demo 略过。
    return null;
  })();
  void stats;
  void getCostStats;

  console.log(`\n─── Session log written to: ${logsDir}/${session.id}.ndjson`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
