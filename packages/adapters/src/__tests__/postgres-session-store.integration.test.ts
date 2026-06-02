/**
 * PostgresSessionStore —— **真实 Postgres** 集成测试（不是 pg-mem 模拟器）。
 *
 * 为什么需要它：pg-mem 是模拟器，有已知偏差——它**不能重跑 `IF NOT EXISTS` DDL**（第二次抛
 * "AST not supported"），所以 `migrate()` 的幂等性、以及真驱动的 jsonb 往返 / `ON CONFLICT` upsert /
 * `UNIQUE(session_id, seq)` 在**真并发**下的冲突，都只有真库能验。这里用真 `pg.Pool` 把同一套
 * SessionStore 契约再跑一遍，外加几条只有真 PG 才能覆盖的断言。
 *
 * **env-gated**：只在设置了 `POSTGRES_TEST_URL` 时跑；否则整段 skip（CI / 他机不需要起 DB）。
 *   POSTGRES_TEST_URL=postgres://postgres:test@localhost:55432/harness_pi_test pnpm --filter @harness-pi/adapters test
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import type { SessionEntry } from "@harness-pi/core";
import { PostgresSessionStore } from "../postgres-session-store.js";
import { runSessionStoreContract } from "./contract.js";

const url = process.env.POSTGRES_TEST_URL;

// 没设 URL 就整段跳过：`describe.skip` 会把该 suite 内的所有 it 标记为 skipped 显示在报告里（能看到
// 「为何跳过」而非静默消失）。注意 describe.skip 仍会**执行回调体**做收集，所以 pool/store 故意放进
// beforeAll 而非回调顶层——skip 路径下连惰性 Pool 都不构造。
const suite = url ? describe : describe.skip;

function msg(text: string): SessionEntry {
  return { kind: "message", message: { role: "user", content: text, timestamp: 0 } };
}

suite("PostgresSessionStore — real Postgres integration", () => {
  let pool: pg.Pool;
  let store: PostgresSessionStore;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    // node-postgres 的 Pool 直接喂给 store——验证「Pool 天生满足 PgClient」不靠 `as`，直接赋值即过类型。
    store = new PostgresSessionStore(pool);
    await store.migrate(); // 建表（IF NOT EXISTS）
  });

  afterAll(async () => {
    await pool.query(
      "DROP TABLE IF EXISTS session_entries, session_leaf, session_lineage",
    );
    await pool.end();
  });

  // 每个契约用例要全新空 store：truncate 三张表即可（store/pool 复用同一连接池）。
  runSessionStoreContract("real PG", async () => {
    await pool.query(
      "TRUNCATE session_entries, session_leaf, session_lineage",
    );
    return store;
  });

  describe("real-PG-only behaviors (pg-mem 无法覆盖)", () => {
    // 每条需要干净台面的用例自己 TRUNCATE（见各 it 开头）；不需要的（migrate 幂等）本就不关心表内容，
    // 故这里无块级 beforeAll——避免与各用例的 TRUNCATE 重复。

    it("migrate() is idempotent on real PG (re-running IF NOT EXISTS DDL is a no-op)", async () => {
      // pg-mem 第二次跑 IF NOT EXISTS DDL 会抛；真 PG 必须无声成功。连跑两次不抛即证幂等。
      await expect(store.migrate()).resolves.toBeUndefined();
      await expect(store.migrate()).resolves.toBeUndefined();
    });

    it("round-trips a deep terminal RunSummary through real jsonb (driver returns parsed object)", async () => {
      await pool.query("TRUNCATE session_entries, session_leaf, session_lineage");
      const terminal: SessionEntry = {
        kind: "terminal",
        result: {
          turns: 3,
          continuations: 1,
          reason: "done",
          usage: {
            input: 10,
            output: 20,
            cacheRead: 5,
            cacheWrite: 2,
            totalTokens: 30,
            cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
          },
        },
      };
      await store.appendEntry("jsonb-s", terminal);
      const path = await store.getPathToLeaf("jsonb-s");
      expect(path).toHaveLength(1);
      // 真 PG jsonb 列 + node-pg 解析：嵌套数字/字符串若有任何丢失或类型漂移都会被深比较抓到。
      expect(path[0]!.entry).toEqual(terminal);
    });

    it("UNIQUE(session_id, seq) rejects a duplicate seq on real PG (deterministic)", async () => {
      await pool.query("TRUNCATE session_entries, session_leaf, session_lineage");
      const a = await store.appendEntry("dup", msg("x"));
      // 手插一条撞号 seq → 真 PG 的 UNIQUE 索引必须拒绝（pg-mem 的约束覆盖是模拟，这里验真库）。
      // 断言 PG 错误码 23505（unique_violation），坐实「是 UNIQUE 约束拒绝」而非偶发的别的错误。
      await expect(
        pool.query(
          "INSERT INTO session_entries (id, session_id, parent_id, seq, entry) VALUES ($1,$2,$3,$4,$5::jsonb)",
          ["dup-id", "dup", a.id, a.seq, JSON.stringify(msg("collide"))],
        ),
      ).rejects.toMatchObject({ code: "23505" });
    });

    it("under real concurrent appends to one session, the seq invariant holds (no duplicate seq survives)", async () => {
      await pool.query("TRUNCATE session_entries, session_leaf, session_lineage");
      // 文档承诺：同 session 并发 append 是「读 MAX(seq) → insert」的读改写，并发请求可能算出同一个 next
      // seq、撞 UNIQUE，由约束兜底（而非协调）。真 PG 才跑得出真并发。**不**断言「必有一个被拒」——那依赖
      // 时序（理论上可能恰好串行而全成功），会 flaky；而是断言无论怎么交错，约束守住的**不变量**：
      // 落库的 seq 永不重复。撞号的那些 append 自己 reject（INSERT 失败、无半行残留）。
      const results = await Promise.allSettled([
        store.appendEntry("race", msg("c1")),
        store.appendEntry("race", msg("c2")),
        store.appendEntry("race", msg("c3")),
        store.appendEntry("race", msg("c4")),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled").length;
      expect(fulfilled).toBeGreaterThan(0); // 至少一个成功落库

      const rows = await pool.query(
        "SELECT seq FROM session_entries WHERE session_id = $1 ORDER BY seq",
        ["race"],
      );
      const seqs = rows.rows.map((r) => Number(r.seq));
      expect(rows.rows.length).toBe(fulfilled); // 成功数 == 落库行数（被拒的没留残行）
      expect(new Set(seqs).size).toBe(seqs.length); // 关键不变量：seq 无重复，约束守住了
    });

    it("fork's multi-row INSERT rebuilds the prefix correctly on real PG", async () => {
      await pool.query("TRUNCATE session_entries, session_leaf, session_lineage");
      await store.appendEntry("src", msg("a"));
      const b = await store.appendEntry("src", msg("b"));
      await store.appendEntry("src", msg("c"));
      const forkId = await store.fork("src", b.id);
      const forkPath = await store.getPathToLeaf(forkId);
      expect(forkPath.map((e) => (e.entry.kind === "message" ? e.entry.message.content : ""))).toEqual(["a", "b"]);
      expect(forkPath.map((e) => e.seq)).toEqual([1, 2]);
      expect(forkPath[0]!.parentId).toBeNull();
      expect(forkPath[1]!.parentId).toBe(forkPath[0]!.id);
      // lineage 行也落库正确。
      expect(await store.getLineage(forkId)).toEqual({ parentSessionId: "src", fromEntryId: b.id });
    });

    it("getPathToLeaf throws on a broken lineage (tampered parent_id) against real PG", async () => {
      await pool.query("TRUNCATE session_entries, session_leaf, session_lineage");
      await store.appendEntry("brk", msg("a"));
      const b = await store.appendEntry("brk", msg("b"));
      await pool.query("UPDATE session_entries SET parent_id = $1 WHERE id = $2", ["GHOST", b.id]);
      await expect(store.getPathToLeaf("brk")).rejects.toThrow(/broken lineage/);
    });
  });
});
