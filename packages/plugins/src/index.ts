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

export { sessionLog, getSessionLogDropped } from "./session-log.js";
export type {
  SessionLogOptions,
  SessionLogEventName,
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

export {
  metrics,
  getMetricsSink,
  emitMetric,
  MemorySink,
  NdjsonFileSink,
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
} from "./metrics/all.js";

export { costTracker, getCostStats } from "./cost-tracker.js";
export type { CostTrackerOptions, CostStats } from "./cost-tracker.js";

export { tokenBudget } from "./token-budget.js";
export type { TokenBudgetOptions } from "./token-budget.js";

export { repeatedCallGuard } from "./repeated-call-guard.js";
export type { RepeatedCallGuardOptions } from "./repeated-call-guard.js";
