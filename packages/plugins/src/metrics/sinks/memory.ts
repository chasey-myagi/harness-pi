/**
 * MemorySink —— 默认零依赖 sink，把 events 留在内存。
 * 测试 / debug / 短任务用；不持久化。
 *
 * SinkStats 语义注意：MemorySink 不"刷"——`flushed === enqueued - dropped`，
 * `lastFlushTs` 是最后一次 enqueue 的时间戳（不是真的 flush，但 dashboard 读起来一致）。
 */

import type { MetricEvent, MetricsSink, SinkStats } from "../types.js";

export interface MemorySinkOptions {
  /** 超过即丢最老的；默认无限。 */
  maxEvents?: number;
}

export class MemorySink implements MetricsSink {
  private events: MetricEvent[] = [];
  private _stats: SinkStats = {
    enqueued: 0,
    flushed: 0,
    failed: 0,
    dropped: 0,
    pending: 0,
    lastFlushTs: 0,
    lastError: null,
  };

  constructor(private readonly opts: MemorySinkOptions = {}) {}

  enqueue(event: MetricEvent): void {
    this.events.push(event);
    this._stats.enqueued++;
    this._stats.lastFlushTs = Date.now();
    if (
      this.opts.maxEvents !== undefined &&
      this.events.length > this.opts.maxEvents
    ) {
      const drop = this.events.length - this.opts.maxEvents;
      this.events.splice(0, drop);
      this._stats.dropped += drop;
    }
    // MemorySink 不真的 flush；用 enqueued - dropped 表示"留在内存里"
    this._stats.flushed = this._stats.enqueued - this._stats.dropped;
  }

  snapshot(): ReadonlyArray<MetricEvent> {
    return [...this.events];
  }

  filter(predicate: (e: MetricEvent) => boolean): ReadonlyArray<MetricEvent> {
    return this.events.filter(predicate);
  }

  clear(): void {
    this.events = [];
  }

  stats(): SinkStats {
    return { ...this._stats, pending: 0 };
  }

  async flush(): Promise<void> {
    /* no-op */
  }

  async close(): Promise<void> {
    this.events = [];
  }
}
