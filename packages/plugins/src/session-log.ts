/**
 * Session log —— 每个 session 写一份 NDJSON 日志，复盘 / 调试 / 重放用。
 *
 * Backpressure：stream.write 返 false 时不再 enqueue，避免 burst 写入 OOM。
 *
 * 详见 docs/05-plugins.md §5.5。
 */

import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import type { Hook, HookContext } from "@harness-pi/core";

export type SessionLogEventName =
  | "sessionStart"
  | "sessionEnd"
  | "turnStart"
  | "turnEnd"
  | "llmEnd"
  | "preToolUse"
  | "postToolUse"
  | "error";

export interface SessionLogOptions {
  /** 文件存放目录。会自动 mkdir -p。 */
  dir: string;
  /** 哪些 event 写入。默认全部。 */
  events?: SessionLogEventName[];
  /** 文件名（默认 `<sessionId>.ndjson`）。 */
  filenameFor?: (sessionId: string) => string;
}

const KEY_STREAM = "session-log.stream";

interface StreamState {
  stream: WriteStream;
  backpressured: boolean;
  dropped: number;
}

/** 业务 / debug 用：返回当前 session 因 backpressure 丢弃的 event 数。 */
export function getSessionLogDropped(ctx: import("@harness-pi/core").HookContext): number {
  const st = ctx.state.get(KEY_STREAM) as StreamState | undefined;
  return st?.dropped ?? 0;
}

export function sessionLog(opts: SessionLogOptions): Hook {
  const includes = (e: SessionLogEventName): boolean =>
    !opts.events || opts.events.includes(e);
  const filenameFor =
    opts.filenameFor ?? ((id: string) => `${id}.ndjson`);

  const write = (
    ctx: HookContext,
    event: SessionLogEventName,
    payload: Record<string, unknown>,
  ): void => {
    const st = ctx.state.get(KEY_STREAM) as StreamState | undefined;
    if (!st || st.stream.writableEnded || st.stream.destroyed) return;
    if (st.backpressured) {
      st.dropped++;
      return;
    }
    try {
      const ok = st.stream.write(
        JSON.stringify({
          ts: Date.now(),
          turnIdx: ctx.turnIdx,
          event,
          ...payload,
        }) + "\n",
      );
      if (!ok) {
        st.backpressured = true;
        st.stream.once("drain", () => {
          st.backpressured = false;
        });
      }
    } catch {
      /* swallow */
    }
  };

  return {
    name: "session-log",
    internal: true,

    onSessionStart(input, ctx) {
      try {
        mkdirSync(opts.dir, { recursive: true });
      } catch {
        /* may already exist */
      }
      const path = join(opts.dir, filenameFor(ctx.sessionId));
      const stream = createWriteStream(path, { flags: "a" });
      const state: StreamState = { stream, backpressured: false, dropped: 0 };
      stream.on("error", () => {
        /* swallow; record-stat would be nice but plugin scope */
      });
      ctx.state.set(KEY_STREAM, state);
      if (includes("sessionStart")) {
        write(ctx, "sessionStart", { source: input.source });
      }
    },

    onSessionEnd(input, ctx) {
      if (includes("sessionEnd")) {
        write(ctx, "sessionEnd", {
          turns: input.turns,
          reason: input.reason,
        });
      }
      const st = ctx.state.get(KEY_STREAM) as StreamState | undefined;
      st?.stream.end();
      ctx.state.delete(KEY_STREAM);
    },

    onTurnStart(input, ctx) {
      if (includes("turnStart")) {
        write(ctx, "turnStart", { turnIdx: input.turnIdx });
      }
    },
    onTurnEnd(input, ctx) {
      if (includes("turnEnd")) {
        write(ctx, "turnEnd", {
          turnIdx: input.turnIdx,
          toolResultsCount: input.toolResults.length,
          stopReason: input.assistantMessage.stopReason,
        });
      }
    },
    onLlmEnd(input, ctx) {
      if (includes("llmEnd")) {
        write(ctx, "llmEnd", {
          durationMs: input.durationMs,
          tokensInput: input.msg.usage.input,
          tokensOutput: input.msg.usage.output,
          stopReason: input.msg.stopReason,
        });
      }
    },
    onPreToolUse(input, ctx) {
      if (includes("preToolUse")) {
        write(ctx, "preToolUse", {
          tool: input.call.name,
          args: input.call.arguments,
        });
      }
    },
    onPostToolUse(input, ctx) {
      if (includes("postToolUse")) {
        write(ctx, "postToolUse", {
          tool: input.call.name,
          durationMs: input.durationMs,
          isError: input.result.isError ?? false,
        });
      }
    },
    onError(input, ctx) {
      if (includes("error")) {
        write(ctx, "error", {
          phase: input.phase,
          message: input.err.message,
          ...(input.hookName ? { hookName: input.hookName } : {}),
        });
      }
    },
  };
}
