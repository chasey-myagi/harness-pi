# 07 · Adapters (Sinks)

> Sink 接口、内置 sink 列表、batching pattern、peerDep 约定、backpressure 策略。

## 1. Adapter 是什么

**Adapter = plugin 把数据写出去的 I/O 实现。**

具体到 v0：主要是 metrics plugin 的 `MetricsSink`。

Adapter 跟 plugin 的关系：

```
metrics plugin (hook 行为)
       ↓ enqueue event
MetricsSink (interface)
       ↓ 由具体 sink 实现
┌────────┬─────────────┬───────────┬────────┐
│ Memory │ NdjsonFile  │ Postgres  │ OTel   │
│  Sink  │   Sink      │   Sink    │  Sink  │
└────────┴─────────────┴───────────┴────────┘
   零依赖      零依赖     peerDep `pg`   peerDep `@opentelemetry/*`
```

## 2. Sink 接口

```ts
// packages/plugins/src/metrics/types.ts

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

export interface SinkStats {
  enqueued: number;
  flushed: number;
  failed: number;     // 写失败丢的
  dropped: number;    // backpressure 丢的
  pending: number;    // buffer 里未刷的
  lastFlushTs: number;
  lastError: string | null;
}
```

**契约**：

- `enqueue` 必须**同步且快**（push 到内存 buffer 即可）
- `flush` 可以 throw / reject——caller 看 `stats()` 自己决定怎么办
- `close` 应该 flush 一次再清资源
- sink 实例**不能跨 session 共享 state 而互相串味**——`stats` 是全局聚合 OK

## 3. 通用 batching 模式

所有 sink（除 Memory）都应该采用同一个 batching 模板。基于 bidding-agent `metrics/recorder.ts`：

```ts
import type { MetricsSink, MetricEvent, SinkStats } from "./types.js";

export interface BatchingSinkOptions {
  batchSize?: number;       // 默认 200
  flushIntervalMs?: number; // 默认 1000
  bufferOverflow?: number;  // 默认 5000，超过丢老的
}

export abstract class BatchingSink implements MetricsSink {
  protected buffer: MetricEvent[] = [];
  protected stats: SinkStats = { enqueued: 0, flushed: 0, failed: 0, dropped: 0, pending: 0, lastFlushTs: 0, lastError: null };
  protected timer: ReturnType<typeof setTimeout> | null = null;
  protected flushing = false;
  protected flushPromise: Promise<boolean> | null = null;

  constructor(protected opts: BatchingSinkOptions = {}) {
    this.opts.batchSize ??= 200;
    this.opts.flushIntervalMs ??= 1000;
    this.opts.bufferOverflow ??= 5000;
  }

  enqueue(event: MetricEvent): void {
    this.buffer.push(event);
    this.stats.enqueued++;
    if (this.buffer.length >= this.opts.batchSize!) {
      void this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  async flush(): Promise<void> {
    if (this.flushing && this.flushPromise) { await this.flushPromise; return; }
    if (this.buffer.length === 0) return;
    this.flushing = true;
    this.flushPromise = (async () => {
      const batch = this.buffer.splice(0, this.buffer.length);
      try {
        await this.write(batch);     // 子类实现
        this.stats.flushed += batch.length;
        this.stats.lastFlushTs = Date.now();
        this.stats.lastError = null;
        return true;
      } catch (err) {
        this.stats.lastError = (err as Error).message;
        // 失败重排队到 head
        this.buffer.unshift(...batch);
        if (this.buffer.length > this.opts.bufferOverflow!) {
          const overflow = this.buffer.length - this.opts.bufferOverflow!;
          this.buffer.splice(0, overflow);
          this.stats.failed += overflow;
          this.stats.dropped += overflow;
        }
        return false;
      } finally {
        this.flushing = false;
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
    }, this.opts.flushIntervalMs);
    this.timer.unref?.();
  }

  getStats(): SinkStats {
    return { ...this.stats, pending: this.buffer.length };
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    await this.flush();
  }

  /** 子类实现真正的 I/O。 */
  protected abstract write(batch: MetricEvent[]): Promise<void>;
}
```

每个具体 sink 只要继承这个 base + 实现 `write(batch)` 即可，不必重复 batching 逻辑。

## 4. 内置 Sink

### 4.1 MemorySink（默认）

```ts
import type { MetricsSink, MetricEvent, SinkStats } from "./types.js";

export class MemorySink implements MetricsSink {
  private events: MetricEvent[] = [];
  private stats = { enqueued: 0, flushed: 0, failed: 0, dropped: 0, pending: 0, lastFlushTs: 0, lastError: null };

  constructor(private opts: { maxEvents?: number } = {}) {}

  enqueue(event: MetricEvent): void {
    this.events.push(event);
    this.stats.enqueued++;
    if (this.opts.maxEvents && this.events.length > this.opts.maxEvents) {
      const dropped = this.events.length - this.opts.maxEvents;
      this.events.splice(0, dropped);
      this.stats.dropped += dropped;
    }
  }

  /** 测试 / debug 用 */
  snapshot(): ReadonlyArray<MetricEvent> { return [...this.events]; }
  clear(): void { this.events = []; }

  getStats() { return { ...this.stats, pending: this.events.length, flushed: this.stats.enqueued }; }
  async flush() {}
  async close() {}
}
```

**用途**：测试、debug、超短生命的脚本任务。不持久化。

### 4.2 NdjsonFileSink（零依赖）

```ts
import { createWriteStream, type WriteStream } from "fs";
import { BatchingSink } from "./batching-sink.js";

export interface NdjsonFileSinkOptions {
  path: string;
  batchSize?: number;
  flushIntervalMs?: number;
}

export class NdjsonFileSink extends BatchingSink {
  private stream: WriteStream;

  constructor(opts: NdjsonFileSinkOptions) {
    super(opts);
    this.stream = createWriteStream(opts.path, { flags: "a" });
    this.stream.on("error", (err) => {
      this.stats.lastError = err.message;
    });
  }

  protected async write(batch: MetricEvent[]): Promise<void> {
    const lines = batch.map(e => JSON.stringify(e)).join("\n") + "\n";
    return new Promise((resolve, reject) => {
      this.stream.write(lines, (err) => err ? reject(err) : resolve());
    });
  }

  async close(): Promise<void> {
    await super.close();
    await new Promise<void>((resolve) => this.stream.end(resolve));
  }
}
```

**用途**：本地开发、容器化部署到带挂载 volume 的环境。

### 4.3 PostgresSink（peerDep on `pg`）

```ts
// 假设用户自己装了 pg
import type { Pool } from "pg";
import { BatchingSink } from "./batching-sink.js";

export interface PostgresSinkOptions {
  pool: Pool;          // 用户传入已建好的连接池
  table?: string;      // 默认 "metrics_events"
  batchSize?: number;
  flushIntervalMs?: number;
}

export class PostgresSink extends BatchingSink {
  constructor(private pgOpts: PostgresSinkOptions) {
    super(pgOpts);
  }

  protected async write(batch: MetricEvent[]): Promise<void> {
    const table = this.pgOpts.table ?? "metrics_events";
    // 简化的 bulk insert（实际要用 unnest 或 pg-format 防 SQL 注入）
    const values = batch.map((e, i) => {
      const offset = i * 5;
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`;
    }).join(", ");
    const params = batch.flatMap(e => [
      e.kind,
      e.sessionId ?? null,
      e.turnIdx ?? null,
      new Date(e.ts),
      JSON.stringify(e),
    ]);
    await this.pgOpts.pool.query(
      `INSERT INTO ${table} (kind, session_id, turn_idx, ts, payload) VALUES ${values}`,
      params,
    );
  }
}
```

**用途**：production agent 后台，dashboard 查询。

**peerDep 声明**（`packages/plugins/package.json`）：

```json
{
  "peerDependencies": {
    "pg": "^8.0.0"
  },
  "peerDependenciesMeta": {
    "pg": { "optional": true }
  }
}
```

用户：

```bash
npm install @harness-pi/plugins pg
# 然后才能 import { PostgresSink } from "@harness-pi/plugins/metrics/sinks/postgres"
```

**Schema（包内提供 DDL）**：

PostgresSink 导出幂等的 `POSTGRES_METRICS_SINK_DDL` 并提供 `migrate()`（按 `;` 拆条执行）——与 `PostgresSessionStore` 同构，**本包零 `pg` 依赖**（注入 `PgClient`，node-postgres 的 `Pool`/`Client` 满足）。首次使用前 `await sink.migrate()` 建表即可；也可以把这段 DDL 接进你自己的 migration 工具（drizzle/prisma/raw SQL）。

DDL（`ts` 用 `bigint` = epoch 毫秒，对齐 `MetricEvent.ts: number`；索引按「等值过滤列 + 时间」复合，服务「按 kind + 时间窗 + session/work-item 聚合」的典型查询）：

```sql
CREATE TABLE IF NOT EXISTS metrics_events (
  id           BIGSERIAL PRIMARY KEY,
  kind         TEXT   NOT NULL,
  session_id   TEXT,
  turn_idx     INTEGER,
  work_item_id TEXT,
  ts           BIGINT NOT NULL,
  payload      JSONB  NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_metrics_events_kind_ts ON metrics_events (kind, ts);
CREATE INDEX IF NOT EXISTS idx_metrics_events_session_kind_ts ON metrics_events (session_id, kind, ts);
CREATE INDEX IF NOT EXISTS idx_metrics_events_work_item_kind_ts ON metrics_events (work_item_id, kind, ts);
```

### 4.4 OtelSink（peerDep on `@opentelemetry/api` + 一个 exporter，v0.x 候选）

```ts
// 草图，v0.1 后再做
import type { Meter, Tracer } from "@opentelemetry/api";
import { BatchingSink } from "./batching-sink.js";

export class OtelSink extends BatchingSink {
  constructor(private otelOpts: { meter: Meter; tracer?: Tracer; ... }) {
    super();
  }

  protected async write(batch: MetricEvent[]): Promise<void> {
    for (const e of batch) {
      // 按 kind 映射到 metric 类型：counter / histogram / event
      switch (e.kind) {
        case "llm.called":
          this.otelOpts.meter.createHistogram("llm.duration").record(e.durationMs, { ... });
          break;
        // ...
      }
    }
  }
}
```

**v0 不做的理由**：OTel 的抽象（counter / histogram / span）跟我们的 event 模型对不齐，做好需要一轮设计。先用 ndjson / postgres 顶。

## 5. Backpressure 策略

所有 batching sink 都遵循同一策略：

1. **正常**：batch 满或 1s 到刷
2. **写失败**：events 重排队到 head，继续在内存累积
3. **buffer overflow**（> 5000 events）：丢**最老**的，记 `dropped` 计数

为什么丢最老的而不是新的：
- 老 event 已经"陈旧"，比新 event 信息价值低
- 新 event 反映当前问题，更需要保留以诊断

**用户监控点**：定期看 `sink.getStats()`：

| 字段 | 含义 | 触发警报 |
|---|---|---|
| `lastError` | 最近一次 flush 失败的 message | 非 null 且持续 |
| `dropped` | 因 overflow 丢弃的数量 | 增长 |
| `pending` | buffer 里堆积的数量 | 持续 > 1000 |
| `failed` | 因 overflow 丢弃 = dropped 子集 | 同上 |

## 6. 多 session 共享 sink

Controller 跑多 session 时，**一个 sink 实例服务所有 session**：

```ts
const sharedSink = new PostgresSink({ pool, table: "metrics_events" });

// workPool / leaseQueue 里每个 worker 的 session 都注入这个 sink
workerFactory: async (...) => {
  const session = new AgentSession({
    hooks: [metrics({ sink: sharedSink })],
  });
  return { session, prompt };
}
```

**为什么不每 session 一个 sink**：
- sink 持有数据库连接池等重资源
- batch flush 效率：100 个 session 各自 1 个 event 不如 1 个 sink 攒 100 个 event 一次 flush
- stats 全局聚合方便监控

**Sink 必须线程安全**（实际是 event-loop 安全）：

- `enqueue` 是同步 push，本身原子
- `flush` 有 `flushing` 锁，并发调用 reuse 同一个 flushPromise
- stats 累加不在事务里——可能有 race 让 `stats.enqueued` 跟 `events.length` 短暂不一致，但每个字段读出来都是有效值

## 7. Sink 命名与导出约定

```
packages/plugins/src/metrics/sinks/
├── memory.ts         → export class MemorySink
├── ndjson-file.ts    → export class NdjsonFileSink
├── postgres.ts       → export class PostgresSink
└── batching-sink.ts  → export abstract class BatchingSink
```

`packages/plugins/src/index.ts`：

```ts
// 各 sink 用子路径导入，让 tree-shake 干净
// import { PostgresSink } from "@harness-pi/plugins/metrics/sinks/postgres";

// 但 metrics() factory 在主入口
export { metrics, getMetricsSink } from "./metrics/index.js";
```

为什么 sink **不**在主入口 re-export：避免 bundler 把 pg / otel 等 peerDep 拉进来分析依赖。子路径 import 让 tree-shake 真正生效。

## 8. 自定义 Sink

用户自己实现一个 sink 简单到几十行。比如往 Slack 发：

```ts
import type { MetricsSink, MetricEvent } from "@harness-pi/plugins/metrics/types";

export class SlackAlertSink implements MetricsSink {
  private stats = { enqueued: 0, flushed: 0, failed: 0, dropped: 0, pending: 0, lastFlushTs: 0, lastError: null };

  constructor(private webhookUrl: string) {}

  enqueue(event: MetricEvent): void {
    this.stats.enqueued++;
    if (event.kind !== "error.observed") return;  // 只关心 error
    fetch(this.webhookUrl, {
      method: "POST",
      body: JSON.stringify({ text: `[agent error] ${JSON.stringify(event)}` }),
    }).then(() => this.stats.flushed++).catch(err => {
      this.stats.failed++;
      this.stats.lastError = (err as Error).message;
    });
  }

  getStats() { return { ...this.stats }; }
}
```

注意：这里没用 BatchingSink 因为 error 不需要批；要批就继承 BatchingSink。

## 9. 跟其他 plugin 的 sink

`metrics` plugin 不是唯一带 sink 的。未来：

- `session-log` 现在直接写 ndjson，但**可以**抽出 `SessionLogSink` 接口，让 log 也能往别处发（如远端 log collector）
- `tool-output-buffer` 是内存 buffer，没 sink

每个带 sink 的 plugin 都遵循同一 pattern：
- 接口在该 plugin 自己的 `types.ts`
- 默认 sink 跟 plugin 一起 ship
- 重 sink 走 peerDep

## 10. 下一步

- [05-plugins §metrics](05-plugins.md#59-metrics) —— metrics plugin 怎么调 sink
- [06-controllers](06-controllers.md) —— 多 session 共享 sink 的用法
- [02-kernel §错误处理](02-kernel.md#5-错误处理) —— sink 抛错怎么影响 session
