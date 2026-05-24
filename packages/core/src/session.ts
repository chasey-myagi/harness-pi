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
  validateToolCall,
} from "@mariozechner/pi-ai";
import { HookContextImpl } from "./context.js";
import { HookDispatcher, type HookFailureSink } from "./dispatcher.js";
import type { Hook, ToolExecResult } from "./hook.js";
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

    this._abortCtrl = new AbortController();
    this._ctx = new HookContextImpl({
      sessionId: this.id,
      initialSignal: this._abortCtrl.signal,
      messages: this._messages,
      onAppendMessage: (msg) => this._messages.push(msg),
      onAbort: (reason) => this._abortCtrl.abort(new Error(reason)),
    });
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
    return this;
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
    this._ctx._setSignal(this._abortCtrl.signal);
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

      this._ctx._setTurnIdx(turnIdx);
      const outcome = await this._runOneTurn(turnIdx);
      turnIdx++;

      if (outcome === "done") return { turnIdx, reason: "done" };
      if (outcome === "abort") return { turnIdx, reason: "aborted" };
      if (outcome === "error") return { turnIdx, reason: "error" };
    }
    return { turnIdx, reason: "max_turns" };
  }

  /**
   * 单 turn 的完整逻辑。turn 内：onTurnStart → wrapTurn(LLM + tools) → onTurnEnd。
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
        turnOut.assistant = assistant;

        const lleOut = await this._dispatcher.fireEvent(
          "onLlmEnd",
          { msg: assistant, durationMs: llmDurationMs },
          this._ctx,
        );
        this._flushSystemMessages(lleOut.systemMessages);

        this._messages.push(assistant);

        const toolCalls = assistant.content.filter(
          (b): b is ToolCall => b.type === "toolCall",
        );

        const toolResultsForTurn: ToolExecResult[] = [];

        if (toolCalls.length > 0) {
          const results = await this._executeToolCalls(toolCalls);
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
        }

        const teOut = await this._dispatcher.fireEvent(
          "onTurnEnd",
          {
            turnIdx,
            assistantMessage: assistant,
            toolResults: toolResultsForTurn,
          },
          this._ctx,
        );
        this._flushSystemMessages(teOut.systemMessages);
        // additionalContext from onTurnEnd → 下一 turn 的 LLM call 看到
        for (const c of teOut.additionalContexts) {
          this._pushAttachment(c, "onTurnEnd");
        }
        if (teOut.continue === false) {
          this._abortCtrl.abort(
            new Error(teOut.stopReason ?? "onTurnEnd continue=false"),
          );
        }
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
   * 把 tool calls 按 isConcurrencySafe 分批并执行。
   * 返回 Map<toolCallId, ToolExecResult>。
   * 注意：依赖 Node.js 单线程语义——`Promise.all(safeBatch.map(...))` 并发触发 hook，
   * `ctx.state` 写竞态由 plugin 自己负责（约定走 push-to-queue 不直接 mutate 共享 key）。
   */
  private async _executeToolCalls(
    toolCalls: ToolCall[],
  ): Promise<Map<string, ToolExecResult>> {
    const safeBatch: ToolCall[] = [];
    const sequential: ToolCall[] = [];

    for (const call of toolCalls) {
      const tool = findToolByName(this.tools, call.name);
      let safe = false;
      try {
        safe = !!tool?.isConcurrencySafe?.(call.arguments);
      } catch {
        safe = false;
      }
      (safe ? safeBatch : sequential).push(call);
    }

    const results = new Map<string, ToolExecResult>();
    const executeOne = (call: ToolCall): Promise<void> =>
      this._executeOneToolCall(call).then((res) => {
        results.set(call.id, res);
      });

    await Promise.all(safeBatch.map(executeOne));
    for (const call of sequential) {
      if (this._abortCtrl.signal.aborted) break;
      await executeOne(call);
    }

    return results;
  }

  private async _executeOneToolCall(call: ToolCall): Promise<ToolExecResult> {
    if (this._abortCtrl.signal.aborted) {
      return {
        content: [{ type: "text", text: "aborted before execution" }],
        isError: true,
      };
    }

    const tool = findToolByName(this.tools, call.name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `tool not found: ${call.name}` }],
        isError: true,
      };
    }

    // PreToolUse decision
    const ptOut = await this._dispatcher.fireDecision(
      "onPreToolUse",
      { call, tool },
      this._ctx,
    );

    if (ptOut?.continue === false) {
      // 终止 session：flush systemMessage 让 operator 看到 halt 原因。
      // 不 push additionalContext —— turn 后会立刻 abort 退出，_pendingAttachments
      // 在 _runInternal 入口被清空（line ~213），push 进去是 dead write。
      if (ptOut.systemMessage) {
        this._flushSystemMessages([ptOut.systemMessage]);
      }
      this._abortCtrl.abort(
        new Error(ptOut.stopReason ?? "onPreToolUse continue=false"),
      );
      return {
        content: [
          { type: "text", text: ptOut.stopReason ?? "halted by hook" },
        ],
        isError: true,
      };
    }

    if (ptOut?.decision === "deny") {
      // 对称地保留 dispatcher 聚合的 context 和 systemMessage（跟 continue=false 路径一致）
      if (ptOut.additionalContext) {
        this._pushAttachment(ptOut.additionalContext, "onPreToolUse");
      }
      if (ptOut.systemMessage) {
        this._flushSystemMessages([ptOut.systemMessage]);
      }
      return {
        content: [{ type: "text", text: ptOut.reason ?? "denied by hook" }],
        isError: true,
      };
    }

    // additionalContext 可以在 allow 路径也被聚合（dispatcher 已聚合多 hook）
    if (ptOut?.additionalContext) {
      this._pushAttachment(ptOut.additionalContext, "onPreToolUse");
    }

    const args = ptOut?.updatedInput ?? call.arguments;

    // validate (pi-ai 用 canonical name，alias 路由由 kernel 负责)
    const piTools = this.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
    try {
      validateToolCall(piTools, {
        ...call,
        name: tool.name,
        arguments: args,
      });
    } catch (err) {
      await this._dispatcher.fireError(
        {
          phase: "tool",
          err: err instanceof Error ? err : new Error(String(err)),
          call,
        },
        this._ctx,
      );
      return {
        content: [
          {
            type: "text",
            text: err instanceof Error ? err.message : String(err),
          },
        ],
        isError: true,
      };
    }

    // execute (around chain)
    const t0 = Date.now();
    let rawResult: ToolExecResult;
    try {
      const wrapped = this._dispatcher.buildWrapToolExec(
        call,
        this._ctx,
        () => tool.execute(args, this._ctx, this._abortCtrl.signal),
      );
      rawResult = await wrapped();
    } catch (err) {
      rawResult = {
        content: [
          {
            type: "text",
            text: err instanceof Error ? err.message : String(err),
          },
        ],
        isError: true,
      };
      await this._dispatcher.fireError(
        {
          phase: "tool",
          err: err instanceof Error ? err : new Error(String(err)),
          call,
        },
        this._ctx,
      );
    }
    const durationMs = Date.now() - t0;

    // PostToolUse
    const postOut = await this._dispatcher.fireEvent(
      "onPostToolUse",
      { call, result: rawResult, durationMs },
      this._ctx,
    );
    this._flushSystemMessages(postOut.systemMessages);
    for (const c of postOut.additionalContexts) {
      this._pushAttachment(c, "onPostToolUse");
    }

    return postOut.updatedToolOutput ?? rawResult;
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

export function findToolByName(
  tools: ReadonlyArray<HarnessTool>,
  name: string,
): HarnessTool | undefined {
  for (const t of tools) {
    if (t.name === name) return t;
    if (t.aliases?.includes(name)) return t;
  }
  return undefined;
}

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
