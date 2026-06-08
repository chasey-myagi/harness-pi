/**
 * AgentSession —— harness-pi 的 kernel。
 *
 * 实现要点：
 *   - pi-ai complete() 跑 LLM；按 4 阶段派发 hook
 *   - tool 执行按 isConcurrencySafe 分组：safe 批 Promise.all，unsafe 批顺序
 *   - onSessionEnd continue=true 触发同 session 续跑（maxContinuations 兜底）
 *   - tool.execute throw → isError ToolExecResult 回灌
 *   - hook throw / timeout → dispatcher fail-open（decision hook failClosed=true 时 fail-closed）
 *   - Abort：**单 AbortController**；caller signal forward 进来，hook 调 ctx.abort 也 forward
 *
 * 详见 docs/02-kernel.md。
 */

import {
  stream,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type Api,
  type ToolCall,
  type ToolResultMessage,
  type Usage,
  type StopReason,
} from "@earendil-works/pi-ai";

/**
 * Phase 3：streaming consumer 看到的事件类型。每个事件对应一个 EVENT-category hook。
 *
 * 跟 hook event 的区别：
 *   - hook 是 plugin 写的代码（可以决断、改 context）
 *   - SessionEvent 是只读流，给外部 consumer（HTTP/WS handler / 测试）订阅
 *
 * **故意不包括的事件**（设计决定，不要"补全"）：
 *   - onPreToolUse / onUserPromptSubmit：decision-category，能改 control flow；
 *     stream 是只读视图，让 caller 决断会模糊"控制平面"边界。
 *   - transformSystemPromptBeforeLlm / transformMessagesBeforeLlm：pipe-category，
 *     是 plugin-to-plugin 的转换链，对外部 consumer 不可观察也无意义。
 *   - wrapTurn / wrapToolExec：around-category，洋葱嵌套；嵌套语义跟"flat event 流"
 *     不兼容，强行 yield 会让 consumer 看到错乱的 begin/end 序列。
 *
 * 这个 union 显式列出，让消费者用 discriminated switch 处理。新加 arm 时记得
 * 同步更新 phase3-capabilities.test.ts 的 exhaustive-switch 测试。
 *
 * **注意**：`tool-end.result.newMessages` 包含 tool 想注入的 user/system 消息，但 kernel
 * 可能在 push 进 session.messages 之前过滤掉 assistant/toolResult role 的注入。Stream
 * consumer 看到的是 raw result，不是 kernel 实际接受的 messages。
 */
export type SessionEvent =
  | { type: "session-start"; sessionId: string; source: "run" | "continue"; initialPrompt?: string }
  | { type: "turn-start"; turnIdx: number }
  | { type: "llm-end"; msg: AssistantMessage; durationMs: number }
  | { type: "tool-end"; call: ToolCall; result: ToolExecResult; durationMs: number }
  | { type: "turn-end"; turnIdx: number; toolResultsCount: number; stopReason: AssistantMessage["stopReason"] }
  | { type: "continuation-check"; turns: number; continuations: number }
  | { type: "session-end"; summary: RunSummary }
  | { type: "error"; phase: "llm" | "tool" | "hook"; message: string; hookName?: string };

/**
 * Event Bus —— **live track**（设计依据 docs/09 §3.1）。
 *
 * 与 `SessionEvent`（coarse "recorded" 生命周期事件，经 `runStreaming()` 暴露）分两条轨：
 * 这里是回合**进行中**的细粒度 token/thinking/toolcall delta，经 `session.on(type, cb)` 订阅。
 * 它们**可丢**（UI 丢几帧无所谓），不进 transcript；listener 抛错被内核隔离，绝不影响 loop
 * （借鉴 kimi LoopEventDispatcher 的 durable/live 双轨 + live listener 容错）。
 *
 * 这个 union 显式列出，让消费者用 discriminated switch 处理。新加 arm 时记得
 * 同步更新 event-bus.test.ts 的 LiveEvent exhaustive-switch 测试。
 */
export type LiveEvent =
  | { type: "message_start" }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  // `message_update`：**回合进行中**的「中间态、逐块快照」。在每个内容块边界（text / thinking /
  // toolcall 各自 `*_end`）各发一次，携带 pi-ai 截至此刻**已拼好的 `partial`**。比逐 token delta
  // **低频**（每块一次，非每 token，避免 O(n²) 流量）。
  //
  // **契约（务必看清）**：
  //   - 它是**中间快照**，不是终态。`message.content` 只含「已收尾的块」，回合还没结束。
  //   - **终态、权威**的整条消息以 `message_end`（源自 `stream().result()`）为准。
  //   - 需要终态的消费者**必须**用 `message_end`；把 `message_update.message` 当终态（例如在 mid-abort
  //     时拿最后一帧 update 当成最终结果）是**错的**——它可能缺少尚未收尾的块。
  //   - 偏好「渲染整条快照」的 UI **主动**订阅 `message_update`；偏好「自己累积 delta」的 UI **忽略**它、
  //     只订阅 `*_delta`。两类消费者互不依赖。
  | { type: "message_update"; message: AssistantMessage }
  // `message_start` 与 `message_end` **严格成对**：成功路径在 try 后 emit 一次（带 message），
  // catch 路径 emit 一次（不带 message）且必 rethrow —— 两路恰好各一次，不重复、不悬空。
  // （注意：不是 try/finally；若把成功路径那次挪进 finally 会与 catch 那次造成 double-emit。）
  //
  // **关于 `message`**：绝大多数情况下 `message` 都**存在**——provider 把运行时 LLM 错误 / abort
  // 表达成一个 `error` 流事件，`stream().result()` 会 **resolve** 出一条 `stopReason` 为
  // `"error"`/`"aborted"` 的 AssistantMessage（不 reject），走成功路径、`message_end` **带** message。
  // 只有 `stream()` **同步抛**（如 provider 未注册）才走 catch、`message` 缺省。
  // **下游判失败应看 `message.stopReason`，不要用「message 是否存在」来判。**
  | { type: "message_end"; message?: AssistantMessage };

type LiveEventType = LiveEvent["type"];
type LiveHandler<T extends LiveEventType> = (e: Extract<LiveEvent, { type: T }>) => void;
import { HookContextImpl, getKernelInternals } from "./context.js";
import {
  HookDispatcher,
  verifyHookDependencies,
  assertCriticalDecisionHooks,
  type HookFailureSink,
  type HookDependencyWarning,
} from "./dispatcher.js";
import type {
  Hook,
  LogLevel,
  SessionConfigView,
  ToolExecResult,
  ContextOverflowInput,
} from "./hook.js";
import { ToolExecutor, findToolByName } from "./tool-executor.js";
import { createAttachmentMessage } from "./types.js";
import type { HarnessTool } from "./types.js";
import type { SessionStore } from "./session-store.js";
import { defaultIsContextOverflow } from "./context-overflow.js";
import { resolveLlmOptions } from "./llm-model.js";
import type { LlmOptions } from "./llm-model.js";
import { randomUUID } from "node:crypto";

export interface AgentSessionOptions {
  model: Model<Api>;
  tools: HarnessTool[];
  systemPrompt?: string;
  hooks?: Hook[];
  /** 防失控硬上限；默认 200。 */
  maxTurns?: number;
  /** onSessionEnd 续跑次数硬上限；默认 5。超出返回 reason="max_continuations"。 */
  maxContinuations?: number;
  /** 续跑时可注入历史 messages（lifecycle-restart controller 用）。 */
  initialMessages?: Message[];
  /**
   * 可选会话存储。给定后，内核在每个 turn 结束 + run 结束把新 messages（及一条 terminal entry）
   * append 进 store；配合 `AgentSession.resume(store, sessionId)` 可从落盘历史重建并续跑。
   * 协议在内核，落盘实现（JSONL / Postgres）在 adapter。
   */
  store?: SessionStore;
  /** 覆盖自动生成的 session id。`AgentSession.resume` 用它把新 session 绑回同一 lineage。 */
  sessionId?: string;
  /**
   * 持久化失败的处理模式。默认 false = best-effort（store I/O 失败只记日志 + 计入 RunSummary.persistenceErrors，
   * 不改终态，下次 flush 从 HWM 重试）。true = strict：若 run 结束时持久化未真正完成（最终 flush 或 terminal
   * append 失败），把 RunSummary.reason 改写为 "error" 并填 error，让依赖 durable resume/复现的调用方不会
   * 把「done 但落盘不全」当成功。注意 strict 判定在 onSessionEnd 之后（terminal 持久化发生在 session 结束后），
   * 故 onSessionEnd 仍观察到 loop 的自然 reason；strict 只改写**返回的** RunSummary。
   */
  strictPersistence?: boolean;
  /**
   * 内核内部用：resume 时声明前 N 条 initialMessages 已在 store 里、不要重复 append。
   * 普通调用者不要设。
   */
  resumedMessageCount?: number;
  /**
   * 透传给 pi-ai stream()/complete() 的 provider options（typed，见 {@link LlmOptions}）。
   * 公共字段（apiKey / temperature / headers / …）类型化，`{apikey}` 这类 typo 编译期失败；
   * provider 专属键走 `providerExtras` 逃生口。`signal` 是 kernel 保留字段，已从类型 Omit 掉
   * （即使经 `providerExtras` 偷传也会被当前 session 的 AbortSignal 覆盖）。
   */
  llmOptions?: LlmOptions;
  /** Hook 失败上报通道（metrics plugin 通常 hook 进来）。 */
  hookFailureSink?: HookFailureSink;
  /**
   * 把一次「LLM 以 `stopReason==="error"` 结束」判定为 context-overflow 的谓词（docs/09 §3.6）。
   * 返回 true → 内核 fire `onContextOverflow`（`stopReason:"error"`）。默认 `defaultIsContextOverflow`
   * （匹配 OpenAI/Anthropic/DashScope 常见 prompt-too-long 文案）。`stopReason==="length"` 是无歧义
   * 越界，不经此谓词。内核不内置 compaction 策略，连「什么算 overflow」都让你可换。
   */
  isContextOverflow?: (errorMessage: string) => boolean;
  /**
   * systemMessage emit 通道：所有 HookResult.systemMessage 走这里。
   * 默认 console.log；永不进 LLM context。
   */
  consoleSink?: (
    msg: string,
    ctx: { sessionId: string; turnIdx: number },
  ) => void;
  /**
   * `ctx.log.<level>(msg, fields?)` 的后端 sink。默认走 console.{log,warn,error,debug}
   * 带 `[harness-pi <sessionId> turn=N]` 前缀。生产环境通常注入 pino / winston / 业务 logger。
   *
   * sink 永远在 hot path 上同步调用；如果要 ship 远端，先 buffer 再 batch flush。
   */
  logSink?: (
    level: LogLevel,
    msg: string,
    fields: Record<string, unknown>,
  ) => void;
}

/**
 * 一次 run/continue 的**结构化终态**（设计依据 docs/09 §3.2 的 TerminalResult）。
 *
 * `reason` 是判别字段（done / max_turns / aborted / error / max_continuations）。
 * domain-free：内核只给 done/aborted/error 这种通用终态，业务层（如 bidding 的
 * filled/uncertain/failed）从 `reason` + 自己的 tool 回调映射，**不进内核**。
 *
 * `usage` 总是由内核填充。声明式编排层（controllers）靠 `usage` 做 budget、靠
 * `reason`/`lastMessage` 判 work-item 终态。
 */
export interface RunSummary {
  turns: number;
  /** 同 session 内 onSessionEnd 触发续跑的次数。 */
  continuations: number;
  /**
   * 终态判别字段。注意 `"aborted"` 涵盖三类来源（caller abort / watchdog / onUserPromptSubmit
   * policy-deny），需配合 `abortReason` 细分 —— 编排层判重试不应只看 reason（如 lifecycle-restart
   * 默认只重试 `abortReason` 以 `watchdog:` 开头的，policy-deny 不会被误重试）。
   */
  reason:
    | "done"
    | "max_turns"
    | "aborted"
    | "error"
    | "max_continuations";
  /**
   * **session 累计** token usage（含 cost）：累加该 session `messages` 里**至今所有** assistant
   * 的 usage —— 含本次 run 之前的 run/continue（messages 是持久累积的）。内核总是填充（无 LLM 调用为零值）。
   * 注意：lifecycle-restart 这类「换 session + 搬历史」的 controller 会让 usage 在重启间**重叠累加**，
   * 那是 controller 层语义（见 controllers/lifecycle-restart.ts 注释），内核契约本身自洽。
   */
  usage: Usage;
  /**
   * 该 session `messages` 里最后一条 assistant 消息（无任何 assistant 则缺省）。
   * **注意 `error` 终态**：LLM 同步抛时失败的 assistant **不入 messages**，`lastMessage` 指向
   * 上一个成功 turn（甚至上一次 run），失败详情在 `error`。而 provider 把错误表达成流事件时，
   * `result()` resolve 出 `stopReason="error"` 的 assistant，它**会**入 messages、成为 `lastMessage`。
   * 判失败请看 `reason`/`error`/`lastMessage.stopReason`，别假设 `lastMessage` 就是本次的产物。
   */
  lastMessage?: AssistantMessage;
  /** `lastMessage` 的 stopReason（便于消费者不必自己翻 lastMessage）。 */
  stopReason?: StopReason;
  error?: Error;
  abortReason?: string;
  /** 持久化（SessionStore）失败记录。两种模式下都会**如实暴露**（非空才出现）；strict 模式还会把 reason 改 error。 */
  persistenceErrors?: string[];
}

const DEFAULT_MAX_TURNS = 200;
const DEFAULT_MAX_CONTINUATIONS = 5;

/** Single turn 的退出状态。 */
type TurnOutcome = "done" | "continue" | "abort" | "error";

export class AgentSession {
  readonly id: string;
  readonly model: Model<Api>;
  readonly tools: ReadonlyArray<HarnessTool>;
  readonly systemPrompt: string;
  readonly maxTurns: number;
  readonly maxContinuations: number;
  private readonly _llmOptions: LlmOptions;

  private _messages: Message[];
  private _hooks: Hook[];
  private _dispatcher: HookDispatcher;
  private readonly _hookFailureSink: HookFailureSink | undefined;
  private _ctx: HookContextImpl;
  /** 单 AbortController 唯一的 abort 真相源。Reason 通过 signal.reason 传播。 */
  private _abortCtrl: AbortController;
  private _pendingAttachments: Message[] = [];
  /** Steering inbox（park 队列）。steer() enqueue，loop 在 turn 开始的安全点 drain。 */
  private _steerInbox: Message[] = [];
  private _lastTurnError: Error | null = null;
  private _running = false;
  private _consoleSink: (
    msg: string,
    ctx: { sessionId: string; turnIdx: number },
  ) => void;
  /** Event Bus live listeners（按事件类型分组）。 */
  private readonly _liveListeners = new Map<
    LiveEventType,
    Set<(e: LiveEvent) => void>
  >();
  /** 可选会话存储 + 已 append 进 store 的 messages 数（避免重复落盘）。 */
  private readonly _store: SessionStore | undefined;
  private _persistedCount: number;
  /** strict 持久化模式：run 结束落盘不全则把返回的 RunSummary.reason 改 error（见选项注释）。 */
  private readonly _strictPersistence: boolean;
  /** 本 session 累积的持久化失败记录；两种模式下都如实挂上 RunSummary.persistenceErrors。 */
  private _persistenceErrors: string[] = [];
  /** error-stopReason → 是否 context-overflow 的判定（可经选项覆盖，默认内置启发式）。 */
  private readonly _isContextOverflow: (errorMessage: string) => boolean;

  constructor(opts: AgentSessionOptions) {
    this.id = opts.sessionId ?? randomUUID();
    this._store = opts.store;
    this._strictPersistence = opts.strictPersistence ?? false;
    // resume 时前 N 条 initialMessages 已在 store，不重复 append；普通构造从 0 起。
    // 夹到 initialMessages 长度，防止误传过大值导致首批新消息漏落盘。
    this._persistedCount = Math.min(
      opts.resumedMessageCount ?? 0,
      opts.initialMessages?.length ?? 0,
    );
    this.model = opts.model;
    this.tools = opts.tools;
    this.systemPrompt = opts.systemPrompt ?? "";
    this.maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
    this.maxContinuations = opts.maxContinuations ?? DEFAULT_MAX_CONTINUATIONS;
    this._llmOptions = { ...(opts.llmOptions ?? {}) };

    this._messages = opts.initialMessages ? [...opts.initialMessages] : [];
    this._hooks = [...(opts.hooks ?? [])];
    // fail-closed 分类硬校验（§3.7）：critical decision hook 必须显式声明 failClosed，否则拒绝构造。
    // 放在 dispatcher 之前——配错就 fail-loud，不让一个静默 fail-open 的安全 hook 跑起来。
    assertCriticalDecisionHooks(this._hooks);
    this._hookFailureSink = opts.hookFailureSink;
    this._isContextOverflow = opts.isContextOverflow ?? defaultIsContextOverflow;
    this._dispatcher = new HookDispatcher(this._hooks, this._hookFailureSink);
    this._consoleSink =
      opts.consoleSink ??
      ((msg, c) => {
        // eslint-disable-next-line no-console
        console.log(`[harness-pi ${c.sessionId} turn=${c.turnIdx}] ${msg}`);
      });

    // 构造期校验 hook 软依赖，warning 走 consoleSink；不阻塞构造，让 caller 决定怎么响应
    this._emitDependencyWarnings(verifyHookDependencies(this._hooks));

    this._abortCtrl = new AbortController();
    // tools 是构造期固定（`use()` 只允许在 idle 加 hooks，不改 tools / model / maxTurns）。
    // 整个 configView 包括 nested model 对象都 deep-freeze，runtime 拒绝任何 plugin 修改。
    const configView: SessionConfigView = Object.freeze({
      sessionId: this.id,
      model: Object.freeze({ id: this.model.id, provider: this.model.provider }),
      toolNames: Object.freeze(this.tools.map((t) => t.name)),
      maxTurns: this.maxTurns,
      maxContinuations: this.maxContinuations,
    });
    const ctxDeps: import("./context.js").HookContextDeps = {
      sessionId: this.id,
      initialSignal: this._abortCtrl.signal,
      messages: this._messages,
      config: configView,
      onAppendMessage: (msg) => this._messages.push(msg),
      onAbort: (reason) => this._abortCtrl.abort(new Error(reason)),
    };
    if (opts.logSink) ctxDeps.logSink = opts.logSink;
    this._ctx = new HookContextImpl(ctxDeps);
  }

  get messages(): ReadonlyArray<Message> {
    return this._messages;
  }

  /**
   * 注册 hook。注意：不要在 `run()` / `continue()` 进行中调用，会 throw。
   */
  use(hook: Hook): this {
    if (this._running) {
      throw new Error(
        "AgentSession.use(): cannot register hook while run() is in progress",
      );
    }
    // 与构造期同样的 fail-closed 硬校验：use() 也是注册期，critical decision hook 配错即拒绝。
    assertCriticalDecisionHooks([hook]);
    this._hooks.push(hook);
    this._dispatcher = new HookDispatcher(this._hooks, this._hookFailureSink);
    // 重新校验软依赖（新 hook 可能补齐 missing-required，也可能引入 conflict）
    this._emitDependencyWarnings(verifyHookDependencies(this._hooks));
    return this;
  }

  /**
   * 把 hook 依赖校验 warning 发给 consoleSink。turnIdx 用 -1 表示"构造期"。
   *
   * 抑制规则（避免 spam 用户）：
   *   - 抑制 `hook` 是 `internal: true` 的 hook 触发的 warning（plugin author 自己的事，不该跟用户报）
   *   - 抑制 `related` 是 `internal: true` hook 的 warning（同上）
   */
  private _emitDependencyWarnings(warnings: HookDependencyWarning[]): void {
    const internalNames = new Set(
      this._hooks.filter((h) => h.internal === true).map((h) => h.name),
    );
    for (const w of warnings) {
      if (internalNames.has(w.hook) || internalNames.has(w.related)) continue;
      this._consoleSink(`[hook-deps:${w.kind}] ${w.message}`, {
        sessionId: this.id,
        turnIdx: -1,
      });
    }
  }

  abort(reason = "abort() called"): void {
    if (this._abortCtrl.signal.aborted) return;
    this._abortCtrl.abort(new Error(reason));
  }

  /**
   * 订阅 Event Bus 的 **live** 事件（回合进行中的 token/thinking/toolcall delta）。
   * 返回 unsubscribe 函数。可在 run 进行中或之前注册（与 `use()` 不同，不受 `_running` 限制——
   * 它是只读观察，不改控制平面）。listener 抛错被隔离，不影响 loop。
   */
  on<T extends LiveEventType>(type: T, handler: LiveHandler<T>): () => void {
    let set = this._liveListeners.get(type);
    if (!set) {
      set = new Set();
      this._liveListeners.set(type, set);
    }
    const erased = handler as (e: LiveEvent) => void;
    set.add(erased);
    return () => {
      this._liveListeners.get(type)?.delete(erased);
    };
  }

  /** 发一条 live 事件给订阅者。listener 抛错被吞掉（live 容错），绝不冒泡进 loop。 */
  private _emitLive(e: LiveEvent): void {
    const set = this._liveListeners.get(e.type);
    if (!set || set.size === 0) return;
    // 快照：listener 在回调里 on()/unsubscribe 不影响本次遍历——新 listener 从下个事件起生效。
    for (const h of [...set]) {
      try {
        h(e);
      } catch (err) {
        this._consoleSink(
          `[event-bus] live listener for "${e.type}" threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { sessionId: this.id, turnIdx: this._ctx.turnIdx },
        );
      }
    }
  }

  snapshot(): { sessionId: string; messages: Message[] } {
    return { sessionId: this.id, messages: [...this._messages] };
  }

  getCacheSafeParams(): {
    systemPrompt: string;
    forkContextMessages: Message[];
    model: Model<Api>;
  } {
    return {
      systemPrompt: this.systemPrompt,
      forkContextMessages: [...this._messages],
      model: this.model,
    };
  }

  /**
   * Steering（park/drain，docs/09 §3.5）：把一条消息 **park** 进 steering inbox。loop 会在下一个
   * turn 开始的安全点 drain 它、注入对话——**不 suspend、不打断进行中的 turn**（对齐 iii.dev / codex
   * 的「park 不 suspend」）。run 进行中或之外调用都安全（单线程下 push 是原子的）。
   *
   * 只接受 `role:"user"` 消息（用 `createUserMessage` 构造）——assistant/toolResult 会破坏对话不变量，
   * 直接抛错（fail-loud）。pi-ai 无独立 system role，"系统提示"类 steering 用 user 消息表达或走
   * consoleSink，不在此注入。
   *
   * drain 时机是 loop 控制流的一部分（只有 loop 能保证 turn 原子性 / cache 前缀不破），故此机制进内核；
   * 「何时该 park、谁能回复」是 policy，留给插件 / app。
   */
  steer(message: Message): void {
    if (message.role !== "user") {
      throw new Error(
        `AgentSession.steer: only user-role messages can be steered, got "${message.role}" ` +
          `(assistant/toolResult would break conversation invariants)`,
      );
    }
    this._steerInbox.push(message);
  }

  /** 追加 user prompt 跑到结束。 */
  async run(
    prompt: string,
    opts?: { signal?: AbortSignal },
  ): Promise<RunSummary> {
    return this._runInternal({
      source: "run",
      prompt,
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
  }

  /** 不追加新消息从当前 messages 继续。 */
  async continue(opts?: { signal?: AbortSignal }): Promise<RunSummary> {
    return this._runInternal({
      source: "continue",
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
  }

  /**
   * Phase 3 新增：streaming API。返回 `AsyncIterable<SessionEvent>`，consumer 可以边
   * 跑边 push（典型场景：后端 HTTP/WebSocket 流式回前端）。
   *
   * 实现上挂一个 internal forwarder hook 把事件 push 到 async queue；外部 iterator 把
   * queue 转 async iterator。yield 完最后的 `session-end` 事件后 iterator close。
   *
   * **不能并发**：跟 `run()` / `continue()` 互斥，同一 session 同一时刻只能一个跑。
   */
  runStreaming(
    prompt: string,
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<SessionEvent> & { finalSummary: Promise<RunSummary> } {
    return this._runStreamingInternal({
      source: "run",
      prompt,
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
  }

  /** Streaming 版本的 continue()。 */
  continueStreaming(
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<SessionEvent> & { finalSummary: Promise<RunSummary> } {
    return this._runStreamingInternal({
      source: "continue",
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
  }

  private _runStreamingInternal(args: {
    source: "run" | "continue";
    prompt?: string;
    signal?: AbortSignal;
  }): AsyncIterable<SessionEvent> & { finalSummary: Promise<RunSummary> } {
    // 内部 push-to-queue forwarder hook（不上报 metric / log；纯 plumbing）
    const queue: SessionEvent[] = [];
    let resolveNext: ((v: IteratorResult<SessionEvent>) => void) | null = null;
    let done = false;
    const sessionIdCapture = this.id;

    const push = (ev: SessionEvent): void => {
      if (done) return;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: ev, done: false });
      } else {
        queue.push(ev);
      }
    };
    const close = (): void => {
      if (done) return;
      done = true;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: undefined, done: true });
      }
    };

    const forwarder: Hook = {
      name: "harness-pi.streaming-forwarder",
      internal: true,
      onSessionStart(input) {
        push({
          type: "session-start",
          sessionId: sessionIdCapture,
          source: input.source,
          ...(input.initialPrompt !== undefined
            ? { initialPrompt: input.initialPrompt }
            : {}),
        });
      },
      onTurnStart(input) {
        push({ type: "turn-start", turnIdx: input.turnIdx });
      },
      onLlmEnd(input) {
        push({
          type: "llm-end",
          msg: input.msg,
          durationMs: input.durationMs,
        });
      },
      onPostToolUse(input) {
        push({
          type: "tool-end",
          call: input.call,
          result: input.result,
          durationMs: input.durationMs,
        });
      },
      onTurnEnd(input) {
        push({
          type: "turn-end",
          turnIdx: input.turnIdx,
          toolResultsCount: input.toolResults.length,
          stopReason: input.assistantMessage.stopReason,
        });
      },
      onContinuationCheck(input) {
        push({
          type: "continuation-check",
          turns: input.turns,
          continuations: input.continuations,
        });
      },
      onError(input) {
        push({
          type: "error",
          phase: input.phase,
          message: input.err.message,
          ...(input.hookName !== undefined
            ? { hookName: input.hookName }
            : {}),
        });
      },
    };

    // 提取 cleanup 给 resolve/reject 路径共用，避免重复
    const cleanupForwarder = (): void => {
      const idx = this._hooks.indexOf(forwarder);
      if (idx >= 0) this._hooks.splice(idx, 1);
      this._dispatcher = new HookDispatcher(
        this._hooks,
        this._hookFailureSink,
      );
    };

    // M3 兜底：如果当前已在跑（_running=true），this.use() 会 throw。把这个错转成
    // 已关闭的 iterator，让 caller 可以正常 for-await 而不是 catch sync exception。
    try {
      this.use(forwarder);
    } catch (err) {
      const errEv: SessionEvent = {
        type: "error",
        phase: "hook",
        message:
          err instanceof Error
            ? err.message
            : "runStreaming called while session is already running",
      };
      let emitted = false;
      const closedIter: AsyncIterableIterator<SessionEvent> = {
        async next(): Promise<IteratorResult<SessionEvent>> {
          if (!emitted) {
            emitted = true;
            return { value: errEv, done: false };
          }
          return { value: undefined, done: true };
        },
        async return(): Promise<IteratorResult<SessionEvent>> {
          emitted = true;
          return { value: undefined, done: true };
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
      const rejected = Promise.reject<RunSummary>(
        err instanceof Error
          ? err
          : new Error("runStreaming concurrent invocation"),
      );
      // 避免 unhandled-rejection 警告——caller 不 await finalSummary 也 OK
      rejected.catch(() => {});
      return Object.assign(closedIter, { finalSummary: rejected });
    }

    // 异步跑 session，结束后 push session-end + close
    const summaryPromise = this._runInternal(args).then(
      (summary) => {
        push({ type: "session-end", summary });
        close();
        cleanupForwarder();
        return summary;
      },
      (err) => {
        push({
          type: "error",
          phase: "hook",
          message: err instanceof Error ? err.message : String(err),
        });
        close();
        cleanupForwarder();
        throw err;
      },
    );

    const iter: AsyncIterableIterator<SessionEvent> = {
      next: (): Promise<IteratorResult<SessionEvent>> => {
        if (queue.length > 0) {
          return Promise.resolve({
            value: queue.shift()!,
            done: false,
          });
        }
        if (done) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          resolveNext = resolve;
        });
      },
      // M2：consumer 可以提前 break，触发 session.abort() 取消正在跑的 session。
      // 满足标准 AsyncIterator close protocol：`for await ... break` / iter.return() 都会调这里。
      return: (): Promise<IteratorResult<SessionEvent>> => {
        if (!done) {
          // 让 session 走正常 abort 流程（onSessionEnd 还会 fire，summaryPromise 会 resolve aborted）
          if (!this._abortCtrl.signal.aborted) {
            this._abortCtrl.abort(
              new Error("runStreaming: consumer broke iteration"),
            );
          }
        }
        return Promise.resolve({ value: undefined, done: true });
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };

    return Object.assign(iter, { finalSummary: summaryPromise });
  }

  /* ────────────── 主流程 ────────────── */

  private async _runInternal(args: {
    source: "run" | "continue";
    prompt?: string;
    signal?: AbortSignal;
  }): Promise<RunSummary> {
    if (this._running) {
      throw new Error("AgentSession: run() / continue() already in progress");
    }
    this._running = true;
    try {
      return await this._runInternalUnchecked(args);
    } finally {
      this._running = false;
    }
  }

  private async _runInternalUnchecked(args: {
    source: "run" | "continue";
    prompt?: string;
    signal?: AbortSignal;
  }): Promise<RunSummary> {
    // 每次 run/continue 重建 AbortController；上次的 abort 状态不污染本次
    this._abortCtrl = new AbortController();
    getKernelInternals(this._ctx).setSignal(this._abortCtrl.signal);
    this._pendingAttachments = [];
    this._lastTurnError = null;
    // persistenceErrors 是 per-run 信号（对齐 error/abortReason）：每次 run/continue 清零，
    // 否则上一次的失败会污染本次干净 run 的 RunSummary.persistenceErrors。
    this._persistenceErrors = [];
    // 注意：_steerInbox **故意不在此清空**——park 的 steer 是「等下次跑起来时插队」的用户意图，
    // 应跨 run/continue 边界存活、在首个 turn 的安全点 drain；这与 transient 的 _pendingAttachments
    // （上次 run 的残渣、每次清零）语义相反。别"顺手"加 `this._steerInbox = []` 求对称。

    // 把 caller signal forward 进 internal controller
    const cleanupCallerForward = forwardSignal(args.signal, this._abortCtrl);

    try {
      // onSessionStart
      const ssInput: { source: "run" | "continue"; initialPrompt?: string } = {
        source: args.source,
      };
      if (args.prompt !== undefined) ssInput.initialPrompt = args.prompt;
      const ssOut = await this._dispatcher.fireEvent(
        "onSessionStart",
        ssInput,
        this._ctx,
      );
      this._flushSystemMessages(ssOut.systemMessages);
      if (ssOut.initialUserMessage) {
        this._messages.push({
          role: "user",
          content: ssOut.initialUserMessage,
          timestamp: Date.now(),
        });
      }
      for (const c of ssOut.additionalContexts) {
        this._pushAttachment(c, "onSessionStart");
      }

      // run 模式：push user prompt + UserPromptSubmit
      if (args.source === "run" && args.prompt !== undefined) {
        const userMsg: Message = {
          role: "user",
          content: args.prompt,
          timestamp: Date.now(),
        };
        this._messages.push(userMsg);

        const upsOut = await this._dispatcher.fireDecision(
          "onUserPromptSubmit",
          { userMessage: userMsg },
          this._ctx,
        );
        // continue=false OR decision="deny" both halt the prompt
        if (
          upsOut?.continue === false ||
          upsOut?.decision === "deny"
        ) {
          // 终止 run：flush systemMessage 让 operator 看到原因。
          // 不 push additionalContext —— 这条 run 不会再有 LLM call 消费它，
          // 而 _pendingAttachments 会在下次 _runInternalUnchecked 被清空（line ~213），
          // push 进去是 dead write。
          if (upsOut.systemMessage) {
            this._flushSystemMessages([upsOut.systemMessage]);
          }
          const summary: RunSummary = {
            turns: 0,
            continuations: 0,
            reason: "aborted",
            usage: this._accumulatedUsage(),
          };
          const last = this._lastAssistant();
          if (last) {
            summary.lastMessage = last;
            summary.stopReason = last.stopReason;
          }
          const reasonText =
            upsOut.stopReason ??
            upsOut.reason ??
            "onUserPromptSubmit halted";
          summary.abortReason = reasonText;
          await this._fireSessionEnd(0, 0, summary.reason);
          const persistedOk = await this._persistTerminal(summary);
          this._finalizePersistence(summary, persistedOk);
          return summary;
        }
        if (upsOut?.systemMessage) {
          this._flushSystemMessages([upsOut.systemMessage]);
        }
        if (upsOut?.additionalContext) {
          this._pushAttachment(upsOut.additionalContext, "onUserPromptSubmit");
        }
      }

      // turn loop（首轮 + 任意 continuations）
      let turnIdx = 0;
      let continuations = 0;
      let reason: RunSummary["reason"] = "done";

      while (true) {
        const r = await this._runTurnsUntilStop(turnIdx);
        turnIdx = r.turnIdx;
        reason = r.reason;

        if (reason !== "done") break;

        // 到上限就不再问续跑
        if (continuations >= this.maxContinuations) {
          reason = "max_continuations";
          break;
        }

        // 询问 hook 是否要续跑（独立事件 onContinuationCheck，不是 onSessionEnd）
        const ccOut = await this._dispatcher.fireEvent(
          "onContinuationCheck",
          { turns: turnIdx, continuations },
          this._ctx,
        );
        this._flushSystemMessages(ccOut.systemMessages);

        const wantsContinue =
          ccOut.continue === true && !this._abortCtrl.signal.aborted;

        if (!wantsContinue) break;

        continuations++;
        for (const c of ccOut.additionalContexts) {
          this._pushAttachment(c, "onContinuationCheck");
        }
        // 继续下一轮 turn loop
      }

      // 退出 loop：恰好 fire 一次 onSessionEnd（无论 done / aborted / error / max_turns / max_continuations）
      await this._fireSessionEnd(turnIdx, continuations, reason);
      const summary = this._buildSummary(turnIdx, continuations, reason);
      const persistedOk = await this._persistTerminal(summary);
      this._finalizePersistence(summary, persistedOk);
      return summary;
    } finally {
      cleanupCallerForward();
    }
  }

  private async _fireSessionEnd(
    turns: number,
    continuations: number,
    reason: RunSummary["reason"],
  ): Promise<void> {
    const seOut = await this._dispatcher.fireEvent(
      "onSessionEnd",
      { turns, reason, continuations },
      this._ctx,
    );
    this._flushSystemMessages(seOut.systemMessages);
  }

  /**
   * 累加该 session `messages` 里所有 assistant 的 usage（含 cost）。无 LLM 调用则全零。
   *
   * ⚠️ **维护契约**：这是**逐字段手写**累加。pi-ai 的 `Usage` 若新增字段（如 reasoningTokens），
   * TS 不会在这里报错，会**静默漏算** —— 加字段时务必同步这里。
   * `?? 0` / `if (mu.cost)`：pi-ai 的 Usage 字段类型上均必填，这些是**防御 OpenAI-compatible
   * provider（如 DashScope）/ 代理返回畸形 / 缺字段 usage** 的兜底，不是类型层需要。
   */
  private _accumulatedUsage(): Usage {
    const u: Usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    for (const m of this._messages) {
      if (m.role !== "assistant") continue;
      const mu = (m as AssistantMessage).usage;
      if (!mu) continue;
      u.input += mu.input ?? 0;
      u.output += mu.output ?? 0;
      u.cacheRead += mu.cacheRead ?? 0;
      u.cacheWrite += mu.cacheWrite ?? 0;
      u.totalTokens += mu.totalTokens ?? 0;
      if (mu.cost) {
        u.cost.input += mu.cost.input ?? 0;
        u.cost.output += mu.cost.output ?? 0;
        u.cost.cacheRead += mu.cost.cacheRead ?? 0;
        u.cost.cacheWrite += mu.cost.cacheWrite ?? 0;
        u.cost.total += mu.cost.total ?? 0;
      }
    }
    return u;
  }

  /** 最后一条 assistant 消息（用于 RunSummary.lastMessage）。 */
  private _lastAssistant(): AssistantMessage | undefined {
    for (let i = this._messages.length - 1; i >= 0; i--) {
      const m = this._messages[i];
      if (m && m.role === "assistant") return m as AssistantMessage;
    }
    return undefined;
  }

  private _buildSummary(
    turns: number,
    continuations: number,
    reason: RunSummary["reason"],
  ): RunSummary {
    const last = this._lastAssistant();
    const summary: RunSummary = {
      turns,
      continuations,
      reason,
      usage: this._accumulatedUsage(),
    };
    if (last) {
      summary.lastMessage = last;
      summary.stopReason = last.stopReason;
    }
    if (this._lastTurnError) summary.error = this._lastTurnError;
    if (this._abortCtrl.signal.aborted) {
      const r = this._abortCtrl.signal.reason;
      summary.abortReason = r instanceof Error ? r.message : String(r ?? "aborted");
    }
    return summary;
  }

  /**
   * 记录一次 store I/O 失败：写日志 + 计入 `_persistenceErrors`（两种模式都记，最终都挂上 RunSummary）。
   * best-effort 下失败不劫持控制流（下次 flush 从未成功处重试）；strict 下由 `_finalizePersistence`
   * 据「最终是否真正落盘完成」改写终态，故此处只如实记录、不改控制流。
   */
  private _reportStoreError(op: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    this._persistenceErrors.push(`${op}: ${msg}`);
    const note = this._strictPersistence
      ? "strict persistence"
      : "best-effort persistence, will retry next flush";
    this._consoleSink(`[session-store] ${op} failed (${note}): ${msg}`, {
      sessionId: this.id,
      turnIdx: this._ctx.turnIdx,
    });
  }

  /**
   * 把自上次以来的新 messages append 进 store（顺序、append-only）。无 store 即 no-op。
   *
   * `_persistedCount` 是 **high-water-mark，逐条推进**：append 成功一条才前进一条 —— 中途
   * `appendEntry` 抛错时计数器停在已成功处，下次 flush 从失败那条重试，**绝不重复 append**
   * （store 是 append-only、不去重，重复 append 会让 resume 读出重复消息）。
   * best-effort：append 失败被 catch，不抛给控制流（持久化失败不该杀掉 run）。
   * 依赖 `_messages` **append-only、索引稳定**（内核只 push，从不 splice/reorder）—— HWM 才成立。
   *
   * 返回是否全部 flush 成功（无 store 视为成功）；调用方据此判断持久化是否真正完成。
   */
  private async _flushToStore(): Promise<boolean> {
    if (!this._store) return true;
    try {
      for (; this._persistedCount < this._messages.length; this._persistedCount++) {
        await this._store.appendEntry(this.id, {
          kind: "message",
          message: this._messages[this._persistedCount]!,
        });
      }
      return true;
    } catch (err) {
      this._reportStoreError("appendEntry(message)", err);
      return false;
    }
  }

  /**
   * run 结束：flush 剩余 messages + append 一条 terminal entry（终态元数据）。无 store 即 no-op。
   * 返回「最终 flush + terminal append 是否都成功」这个真实完成信号，供 `_finalizePersistence` 裁决。
   */
  private async _persistTerminal(summary: RunSummary): Promise<boolean> {
    if (!this._store) return true;
    const flushed = await this._flushToStore();
    let terminalAppendedOk = true;
    try {
      await this._store.appendEntry(this.id, { kind: "terminal", result: summary });
    } catch (err) {
      this._reportStoreError("appendEntry(terminal)", err);
      terminalAppendedOk = false;
    }
    return flushed && terminalAppendedOk;
  }

  /**
   * run 返回前对持久化结果做最终裁决：把累积的 persistenceErrors 如实挂上 summary；strict 模式下若持久化
   * 未真正完成（persistedOk=false）则把 reason 改 "error" 并补 error。persistedOk 用「最终 flush+terminal
   * 是否成功」这个真实完成信号，而非「是否出现过 error」——故 best-effort 下的瞬时错误若已重试成功，strict
   * 不会误判。
   *
   * **只提级 `done`**：strict 仅把「本应成功(done)却落盘不全」这一危险情形提级为 error；已是非 done 终态
   * （aborted/error/max_turns/max_continuations）**不被覆盖**——它们本就非干净成功、调用方不会误信，且
   * persistenceErrors 已如实暴露失败。这避免 strict 用 "error" 盖掉合法的 aborted/max_turns 信号，
   * 也保留某 turn 自然抛错时的原始 `summary.error`（不被 "strict persistence failed" 顶替）。
   */
  private _finalizePersistence(summary: RunSummary, persistedOk: boolean): void {
    if (this._persistenceErrors.length > 0) {
      summary.persistenceErrors = [...this._persistenceErrors];
    }
    if (this._strictPersistence && !persistedOk && summary.reason === "done") {
      summary.reason = "error";
      summary.error = new Error(
        `strict persistence failed: ${this._persistenceErrors.join("; ") || "store append did not complete"}`,
      );
    }
  }

  /**
   * 从 store 的落盘历史重建一个绑回同一 lineage 的 AgentSession，可直接 `continue()` 续跑。
   *
   * 重放规则：按 root→leaf 顺序重建 messages；遇到 `compaction_boundary` **丢弃已累积前缀、
   * 用 summary 接续**（这正是 SessionStore 故意不裁剪、把裁剪留给 resume 的那部分，见 session-store.ts）；
   * `terminal` entry 忽略（仅元数据）。重建出的 messages 标记为「已持久化」，续跑只 append 新消息。
   *
   * **信任边界**：这是不可信落盘数据进入内核的唯一入口。本方法**信任 store 返回的 `Message` 形状合法**
   * （schema 校验是 adapter 的职责）；形状坏的 message 会在下一次 `_phaseLlmCall` 喂给 pi-ai 时才炸。
   * **引用不可变**：重建直接复用 store 返回的 `Message`/`summary` 引用塞进新 session 的 messages —— 依赖
   * hooks/pipes **不原地 mutate** message 对象（与 SessionStore 的不可变契约一致，见 session-store.ts:SessionEntry）。
   */
  static async resume(
    store: SessionStore,
    sessionId: string,
    opts: Omit<
      AgentSessionOptions,
      "store" | "sessionId" | "initialMessages" | "resumedMessageCount"
    >,
  ): Promise<AgentSession> {
    const path = await store.getPathToLeaf(sessionId);
    const msgs: Message[] = [];
    for (const { entry } of path) {
      if (entry.kind === "message") {
        msgs.push(entry.message);
      } else if (entry.kind === "compaction_boundary") {
        msgs.length = 0; // 丢弃被 summary 替换的前缀
        msgs.push(entry.summary);
      }
      // terminal: 忽略
    }
    return new AgentSession({
      ...opts,
      store,
      sessionId,
      initialMessages: msgs,
      resumedMessageCount: msgs.length,
    });
  }

  /**
   * 跑 turn 直到某种结束（done / abort / error / max_turns）。
   * 不处理 onSessionEnd —— 调用方决定要不要续跑。
   */
  private async _runTurnsUntilStop(
    startTurnIdx: number,
  ): Promise<{ turnIdx: number; reason: RunSummary["reason"] }> {
    let turnIdx = startTurnIdx;

    while (turnIdx < this.maxTurns) {
      if (this._abortCtrl.signal.aborted) {
        return { turnIdx, reason: "aborted" };
      }

      getKernelInternals(this._ctx).setTurnIdx(turnIdx);
      const outcome = await this._runOneTurn(turnIdx);
      turnIdx++;

      // 每个 turn 结束把新 messages append 进 store（durable resume；no-op if no store）。
      await this._flushToStore();

      if (outcome === "done") return { turnIdx, reason: "done" };
      if (outcome === "abort") return { turnIdx, reason: "aborted" };
      if (outcome === "error") return { turnIdx, reason: "error" };
    }
    return { turnIdx, reason: "max_turns" };
  }

  /**
   * Drain steering inbox（docs/09 §3.5）：原子取走队列、按入队顺序 push 进 _messages，并对每条
   * fire 一次 onSteer。在 turn 开始的安全点调用，保证插队消息进入下一次 buildMessages、且不破坏
   * 进行中 turn 的原子性。
   *
   * 原子性：`drained = inbox; inbox = []` 是同步 swap，读取与清空之间无 await，所以 fire onSteer 期间
   * steer() 的新 push 落进新数组、下个 turn 再 drain，既不丢也不重。
   */
  private async _drainSteerInbox(turnIdx: number): Promise<void> {
    if (this._steerInbox.length === 0) return;
    const drained = this._steerInbox;
    this._steerInbox = [];
    for (const message of drained) {
      this._messages.push(message);
      const out = await this._dispatcher.fireEvent(
        "onSteer",
        { message, turnIdx },
        this._ctx,
      );
      this._flushSystemMessages(out.systemMessages);
      for (const c of out.additionalContexts) {
        this._pushAttachment(c, "onSteer");
      }
    }
  }

  /**
   * 单 turn 的完整逻辑。3 个 phase 串起来，外层包 wrapTurn around chain。
   * 每个 phase 做一件事，方便 reviewer 改某一阶段不动其他 phase 的缩进。
   *
   *   drainSteer → onTurnStart event → wrapTurn[ _phaseLlmCall → _phaseToolBatch → _phaseTurnEnd ]
   */
  private async _runOneTurn(turnIdx: number): Promise<TurnOutcome> {
    // 安全点：turn 开始前 drain steering inbox，把 park 的消息注入下一次 buildMessages。
    await this._drainSteerInbox(turnIdx);

    const tsOut = await this._dispatcher.fireEvent(
      "onTurnStart",
      { turnIdx },
      this._ctx,
    );
    this._flushSystemMessages(tsOut.systemMessages);
    for (const c of tsOut.additionalContexts) {
      this._pushAttachment(c, "onTurnStart");
    }

    const turnOut: { assistant: AssistantMessage | null } = { assistant: null };

    try {
      const inner = async (): Promise<void> => {
        const assistant = await this._phaseLlmCall();
        turnOut.assistant = assistant;
        if (this._abortCtrl.signal.aborted) return;

        const toolResults = await this._phaseToolBatch(assistant);
        await this._phaseTurnEnd(turnIdx, assistant, toolResults);
      };

      const wrapped = this._dispatcher.buildWrapTurn(this._ctx, inner);
      await wrapped();
    } catch (err) {
      this._lastTurnError =
        err instanceof Error ? err : new Error(String(err));
      return "error";
    }

    if (this._abortCtrl.signal.aborted) return "abort";
    const finalAssistant = turnOut.assistant;
    if (!finalAssistant) return "error";
    if (finalAssistant.stopReason !== "toolUse") return "done";
    return "continue";
  }

  /**
   * Phase 1 / 3：LLM call。
   *   - pipe systemPrompt + messages
   *   - flush pendingAttachments（已纳入 transformed view）
   *   - 调 pi-ai complete()，失败 fire onError 后 re-throw
   *   - onLlmEnd event
   *   - assistant push 进 session.messages
   */
  private async _phaseLlmCall(): Promise<AssistantMessage> {
    const sysPrompt = await this._dispatcher.firePipeSystemPrompt(
      this.systemPrompt,
      this._ctx,
    );
    const baseMessages: Message[] = [
      ...this._messages,
      ...this._pendingAttachments,
    ];
    const transformed = await this._dispatcher.firePipeMessages(
      baseMessages,
      this._ctx,
    );
    this._pendingAttachments = [];

    const piTools = this.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
    const context: Context = {
      messages: stripHarnessOnlyFields(transformed),
      tools: piTools,
      ...(sysPrompt ? { systemPrompt: sysPrompt } : {}),
    };

    const t0 = Date.now();
    let assistant: AssistantMessage;
    this._emitLive({ type: "message_start" });
    try {
      // stream() 而非 complete()：complete() 内部就是 stream().result()，两者结果完全等价，
      // 但 stream 让我们在回合进行中把 delta 作为 live 事件发出（Event Bus）。
      const s = stream(this.model, context, {
        ...resolveLlmOptions(this._llmOptions),
        signal: this._abortCtrl.signal,
      });
      for await (const ev of s) {
        // pi-ai 的 delta 事件字段名（contentIndex/delta）与 LiveEvent 一致，直接转发。
        if (
          ev.type === "text_delta" ||
          ev.type === "thinking_delta" ||
          ev.type === "toolcall_delta"
        ) {
          this._emitLive({ type: ev.type, contentIndex: ev.contentIndex, delta: ev.delta });
        } else if (
          ev.type === "text_end" ||
          ev.type === "thinking_end" ||
          ev.type === "toolcall_end"
        ) {
          // 内容块收尾：发一次「已拼好的整条消息」快照（pi-ai 的 partial）。低频、给快照式前端。
          this._emitLive({ type: "message_update", message: ev.partial });
        }
      }
      assistant = await s.result();
    } catch (err) {
      // message_start 必须配对：抛错 / abort 时也发 message_end（不带 message）。
      this._emitLive({ type: "message_end" });
      await this._dispatcher.fireError(
        {
          phase: "llm",
          err: err instanceof Error ? err : new Error(String(err)),
        },
        this._ctx,
      );
      throw err;
    }
    const llmDurationMs = Date.now() - t0;
    this._emitLive({ type: "message_end", message: assistant });

    const lleOut = await this._dispatcher.fireEvent(
      "onLlmEnd",
      { msg: assistant, durationMs: llmDurationMs },
      this._ctx,
    );
    this._flushSystemMessages(lleOut.systemMessages);
    this._messages.push(assistant);

    // Context overflow 观测点（docs/09 §3.6）。pi-ai 把「越界」表达成两种 resolve 出的终态：
    //   - stopReason==="length"：输出/窗口被模型截断（无歧义，必是 overflow）。
    //   - stopReason==="error" + errorMessage 命中 overflow 文案（provider 把 context-overflow 当
    //     API error 报回，pi-ai 转成 error 流事件 → result() resolve 出 stopReason==="error"）。
    // 内核只「发事件」，不再当普通 done 静默吞掉；压缩/重启策略全在插件（ctx.abort("compaction:...")
    // → compactRestartFresh 重启 fresh，或 transformMessagesBeforeLlm 改写消息）。注意 fire 不改控制流：
    // 没策略 abort 时这条 length/error assistant 仍以 reason:"done" 收尾。connection/config 类 sync-throw
    //（provider 未注册）走上面的 catch，不是 overflow，不在此分类。
    const overflow = this._detectOverflow(assistant);
    if (overflow) {
      const coOut = await this._dispatcher.fireEvent(
        "onContextOverflow",
        overflow,
        this._ctx,
      );
      this._flushSystemMessages(coOut.systemMessages);
    }

    return assistant;
  }

  /**
   * 把一条 resolve 出的 assistant 判定为 context-overflow（docs/09 §3.6），返回 fire 用的事件输入或
   * null。"length" 无歧义；"error" 经 `_isContextOverflow`（默认启发式，可选项覆盖）匹配 errorMessage。
   */
  private _detectOverflow(
    assistant: AssistantMessage,
  ): ContextOverflowInput | null {
    const base = {
      turnIdx: this._ctx.turnIdx,
      messageCount: this._messages.length,
    };
    if (assistant.stopReason === "length") {
      return { ...base, stopReason: "length" };
    }
    if (assistant.stopReason === "error") {
      const errorMessage = assistant.errorMessage ?? "";
      if (this._isContextOverflow(errorMessage)) {
        return { ...base, stopReason: "error", errorMessage };
      }
    }
    return null;
  }

  /**
   * Phase 2 / 3：tool batch。
   *   - 提取 toolCalls
   *   - ToolExecutor 按 isConcurrencySafe 分批跑
   *   - 每个 result push 一条 toolResult message
   *   - newMessages 注入时拦截 toolResult/assistant role（防 tool 破坏对话不变量）
   */
  private async _phaseToolBatch(
    assistant: AssistantMessage,
  ): Promise<ToolExecResult[]> {
    const toolCalls = assistant.content.filter(
      (b): b is ToolCall => b.type === "toolCall",
    );
    if (toolCalls.length === 0) return [];

    const executor = new ToolExecutor({
      tools: this.tools,
      dispatcher: this._dispatcher,
      ctx: this._ctx,
      abortCtrl: this._abortCtrl,
      pushAttachment: (c, e) => this._pushAttachment(c, e),
      flushSystemMessages: (m) => this._flushSystemMessages(m),
    });
    const results = await executor.executeBatch(toolCalls);

    const toolResultsForTurn: ToolExecResult[] = [];
    for (const call of toolCalls) {
      const result = results.get(call.id);
      if (!result) continue;
      const trMsg: ToolResultMessage = {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: result.content,
        isError: result.isError ?? false,
        timestamp: Date.now(),
      };
      if (result.details !== undefined) {
        (trMsg as ToolResultMessage & { details?: unknown }).details =
          result.details;
      }
      this._messages.push(trMsg);
      if (result.newMessages) {
        for (const m of result.newMessages) {
          // 防御：tool 不能伪造 toolResult / assistant role 来破坏 conversation 完整性
          // user / system role 是可接受的注入（attachment 模式）
          if (m.role === "toolResult" || m.role === "assistant") {
            await this._dispatcher.fireError(
              {
                phase: "tool",
                err: new Error(
                  `tool "${call.name}" attempted to inject ${m.role} message via newMessages — rejected (only user/system allowed)`,
                ),
                call,
              },
              this._ctx,
            );
            continue;
          }
          this._messages.push(m);
        }
      }
      toolResultsForTurn.push(result);
    }
    return toolResultsForTurn;
  }

  /**
   * Phase 3 / 3：onTurnEnd event。
   *   - flush systemMessages
   *   - push additionalContext attachments（下一 turn 的 LLM 看到）
   *   - 处理 continue=false（plugin 在 turn 边界主动中止 session）
   */
  private async _phaseTurnEnd(
    turnIdx: number,
    assistant: AssistantMessage,
    toolResults: ToolExecResult[],
  ): Promise<void> {
    const teOut = await this._dispatcher.fireEvent(
      "onTurnEnd",
      {
        turnIdx,
        assistantMessage: assistant,
        toolResults,
      },
      this._ctx,
    );
    this._flushSystemMessages(teOut.systemMessages);
    for (const c of teOut.additionalContexts) {
      this._pushAttachment(c, "onTurnEnd");
    }
    if (teOut.continue === false) {
      this._abortCtrl.abort(
        new Error(teOut.stopReason ?? "onTurnEnd continue=false"),
      );
    }
  }


  /* ────────────── Helpers ────────────── */

  private _pushAttachment(content: string, hookEvent: string): void {
    this._pendingAttachments.push(
      createAttachmentMessage({
        type: "hook_additional_context",
        content,
        hookEvent,
      }),
    );
  }

  private _flushSystemMessages(msgs: ReadonlyArray<string>): void {
    if (msgs.length === 0) return;
    for (const m of msgs) {
      this._consoleSink(m, {
        sessionId: this.id,
        turnIdx: this._ctx.turnIdx,
      });
    }
  }
}

/* ────────────── 模块级 helpers ────────────── */

// findToolByName 移到 tool-executor.ts，从这里 re-export 保持向后兼容
export { findToolByName } from "./tool-executor.js";

/**
 * 把 kernel-only 字段去掉再发给 pi-ai。
 * `details` 是本地 trace metadata，不能进入模型上下文。
 * 优化：先 scan，只有真有字段要剥离时才走 map。
 */
function stripHarnessOnlyFields(messages: ReadonlyArray<Message>): Message[] {
  let hasHarnessOnlyFields = false;
  for (const m of messages) {
    if (
      (m as { _meta?: unknown })._meta !== undefined ||
      (m as { details?: unknown }).details !== undefined
    ) {
      hasHarnessOnlyFields = true;
      break;
    }
  }
  if (!hasHarnessOnlyFields) return messages.slice();

  return messages.map((m) => {
    if (
      (m as { _meta?: unknown })._meta === undefined &&
      (m as { details?: unknown }).details === undefined
    ) {
      return m;
    }
    const copy = { ...m } as Message & { _meta?: unknown; details?: unknown };
    delete copy._meta;
    delete copy.details;
    return copy;
  });
}

/**
 * 把 external AbortSignal 桥接到 internal AbortController。
 * 返回 cleanup 函数（卸载 listener，避免 long-lived signal 持有 controller 引用）。
 */
function forwardSignal(
  external: AbortSignal | undefined,
  internal: AbortController,
): () => void {
  if (!external) return () => {};
  if (external.aborted) {
    internal.abort(external.reason);
    return () => {};
  }
  const handler = (): void => internal.abort(external.reason);
  external.addEventListener("abort", handler, { once: true });
  return () => external.removeEventListener("abort", handler);
}
