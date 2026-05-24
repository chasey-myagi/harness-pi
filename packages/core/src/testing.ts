/**
 * Testing utilities ——  for unit / integration tests that need to run the kernel
 * without hitting a real LLM provider.
 *
 * 每次 `createFakeModel(script)` 返回一个**独立的** Model，绑定到一个独立的 api id
 * + 独立的 queue + 独立的 seen-contexts。多个 fake model 互不污染——并行测试也安全。
 *
 * Usage:
 *   const fake = createFakeModel([
 *     { content: [{ type: "toolCall", id: "1", name: "echo", arguments: { msg: "hi" } }] },
 *     { content: [{ type: "text", text: "done" }] },
 *   ]);
 *   const session = new AgentSession({ model: fake.model, tools: [echoTool] });
 *   await session.run("go");
 *   // 后续脚本动态追加：
 *   fake.push({ content: [{ type: "text", text: "extra" }] });
 *   // 拿到 LLM 收到的 contexts：
 *   const seen = fake.getCalls();
 */

import {
  createAssistantMessageEventStream,
  registerApiProvider,
  unregisterApiProviders,
  type AssistantMessage,
  type Api,
  type Context,
  type Model,
  type ToolCall,
} from "@mariozechner/pi-ai";

export interface FakeAssistantResponse {
  content: Array<
    | { type: "text"; text: string }
    | {
        type: "toolCall";
        id?: string;
        name: string;
        arguments: Record<string, unknown>;
      }
  >;
  stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
  usage?: { input: number; output: number; cached?: number };
  delayMs?: number;
  throwError?: Error;
}

/**
 * Fake model 既是 pi-ai 的 `Model`，又携带 push / getCalls / reset / teardown helpers。
 * 这样测试代码可以 `const model = createFakeModel(...); session = new AgentSession({ model })`。
 */
export type FakeModel = Model<Api> & {
  /** 追加更多 scripted response。 */
  push(...resp: FakeAssistantResponse[]): void;
  /** 看 LLM 这边 provider 收到的所有 contexts（调试用）。 */
  getCalls(): ReadonlyArray<Context>;
  /** 清队列 + calls。 */
  reset(): void;
  /** 注销 provider（释放 api id）。一般测试结束后调；不调也无害。 */
  teardown(): void;
};

let fakeSeq = 0;

function zeroUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * 创建一个独立的 fake Model。每次调用返回新的 api id + 独立 closure state。
 */
export function createFakeModel(
  script: FakeAssistantResponse[] = [],
): FakeModel {
  const id = ++fakeSeq;
  const api = `harness-pi-fake-${id}` as Api;
  const sourceId = `@harness-pi/core:testing#${id}`;
  const queue: FakeAssistantResponse[] = [...script];
  const seenContexts: Context[] = [];
  let toolCallSeq = 0;

  registerApiProvider(
    {
      api,
      stream: ((_model: Model<Api>, context: Context) => {
        seenContexts.push(context);
        const stream = createAssistantMessageEventStream();
        void (async () => {
          const next = queue.shift();
          if (!next) {
            stream.end({
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "[fake: no more scripted responses]",
                },
              ],
              api,
              provider: `fake-${id}`,
              model: `fake-model-${id}`,
              usage: zeroUsage(),
              stopReason: "stop",
              timestamp: Date.now(),
            });
            return;
          }
          if (next.delayMs) {
            await new Promise<void>((r) => setTimeout(r, next.delayMs));
          }
          if (next.throwError) {
            stream.end({
              role: "assistant",
              content: [],
              api,
              provider: `fake-${id}`,
              model: `fake-model-${id}`,
              usage: zeroUsage(),
              stopReason: "error",
              errorMessage: next.throwError.message,
              timestamp: Date.now(),
            });
            return;
          }
          const content = next.content.map((b) => {
            if (b.type === "toolCall") {
              const tc: ToolCall = {
                type: "toolCall",
                id: b.id ?? `fake-tc-${id}-${++toolCallSeq}`,
                name: b.name,
                arguments: b.arguments,
              };
              return tc;
            }
            return b;
          });
          const hasToolCall = content.some((b) => b.type === "toolCall");
          const assistant: AssistantMessage = {
            role: "assistant",
            content,
            api,
            provider: `fake-${id}`,
            model: `fake-model-${id}`,
            usage: {
              input: next.usage?.input ?? 0,
              output: next.usage?.output ?? 0,
              cacheRead: next.usage?.cached ?? 0,
              cacheWrite: 0,
              totalTokens:
                (next.usage?.input ?? 0) + (next.usage?.output ?? 0),
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: next.stopReason ?? (hasToolCall ? "toolUse" : "stop"),
            timestamp: Date.now(),
          };
          stream.end(assistant);
        })();
        return stream;
      }) as never,
      streamSimple: (() => {
        throw new Error("fake provider: streamSimple not implemented");
      }) as never,
    },
    sourceId,
  );

  const model = {
    id: `fake-model-${id}`,
    name: `Fake Model #${id} (testing)`,
    api,
    provider: `fake-${id}`,
    baseUrl: "https://fake.local",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4096,
    push(...resp: FakeAssistantResponse[]) {
      queue.push(...resp);
    },
    getCalls() {
      return seenContexts;
    },
    reset() {
      queue.length = 0;
      seenContexts.length = 0;
      toolCallSeq = 0;
    },
    teardown() {
      unregisterApiProviders(sourceId);
    },
  } as unknown as FakeModel;

  return model;
}

/**
 * @deprecated 已弃用——新代码用 `createFakeModel()` 每次返回独立 model 即可，无需全局 reset。
 * 保留为 no-op 兼容旧测试。
 */
export function resetFakeProvider(): void {
  /* no-op (new fake models are isolated per-instance) */
}

/**
 * @deprecated 用 `model.push(...)` 代替（新 fake model 自带 push 方法）。
 */
export function pushFakeResponse(..._resp: FakeAssistantResponse[]): void {
  throw new Error(
    "pushFakeResponse() is deprecated; use the model.push() returned by createFakeModel()",
  );
}
