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
  complete,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type Api,
  type ToolCall,
  type ToolResultMessage,
} from "@mariozechner/pi-ai";

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
import { HookContextImpl, getKernelInternals } from "./context.js";
import {
  HookDispatcher,
  verifyHookDependencies,
  type HookFailureSink,
  type HookDependencyWarning,
} from "./dispatcher.js";
import type { Hook, LogLevel, SessionConfigView, ToolExecResult } from "./hook.js";
import { ToolExecutor, findToolByName } from "./tool-executor.js";
import { createAttachmentMessage } from "./types.js";
import type { HarnessTool } from "./types.js";
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
  /** Hook 失败上报通道（metrics plugin 通常 hook 进来）。 */
  hookFailureSink?: HookFailureSink;
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

export interface RunSummary {
  turns: number;
  /** 同 session 内 onSessionEnd 触发续跑的次数。 */
  continuations: number;
  reason:
    | "done"
    | "max_turns"
    | "aborted"
    | "error"
    | "max_continuations";
  error?: Error;
  abortReason?: string;
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

  private _messages: Message[];
  private _hooks: Hook[];
  private _dispatcher: HookDispatcher;
  private readonly _hookFailureSink: HookFailureSink | undefined;
  private _ctx: HookContextImpl;
  /** 单 AbortController 唯一的 abort 真相源。Reason 通过 signal.reason 传播。 */
  private _abortCtrl: AbortController;
  private _pendingAttachments: Message[] = [];
  private _lastTurnError: Error | null = null;
  private _running = false;
  private _consoleSink: (
    msg: string,
    ctx: { sessionId: string; turnIdx: number },
  ) => void;

  constructor(opts: AgentSessionOptions) {
    this.id = randomUUID();
    this.model = opts.model;
    this.tools = opts.tools;
    this.systemPrompt = opts.systemPrompt ?? "";
    this.maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
    this.maxContinuations = opts.maxContinuations ?? DEFAULT_MAX_CONTINUATIONS;

    this._messages = opts.initialMessages ? [...opts.initialMessages] : [];
    this._hooks = [...(opts.hooks ?? [])];
    this._hookFailureSink = opts.hookFailureSink;
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
          };
          const reasonText =
            upsOut.stopReason ??
            upsOut.reason ??
            "onUserPromptSubmit halted";
          summary.abortReason = reasonText;
          await this._fireSessionEnd(0, 0, summary.reason);
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
      return this._buildSummary(turnIdx, continuations, reason);
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

  private _buildSummary(
    turns: number,
    continuations: number,
    reason: RunSummary["reason"],
  ): RunSummary {
    const summary: RunSummary = { turns, continuations, reason };
    if (this._lastTurnError) summary.error = this._lastTurnError;
    if (this._abortCtrl.signal.aborted) {
      const r = this._abortCtrl.signal.reason;
      summary.abortReason = r instanceof Error ? r.message : String(r ?? "aborted");
    }
    return summary;
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

      if (outcome === "done") return { turnIdx, reason: "done" };
      if (outcome === "abort") return { turnIdx, reason: "aborted" };
      if (outcome === "error") return { turnIdx, reason: "error" };
    }
    return { turnIdx, reason: "max_turns" };
  }

  /**
   * 单 turn 的完整逻辑。3 个 phase 串起来，外层包 wrapTurn around chain。
   * 每个 phase 做一件事，方便 reviewer 改某一阶段不动其他 phase 的缩进。
   *
   *   onTurnStart event → wrapTurn[ _phaseLlmCall → _phaseToolBatch → _phaseTurnEnd ]
   */
  private async _runOneTurn(turnIdx: number): Promise<TurnOutcome> {
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
      messages: stripAttachmentMeta(transformed),
      tools: piTools,
      ...(sysPrompt ? { systemPrompt: sysPrompt } : {}),
    };

    const t0 = Date.now();
    let assistant: AssistantMessage;
    try {
      assistant = await complete(this.model, context, {
        signal: this._abortCtrl.signal,
      });
    } catch (err) {
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

    const lleOut = await this._dispatcher.fireEvent(
      "onLlmEnd",
      { msg: assistant, durationMs: llmDurationMs },
      this._ctx,
    );
    this._flushSystemMessages(lleOut.systemMessages);
    this._messages.push(assistant);

    return assistant;
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
 * 把 attachment message 的 `_meta` 字段去掉再发给 pi-ai。
 * 优化：先 scan，只有真有 `_meta` 才走 map（绝大多数 turn messages 没有 attachment）。
 */
function stripAttachmentMeta(messages: ReadonlyArray<Message>): Message[] {
  let hasMeta = false;
  for (const m of messages) {
    if ((m as { _meta?: unknown })._meta !== undefined) {
      hasMeta = true;
      break;
    }
  }
  if (!hasMeta) return messages.slice();

  return messages.map((m) => {
    if ((m as { _meta?: unknown })._meta === undefined) return m;
    const copy = { ...m } as Message & { _meta?: unknown };
    delete copy._meta;
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
