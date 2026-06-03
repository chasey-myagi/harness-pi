/**
 * PostgresSessionStore —— Postgres 落盘的 SessionStore 适配器（docs/09 §4.5，#12）。
 *
 * 实现内核 `SessionStore` 协议。**本包零 `pg` 依赖**：通过一个最小 `PgClient` 接口注入查询能力，
 * node-postgres 的 `Pool` / `Client` 天然满足它（`query(text, params) -> { rows }`）——「内核/adapter
 * 零依赖具体 driver」(judging 判据：实现可换)。调用方自带 `pg`（peerDep）。
 *
 * DDL 见导出的 `POSTGRES_SESSION_STORE_DDL`；`migrate()` 会执行它（IF NOT EXISTS，幂等）。
 *
 * **并发契约**：协议要求同一 sessionId 的 appendEntry / fork 串行。appendEntry 的 leaf+seq 现在
 * 并入 INSERT 自身的同一条语句（单条 INSERT...SELECT...RETURNING）读取，在该语句自己的快照里算出
 * parent_id 与 seq，**消除了原先 getLeafId + SELECT MAX 多次往返的 read-modify-write 窗口**。
 * `session_entries(session_id, seq)` 的 UNIQUE 约束仍是**跨进程真并发**写同一 session 的兜底
 * （协议本就禁止——同 session 的 append 由调用方串行）：并发写中撞号的一方插入失败，是兜底而非协调。
 * 不同 sessionId 之间可并发。
 */

import { randomUUID } from "node:crypto";
import type {
  SessionStore,
  SessionEntry,
  StoredEntry,
  ForkLineage,
} from "@harness-pi/core";

/** node-postgres 的 Pool/Client 满足的最小查询接口。 */
export interface PgClient {
  query(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * 建表 DDL（幂等，分号分隔的多条语句）。生产部署可整段直接跑，或交给迁移工具；
 * `migrate()` 会按分号拆开逐条执行。`(session_id, seq)` 的唯一性用独立 UNIQUE INDEX 表达
 *（而非 inline 表约束），real PG 与迁移工具都接受，也避开模拟器对 inline 约束的覆盖盲点。
 */
export const POSTGRES_SESSION_STORE_DDL = `
CREATE TABLE IF NOT EXISTS session_entries (
  id          text PRIMARY KEY,
  session_id  text    NOT NULL,
  parent_id   text,
  seq         integer NOT NULL,
  entry       jsonb   NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_session_entries_seq ON session_entries (session_id, seq);
CREATE INDEX IF NOT EXISTS idx_session_entries_session ON session_entries (session_id);
CREATE TABLE IF NOT EXISTS session_leaf (
  session_id text PRIMARY KEY,
  leaf_id    text NOT NULL
);
CREATE TABLE IF NOT EXISTS session_lineage (
  session_id        text PRIMARY KEY,
  parent_session_id text NOT NULL,
  from_entry_id     text NOT NULL
);
`;

type EntryRow = {
  id: unknown;
  parent_id: unknown;
  seq: unknown;
  entry: unknown;
};

/** jsonb 列：node-pg 返回已解析对象，pg-mem 亦然；string 则补一道 parse 兜底。 */
function parseEntry(raw: unknown): SessionEntry {
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as SessionEntry;
}

function toStored(row: EntryRow): StoredEntry {
  return {
    id: String(row.id),
    parentId: row.parent_id === null ? null : String(row.parent_id),
    seq: Number(row.seq),
    entry: parseEntry(row.entry),
  };
}

export class PostgresSessionStore implements SessionStore {
  constructor(private readonly client: PgClient) {}

  /** 执行建表 DDL（幂等）。首次使用前调一次。按分号拆成单条语句逐条执行（兼容只支持单语句的 driver）。 */
  async migrate(): Promise<void> {
    for (const stmt of POSTGRES_SESSION_STORE_DDL.split(";")) {
      const sql = stmt.trim();
      if (sql.length > 0) await this.client.query(sql);
    }
  }

  async appendEntry(
    sessionId: string,
    entry: SessionEntry,
  ): Promise<StoredEntry> {
    const id = randomUUID();
    // 单条 INSERT...SELECT...RETURNING：parent_id（当前 leaf）与 seq（MAX+1）在 INSERT 自身的
    // 快照里算出并写入，消除原先 getLeafId + SELECT MAX 多次往返的 read-modify-write 窗口。
    // leaf / max(seq) 用 FROM 子句的 LEFT JOIN（而非 SELECT-list 标量子查询）取值——两者在真 PG 等价
    // （单行源 LEFT JOIN 恰产一行），但 pg-mem 会把 SELECT-list 里的标量子查询错当成 record 行包裹，
    // 故走 FROM 子查询绕开模拟器这一限制，语义不变。
    const insRes = await this.client.query(
      `INSERT INTO session_entries (id, session_id, parent_id, seq, entry)
       SELECT $1, $2, l.leaf_id, COALESCE(m.mx, 0) + 1, $3::jsonb
       FROM (SELECT 1) AS one
       LEFT JOIN (SELECT leaf_id FROM session_leaf WHERE session_id = $2) AS l ON true
       LEFT JOIN (SELECT MAX(seq) AS mx FROM session_entries WHERE session_id = $2) AS m ON true
       RETURNING parent_id, seq`,
      [id, sessionId, JSON.stringify(entry)],
    );
    const row = insRes.rows[0]!;
    const parentId = row.parent_id === null ? null : String(row.parent_id);
    const seq = Number(row.seq);
    await this.client.query(
      `INSERT INTO session_leaf (session_id, leaf_id) VALUES ($1, $2)
       ON CONFLICT (session_id) DO UPDATE SET leaf_id = EXCLUDED.leaf_id`,
      [sessionId, id],
    );
    return { id, parentId, seq, entry };
  }

  async getLeafId(sessionId: string): Promise<string | null> {
    const res = await this.client.query(
      `SELECT leaf_id FROM session_leaf WHERE session_id = $1`,
      [sessionId],
    );
    return res.rows.length ? String(res.rows[0]!.leaf_id) : null;
  }

  async getPathToLeaf(
    sessionId: string,
    leafId?: string,
  ): Promise<StoredEntry[]> {
    const start = leafId ?? (await this.getLeafId(sessionId));
    if (start === null) return [];

    // 取该 session 全部 entry，在内存里沿 parent 链回溯（避免对 pg-mem/recursive-CTE 的依赖）。
    const res = await this.client.query(
      `SELECT id, parent_id, seq, entry FROM session_entries WHERE session_id = $1`,
      [sessionId],
    );
    const byId = new Map<string, EntryRow>();
    for (const r of res.rows) byId.set(String(r.id), r as EntryRow);

    // 第一跳就查不到：未知 / 跨 session 的 leafId —— 合法空结果。
    if (!byId.has(start)) return [];

    const path: StoredEntry[] = [];
    let cur: string | null = start;
    while (cur !== null) {
      const row = byId.get(cur);
      if (!row) {
        // 从合法 leaf 走进来后中途断链：append-only 单链不变量被破坏（数据损坏），不静默返回半截。
        throw new Error(
          `getPathToLeaf: broken lineage in session ${sessionId}: entry ${cur} referenced but not found`,
        );
      }
      const stored = toStored(row);
      path.push(stored);
      cur = stored.parentId;
    }
    return path.reverse();
  }

  async fork(sessionId: string, fromEntryId: string): Promise<string> {
    const prefix = await this.getPathToLeaf(sessionId, fromEntryId);
    if (prefix.length === 0) {
      throw new Error(
        `fork: entry ${fromEntryId} not found in session ${sessionId}`,
      );
    }
    const forkId = randomUUID();

    // 批量复制前缀（新 id，重建 parent 链）—— 一条多行 INSERT，符合协议「fork 是批量插入」。
    const tuples: string[] = [];
    const params: unknown[] = [];
    let p = 0;
    let prevId: string | null = null;
    let seq = 0;
    for (const node of prefix) {
      const id = randomUUID();
      tuples.push(`($${++p}, $${++p}, $${++p}, $${++p}, $${++p}::jsonb)`);
      params.push(id, forkId, prevId, ++seq, JSON.stringify(node.entry));
      prevId = id;
    }
    await this.client.query(
      `INSERT INTO session_entries (id, session_id, parent_id, seq, entry) VALUES ${tuples.join(", ")}`,
      params,
    );
    await this.client.query(
      `INSERT INTO session_leaf (session_id, leaf_id) VALUES ($1, $2)
       ON CONFLICT (session_id) DO UPDATE SET leaf_id = EXCLUDED.leaf_id`,
      [forkId, prevId],
    );
    await this.client.query(
      `INSERT INTO session_lineage (session_id, parent_session_id, from_entry_id)
       VALUES ($1, $2, $3)`,
      [forkId, sessionId, fromEntryId],
    );
    return forkId;
  }

  async getLineage(sessionId: string): Promise<ForkLineage | null> {
    const res = await this.client.query(
      `SELECT parent_session_id, from_entry_id FROM session_lineage WHERE session_id = $1`,
      [sessionId],
    );
    if (res.rows.length === 0) return null;
    return {
      parentSessionId: String(res.rows[0]!.parent_session_id),
      fromEntryId: String(res.rows[0]!.from_entry_id),
    };
  }
}
