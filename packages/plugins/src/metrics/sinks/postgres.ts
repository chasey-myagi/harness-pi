/**
 * PostgresSink —— 把 metric events 批写进 Postgres，供 dashboard / 跨会话聚合查询。
 *
 * 与 `PostgresSessionStore` 同构：**本包零 `pg` 依赖**，通过最小 `PgClient` 接口注入查询能力，
 * node-postgres 的 `Pool` / `Client` 天然满足它（`query(text, params) -> { rows }`）。调用方自带 `pg`。
 * 继承 `BatchingSink`，复用批量 / 重试 / overflow 语义，只实现 `write(batch)`。
 *
 * 把 `kind / session_id / turn_idx / work_item_id / ts` 提升为可索引列（恒温器 / dashboard 按
 * kind + 时间窗 + work-item 聚合），其余字段进 `payload` jsonb。DDL 见导出的
 * `POSTGRES_METRICS_SINK_DDL`；`migrate()` 幂等执行它。详见 docs/07-adapters.md §3。
 */

import { BatchingSink, type BatchingSinkOptions } from "../batching-sink.js";
import type { MetricEvent } from "../types.js";

/** node-postgres 的 Pool/Client 满足的最小查询接口（与 PostgresSessionStore 同形）。 */
export interface PgClient {
  query(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * 建表 DDL（幂等，分号分隔多条语句）。`migrate()` 按分号拆开逐条执行（兼容只支持单语句的 driver）。
 *
 * 索引按「先等值过滤列、后时间」的复合形式建，直接服务典型查询（恒温器 / dashboard）：
 *   WHERE kind = $1 [AND session_id = $2 | AND work_item_id = $2] AND ts >= $a AND ts < $b
 * 复合索引比四个单列索引更高效（无需 bitmap-AND / 内存过滤），也少一份写放大。可按真实 EXPLAIN 再调。
 *
 * `ts` 用 bigint = epoch 毫秒（对齐 `MetricEvent.ts: number`）；`ts BETWEEN a AND b` 范围过滤直接可用，
 * 需要 timestamptz 视图时在查询里 `to_timestamp(ts / 1000.0)` 即可，故不在存储层强转。
 */
export const POSTGRES_METRICS_SINK_DDL = `
CREATE TABLE IF NOT EXISTS metrics_events (
  id           bigserial PRIMARY KEY,
  kind         text   NOT NULL,
  session_id   text,
  turn_idx     integer,
  work_item_id text,
  ts           bigint NOT NULL,
  payload      jsonb  NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_metrics_events_kind_ts ON metrics_events (kind, ts);
CREATE INDEX IF NOT EXISTS idx_metrics_events_session_kind_ts ON metrics_events (session_id, kind, ts);
CREATE INDEX IF NOT EXISTS idx_metrics_events_work_item_kind_ts ON metrics_events (work_item_id, kind, ts);
`;

/** 65535 bind-param 上限 / 6 binds-per-row ≈ 10922；取 10000 留余量。超过则 write() 拆成多条 INSERT。 */
const MAX_ROWS_PER_INSERT = 10000;

/**
 * 只对「序列化错误」永不抛错的 JSON.stringify，避免一条坏 payload 毒死整个 sink：BigInt → 字符串、
 * 循环引用 → "[Circular]" 在 replacer 里处理；其它仍会抛的（如 toJSON() 自身抛错）由外层 try/catch
 * 兜底，退化成 {_unserializable:true}。（client.query() 的 I/O 错误是另一回事——照常抛出由 BatchingSink 重试。）
 * 没有它的话，一条不可序列化事件会让 write() 抛错、被 BatchingSink 无限重排队、最终 overflow 丢掉整批。
 *
 * 注意（JSON.stringify 固有语义）：Symbol 键与 undefined 值被静默丢弃；共享（非循环）引用会被保守标成
 * "[Circular]"。payload 预期是普通 JSON 数据——所有 core metric kind 都满足。
 */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === "bigint") return val.toString();
      if (typeof val === "object" && val !== null) {
        if (seen.has(val)) return "[Circular]";
        seen.add(val);
      }
      return val as unknown;
    });
  } catch {
    return JSON.stringify({ _unserializable: true });
  }
}

export interface PostgresSinkOptions extends BatchingSinkOptions {
  client: PgClient;
}

export class PostgresSink extends BatchingSink {
  private readonly client: PgClient;

  constructor(opts: PostgresSinkOptions) {
    super(opts);
    this.client = opts.client;
  }

  /** 执行建表 DDL（幂等）。首次使用前调一次。按分号拆成单条语句逐条执行。 */
  async migrate(): Promise<void> {
    for (const stmt of POSTGRES_METRICS_SINK_DDL.split(";")) {
      const sql = stmt.trim();
      if (sql.length > 0) await this.client.query(sql);
    }
  }

  protected async write(batch: MetricEvent[]): Promise<void> {
    // Chunk so a single INSERT never exceeds Postgres' 65535 bind-parameter cap (6 binds/row).
    // BatchingSink hands the whole buffer (up to bufferOverflow) in one call, so this is load-bearing.
    for (let i = 0; i < batch.length; i += MAX_ROWS_PER_INSERT) {
      await this.writeChunk(batch.slice(i, i + MAX_ROWS_PER_INSERT));
    }
  }

  private async writeChunk(batch: MetricEvent[]): Promise<void> {
    if (batch.length === 0) return;
    const tuples: string[] = [];
    const params: unknown[] = [];
    let p = 0;
    for (const event of batch) {
      const { kind, sessionId, turnIdx, ts, workItemId, ...payload } = event;
      tuples.push(
        `($${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $${++p}::jsonb)`,
      );
      params.push(
        kind,
        sessionId ?? null,
        turnIdx ?? null,
        workItemId == null ? null : String(workItemId),
        ts,
        safeStringify(payload),
      );
    }
    await this.client.query(
      `INSERT INTO metrics_events (kind, session_id, turn_idx, work_item_id, ts, payload) VALUES ${tuples.join(", ")}`,
      params,
    );
  }
}
