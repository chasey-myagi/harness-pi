/**
 * Example 03: tools —— 第一方 read/grep/find/ls 直接挂到 AgentSession。
 *
 * 这里仍然用 fake model，所以 example 离线可跑。fake model 一次发出四个只读 toolCall，
 * kernel 会把它们作为 concurrency-safe tools 并行执行。
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "@harness-pi/core";
import { createFakeModel } from "@harness-pi/core/testing";
import { createReadOnlyTools } from "@harness-pi/tools";

async function main(): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "harness-pi-tools-demo-"));
  await mkdir(join(workspace, "docs"), { recursive: true });
  await writeFile(join(workspace, "README.md"), "# Demo\n\nneedle lives here\n");
  await writeFile(join(workspace, "docs", "guide.md"), "another needle\n");

  const model = createFakeModel([
    {
      content: [
        { type: "toolCall", name: "ls", arguments: { path: "." } },
        { type: "toolCall", name: "find", arguments: { pattern: "*.md" } },
        {
          type: "toolCall",
          name: "grep",
          arguments: { pattern: "needle", path: ".", literal: true },
        },
        {
          type: "toolCall",
          name: "read",
          arguments: { path: "README.md", limit: 2 },
        },
      ],
    },
    { content: [{ type: "text", text: "Tool pass complete." }] },
  ]);

  const session = new AgentSession({
    model,
    tools: createReadOnlyTools(workspace),
    systemPrompt: "Use the filesystem tools and then finish.",
  });

  const summary = await session.run("Inspect this tiny workspace.");

  console.log("\n─── Workspace ───────────────────────────────");
  console.log(workspace);

  console.log("\n─── Tool results ────────────────────────────");
  for (const m of session.messages) {
    if (m.role !== "toolResult") continue;
    const text = m.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    console.log(`[${m.toolName}] ${text.slice(0, 240)}`);
  }

  console.log("\n─── RunSummary ──────────────────────────────");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
