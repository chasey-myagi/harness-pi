/**
 * Metrics plugin —— 把 hook event 翻译成 MetricEvent push 给 sink。
 *
 * 详见 docs/05-plugins.md §5.9。
 */

import type { Hook, HookContext } from "@harness-pi/core";
import type { MetricEvent, MetricKind, MetricsSink } from "./types.js";

export interface MetricsOptions {
  sink: MetricsSink;
  /** 只 emit 这些 kind。undefined = 全部。 */
  kinds?: MetricKind[];
  /**
   * 该 session 归属的 **work-item id**（docs/09 §4.4，#11）。给定后，本插件 emit 的每条
   * MetricEvent 都带上 `workItemId`，供 sink / 聚合器按 work-item 归账（cost / token / tool 调用）。
   * **domain 中性**——不是 `questionId`；编排层一 session 一 work-item 时传入，业务层自行映射。
   */
  workItemId?: string;
}

declare module "@harness-pi/core" {
  interface HookStateRegistry {
    "metrics.sink": MetricsSink;
  }
}

const KEY_SINK = "metrics.sink" as const;

export function metrics(opts: MetricsOptions): Hook {
  const include = (k: MetricKind): boolean =>
    !opts.kinds || opts.kinds.includes(k);

  const emit = (kind: MetricKind, payload: Record<string, unknown>): void => {
    opts.sink.enqueue({
      kind,
      ts: Date.now(),
      // workItemId 戳在 payload 之前展开：若将来某 kind 的 payload 自带 workItemId，让 payload 优先
      //（更贴近事件真实归属），这是有意的优先级——当前无此 kind。
      ...(opts.workItemId !== undefined ? { workItemId: opts.workItemId } : {}),
      ...payload,
    });
  };

  return {
    name: "metrics",
    internal: true,
    timeout: 50,

    onSessionStart(input, ctx) {
      ctx.state.set(KEY_SINK, opts.sink);
      if (include("session.started")) {
        emit("session.started", {
          sessionId: ctx.sessionId,
          source: input.source,
        });
      }
    },

    onSessionEnd(input, ctx) {
      if (include("session.ended")) {
        emit("session.ended", {
          sessionId: ctx.sessionId,
          turns: input.turns,
          reason: input.reason,
        });
      }
    },

    onTurnStart(input, ctx) {
      if (include("turn.started")) {
        emit("turn.started", {
          sessionId: ctx.sessionId,
          turnIdx: input.turnIdx,
        });
      }
    },

    onTurnEnd(input, ctx) {
      if (include("turn.ended")) {
        emit("turn.ended", {
          sessionId: ctx.sessionId,
          turnIdx: input.turnIdx,
          toolResultsCount: input.toolResults.length,
          stopReason: input.assistantMessage.stopReason,
        });
      }
    },

    onLlmEnd(input, ctx) {
      if (include("llm.called")) {
        emit("llm.called", {
          sessionId: ctx.sessionId,
          turnIdx: ctx.turnIdx,
          durationMs: input.durationMs,
          stopReason: input.msg.stopReason,
          model: input.msg.model,
          tokensInput: input.msg.usage.input,
          tokensOutput: input.msg.usage.output,
          tokensCacheRead: input.msg.usage.cacheRead,
        });
      }
    },

    onPostToolUse(input, ctx) {
      if (include("tool.called")) {
        emit("tool.called", {
          sessionId: ctx.sessionId,
          turnIdx: ctx.turnIdx,
          toolName: input.call.name,
          durationMs: input.durationMs,
          isError: input.result.isError ?? false,
        });
      }
    },

    onError(input, ctx) {
      if (include("error.observed")) {
        emit("error.observed", {
          sessionId: ctx.sessionId,
          turnIdx: ctx.turnIdx,
          phase: input.phase,
          message: input.err.message,
          ...(input.hookName ? { hookName: input.hookName } : {}),
        });
      }
    },
  };
}

/** 业务代码 / 其他 plugin 拿 sink 自己 emit 自定义 kind。 */
export function getMetricsSink(ctx: HookContext): MetricsSink | undefined {
  return ctx.state.get(KEY_SINK);
}

/** Emit 一个事件，如果 ctx 里有 sink。 */
export function emitMetric(ctx: HookContext, event: MetricEvent): void {
  const sink = getMetricsSink(ctx);
  if (!sink) return;
  sink.enqueue(event);
}

export { MemorySink } from "./sinks/memory.js";
export { NdjsonFileSink } from "./sinks/ndjson-file.js";
export { PostgresSink, POSTGRES_METRICS_SINK_DDL } from "./sinks/postgres.js";
export type { PostgresSinkOptions, PgClient } from "./sinks/postgres.js";
export { WorkItemAggregator } from "./sinks/work-item-aggregator.js";
export type {
  WorkItemRollup,
  WorkItemAggregatorOptions,
} from "./sinks/work-item-aggregator.js";
export { BatchingSink } from "./batching-sink.js";
export type { BatchingSinkOptions } from "./batching-sink.js";
export type { MetricEvent, MetricKind, MetricsSink, SinkStats } from "./types.js";
