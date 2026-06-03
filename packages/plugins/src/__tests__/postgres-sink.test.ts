import { describe, it, expect } from "vitest";
import { newDb } from "pg-mem";
import {
  PostgresSink,
  POSTGRES_METRICS_SINK_DDL,
  type PgClient,
} from "../metrics/sinks/postgres.js";

/**
 * 用 pg-mem（内存 Postgres 模拟器，真解析+执行 SQL）跑 PostgresSink 的真实 SQL 覆盖——
 * 与 PostgresSessionStore 的测试同构，不手搓 fake DB。失败/重排队路径用一个 fail-once 包装
 * client（pg-mem 不便模拟瞬时写失败），底层仍委托给 pg-mem。
 */
function makePgMemClient(): PgClient {
  const db = newDb();
  const pg = db.adapters.createPg();
  return new pg.Pool() as unknown as PgClient;
}

describe("PostgresSink", () => {
  it("migrate runs each DDL statement once", async () => {
    const calls: string[] = [];
    const client: PgClient = {
      async query(text) {
        calls.push(text);
        return { rows: [] };
      },
    };
    await new PostgresSink({ client }).migrate();
    const stmts = POSTGRES_METRICS_SINK_DDL.split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(calls).toHaveLength(stmts.length);
    expect(calls[0]).toContain("CREATE TABLE IF NOT EXISTS metrics_events");
  });

  it("flush batch-inserts events with promoted columns + jsonb payload", async () => {
    const client = makePgMemClient();
    const sink = new PostgresSink({ client });
    await sink.migrate();

    sink.enqueue({
      kind: "llm.called",
      ts: 1,
      sessionId: "s1",
      turnIdx: 2,
      workItemId: "w1",
      durationMs: 42,
    });
    sink.enqueue({ kind: "tool.called", ts: 2, sessionId: "s1", toolName: "read" });
    await sink.flush();

    const res = await client.query(
      "SELECT kind, session_id, turn_idx, work_item_id, ts, payload FROM metrics_events ORDER BY ts",
    );
    expect(res.rows).toHaveLength(2);
    expect(res.rows[0]).toMatchObject({
      kind: "llm.called",
      session_id: "s1",
      turn_idx: 2,
      work_item_id: "w1",
    });
    const payload0 =
      typeof res.rows[0]!.payload === "string"
        ? JSON.parse(res.rows[0]!.payload as string)
        : res.rows[0]!.payload;
    // promoted columns are stripped out of the payload (no duplication)
    expect(payload0).toEqual({ durationMs: 42 });
    expect(res.rows[1]).toMatchObject({
      kind: "tool.called",
      session_id: "s1",
      turn_idx: null,
      work_item_id: null,
    });
  });

  it("requeues the batch on write failure, then recovers", async () => {
    const inner = makePgMemClient();
    let failOnce = true;
    const flaky: PgClient = {
      async query(text, params) {
        if (failOnce && text.startsWith("INSERT")) {
          failOnce = false;
          throw new Error("transient write failure");
        }
        return inner.query(text, params);
      },
    };
    const sink = new PostgresSink({ client: flaky });
    await sink.migrate();

    sink.enqueue({ kind: "session.started", ts: 1, sessionId: "s2" });
    await sink.flush(); // INSERT throws once -> batch requeued at head
    expect(sink.stats().failed).toBeGreaterThan(0);
    expect(sink.stats().pending).toBe(1);

    await sink.flush(); // retry succeeds
    expect(sink.stats().pending).toBe(0);
    expect(sink.stats().flushed).toBe(1);

    const res = await inner.query("SELECT kind FROM metrics_events");
    expect(res.rows).toHaveLength(1);
  });
});
