/**
 * Abstract BatchingSink —— 通用 batching 模板。所有重 sink（NDJSON / Postgres / OTel）
 * 继承并实现 `write(batch)`。
 *
 * - enqueue 同步 push 到内存 buffer
 * - 每 batchSize 条或 flushIntervalMs 触发 flush
 * - flush 失败：events 重排队到 head（O(n) via 重建），重试；超过 bufferOverflow 丢最老的
 *
 * flush() 语义：返回的 promise resolve 时**至少**当前 buffer 的快照已经尝试写出。
 *   - 并发 flush() 调用复用同一个 in-flight Promise（避免双 write）。
 *   - 不保证 enqueue 完的"未来"事件也被刷——这是 fire-and-forget sink，不是 sync barrier。
 *
 * 详见 docs/07-adapters.md §3。
 */

import type { MetricEvent, MetricsSink, SinkStats } from "./types.js";

export interface BatchingSinkOptions {
  batchSize?: number;
  flushIntervalMs?: number;
  bufferOverflow?: number;
}

const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_FLUSH_INTERVAL_MS = 1000;
const DEFAULT_BUFFER_OVERFLOW = 5000;

export abstract class BatchingSink implements MetricsSink {
  protected buffer: MetricEvent[] = [];
  protected _stats: SinkStats = {
    enqueued: 0,
    flushed: 0,
    failed: 0,
    dropped: 0,
    pending: 0,
    lastFlushTs: 0,
    lastError: null,
  };

  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushPromise: Promise<void> | null = null;
  private closed = false;
  protected readonly cfg: Required<BatchingSinkOptions>;

  constructor(opts: BatchingSinkOptions = {}) {
    this.cfg = {
      batchSize: opts.batchSize ?? DEFAULT_BATCH_SIZE,
      flushIntervalMs: opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
      bufferOverflow: opts.bufferOverflow ?? DEFAULT_BUFFER_OVERFLOW,
    };
  }

  enqueue(event: MetricEvent): void {
    if (this.closed) return;
    this.buffer.push(event);
    this._stats.enqueued++;
    if (this.buffer.length >= this.cfg.batchSize) {
      void this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  async flush(): Promise<void> {
    if (this.flushPromise) {
      await this.flushPromise;
      return;
    }
    if (this.buffer.length === 0) return;
    this.flushPromise = (async () => {
      const batch = this.buffer.splice(0, this.buffer.length);
      try {
        await this.write(batch);
        this._stats.flushed += batch.length;
        this._stats.lastFlushTs = Date.now();
        this._stats.lastError = null;
      } catch (err) {
        this._stats.lastError =
          err instanceof Error ? err.message : String(err);
        // 记本次 write 失败的事件数（独立 invariant：累计 write 失败但已重排队的 events 计 failed）
        this._stats.failed += batch.length;
        // requeue at head, O(n) via rebuild (avoid unshift O(n²))
        this.buffer = batch.concat(this.buffer);
        if (this.buffer.length > this.cfg.bufferOverflow) {
          const overflow = this.buffer.length - this.cfg.bufferOverflow;
          this.buffer.splice(0, overflow);
          // dropped 是因为 overflow 真丢的数（已不在 buffer 也不会再被尝试）；
          // 不再重复累加 failed —— overflow 是 dropped 的子集场景
          this._stats.dropped += overflow;
        }
      } finally {
        this.flushPromise = null;
      }
    })();
    await this.flushPromise;
  }

  protected scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.cfg.flushIntervalMs);
    if (typeof (this.timer as { unref?: () => void }).unref === "function") {
      (this.timer as { unref: () => void }).unref();
    }
  }

  stats(): SinkStats {
    return { ...this._stats, pending: this.buffer.length };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Drain loop：close() 阻塞 enqueue，但已经在 buffer 的 + 在 in-flight flush 期间从其它路径
    // 漏进来的 events 必须全部刷掉。`closed=true` 保证 enqueue 不再追加。
    //
    // 逃生：write 永久失败时 (stream broken / 磁盘满 / network down)，buffer 永远 requeue 不空。
    // 检测 failed 计数增长就放弃 drain，把剩余 buffer 标 dropped，避免 close() 死锁进程。
    while (this.buffer.length > 0 || this.flushPromise) {
      const prevFailed = this._stats.failed;
      await this.flush();
      if (this._stats.failed > prevFailed && this.buffer.length > 0) {
        // 本轮 flush 失败 + buffer 还有东西 → 放弃，剩余计 dropped
        this._stats.dropped += this.buffer.length;
        this.buffer = [];
        break;
      }
    }
    await this.cleanup();
  }

  /** 子类实现真正的 I/O。 */
  protected abstract write(batch: MetricEvent[]): Promise<void>;

  /** 子类可选：close 时清理资源（关 stream / 连接池）。 */
  protected cleanup(): Promise<void> | void {
    return;
  }
}
