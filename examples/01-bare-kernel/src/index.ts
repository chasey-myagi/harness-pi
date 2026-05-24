/**
 * Example 01: bare kernel —— 不挂任何 plugin 的最简 agent。
 *
 * 用 fake provider 而不是真实 LLM，所以这个 example 离线可跑、CI 也能 verify。
 * 把 `createFakeModel(...)` 换成 `getModel("anthropic", "claude-sonnet-...")` 就是真实 agent。
 */

import { AgentSession, Type, type HarnessTool } from "@harness-pi/core";
import { createFakeModel } from "@harness-pi/core/testing";

const echoTool: HarnessTool = {
  name: "echo",
  description: "Echo back the message",
  parameters: Type.Object({ msg: Type.String() }),
  async execute(args) {
    return { content: [{ type: "text", text: `echoed: ${args["msg"]}` }] };
  },
};

async function main(): Promise<void> {
  const model = createFakeModel([
    {
      content: [
        {
          type: "toolCall",
          name: "echo",
          arguments: { msg: "hello from harness-pi" },
        },
      ],
    },
    { content: [{ type: "text", text: "All done." }] },
  ]);

  const session = new AgentSession({
    model,
    tools: [echoTool],
    systemPrompt: "You are a friendly assistant. Echo what the user says.",
  });

  const summary = await session.run("call echo for me");
  console.log("");
  console.log("─── RunSummary ───────────────────────────────");
  console.log(JSON.stringify(summary, null, 2));
  console.log("");
  console.log("─── Final messages ───────────────────────────");
  for (const m of session.messages) {
    const head = `[${m.role}]`;
    let body = "";
    if (typeof (m as { content?: unknown }).content === "string") {
      body = (m as { content: string }).content;
    } else if (Array.isArray((m as { content?: unknown }).content)) {
      body = (m as { content: Array<{ type: string; text?: string; name?: string }> }).content
        .map((c) => {
          if (c.type === "text") return c.text ?? "";
          if (c.type === "toolCall") return `<toolCall ${c.name}>`;
          return `<${c.type}>`;
        })
        .join(" ");
    }
    console.log(`${head} ${body.slice(0, 200)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
