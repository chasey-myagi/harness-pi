/**
 * JsonlSessionStore —— 文件落盘的 SessionStore 适配器（docs/09 §4.5，#12）。
 *
 * 实现内核的 `SessionStore` 协议（packages/core/src/session-store.ts）：append-only / lineage /
 * leaf 指针。落盘形态是 **append-only 的 JSONL 追加日志**——每次 appendEntry / fork 追加若干行
 * JSON 记录；构造时回放整个文件重建内存索引（与 `MemorySessionStore` 同构的索引 + 读路径）。
 *
 * 读路径（getLeafId / getPathToLeaf）全走内存索引，O(链长)；只有写才碰盘。
 *
 * **持久性边界（诚实声明）**：写用 `appendFileSync`，数据交给 OS page cache 但**不 fsync**。
 *   - **进程崩溃**（异常退出 / OOM）：已 append 的行都在 OS 里，重启回放可完整恢复。
 *   - **断电 / 内核 panic**：最后若干尚未刷盘的写可能丢；且崩溃可能在尾部留下一条**半截（torn）记录**。
 *     回放对**末尾**那条解析失败的记录是容忍的（丢弃它、恢复其余全部历史，见 `_load`）——绝不让一条
 *     torn 尾行使整个 store 读不出来；但文件**中段**的坏行视为真损坏、响亮抛错。
 *   要更强的断电持久性请自行 fsync 或换 `PostgresSessionStore`。
 *
 * **并发契约**：与协议一致——同一 sessionId 的 appendEntry / fork 必须串行。本实现的读改写在内存里
 * 同步完成（无 await 穿插），单进程内天然串行；**跨进程**写同一文件没有加锁，调用方须自行保证单写者。
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  SessionStore,
  SessionEntry,
  StoredEntry,
  ForkLineage,
} from "@harness-pi/core";

/** JSONL 日志的一行记录（追加日志的最小单元）。 */
type LogRecord =
  | { t: "entry"; sid: string; e: StoredEntry }
  | { t: "lineage"; sid: string; l: ForkLineage };

/**
 * 运行时形状校验：判别字段 **和载荷一起**验。torn write 不只产生「parse 不了的 JSON」，也可能产生
 * 「parse 得了但形状残缺」的记录（崩溃恰好停在写出 `{"t":"entry"}` 之后）——只验 `t` 会让这种残缺行
 * 漏过 torn/throw 分支、后续读 `e.id` 抛裸 TypeError 把整库读崩。这里连 entry 实际要用的 id/seq、
 * lineage 的 l 一起验，残缺行一律判为非法（→ 走 torn 容忍 / 中段抛错）。
 */
function isLogRecord(x: unknown): x is LogRecord {
  if (typeof x !== "object" || x === null) return false;
  const r = x as { t?: unknown; sid?: unknown; e?: unknown; l?: unknown };
  if (typeof r.sid !== "string") return false;
  if (r.t === "entry") {
    const e = r.e as { id?: unknown; seq?: unknown } | null | undefined;
    return (
      typeof e === "object" &&
      e !== null &&
      typeof e.id === "string" &&
      typeof e.seq === "number"
    );
  }
  if (r.t === "lineage") {
    return typeof r.l === "object" && r.l !== null;
  }
  return false;
}

export class JsonlSessionStore implements SessionStore {
  private readonly _entries = new Map<string, Map<string, StoredEntry>>();
  private readonly _leaf = new Map<string, string | null>();
  private readonly _seq = new Map<string, number>();
  private readonly _lineage = new Map<string, ForkLineage>();

  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    if (existsSync(filePath)) this._load();
  }

  private _indexOf(sessionId: string): Map<string, StoredEntry> {
    let m = this._entries.get(sessionId);
    if (!m) {
      m = new Map();
      this._entries.set(sessionId, m);
    }
    return m;
  }

  /**
   * 回放整个 JSONL 日志重建内存索引。空行忽略。
   *
   * 坏行处理区分两种情形（append-only 下，崩溃只可能在**尾部**留下半截记录）：
   *   - **末尾**那条解析失败 / 形状非法的记录 = torn write，**容忍**（丢弃它、恢复其余全部历史）。
   *   - **中段**坏行 = 真损坏，**抛错**（不静默返回半截历史）。
   */
  private _load(): void {
    const text = readFileSync(this.filePath, "utf8");
    const lines = text.split("\n");
    // 最后一条非空行的下标——只有它可能是崩溃中途未写完的 torn 行。
    let lastNonEmpty = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i]!.trim().length > 0) {
        lastNonEmpty = i;
        break;
      }
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim().length === 0) continue;

      let rec: LogRecord | null = null;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isLogRecord(parsed)) rec = parsed;
      } catch {
        rec = null;
      }

      if (rec === null) {
        // 只容忍**最后一条**非空行 torn（append-only 下一次只可能在尾部留半截一条）；尾部连续多条坏行时，
        // 倒数第二条坏行不是 lastNonEmpty → 在它处抛 corrupt log（保守、正确）。
        if (i === lastNonEmpty) break; // torn 尾行：容忍，恢复其余历史。
        throw new Error(
          `JsonlSessionStore: corrupt log at ${this.filePath}:${i + 1}`,
        );
      }

      if (rec.t === "entry") {
        this._indexOf(rec.sid).set(rec.e.id, rec.e);
        this._leaf.set(rec.sid, rec.e.id);
        const prev = this._seq.get(rec.sid) ?? 0;
        if (rec.e.seq > prev) this._seq.set(rec.sid, rec.e.seq);
      } else {
        this._lineage.set(rec.sid, rec.l);
      }
    }
  }

  private _writeLines(records: LogRecord[]): void {
    if (records.length === 0) return;
    appendFileSync(
      this.filePath,
      records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
  }

  async appendEntry(
    sessionId: string,
    entry: SessionEntry,
  ): Promise<StoredEntry> {
    const seq = (this._seq.get(sessionId) ?? 0) + 1;
    const stored: StoredEntry = {
      id: randomUUID(),
      parentId: this._leaf.get(sessionId) ?? null,
      seq,
      entry,
    };
    // 先写日志（append 到 OS，不 fsync——见文件头持久性边界）再更内存：写失败则抛错、内存不被污染。
    this._writeLines([{ t: "entry", sid: sessionId, e: stored }]);
    this._indexOf(sessionId).set(stored.id, stored);
    this._leaf.set(sessionId, stored.id);
    this._seq.set(sessionId, seq);
    return stored;
  }

  async getLeafId(sessionId: string): Promise<string | null> {
    return this._leaf.get(sessionId) ?? null;
  }

  async getPathToLeaf(
    sessionId: string,
    leafId?: string,
  ): Promise<StoredEntry[]> {
    const index = this._entries.get(sessionId);
    if (!index) return [];
    const start = leafId ?? this._leaf.get(sessionId) ?? null;
    if (start === null) return [];
    // 第一跳就查不到：未知 / 跨 session 的 leafId —— 合法空结果。
    if (!index.has(start)) return [];

    const path: StoredEntry[] = [];
    let cur: string | null = start;
    while (cur !== null) {
      const node = index.get(cur);
      if (!node) {
        // 从合法 leaf 走进来后中途断链：append-only 单链不变量被破坏（日志损坏），不静默返回半截。
        throw new Error(
          `getPathToLeaf: broken lineage in session ${sessionId}: entry ${cur} referenced but not found`,
        );
      }
      path.push(node);
      cur = node.parentId;
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
    const forkIndex = this._indexOf(forkId);
    const records: LogRecord[] = [];
    // 批量复制前缀（新 id，重建 parent 链），一次性 append —— 符合协议「fork 是批量插入」。
    let prevId: string | null = null;
    let seq = 0;
    for (const node of prefix) {
      const stored: StoredEntry = {
        id: randomUUID(),
        parentId: prevId,
        seq: ++seq,
        entry: node.entry,
      };
      forkIndex.set(stored.id, stored);
      records.push({ t: "entry", sid: forkId, e: stored });
      prevId = stored.id;
    }
    const lineage: ForkLineage = { parentSessionId: sessionId, fromEntryId };
    records.push({ t: "lineage", sid: forkId, l: lineage });
    this._writeLines(records);
    this._leaf.set(forkId, prevId);
    this._seq.set(forkId, seq);
    this._lineage.set(forkId, lineage);
    return forkId;
  }

  async getLineage(sessionId: string): Promise<ForkLineage | null> {
    return this._lineage.get(sessionId) ?? null;
  }
}
