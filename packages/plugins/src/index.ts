// 12 standard plugins
export { watchdog } from "./watchdog.js";
export type { WatchdogOptions } from "./watchdog.js";

export { trimHistory } from "./trim-history.js";
export type { TrimHistoryOptions } from "./trim-history.js";

export { emptyRunGuard } from "./empty-run-guard.js";
export type { EmptyRunGuardOptions } from "./empty-run-guard.js";

export {
  toolOutputBuffer,
  getToolOutputBuffer,
  RingBuffer,
} from "./tool-output-buffer.js";
export type {
  ToolOutputBufferOptions,
  BufferEntry,
} from "./tool-output-buffer.js";

export {
  sessionLog,
  getSessionLogDropped,
  getSessionLogStatus,
} from "./session-log.js";
export type {
  SessionLogOptions,
  SessionLogEventName,
  SessionLogStatus,
} from "./session-log.js";

export { systemReminder } from "./system-reminder.js";
export type {
  SystemReminderOptions,
  ReminderEvent,
} from "./system-reminder.js";

export { batchCounter } from "./batch-counter.js";
export type { BatchCounterOptions } from "./batch-counter.js";

export { leaseDecision } from "./lease-decision.js";
export type { LeaseDecisionOptions } from "./lease-decision.js";

export { compactSummarize } from "./compact-summarize.js";
export type { CompactSummarizeOptions } from "./compact-summarize.js";

export {
  autoCompaction,
  estimateTokensByChars,
  estimateRequestTokens,
  defaultTokenCounter,
  hybridTokenCounter,
} from "./auto-compaction.js";
export type {
  AutoCompactionOptions,
  RequestTokenInput,
  TokenCounter,
} from "./auto-compaction.js";

export { microcompact } from "./microcompact.js";
export type { MicrocompactOptions } from "./microcompact.js";

export { permissionGate } from "./permission-gate.js";
export type {
  PermissionGateOptions,
  PermissionRule,
  PermissionDecision,
  PermissionMatch,
} from "./permission-gate.js";

export {
  metrics,
  getMetricsSink,
  emitMetric,
  MemorySink,
  NdjsonFileSink,
  PostgresSink,
  POSTGRES_METRICS_SINK_DDL,
  WorkItemAggregator,
  BatchingSink,
} from "./metrics/index.js";
export type {
  MetricsOptions,
  BatchingSinkOptions,
  MetricEvent,
  MetricKind,
  MetricsSink,
  SinkStats,
  UserMetricKinds,
  CoreMetricKind,
  WorkItemRollup,
  WorkItemAggregatorOptions,
  PostgresSinkOptions,
  PgClient,
} from "./metrics/all.js";

export { costTracker, getCostStats } from "./cost-tracker.js";
export type { CostTrackerOptions, CostStats } from "./cost-tracker.js";

export {
  toolStats,
  getToolStats,
  estimateParallelSavings,
} from "./tool-stats.js";
export type {
  ToolStatsOptions,
  ToolStats,
  ToolStatsByTool,
  ToolSpan,
} from "./tool-stats.js";

export { tokenBudget } from "./token-budget.js";
export type { TokenBudgetOptions } from "./token-budget.js";

export { repeatedCallGuard } from "./repeated-call-guard.js";
export type { RepeatedCallGuardOptions } from "./repeated-call-guard.js";

export { deferredTools } from "./deferred-tools.js";
export type { DeferredToolsOptions } from "./deferred-tools.js";

export { toolSearch } from "./tool-search.js";
export type { ToolSearchOptions } from "./tool-search.js";

export { skills } from "./skills.js";
export type { SkillSpec, SkillsOptions } from "./skills.js";
