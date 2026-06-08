import { describe, expect, it } from "vitest";
import {
  createAssistantMessageEventStream,
  registerApiProvider,
  unregisterApiProviders,
  type Api,
  type Context,
  type Model,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import { AgentSession } from "../session.js";

describe("AgentSession llmOptions", () => {
  it("passes caller LLM options through while reserving signal for the kernel", async () => {
    const api = "harness-pi-llm-options-test" as Api;
    const sourceId = "harness-pi-llm-options-test";
    const seenOptions: Array<StreamOptions & Record<string, unknown>> = [];

    registerApiProvider(
      {
        api,
        stream: (_model: Model<Api>, _context: Context, options?: StreamOptions) => {
          seenOptions.push((options ?? {}) as StreamOptions & Record<string, unknown>);
          const stream = createAssistantMessageEventStream();
          stream.end({
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            api,
            provider: "test-provider",
            model: "test-model",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: "stop",
            timestamp: Date.now(),
          });
          return stream;
        },
        streamSimple: () => {
          throw new Error("not used");
        },
      },
      sourceId,
    );

    try {
      const callerSignal = new AbortController().signal;
      const model = {
        id: "test-model",
        name: "Test Model",
        api,
        provider: "test-provider",
        baseUrl: "https://example.invalid",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000,
        maxTokens: 1000,
      } as Model<Api>;

      const session = new AgentSession({
        model,
        tools: [],
        llmOptions: {
          temperature: 0.2,
          // provider 专属 / 非 StreamOptions 键走 providerExtras 逃生口；摊平后回到顶层透传。
          // signal 经 providerExtras「偷传」也应被 kernel 覆盖（文档承诺的不变量）。
          providerExtras: { customOption: "kept", signal: callerSignal },
        },
      });

      await session.run("go");

      expect(seenOptions).toHaveLength(1);
      expect(seenOptions[0]?.temperature).toBe(0.2);
      expect(seenOptions[0]?.customOption).toBe("kept");
      expect(seenOptions[0]?.signal).toBeInstanceOf(AbortSignal);
      expect(seenOptions[0]?.signal).not.toBe(callerSignal);
    } finally {
      unregisterApiProviders(sourceId);
    }
  });
});
