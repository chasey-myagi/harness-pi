import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  appendFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry } from "@harness-pi/core";
import { JsonlSessionStore } from "../jsonl-session-store.js";
import { runSessionStoreContract } from "./contract.js";

/** 每次返回一个新文件路径下的空 store。 */
function freshStore(): JsonlSessionStore {
  const dir = mkdtempSync(join(tmpdir(), "harness-jsonl-"));
  return new JsonlSessionStore(join(dir, "session.jsonl"));
}

function msg(text: string): SessionEntry {
  return { kind: "message", message: { role: "user", content: text, timestamp: 0 } };
}

/** 手写一条合法的 entry 日志行（用于直接构造文件内容做损坏/断链测试）。 */
function entryLine(sid: string, id: string, parentId: string | null, seq: number, content: string): string {
  return JSON.stringify({ t: "entry", sid, e: { id, parentId, seq, entry: msg(content) } });
}

// 跑通用契约套件。
runSessionStoreContract("JsonlSessionStore", freshStore);

// JSONL 特有：durability / reload。
describe("JsonlSessionStore durability", () => {
  it("reloads the full lineage from the log file on reconstruction", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-jsonl-reload-"));
    const path = join(dir, "s.jsonl");

    const s1 = new JsonlSessionStore(path);
    await s1.appendEntry("sess", { kind: "message", message: { role: "user", content: "one", timestamp: 0 } });
    const b = await s1.appendEntry("sess", { kind: "message", message: { role: "user", content: "two", timestamp: 0 } });
    const forkId = await s1.fork("sess", b.id);

    // 全新实例从同一文件回放重建。
    const s2 = new JsonlSessionStore(path);
    expect(await s2.getLeafId("sess")).toBe(b.id);
    const path2 = await s2.getPathToLeaf("sess");
    expect(path2.map((e) => (e.entry.kind === "message" ? e.entry.message.content : ""))).toEqual(["one", "two"]);
    // fork 的 lineage + 前缀也被回放。
    expect(await s2.getLineage(forkId)).toEqual({ parentSessionId: "sess", fromEntryId: b.id });
    expect((await s2.getPathToLeaf(forkId)).length).toBe(2);

    // fork 写入的 entry 行被回放后，_seq 对该 forked session 重建正确：post-reload append 接 seq=3。
    const d = await s2.appendEntry(forkId, msg("after-reload"));
    expect(d.seq).toBe(3);
    expect((await s2.getPathToLeaf(forkId)).length).toBe(3);

    rmSync(dir, { recursive: true, force: true });
  });

  it("appends keep seq monotonic across reload (no seq reset / collision)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-jsonl-seq-"));
    const path = join(dir, "s.jsonl");

    const s1 = new JsonlSessionStore(path);
    await s1.appendEntry("sess", { kind: "message", message: { role: "user", content: "1", timestamp: 0 } });
    await s1.appendEntry("sess", { kind: "message", message: { role: "user", content: "2", timestamp: 0 } });

    const s2 = new JsonlSessionStore(path);
    const c = await s2.appendEntry("sess", { kind: "message", message: { role: "user", content: "3", timestamp: 0 } });
    expect(c.seq).toBe(3); // 接着 reload 出来的 seq=2 继续，不从 1 重来
    expect((await s2.getPathToLeaf("sess")).map((e) => e.seq)).toEqual([1, 2, 3]);

    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the parent directory if missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-jsonl-mkdir-"));
    const nested = join(dir, "a", "b", "c", "session.jsonl");
    expect(() => new JsonlSessionStore(nested)).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a brand-new store with no file is empty (no crash)", async () => {
    const s = freshStore();
    expect(await s.getLeafId("x")).toBeNull();
    expect(await s.getPathToLeaf("x")).toEqual([]);
    expect(existsSync).toBeTruthy();
  });

  it("throws on a corrupt log line in the MIDDLE of the file (real corruption, not a torn tail)", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-jsonl-corrupt-"));
    const path = join(dir, "s.jsonl");
    // 坏行在中段（后面还有合法行）→ 真损坏，必须抛错。
    writeFileSync(
      path,
      entryLine("s", "A", null, 1, "a") + "\nNOT JSON AT ALL\n" + entryLine("s", "B", "A", 2, "b") + "\n",
    );
    expect(() => new JsonlSessionStore(path)).toThrow(/corrupt log/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("tolerates a torn (truncated) trailing line — recovers all prior history", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-jsonl-torn-"));
    const path = join(dir, "s.jsonl");
    const s1 = new JsonlSessionStore(path);
    await s1.appendEntry("s", msg("a"));
    const b = await s1.appendEntry("s", msg("b"));
    // 模拟崩溃在追加第三条时只写了半截（无换行、JSON 截断）。
    appendFileSync(path, '{"t":"entry","sid":"s","e":{"id":"C","paren');
    const s2 = new JsonlSessionStore(path);
    // torn 尾行被丢弃，前两条完整恢复（不让一条半截行使整个 store 读不出来）。
    expect(await s2.getLeafId("s")).toBe(b.id);
    expect(
      (await s2.getPathToLeaf("s")).map((e) => (e.entry.kind === "message" ? e.entry.message.content : "")),
    ).toEqual(["a", "b"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("ignores blank / whitespace-only lines on reload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-jsonl-blank-"));
    const path = join(dir, "s.jsonl");
    const s1 = new JsonlSessionStore(path);
    await s1.appendEntry("s", msg("a"));
    appendFileSync(path, "\n   \n\n");
    const s2 = new JsonlSessionStore(path);
    expect((await s2.getPathToLeaf("s")).length).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("tolerates a shape-valid-but-payload-missing trailing line (parseable torn write)", async () => {
    // torn write 也能产生「parse 得了但形状残缺」的尾行（崩溃停在 `{\"t\":\"entry\"}` 后）。
    // 只验 t 字段会让它漏过 torn 分支、后续读 e.id 抛裸 TypeError 把整库读崩——必须当 torn 容忍。
    const dir = mkdtempSync(join(tmpdir(), "harness-jsonl-shape-tail-"));
    const path = join(dir, "s.jsonl");
    const s1 = new JsonlSessionStore(path);
    await s1.appendEntry("s", msg("a"));
    const b = await s1.appendEntry("s", msg("b"));
    appendFileSync(path, '{"t":"entry"}\n'); // 合法 JSON、但缺载荷 e
    const s2 = new JsonlSessionStore(path);
    expect(await s2.getLeafId("s")).toBe(b.id);
    expect(
      (await s2.getPathToLeaf("s")).map((e) => (e.entry.kind === "message" ? e.entry.message.content : "")),
    ).toEqual(["a", "b"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws corrupt-log on a shape-valid-but-payload-missing line in the MIDDLE", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-jsonl-shape-mid-"));
    const path = join(dir, "s.jsonl");
    // 残缺行在中段（后面还有合法行）→ 真损坏，抛 /corrupt log/（而非裸 TypeError）。
    writeFileSync(
      path,
      entryLine("s", "A", null, 1, "a") + '\n{"t":"entry"}\n' + entryLine("s", "B", "A", 2, "b") + "\n",
    );
    expect(() => new JsonlSessionStore(path)).toThrow(/corrupt log/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("getPathToLeaf throws on a broken lineage (leaf's parentId points to a missing entry)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-jsonl-broken-"));
    const path = join(dir, "s.jsonl");
    const s1 = new JsonlSessionStore(path);
    await s1.appendEntry("s", msg("a"));
    // 追加一条 leaf 指向幽灵 parent 的合法 entry（解析得了，但链断了）。
    appendFileSync(path, entryLine("s", "B", "GHOST", 2, "b") + "\n");
    const s2 = new JsonlSessionStore(path);
    // 回放 OK（B 是合法行、成为 leaf），但从 leaf 回溯到不存在的 GHOST → 数据损坏，抛错。
    await expect(s2.getPathToLeaf("s")).rejects.toThrow(/broken lineage/);
    rmSync(dir, { recursive: true, force: true });
  });
});
