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
 * 索引列服务于「按 kind + 时间窗 + session/work-item 聚合」这一典型 dashboard / 恒温器查询。
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
CREATE INDEX IF NOT EXISTS idx_metrics_events_kind ON metrics_events (kind);
CREATE INDEX IF NOT EXISTS idx_metrics_events_session ON metrics_events (session_id);
CREATE INDEX IF NOT EXISTS idx_metrics_events_work_item ON metrics_events (work_item_id);
CREATE INDEX IF NOT EXISTS idx_metrics_events_ts ON metrics_events (ts);
`;

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
        JSON.stringify(payload),
      );
    }
    await this.client.query(
      `INSERT INTO metrics_events (kind, session_id, turn_idx, work_item_id, ts, payload) VALUES ${tuples.join(", ")}`,
      params,
    );
  }
}
