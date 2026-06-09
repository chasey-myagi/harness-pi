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
} from "@earendil-works/pi-ai";
import { HookContextImpl, getKernelInternals } from "./context.js";
import type {
  HookContext,
  HookLogger,
  LogLevel,
  SessionConfigView,
} from "./hook.js";

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
  /**
   * 可选：让 fake provider 在 `.end()` 之前**逐块 push** 流式 delta 事件，
   * 用于测试 kernel 的 Event Bus（live token/thinking 流）。不设则只 end（沿用旧行为，
   * 既有测试不受影响）。delta 内容仅供断言，与最终 message 的 text 不强制一致。
   */
  textDeltas?: string[];
  thinkingDeltas?: string[];
  toolcallDeltas?: string[];
  /**
   * 让 provider 的 `stream()` **同步抛**（而非返回流后 end-with-error）。模拟真实 provider
   * 在建流阶段就失败（网络/鉴权异常）—— kernel 的 `stream()` 调用会 throw、走 catch 路径。
   * 用于测试 message_start/message_end 在异常下仍严格配对。
   */
  streamThrows?: Error;
  /**
   * 在指定内容块的 `*_end` 之后**注入一次 mid-stream abort**：fake 不再发后续块，直接以
   * 「截至此刻的 partial」为内容 push 一个 `stopReason:"aborted"` 终态（对齐 pi-ai faux provider 的
   * `createAbortedMessage(partial)` 语义）。用于测 `message_update` 契约——证明流被中途打断时，最后一帧
   * `message_update` 只含**已收尾的块**、缺尚未流出的块，且终态须由 `message_end`（携 `stopReason:"aborted"`）
   * 判定，而非把最后一帧 update 当终态。确定性、无时序竞争（abort 由 fake 在块边界自行注入，不靠外部 signal 抢跑）。
   */
  abortAfterBlock?: "thinking" | "text" | "toolcall";
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
        const next = queue.shift();
        // provider.stream 同步抛 → pi-ai 的 stream() 抛 → kernel 走 catch 路径。
        if (next?.streamThrows) throw next.streamThrows;
        const stream = createAssistantMessageEventStream();
        // 对齐真实 provider 的终止语义：push 一个 done/error 事件再 end()（无参），
        // 而不是 end(message)。这样 `for await` 在 fake 与真实 provider 看到的事件序列同构，
        // result() 仍从 done/error 事件 resolve（借鉴真实 provider，避免 fake 语义漂移）。
        const finish = (m: AssistantMessage): void => {
          if (m.stopReason === "error" || m.stopReason === "aborted") {
            stream.push({ type: "error", reason: m.stopReason, error: m } as never);
          } else {
            stream.push({ type: "done", reason: m.stopReason, message: m } as never);
          }
          stream.end();
        };
        void (async () => {
          if (!next) {
            finish({
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
            finish({
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
          // 可选：push 流式 delta 事件（供 Event Bus 测试）。在 end() 之前。
          //
          // **忠实复刻 pi-ai 的 `partial` 语义**（对齐 providers/faux.js + anthropic/google 等真实 provider）：
          // `partial` 是「截至当前已收尾块」的**渐进式快照**，每条事件携带一份**独立拷贝**（content 数组逐块增长），
          // 而非全程复用最终 `assistant`。kernel 只在 `*_end` 转发 `partial` 作 `message_update`，故只有 `*_end`
          // 上的 partial 会被消费——但 start/delta 也照发独立快照，避免「假 partial」给测试错误的安全感。
          // 最终 `result()` 仍是完整 `assistant`（done 事件携带），与 partial 是不同对象、内容是其超集。
          const built: AssistantMessage["content"] = [];
          const snap = (): AssistantMessage => ({ ...assistant, content: built.slice() });
          // 在某块 `*_end` 后注入 mid-stream abort：以「截至此刻 partial」为内容 finish 成 aborted 终态，不再发后续块。
          const abortHere = (block: NonNullable<FakeAssistantResponse["abortAfterBlock"]>): boolean => {
            if (next.abortAfterBlock !== block) return false;
            finish({ ...assistant, content: built.slice(), stopReason: "aborted", errorMessage: "aborted mid-stream" });
            return true;
          };

          if (next.thinkingDeltas?.length) {
            stream.push({ type: "thinking_start", contentIndex: 0, partial: snap() } as never);
            for (const d of next.thinkingDeltas)
              stream.push({ type: "thinking_delta", contentIndex: 0, delta: d, partial: snap() } as never);
            built.push({ type: "thinking", thinking: next.thinkingDeltas.join("") } as never);
            stream.push({ type: "thinking_end", contentIndex: 0, content: next.thinkingDeltas.join(""), partial: snap() } as never);
            if (abortHere("thinking")) return;
          }
          if (next.textDeltas?.length) {
            const ci = content.findIndex((b) => b.type === "text");
            if (ci < 0) throw new Error("createFakeModel: textDeltas set but no text block in content");
            stream.push({ type: "text_start", contentIndex: ci, partial: snap() } as never);
            for (const d of next.textDeltas)
              stream.push({ type: "text_delta", contentIndex: ci, delta: d, partial: snap() } as never);
            built.push(content[ci]!); // ci>=0 已校验
            stream.push({ type: "text_end", contentIndex: ci, content: next.textDeltas.join(""), partial: snap() } as never);
            if (abortHere("text")) return;
          }
          if (next.toolcallDeltas?.length) {
            const ci = content.findIndex((b) => b.type === "toolCall");
            if (ci < 0) throw new Error("createFakeModel: toolcallDeltas set but no toolCall block in content");
            const tc = content[ci]!; // ci>=0 已校验
            stream.push({ type: "toolcall_start", contentIndex: ci, partial: snap() } as never);
            for (const d of next.toolcallDeltas)
              stream.push({ type: "toolcall_delta", contentIndex: ci, delta: d, partial: snap() } as never);
            built.push(tc);
            stream.push({ type: "toolcall_end", contentIndex: ci, toolCall: tc, partial: snap() } as never);
            if (abortHere("toolcall")) return;
          }
          finish(assistant);
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

/* ──────────────────── createTestContext ──────────────────── */

export interface TestContextOptions {
  sessionId?: string;
  turnIdx?: number;
  signal?: AbortSignal;
  config?: Partial<SessionConfigView>;
  logSink?: (level: LogLevel, msg: string, fields: Record<string, unknown>) => void;
  onAppendMessage?: (msg: import("@earendil-works/pi-ai").Message) => void;
  onAbort?: (reason: string) => void;
  /** captureLog=true 时 logSink 默认变成把 log 推到一个数组里，便于 assert。 */
  captureLog?: boolean;
}

/**
 * 创建一个真实的 HookContext 实例供 dispatcher / plugin 单测用，**不需要 cast**。
 *
 * 默认 turnIdx=0，sessionId="test-<random>"，config 是个最小合法 view。
 * `captureLog: true` 会把所有 log 收集到返回对象的 `.logs` 数组里。
 *
 * 跟手搓 fakeCtx 比，这个 helper 用了真实的 HookContextImpl，所以 state/config/log
 * 的所有不变量（deep-freeze / kernel-internals encapsulation / log field 顺序）
 * 都跟生产代码一致——unit test 不会因为 fakeCtx 跟生产实现漂移而误绿。
 */
export interface TestContextHandle {
  ctx: HookContext;
  /** 把 ctx 推进到 turn `idx`（用 kernel-internals 通道）。 */
  setTurnIdx(idx: number): void;
  /** 替换 abort signal（模拟 run/continue 重入）。 */
  setSignal(signal: AbortSignal): void;
  /** captureLog=true 时收集到的 log。 */
  logs: Array<{ level: LogLevel; msg: string; fields: Record<string, unknown> }>;
  /** 最近 appendMessage 的内容（默认收集；可被 onAppendMessage 覆盖）。 */
  appended: import("@earendil-works/pi-ai").Message[];
  /** 最近 onAbort 的 reason。 */
  abortReasons: string[];
}

export function createTestContext(opts: TestContextOptions = {}): TestContextHandle {
  const logs: TestContextHandle["logs"] = [];
  const appended: import("@earendil-works/pi-ai").Message[] = [];
  const abortReasons: string[] = [];

  const defaultConfig: SessionConfigView = Object.freeze({
    sessionId: opts.sessionId ?? "test-session",
    model: Object.freeze({ id: "test-model", provider: "test" }),
    toolNames: Object.freeze([]),
    tools: Object.freeze([]),
    systemPrompt: "",
    maxTurns: 200,
    maxContinuations: 5,
    ...(opts.config ?? {}),
  });

  const sink =
    opts.logSink ??
    (opts.captureLog
      ? (level: LogLevel, msg: string, fields: Record<string, unknown>) => {
          logs.push({ level, msg, fields });
        }
      : () => {});

  const impl = new HookContextImpl({
    sessionId: defaultConfig.sessionId,
    initialSignal: opts.signal ?? new AbortController().signal,
    messages: [],
    config: defaultConfig,
    logSink: sink,
    onAppendMessage: opts.onAppendMessage
      ? opts.onAppendMessage
      : (msg) => {
          appended.push(msg);
        },
    onAbort: opts.onAbort
      ? opts.onAbort
      : (reason) => {
          abortReasons.push(reason);
        },
  });

  const internals = getKernelInternals(impl);
  if (opts.turnIdx !== undefined) internals.setTurnIdx(opts.turnIdx);

  return {
    ctx: impl,
    setTurnIdx: (idx) => internals.setTurnIdx(idx),
    setSignal: (signal) => internals.setSignal(signal),
    logs,
    appended,
    abortReasons,
  };
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
