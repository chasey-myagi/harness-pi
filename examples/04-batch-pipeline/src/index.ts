/**
 * 可运行入口：`pnpm --filter @harness-pi-example/04-batch-pipeline start`。
 *
 * 用 **fake model**（无需 API key、确定性）跑通整条链路并打印结果。真实使用时唯一要换的是 `makeModel`
 * ——返回一个真 pi-ai model（如 DashScope/Qwen），其余编排/落盘/事件流原样不动。
 *
 * 范围说明：这是「机制咬合」的干跑，**不**覆盖真 provider 的流式错误 / context-overflow / 中途断流语义
 * （fake model 只脚本化 happy 的 toolUse→stop）。那些是另一条线的事（见 docs/09 风险 #1 / pi-ai SDK 边界核验）。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSessionStore, WebSocketSink, type WebSocketLike } from "@harness-pi/adapters";
import { createFakeModel, type FakeModel } from "@harness-pi/core/testing";
import { runBatch, resumeAndContinue, type BatchItem } from "./batch-pipeline.js";

// 每题脚本：turn1 调 lookup → turn2 出答案（带 live deltas）。真实里换成真 provider 即可。
function answeringModel(id: string): FakeModel {
  return createFakeModel([
    { content: [{ type: "toolCall", name: "lookup", arguments: { key: id } }], stopReason: "toolUse" },
    {
      content: [{ type: "text", text: `answer for ${id}` }],
      textDeltas: ["answer ", `for ${id}`],
      stopReason: "stop",
    },
  ]);
}

async function main(): Promise<void> {
  const items: BatchItem[] = [
    { id: "q1", prompt: "What is the capital of France?" },
    { id: "q2", prompt: "Define recursion." },
    { id: "q3", prompt: "Summarize the water cycle." },
  ];

  // 每次运行用一个**唯一**临时目录，跑完即清——演示输出可复现，且不在机器上留累积的落盘文件。
  // （换 MemorySessionStore 可去掉 fs；换 PostgresSessionStore 可跨进程持久化。）
  const dir = mkdtempSync(join(tmpdir(), "harness-pi-batch-"));
  const store = new JsonlSessionStore(join(dir, "sessions.jsonl"));

  // 把事件推到一个「console socket」（结构化满足 WebSocketLike；真实里换成真 WebSocket）。
  let eventCount = 0;
  const socket: WebSocketLike = { readyState: 1 /* OPEN */, send: () => void eventCount++ };
  const sink = new WebSocketSink(socket);

  const models = new Map(items.map((it) => [it.id, answeringModel(it.id)] as const));

  try {
    console.log(`\n▶ runBatch: ${items.length} items through pipeline() (answer → score)\n`);
    const outcomes = await runBatch({
      items,
      store,
      sink,
      makeModel: (it) => models.get(it.id)!,
      concurrency: 2,
    });

    for (const o of outcomes) {
      if (o.status === "ok") {
        console.log(`  ✓ ${o.value.id}: "${o.value.answer}" (reason=${o.value.reason}, score=${o.value.score})`);
      } else if (o.status === "failed") {
        console.log(`  ✗ ${o.item.id}: failed at stage ${o.stage} — ${(o.error as Error).message}`);
      } else {
        console.log(`  ⊘ ${o.item.id}: skipped (${o.reason})`);
      }
    }
    console.log(`\n  events streamed to sink: ${eventCount}`);

    // resume 演示：从 store 续跑 q1，问个 follow-up（模拟进程重启后接着跑）。
    console.log(`\n▶ resumeAndContinue: resume "q1" from store + follow-up\n`);
    const { summary, recordedCount } = await resumeAndContinue({
      store,
      sessionId: "q1",
      makeModel: () => createFakeModel([{ content: [{ type: "text", text: "follow-up answer" }], stopReason: "stop" }]),
      followUp: "And its population?",
      sink,
    });
    console.log(`  ✓ q1 continued: reason=${summary.reason}, recorded events=${recordedCount}`);
    const resumedPath = await store.getPathToLeaf("q1");
    console.log(`  q1 history now ${resumedPath.length} entries (prefix preserved, follow-up appended)\n`);
  } finally {
    for (const m of models.values()) m.teardown();
    rmSync(dir, { recursive: true, force: true }); // 不留落盘垃圾
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
