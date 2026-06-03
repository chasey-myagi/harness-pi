// Re-export everything from the metrics subsystem in one entry point — used by
// the package barrel index.ts so consumers can `import type { MetricEvent } from
// "@harness-pi/plugins"`.

export type {
  MetricEvent,
  MetricKind,
  MetricsSink,
  SinkStats,
  UserMetricKinds,
  CoreMetricKind,
} from "./types.js";
export type { BatchingSinkOptions } from "./batching-sink.js";
export type { MetricsOptions } from "./index.js";
export type {
  WorkItemRollup,
  WorkItemAggregatorOptions,
} from "./sinks/work-item-aggregator.js";
export type { PostgresSinkOptions, PgClient } from "./sinks/postgres.js";
