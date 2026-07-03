import { describe, expect, it } from "vitest";
import { ACTIVE_BOUNDARY_KEY, AgentSession } from "../session.js";
import { createFakeModel } from "../testing.js";
import { createUserMessage } from "../types.js";
import type { HarnessTool, Hook, LlmOptions, Message } from "../index.js";

const noopTool: HarnessTool = {
  name: "noop",
  description: "noop",
  parameters: { type: "object", properties: {} } as never,
  async execute() {
    return { content: [{ type: "text" as const, text: "ok" }] };
  },
};

const user = (text: string): Message => createUserMessage(text);
const toolCall = (id: string) => ({ type: "toolCall" as const, id, name: "noop", arguments: {} });
const assistant = (content: unknown[]): Message =>
  ({ role: "assistant", content, timestamp: 0 }) as unknown as Message;
const toolResult = (toolCallId: string): Message =>
  ({
    role: "toolResult",
    toolCallId,
    toolName: "noop",
    content: [],
    isError: false,
    timestamp: 0,
  }) as unknown as Message;

describe("AgentSession.getCacheSafeParams", () => {
  it("exports the same active-boundary projection used by the next live LLM call", async () => {
    const fake = createFakeModel([
      { content: [toolCall("tc1")] },
      { content: [{ type: "text", text: "done" }] },
      { content: [{ type: "text", text: "continued" }] },
    ]);
    const summary = createUserMessage("BOUNDARY");
    const hook: Hook = {
      name: "set-live-boundary",
      transformMessagesBeforeLlm(_messages, ctx) {
        if (ctx.turnIdx === 0) {
          ctx.state.set(ACTIVE_BOUNDARY_KEY, { summary, coveredCount: 1 });
        }
      },
    };
    const session = new AgentSession({
      model: fake,
      tools: [noopTool],
      hooks: [hook],
    });

    await session.run("go");
    const cacheSafe = session.getCacheSafeParams();

    expect(cacheSafe.forkContextMessages).toEqual([
      summary,
      ...session.messages.slice(1),
    ]);
    expect(cacheSafe.forkContextMessages[0]).toBe(summary);

    await session.continue();
    const liveMessages = fake.getCalls()[2]?.messages;

    expect(liveMessages).toEqual(cacheSafe.forkContextMessages);
    expect(liveMessages?.[0]).toBe(summary);
    fake.teardown();
  });

  it("filters incomplete toolCalls before exporting fork context messages", () => {
    const completeUser = user("hi");
    const danglingAssistant = assistant([toolCall("dangling")]);
    const fake = createFakeModel();
    const session = new AgentSession({
      model: fake,
      tools: [],
      initialMessages: [completeUser, danglingAssistant],
    });

    expect(session.getCacheSafeParams().forkContextMessages).toEqual([completeUser]);
    fake.teardown();
  });

  it("keeps the full message snapshot when there is no active boundary", () => {
    const messages = [
      user("hi"),
      assistant([toolCall("tc1")]),
      toolResult("tc1"),
      assistant([{ type: "text", text: "done" }]),
    ];
    const fake = createFakeModel();
    const session = new AgentSession({
      model: fake,
      tools: [],
      initialMessages: messages,
    });

    const cacheSafe = session.getCacheSafeParams();

    expect(cacheSafe.forkContextMessages).toEqual(messages);
    expect(cacheSafe.forkContextMessages).not.toBe(messages);
    fake.teardown();
  });

  it("includes the session LLM options used for cache-safe forks", () => {
    const llmOptions: LlmOptions = {
      sessionId: "parent-session",
      cacheRetention: "long",
      providerExtras: { cacheNamespace: "forks" },
    };
    const fake = createFakeModel();
    const session = new AgentSession({
      model: fake,
      tools: [],
      llmOptions,
    });

    expect(session.getCacheSafeParams().llmOptions).toEqual(llmOptions);
    fake.teardown();
  });
});
