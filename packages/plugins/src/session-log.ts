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

interface StreamState {
  stream: WriteStream;
  backpressured: boolean;
  dropped: number;
  /** Phase 2 加：stream close / error 后置 true；后续 write 直接丢，不再等不可能到达的 drain。 */
  dead: boolean;
  /** 终态原因（debug / status 暴露）。 */
  deadReason?: string;
}

declare module "@harness-pi/core" {
  interface HookStateRegistry {
    "session-log.stream": StreamState;
  }
}

const KEY_STREAM = "session-log.stream" as const;

/** 业务 / debug 用：返回当前 session 因 backpressure 丢弃的 event 数。 */
export function getSessionLogDropped(ctx: import("@harness-pi/core").HookContext): number {
  const st = ctx.state.get(KEY_STREAM);
  return st?.dropped ?? 0;
}

/**
 * Phase 2 加：当前 stream 状态。
 *
 * - "ok"：可正常写入
 * - "backpressured"：临时写满，等 drain；新 event 被 drop
 * - "dead"：stream 已 close / error，永远不再写；新 event 也被 drop（不会再恢复）
 * - "absent"：本 plugin 未挂或 session 未开始
 *
 * "dead" 跟 "backpressured" 区分很重要：前者是终态，后者是瞬态。监控应当对 dead 报警。
 */
export type SessionLogStatus = "ok" | "backpressured" | "dead" | "absent";

export function getSessionLogStatus(
  ctx: import("@harness-pi/core").HookContext,
): { status: SessionLogStatus; dropped: number; deadReason?: string } {
  const st = ctx.state.get(KEY_STREAM);
  if (!st) return { status: "absent", dropped: 0 };
  const dropped = st.dropped;
  if (st.dead) {
    const out: { status: SessionLogStatus; dropped: number; deadReason?: string } = {
      status: "dead",
      dropped,
    };
    if (st.deadReason !== undefined) out.deadReason = st.deadReason;
    return out;
  }
  if (st.backpressured) return { status: "backpressured", dropped };
  return { status: "ok", dropped };
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
    const st = ctx.state.get(KEY_STREAM);
    if (!st) return;
    // dead 是终态，永远不再尝试 write（即使 writableEnded/destroyed 也归入 dead）
    if (st.dead || st.stream.writableEnded || st.stream.destroyed) {
      if (!st.dead) {
        st.dead = true;
        st.deadReason = st.deadReason ?? "stream already ended/destroyed";
      }
      st.dropped++;
      return;
    }
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
    } catch (err) {
      // write 抛错时（rare：通常 stream 已被 destroy）转 dead，不再继续尝试
      st.dead = true;
      st.deadReason = err instanceof Error ? err.message : String(err);
      st.dropped++;
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
      const state: StreamState = {
        stream,
        backpressured: false,
        dropped: 0,
        dead: false,
      };
      // 任一终态事件都把 stream 置 dead，后续 write 一律 drop，不等 drain（drain 永不到达）
      stream.on("error", (err) => {
        state.dead = true;
        state.deadReason = err instanceof Error ? err.message : String(err);
        ctx.log.warn("session-log: stream errored", {
          hook: "session-log",
          path,
          reason: state.deadReason,
        });
      });
      stream.on("close", () => {
        if (!state.dead) {
          state.dead = true;
          state.deadReason = state.deadReason ?? "stream closed";
        }
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
      const st = ctx.state.get(KEY_STREAM);
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
