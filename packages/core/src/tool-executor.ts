/**
 * ToolExecutor —— 把一组 toolCall 跑完，按 `isConcurrencySafe` 分批。
 *
 * 从 session.ts 抽出来的内聚单元。一个 turn 一个 ToolExecutor instance（每 turn 重新
 * inject 依赖；不持有跨 turn 状态）。
 *
 * 单 call 流程：
 *   1. PreToolUse decision（顺序短路）
 *      - continue=false → flush systemMessage + abort + 返 isError result
 *      - decision="deny" → push attachment + flush systemMessage + 返 isError result
 *      - 否则：allow 路径也 push 累积的 additionalContext
 *   2. validateToolCall（pi-ai 校验；alias 路由由 ToolExecutor 走 canonical name）
 *   3. tool.execute()（被 around chain wrapToolExec 包裹）
 *   4. PostToolUse event（push additionalContext + flush systemMessage）
 *   5. 应用 updatedToolOutput（如果有）
 *
 * 注意：依赖 Node.js 单线程语义—— `Promise.all(safeBatch.map(...))` 并发触发 hook，
 * `ctx.state` 写竞态由 plugin 自己负责（约定走 push-to-queue 不直接 mutate 共享 key）。
 */

import {
  validateToolCall,
  type ToolCall,
} from "@mariozechner/pi-ai";
import type { HookContextImpl } from "./context.js";
import type { HookDispatcher } from "./dispatcher.js";
import type { ToolExecResult } from "./hook.js";
import type { HarnessTool } from "./types.js";

export interface ToolExecutorDeps {
  tools: ReadonlyArray<HarnessTool>;
  dispatcher: HookDispatcher;
  ctx: HookContextImpl;
  /** Kernel 的 abort controller。`signal.aborted` 用作 break 信号；`abort()` 由 PreToolUse continue=false 触发。 */
  abortCtrl: AbortController;
  /** Kernel 提供的 attachment push 回调。 */
  pushAttachment: (content: string, hookEvent: string) => void;
  /** Kernel 提供的 systemMessage emit 回调。 */
  flushSystemMessages: (msgs: ReadonlyArray<string>) => void;
}

export class ToolExecutor {
  constructor(private readonly deps: ToolExecutorDeps) {}

  /**
   * 跑一批 toolCall。返回 Map<toolCallId, result>。
   * 按 `isConcurrencySafe` 分批：safe 批 Promise.all 并发，unsafe 批 await 顺序。
   */
  async executeBatch(
    toolCalls: ToolCall[],
  ): Promise<Map<string, ToolExecResult>> {
    const safeBatch: ToolCall[] = [];
    const sequential: ToolCall[] = [];

    for (const call of toolCalls) {
      const tool = findToolByName(this.deps.tools, call.name);
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
      this._executeOne(call).then((res) => {
        results.set(call.id, res);
      });

    await Promise.all(safeBatch.map(executeOne));
    for (const call of sequential) {
      if (this.deps.abortCtrl.signal.aborted) break;
      await executeOne(call);
    }

    return results;
  }

  private async _executeOne(call: ToolCall): Promise<ToolExecResult> {
    const { tools, dispatcher, ctx, abortCtrl, pushAttachment, flushSystemMessages } = this.deps;

    if (abortCtrl.signal.aborted) {
      return {
        content: [{ type: "text", text: "aborted before execution" }],
        isError: true,
      };
    }

    const tool = findToolByName(tools, call.name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `tool not found: ${call.name}` }],
        isError: true,
      };
    }

    // ── PreToolUse decision ──
    const ptOut = await dispatcher.fireDecision(
      "onPreToolUse",
      { call, tool },
      ctx,
    );

    if (ptOut?.continue === false) {
      // 终止 session：flush systemMessage 让 operator 看到 halt 原因。
      // 不 push additionalContext —— turn 后会立刻 abort 退出，_pendingAttachments
      // 在 _runInternal 入口被清空，push 进去是 dead write。
      if (ptOut.systemMessage) flushSystemMessages([ptOut.systemMessage]);
      abortCtrl.abort(
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
      // 对称地保留 dispatcher 聚合的 context 和 systemMessage
      if (ptOut.additionalContext) {
        pushAttachment(ptOut.additionalContext, "onPreToolUse");
      }
      if (ptOut.systemMessage) flushSystemMessages([ptOut.systemMessage]);
      return {
        content: [{ type: "text", text: ptOut.reason ?? "denied by hook" }],
        isError: true,
      };
    }

    // additionalContext 可以在 allow 路径也被聚合（dispatcher 已聚合多 hook）
    if (ptOut?.additionalContext) {
      pushAttachment(ptOut.additionalContext, "onPreToolUse");
    }

    const args = ptOut?.updatedInput ?? call.arguments;

    // ── validate (pi-ai 用 canonical name，alias 路由由 ToolExecutor 负责) ──
    const piTools = tools.map((t) => ({
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
      await dispatcher.fireError(
        {
          phase: "tool",
          err: err instanceof Error ? err : new Error(String(err)),
          call,
        },
        ctx,
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

    // ── execute (around chain) ──
    const t0 = Date.now();
    let rawResult: ToolExecResult;
    try {
      const wrapped = dispatcher.buildWrapToolExec(
        call,
        ctx,
        () => tool.execute(args, ctx, abortCtrl.signal),
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
      await dispatcher.fireError(
        {
          phase: "tool",
          err: err instanceof Error ? err : new Error(String(err)),
          call,
        },
        ctx,
      );
    }
    const durationMs = Date.now() - t0;

    // ── PostToolUse ──
    const postOut = await dispatcher.fireEvent(
      "onPostToolUse",
      { call, result: rawResult, durationMs },
      ctx,
    );
    flushSystemMessages(postOut.systemMessages);
    for (const c of postOut.additionalContexts) {
      pushAttachment(c, "onPostToolUse");
    }

    return postOut.updatedToolOutput ?? rawResult;
  }
}

/**
 * Tool name 解析：先按 canonical name 匹配，再走 aliases。
 * 跟 session.ts 的 findToolByName 是同一份语义（导出公共版本，session 也复用）。
 */
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
