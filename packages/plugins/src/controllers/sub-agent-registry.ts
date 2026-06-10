/**
 * subAgent 续聊句柄 —— 一个 **bounded** registry：把已 spawn 的子 session 按 id 留住，让父能按 id 续聊（S4 / 0.3.0）。
 *
 * **资源安全是头等约束**：cc 曾因 sub-agent 句柄无界保留爆 36.8GB 内存。故本 registry 三道闸：
 *   - **硬上限** `maxRetained`（默认 16）：超上限按 **LRU** 驱逐最久未用的；
 *   - **TTL** `ttlMs`（默认 5 分钟）：每次 retain/continue 前先扫掉过期项；
 *   - **父 abort 清空**：父 signal abort → 清空全部（子 session 不再可续，让 GC 回收）。
 *
 * **opt-in**：默认 `subAgentTool` 不接 registry（子 session 跑完即弃，0.2.4 逐字节一致）。只有调用方把
 * `registry.retain` 接到 `subAgentTool({ onSpawn })` 上，子 session 才被留住。
 *
 * **domain-free**：registry 不认识任何业务；它只持有 AgentSession 句柄 + 调内核已有的 `session.run(...)`。
 */

import type { AgentSession, ToolExecResult } from "@harness-pi/core";
import { subAgentResult } from "./sub-agent-tool.js";

/** 一个被留住的子 session 句柄 + 它最后一次被用到的时刻（LRU/TTL 判据）。 */
interface RetainedEntry {
  session: AgentSession;
  lastUsedMs: number;
}

export interface SubAgentRegistryOptions {
  /** 最多留住多少个子 session（**硬上限**，超出按 LRU 驱逐）。默认 16。 */
  maxRetained?: number;
  /** 留存存活时长（毫秒）；超过未用即被驱逐。默认 5 分钟。 */
  ttlMs?: number;
  /**
   * 父 session 的 abort signal。一旦 abort → 清空全部留存（子 session 不再可续）。
   * 不传则不绑定（调用方需自行管理生命周期 / 显式 `clear()`）。
   */
  parentSignal?: AbortSignal;
}

const DEFAULT_MAX_RETAINED = 16;
const DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * Bounded sub-agent 续聊 registry。典型用法：
 *
 * ```ts
 * const registry = new SubAgentRegistry({ parentSignal: ctx.signal });
 * const tool = subAgentTool({ sessionFactory, onSpawn: registry.retain });
 * // 父模型先 spawn（details.subAgent.sessionId 拿到 id），之后：
 * const result = await registry.continueSubAgent(id, "再补一句", { signal });
 * ```
 */
export class SubAgentRegistry {
  private readonly _maxRetained: number;
  private readonly _ttlMs: number;
  private readonly _entries = new Map<string, RetainedEntry>();

  constructor(opts: SubAgentRegistryOptions = {}) {
    this._maxRetained = opts.maxRetained ?? DEFAULT_MAX_RETAINED;
    this._ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    // 父 abort → 清空全部（资源安全：句柄不在 abort 后泄漏）。once 即可，abort 不可逆。
    opts.parentSignal?.addEventListener("abort", () => this.clear(), { once: true });
  }

  /** 当前留存数量（测试 / 观测用）。 */
  get size(): number {
    return this._entries.size;
  }

  /**
   * retain 回调：接到 `subAgentTool({ onSpawn })` 上，把 spawn 出的子 session 留住。
   * 箭头属性（非方法）→ 解构传递时 `this` 不丢。retain 时先扫 TTL 过期项，再按 LRU 收口到上限内。
   */
  readonly retain = (session: AgentSession): void => {
    const now = Date.now();
    this._evictExpired(now);
    // 重复 retain 同一 id：刷新 lastUsedMs（视为「刚用过」），不重复占名额。
    this._entries.set(session.id, { session, lastUsedMs: now });
    this._evictOverflow();
  };

  /**
   * 按 id 续聊一个已留住的子 session：调内核已有的 `session.run(message)`（追加新 user prompt 跑到结束，
   * 保留此前上下文）→ 返回与 `spawnSubAgent` **同形状**的 ToolExecResult（text + details 含 sessionId + usage）。
   *
   * id 不存在 / 已被驱逐（LRU/TTL/abort）→ 抛清晰 error（不静默返回空）。
   */
  async continueSubAgent(
    id: string,
    message: string,
    runOpts?: { signal?: AbortSignal },
  ): Promise<ToolExecResult> {
    const now = Date.now();
    this._evictExpired(now);
    const entry = this._entries.get(id);
    if (!entry) {
      throw new Error(
        `SubAgentRegistry: no retained sub-agent for id "${id}" ` +
          `(unknown, or evicted by TTL/LRU/parent-abort)`,
      );
    }
    entry.lastUsedMs = now;
    const summary = await entry.session.run(message, runOpts);
    // 续聊后再刷新一次：run 可能耗时较长，按「用完」的时刻记 lastUsedMs，LRU 更准。
    entry.lastUsedMs = Date.now();
    return subAgentResult(entry.session, summary);
  }

  /** 清空全部留存（父 abort 时自动调；也可手动调）。 */
  clear(): void {
    this._entries.clear();
  }

  /** 扫掉所有超过 TTL 的项。 */
  private _evictExpired(now: number): void {
    for (const [id, entry] of this._entries) {
      if (now - entry.lastUsedMs >= this._ttlMs) {
        this._entries.delete(id);
      }
    }
  }

  /** 超上限则按 LRU（lastUsedMs 最小）逐个驱逐，直到收口到上限内。 */
  private _evictOverflow(): void {
    while (this._entries.size > this._maxRetained) {
      let lruId: string | undefined;
      let lruMs = Infinity;
      for (const [id, entry] of this._entries) {
        if (entry.lastUsedMs < lruMs) {
          lruMs = entry.lastUsedMs;
          lruId = id;
        }
      }
      if (lruId === undefined) break;
      this._entries.delete(lruId);
    }
  }
}
