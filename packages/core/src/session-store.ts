/**
 * SessionStore —— 会话持久化协议（内核协议；具体落盘实现在 adapter）。
 *
 * 设计依据：docs/09-bidding-core-parity-design.md §3.4。
 *
 * 内核只定义**协议 + append-only/lineage 语义**；`MemorySessionStore` 是内核自带的
 * 测试/默认实现，`JsonlSessionStore` / `PostgresSessionStore` 等落盘实现下沉到 adapter
 * （内核零 `pg` / 零文件依赖）。
 *
 * 语义（借鉴 pi branching tree / codex rollout / kimi SessionStorage）：
 *   - **append-only**：只追加，从不改已有 entry。
 *   - **lineage**：每个 entry 有 `parentId`，串成从 root 到 leaf 的链（未来可分叉成树）。
 *   - **leaf pointer**：每个 sessionId 记一个当前 leaf；append 自动挂到 leaf 之后并推进 leaf。
 */

import type { Message } from "@mariozechner/pi-ai";
import { randomUUID } from "node:crypto";

/**
 * 一条会话条目的**内容**。domain-free：内核不认识 question/evidence/judgment。
 *
 * - `message`：一条对话消息（user / assistant / toolResult）。
 * - `compaction_boundary`：一次 compaction 的边界 —— `summary` 替换了它**之前**的前缀。
 *   resume 重放时遇到 boundary，只取 summary，不重发被替换的前缀（四大 harness 共识）。
 *
 * **不可变契约**：entry（及其内部 `Message`）一旦落库即视为不可变。store 出于性能不深拷贝，
 * 调用方**不得**原地修改从 `getPathToLeaf` 取回的 entry（否则会跨 fork/session 串改）。
 *
 * **待补变体**（设计依据 docs/09 §3.4 附录 A）：`{ kind: "terminal"; result: TerminalResult }`
 * 随 `TerminalResult`（Task #3）落地，由 resume 机制（Task #4）在每个 turn 结束时 append。
 * 本模块当前只承诺 `message` / `compaction_boundary` —— 它们已足够支撑 store 协议与回溯。
 */
export type SessionEntry =
  | { kind: "message"; message: Message }
  | { kind: "compaction_boundary"; summary: Message };

/** 落库后的条目：内核分配 `id` / `parentId` / `seq`，调用方只给 `entry` 内容。 */
export interface StoredEntry {
  id: string;
  /** 上一条 entry 的 id；session 第一条为 `null`。 */
  parentId: string | null;
  /** 单调递增序号（同 session 内），用于稳定排序与调试。 */
  seq: number;
  entry: SessionEntry;
}

/** fork 的血缘记录：新 session 从哪个父 session 的哪个 entry 分叉而来。 */
export interface ForkLineage {
  parentSessionId: string;
  fromEntryId: string;
}

/**
 * 会话存储协议。`append` 自动把新 entry 挂到当前 leaf 之后并推进 leaf；
 * 读取通过从 leaf 沿 `parentId` 回溯重建有序列表。
 *
 * **并发契约（所有实现都必须遵守）**：对**同一 sessionId** 的 `appendEntry` / `fork`
 * 必须**串行**调用 —— 它们是 read-leaf → write-leaf 的读改写，并发会读到同一个 leaf、
 * 生成 parentId 相同的两条 entry，把单链劈成树、leaf 指针互相覆盖、seq 重号。
 * `MemorySessionStore` 靠单线程 + 方法内无 `await` 天然满足；落盘 adapter（Postgres）
 * **必须**用 `parentId` 唯一约束或行锁兜底。不同 sessionId 之间无此约束，可并发。
 *
 * **sessionId 命名空间**：本协议不强制"先创建 session"——`appendEntry` 对未知 sessionId
 * 隐式 lazy-create。session 间的隔离因此依赖 sessionId 全局唯一（`fork` 用 `randomUUID()`
 * 生成新 id 即为此）。调用方若自带 sessionId，须自行保证不撞。
 */
export interface SessionStore {
  /** 追加一条 entry，挂到当前 leaf 之后；返回落库后的 `StoredEntry`。见接口级并发契约。 */
  appendEntry(sessionId: string, entry: SessionEntry): Promise<StoredEntry>;
  /** 当前 leaf 的 id；空 session 返回 `null`。 */
  getLeafId(sessionId: string): Promise<string | null>;
  /**
   * 从 root 到 `leafId`（默认当前 leaf）的有序条目。
   * - 未知 session / 未知或跨 session 的 `leafId`（第一跳就查不到）→ 合法空结果 `[]`。
   * - 但若从合法 leaf 回溯时**中途断链**（某 `parentId` 指向不存在的 entry）→ 视为
   *   不变量被破坏（数据损坏），**抛错**而非静默返回半截历史。
   */
  getPathToLeaf(sessionId: string, leafId?: string): Promise<StoredEntry[]>;
  /**
   * 从 `fromEntryId`（含）的前缀**复制**出一个新 session，返回新 sessionId。
   * append-only：复制出新 id，父 session 一字不动；记录 lineage。
   *
   * **语义是批量复制前缀**：落盘 adapter 应实现为**一次批量插入**，不要逐条 round-trip。
   * （`MemorySessionStore` 逐条 `appendEntry` 仅因其为 O(1) 内存写。）
   */
  fork(sessionId: string, fromEntryId: string): Promise<string>;
  /** 返回该 session 的 fork 血缘（**直接父**，非始祖）；非 fork 出来的 session 返回 `null`。 */
  getLineage(sessionId: string): Promise<ForkLineage | null>;
}

/** 内存实现：测试与默认用。进程退出即丢，不做持久化。 */
export class MemorySessionStore implements SessionStore {
  private readonly _entries = new Map<string, Map<string, StoredEntry>>();
  private readonly _leaf = new Map<string, string | null>();
  private readonly _seq = new Map<string, number>();
  private readonly _lineage = new Map<string, ForkLineage>();

  /** 取（或 lazy-create）某 session 的 entryId→entry 索引。 */
  private _indexOf(sessionId: string): Map<string, StoredEntry> {
    let m = this._entries.get(sessionId);
    if (!m) {
      m = new Map();
      this._entries.set(sessionId, m);
    }
    return m;
  }

  async appendEntry(sessionId: string, entry: SessionEntry): Promise<StoredEntry> {
    const index = this._indexOf(sessionId);
    const seq = (this._seq.get(sessionId) ?? 0) + 1;
    const stored: StoredEntry = {
      id: randomUUID(),
      parentId: this._leaf.get(sessionId) ?? null,
      seq,
      entry,
    };
    index.set(stored.id, stored);
    this._leaf.set(sessionId, stored.id);
    this._seq.set(sessionId, seq);
    return stored;
  }

  async getLeafId(sessionId: string): Promise<string | null> {
    return this._leaf.get(sessionId) ?? null;
  }

  async getPathToLeaf(sessionId: string, leafId?: string): Promise<StoredEntry[]> {
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
        // 已经从合法 leaf 走进来，中途 parentId 指向不存在的 entry：
        // 这是 append-only 单链的不变量被破坏（数据损坏），不能静默返回半截历史。
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
      throw new Error(`fork: entry ${fromEntryId} not found in session ${sessionId}`);
    }
    const forkId = randomUUID();
    // 逐条复制前缀（新 id，重建 parent 链），父 session 不动 —— append-only。
    for (const node of prefix) {
      await this.appendEntry(forkId, node.entry);
    }
    this._lineage.set(forkId, { parentSessionId: sessionId, fromEntryId });
    return forkId;
  }

  async getLineage(sessionId: string): Promise<ForkLineage | null> {
    return this._lineage.get(sessionId) ?? null;
  }
}
