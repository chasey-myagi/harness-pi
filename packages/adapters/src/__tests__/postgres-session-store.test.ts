import { describe, it, expect } from "vitest";
import { newDb } from "pg-mem";
import type { SessionEntry } from "@harness-pi/core";
import {
  PostgresSessionStore,
  type PgClient,
} from "../postgres-session-store.js";
import { runSessionStoreContract } from "./contract.js";

/**
 * 用 pg-mem（内存 Postgres 模拟器，真解析+执行 SQL，支持 jsonb / 约束 / ON CONFLICT）跑同一套
 * SessionStore 契约。这给 PostgresSessionStore 真实的 SQL 覆盖——不是手搓 fake DB，pg-mem 实现的是
 * 真 PG 语义，契约过即说明 adapter 的 SQL/映射基本正确。（真实部署仍应跑一遍真 PG 集成测试。）
 */
function makePgMemClient(): PgClient {
  const db = newDb();
  const pg = db.adapters.createPg();
  const pool = new pg.Pool();
  return pool as unknown as PgClient;
}

async function freshStore(): Promise<PostgresSessionStore> {
  const store = new PostgresSessionStore(makePgMemClient());
  await store.migrate();
  return store;
}

runSessionStoreContract("PostgresSessionStore (pg-mem)", freshStore);

describe("PostgresSessionStore specifics", () => {
  // 注：migrate() 的幂等性靠 DDL 的 `IF NOT EXISTS`，这是 real PG 的保证；pg-mem 不能重跑
  // `IF NOT EXISTS` DDL（第二次会抛 "AST not supported"），故不在此用 pg-mem 验证幂等——那是
  // 模拟器的局限、不是 adapter 的行为。每个契约测试都已成功跑过一次 migrate()，覆盖建表路径。

  it("新 INSERT...SELECT...RETURNING：空 session 首条 parent_id 为 SQL NULL，第二条链到第一条", async () => {
    // 定向钉死单条 INSERT...SELECT（leaf/seq 走 FROM 子句 LEFT JOIN）的语义：空 session 时 leaf 子查询
    // 无行 → RETURNING parent_id 必为 SQL NULL（归一化成 JS null，非字符串 "null"）；seq 从 COALESCE(MAX,0)+1
    // 起算；第二条经 leaf LEFT JOIN 取到上一条 id 作 parent。
    const store = await freshStore();
    const a = await store.appendEntry("s1", {
      kind: "message",
      message: { role: "user", content: "hi" } as never,
    });
    expect(a.parentId).toBeNull();
    expect(a.seq).toBe(1);
    const b = await store.appendEntry("s1", {
      kind: "message",
      message: { role: "assistant", content: "yo" } as never,
    });
    expect(b.parentId).toBe(a.id);
    expect(b.seq).toBe(2);
  });

  it("persists jsonb entry content faithfully (terminal RunSummary deep round-trip)", async () => {
    const store = await freshStore();
    const terminal: SessionEntry = {
      kind: "terminal",
      result: {
        turns: 3,
        continuations: 1,
        reason: "done",
        usage: { input: 10, output: 20, cacheRead: 5, cacheWrite: 2, totalTokens: 30, cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 } },
      },
    };
    await store.appendEntry("s", terminal);
    const path = await store.getPathToLeaf("s");
    expect(path).toHaveLength(1);
    // 深比较整个 entry：jsonb 序列化若丢任何嵌套字段（cost / reason / usage）都会被抓到。
    expect(path[0]!.entry).toEqual(terminal);
  });

  it("getPathToLeaf throws on a broken lineage (mid-chain parent_id points to a missing entry)", async () => {
    const client = makePgMemClient();
    const store = new PostgresSessionStore(client);
    await store.migrate();
    await store.appendEntry("s", { kind: "message", message: { role: "user", content: "a", timestamp: 0 } });
    const b = await store.appendEntry("s", { kind: "message", message: { role: "user", content: "b", timestamp: 0 } });
    // 篡改 leaf(b) 的 parent_id 指向幽灵 → 从 leaf 回溯中途断链。
    await client.query(`UPDATE session_entries SET parent_id = $1 WHERE id = $2`, ["GHOST", b.id]);
    await expect(store.getPathToLeaf("s")).rejects.toThrow(/broken lineage/);
  });

  it("rejects a duplicate seq within a session (UNIQUE(session_id, seq) guard)", async () => {
    // 直接验证并发兜底约束：手动插入撞号的 seq 应被 PG 拒绝。
    const client = makePgMemClient();
    const store = new PostgresSessionStore(client);
    await store.migrate();
    const a = await store.appendEntry("s", { kind: "message", message: { role: "user", content: "x", timestamp: 0 } });
    await expect(
      client.query(
        `INSERT INTO session_entries (id, session_id, parent_id, seq, entry) VALUES ($1,$2,$3,$4,$5::jsonb)`,
        ["dup", "s", a.id, a.seq, JSON.stringify({ kind: "message", message: { role: "user", content: "dup", timestamp: 0 } })],
      ),
    ).rejects.toThrow();
  });
});
