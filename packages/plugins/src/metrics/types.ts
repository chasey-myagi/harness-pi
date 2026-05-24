/**
 * Metric event types. Core kinds shipped by default; user can extend via module
 * augmentation of `UserMetricKinds`.
 */

export type CoreMetricKind =
  | "session.started"
  | "session.ended"
  | "turn.started"
  | "turn.ended"
  | "llm.called"
  | "tool.called"
  | "error.observed"
  | "hook.failed";

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface UserMetricKinds {
  // 用户扩展：
  // declare module "@harness-pi/plugins" {
  //   interface UserMetricKinds {
  //     "my-domain.event": { foo: string };
  //   }
  // }
}

export type MetricKind = CoreMetricKind | Extract<keyof UserMetricKinds, string>;

export interface MetricEvent {
  kind: MetricKind | (string & {});
  sessionId?: string;
  turnIdx?: number;
  ts: number;
  /** payload —— shape varies per kind；no schema enforced at runtime */
  [k: string]: unknown;
}

export interface SinkStats {
  enqueued: number;
  flushed: number;
  failed: number;
  dropped: number;
  pending: number;
  lastFlushTs: number;
  lastError: string | null;
}

export interface MetricsSink {
  /** 同步 enqueue，纳秒级。Sink 内部决定何时刷。 */
  enqueue(event: MetricEvent): void;
  /** 主动 flush（测试 / shutdown）。 */
  flush?(): Promise<void>;
  /** 自身健康指标。 */
  stats?(): SinkStats;
  /** 资源清理（关 stream / 关 connection pool）。 */
  close?(): Promise<void>;
}
