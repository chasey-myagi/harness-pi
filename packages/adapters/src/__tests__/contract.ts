/**
 * SessionStore 契约一致性测试套件（可复用）。
 *
 * 任何 SessionStore 实现都必须满足同一套**可观测行为**。把这些行为写成一个参数化的 describe，
 * 让每个 adapter（JsonlSessionStore / PostgresSessionStore / …）都跑同一套，证明它们行为等价。
 * 这样 adapter 测试不会各写各的、漏掉协议的某条语义。
 *
 * `makeStore` 每次调用返回一个**全新空 store**（可 async：PG 要建表/清表）。
 */

import { describe, it, expect } from "vitest";
import type { SessionStore, SessionEntry } from "@harness-pi/core";

function msg(text: string): SessionEntry {
  return { kind: "message", message: { role: "user", content: text, timestamp: 0 } };
}

export function runSessionStoreContract(
  name: string,
  makeStore: () => SessionStore | Promise<SessionStore>,
): void {
  describe(`SessionStore contract: ${name}`, () => {
    it("appendEntry chains parentId, increments seq, preserves entry", async () => {
      const s = await makeStore();
      const a = await s.appendEntry("s1", msg("a"));
      const b = await s.appendEntry("s1", msg("b"));
      expect(a.parentId).toBeNull();
      expect(a.seq).toBe(1);
      expect(b.parentId).toBe(a.id);
      expect(b.seq).toBe(2);
      expect(a.entry).toEqual(msg("a"));
      expect(a.id).not.toBe(b.id);
    });

    it("getLeafId is null for an empty session and tracks the last append", async () => {
      const s = await makeStore();
      expect(await s.getLeafId("s1")).toBeNull();
      const a = await s.appendEntry("s1", msg("a"));
      expect(await s.getLeafId("s1")).toBe(a.id);
      const b = await s.appendEntry("s1", msg("b"));
      expect(await s.getLeafId("s1")).toBe(b.id);
    });

    it("getPathToLeaf returns ordered root→leaf", async () => {
      const s = await makeStore();
      await s.appendEntry("s1", msg("a"));
      await s.appendEntry("s1", msg("b"));
      await s.appendEntry("s1", msg("c"));
      const path = await s.getPathToLeaf("s1");
      expect(path.map((e) => (e.entry.kind === "message" ? e.entry.message.content : ""))).toEqual([
        "a",
        "b",
        "c",
      ]);
      expect(path.map((e) => e.seq)).toEqual([1, 2, 3]);
    });

    it("getPathToLeaf with an explicit mid-chain leafId returns the prefix up to it", async () => {
      const s = await makeStore();
      await s.appendEntry("s1", msg("a"));
      const b = await s.appendEntry("s1", msg("b"));
      await s.appendEntry("s1", msg("c"));
      const path = await s.getPathToLeaf("s1", b.id);
      expect(path.map((e) => (e.entry.kind === "message" ? e.entry.message.content : ""))).toEqual([
        "a",
        "b",
      ]);
    });

    it("getPathToLeaf is empty for an unknown session", async () => {
      const s = await makeStore();
      expect(await s.getPathToLeaf("nope")).toEqual([]);
    });

    it("getPathToLeaf is empty for an unknown/cross-session leafId (first-hop miss)", async () => {
      const s = await makeStore();
      await s.appendEntry("s1", msg("a"));
      expect(await s.getPathToLeaf("s1", "no-such-entry")).toEqual([]);
    });

    it("round-trips all three entry kinds", async () => {
      const s = await makeStore();
      await s.appendEntry("s1", { kind: "message", message: { role: "user", content: "m", timestamp: 0 } });
      await s.appendEntry("s1", { kind: "compaction_boundary", summary: { role: "user", content: "sum", timestamp: 0 } });
      await s.appendEntry("s1", {
        kind: "terminal",
        result: { turns: 1, continuations: 0, reason: "done", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
      });
      const path = await s.getPathToLeaf("s1");
      expect(path.map((e) => e.entry.kind)).toEqual([
        "message",
        "compaction_boundary",
        "terminal",
      ]);
    });

    it("isolates sessions", async () => {
      const s = await makeStore();
      await s.appendEntry("s1", msg("a"));
      await s.appendEntry("s2", msg("x"));
      await s.appendEntry("s2", msg("y"));
      expect((await s.getPathToLeaf("s1")).length).toBe(1);
      expect((await s.getPathToLeaf("s2")).length).toBe(2);
    });

    it("fork copies the prefix into a new session, leaves the parent untouched", async () => {
      const s = await makeStore();
      await s.appendEntry("s1", msg("a"));
      const b = await s.appendEntry("s1", msg("b"));
      await s.appendEntry("s1", msg("c"));

      const forkId = await s.fork("s1", b.id);
      expect(forkId).not.toBe("s1");

      // fork 只含到 b 的前缀；新 id、重建 parent 链、seq 在新 session 里从 1 重新计数。
      const forkPath = await s.getPathToLeaf(forkId);
      expect(forkPath.map((e) => (e.entry.kind === "message" ? e.entry.message.content : ""))).toEqual(["a", "b"]);
      expect(forkPath[0]!.parentId).toBeNull();
      expect(forkPath[1]!.parentId).toBe(forkPath[0]!.id);
      expect(forkPath.map((e) => e.seq)).toEqual([1, 2]);
      // 新 id 与父 session 不同。
      expect(forkPath[0]!.id).not.toBe((await s.getPathToLeaf("s1"))[0]!.id);

      // 父 session 一字不动（仍是 a,b,c）。
      const parentPath = await s.getPathToLeaf("s1");
      expect(parentPath.map((e) => (e.entry.kind === "message" ? e.entry.message.content : ""))).toEqual(["a", "b", "c"]);
    });

    it("fork records lineage; non-forked sessions have none", async () => {
      const s = await makeStore();
      const a = await s.appendEntry("s1", msg("a"));
      const forkId = await s.fork("s1", a.id);
      expect(await s.getLineage(forkId)).toEqual({ parentSessionId: "s1", fromEntryId: a.id });
      expect(await s.getLineage("s1")).toBeNull();
    });

    it("a forked session can be appended to independently of its parent", async () => {
      const s = await makeStore();
      const a = await s.appendEntry("s1", msg("a"));
      const forkId = await s.fork("s1", a.id);
      await s.appendEntry(forkId, msg("fork-only"));
      const parentNext = await s.appendEntry("s1", msg("parent-only"));
      expect((await s.getPathToLeaf(forkId)).map((e) => (e.entry.kind === "message" ? e.entry.message.content : ""))).toEqual(["a", "fork-only"]);
      expect((await s.getPathToLeaf("s1")).map((e) => (e.entry.kind === "message" ? e.entry.message.content : ""))).toEqual(["a", "parent-only"]);
      // 父 session 的 seq 不被 fork 的命名空间污染：fork 后向父 append 仍接 seq=2。
      expect(parentNext.seq).toBe(2);
    });

    it("fork from an unknown entry throws", async () => {
      const s = await makeStore();
      await s.appendEntry("s1", msg("a"));
      await expect(s.fork("s1", "no-such-entry")).rejects.toThrow();
    });
  });
}
