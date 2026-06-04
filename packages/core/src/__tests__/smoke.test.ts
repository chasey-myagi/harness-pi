/**
 * Smoke test —— minimal happy path.
 *
 * - Session runs a 2-turn loop: assistant calls tool, then assistant says done.
 * - Verifies messages, RunSummary, ctx.state, hook ordering.
 */

import { describe, it, expect } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import { AgentSession } from "../session.js";
import type { HarnessTool, Hook } from "../index.js";
import { createFakeModel } from "../testing.js";

const echoTool: HarnessTool = {
  name: "echo",
  description: "echo back the msg",
  parameters: Type.Object({ msg: Type.String() }),
  async execute(args) {
    return {
      content: [{ type: "text", text: `echoed: ${args["msg"]}` }],
    };
  },
};

describe("AgentSession smoke", () => {
  it("runs a 2-turn loop: toolCall -> done", async () => {
    const model = createFakeModel([
      {
        content: [
          {
            type: "toolCall",
            id: "tc1",
            name: "echo",
            arguments: { msg: "hello" },
          },
        ],
      },
      { content: [{ type: "text", text: "all done" }] },
    ]);

    const session = new AgentSession({
      model,
      tools: [echoTool],
      systemPrompt: "you are a helpful assistant",
    });

    const summary = await session.run("please call echo");

    expect(summary.reason).toBe("done");
    expect(summary.turns).toBe(2);
    expect(summary.continuations).toBe(0);

    // messages: user prompt, assistant#1 (toolCall), toolResult, assistant#2 (text)
    expect(session.messages).toHaveLength(4);
    const msgs = session.messages;
    expect(msgs[0]?.role).toBe("user");
    expect(msgs[1]?.role).toBe("assistant");
    expect(msgs[2]?.role).toBe("toolResult");
    expect(msgs[3]?.role).toBe("assistant");
  });

  it("hooks fire in correct order with correct payloads", async () => {
    const model = createFakeModel([
      { content: [{ type: "text", text: "ok" }] },
    ]);
    const events: string[] = [];
    const hook: Hook = {
      name: "spy",
      onSessionStart() {
        events.push("onSessionStart");
      },
      onTurnStart(input) {
        events.push(`onTurnStart(${input.turnIdx})`);
      },
      onLlmEnd() {
        events.push("onLlmEnd");
      },
      onTurnEnd() {
        events.push("onTurnEnd");
      },
      onSessionEnd() {
        events.push("onSessionEnd");
      },
    };
    const session = new AgentSession({ model, tools: [], hooks: [hook] });
    await session.run("hi");
    expect(events).toEqual([
      "onSessionStart",
      "onTurnStart(0)",
      "onLlmEnd",
      "onTurnEnd",
      "onSessionEnd",
    ]);
  });

  it("respects maxTurns", async () => {
    // assistant keeps calling tool forever (well: 3 times in script, then default fake)
    const model = createFakeModel([
      { content: [{ type: "toolCall", name: "echo", arguments: { msg: "1" } }] },
      { content: [{ type: "toolCall", name: "echo", arguments: { msg: "2" } }] },
    ]);
    const session = new AgentSession({
      model,
      tools: [echoTool],
      maxTurns: 2,
    });
    const summary = await session.run("loop");
    expect(summary.reason).toBe("max_turns");
    expect(summary.turns).toBe(2);
  });

  it("tool throw → isError result回灌", async () => {
    const failingTool: HarnessTool = {
      name: "fail",
      description: "always fails",
      parameters: Type.Object({}),
      async execute() {
        throw new Error("boom");
      },
    };
    const model = createFakeModel([
      { content: [{ type: "toolCall", name: "fail", arguments: {} }] },
      { content: [{ type: "text", text: "moved on" }] },
    ]);
    const session = new AgentSession({ model, tools: [failingTool] });
    const summary = await session.run("call fail");
    expect(summary.reason).toBe("done");
    // tool result must be isError=true with boom message
    const trMsg = session.messages.find((m) => m.role === "toolResult");
    expect(trMsg).toBeDefined();
    if (trMsg && trMsg.role === "toolResult") {
      expect(trMsg.isError).toBe(true);
      const text = trMsg.content.find((c) => c.type === "text");
      expect(text?.type === "text" && text.text).toContain("boom");
    }
  });
});
