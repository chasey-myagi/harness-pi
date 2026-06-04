/**
 * LeaseQueue —— 单 item lease 模型；K 个 worker 各持一个 lease，处理完领下一个。
 *
 * 跟 WorkPool 的区别：动态领单，适合 item 完成时间分布极不均的场景。
 * 失败的 item 可重试（attempt 计数 + maxAttempts 兜底）。
 *
 * **abort 必给终态**：abort 时正在跑的 item 由内核 abort 收尾，残留(从未派发 / abort 时回退)的 item
 * 在 `start()` 末尾统一 finalize 成 `skipped` 并触发 `onItemComplete`——保证每个 item 都有终态,
 * `completed + failed + conflicted + skipped === totalItems`,不让 work item 静默消失。
 *
 * **并发安全前提**：依赖 Node.js 单线程 event loop——`pending.shift()` / `pending.splice()`
 * 在 await 之间是原子的，K 个 worker 不会竞态。任何修改请保持此契约（shift/splice 跟 length
 * 检查之间禁止插入 await）。
 *
 * 详见 docs/06-controllers.md §5。
 */

import type { AgentSession, RunSummary } from "@harness-pi/core";

export interface QueueItem {
  id: string;
}

export interface QueueLease {
  itemId: string;
  workerId: string;
  attempt: number;
}

export type LeaseStatus = "done" | "error" | "conflict" | "skipped";

export interface LeaseQueueOptions<I extends QueueItem> {
  items: I[];
  concurrency: number;
  maxAttempts?: number;
  /**
   * 给某个 item + lease 创建 session + prompt。
   * `ctx.releaseLease` 让 worker 主动放回（如 watchdog 触发时把 item 标 error 而非 done）。
   */
  workerFactory: (
    item: I,
    lease: QueueLease,
    ctx: { releaseLease: (status: LeaseStatus) => void },
  ) => Promise<{ session: AgentSession; prompt: string }>;
  /** 单 item 完成（或最终失败）时回调。error 仅在 workerFactory throw 时填。 */
  onItemComplete?: (
    item: I,
    status: LeaseStatus,
    summary?: RunSummary,
    error?: Error,
  ) => void;
}

export interface LeaseQueueResult {
  totalItems: number;
  completed: number;
  failed: number;
  conflicted: number;
  /** abort 后从未派发(或 abort 时回退)而被给终态的 item 数。completed+failed+conflicted+skipped === totalItems。 */
  skipped: number;
}

const DEFAULT_MAX_ATTEMPTS = 1;

export class LeaseQueue<I extends QueueItem> {
  constructor(private readonly opts: LeaseQueueOptions<I>) {
    if (opts.concurrency <= 0) {
      throw new Error("LeaseQueue: concurrency must be > 0");
    }
  }

  async start(signal?: AbortSignal): Promise<LeaseQueueResult> {
    const maxAttempts = this.opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const pending: I[] = [...this.opts.items];
    const attempts = new Map<string, number>();

    let completed = 0;
    let failed = 0;
    let conflicted = 0;
    let skipped = 0;

    // 单点终态裁决:worker 与下面的 abort 兜底 sweep 共用,保证每个 item 恰被 finalize 一次。
    const finalize = (
      item: I,
      status: LeaseStatus,
      summary?: RunSummary,
      error?: Error,
    ): void => {
      if (status === "done") completed++;
      else if (status === "conflict") conflicted++;
      else if (status === "skipped") skipped++;
      else failed++;
      this.opts.onItemComplete?.(item, status, summary, error);
    };

    const workerCount = Math.min(
      this.opts.concurrency,
      this.opts.items.length,
    );
    const workers: Promise<void>[] = [];

    for (let i = 0; i < workerCount; i++) {
      workers.push(
        this._workerLoop(`worker-${i}`, pending, attempts, maxAttempts, signal, finalize),
      );
    }

    await Promise.all(workers);

    // abort 后 pending 里残留的 item(从未派发 + abort 时回退重试的)必须给终态——否则「work item
    // 无终态、静默消失」,正是新原语要消灭却从旧 controller 旁路回来的问题(#31)。每个 item 至此恰
    // finalize 一次:派发并跑完的在 worker 里 finalize、未跑完的回退进 pending 在此 sweep,二者互斥。
    while (pending.length > 0) {
      const item = pending.shift()!;
      attempts.delete(item.id);
      finalize(item, "skipped");
    }

    return {
      totalItems: this.opts.items.length,
      completed,
      failed,
      conflicted,
      skipped,
    };
  }

  private async _workerLoop(
    workerId: string,
    pending: I[],
    attempts: Map<string, number>,
    maxAttempts: number,
    signal: AbortSignal | undefined,
    finalizeItem: (
      item: I,
      status: LeaseStatus,
      summary?: RunSummary,
      error?: Error,
    ) => void,
  ): Promise<void> {
    while (pending.length > 0 && !signal?.aborted) {
      const item = pending.shift();
      if (!item) break;
      const attempt = (attempts.get(item.id) ?? 0) + 1;
      attempts.set(item.id, attempt);

      const lease: QueueLease = { itemId: item.id, workerId, attempt };
      let releaseStatus: LeaseStatus | null = null;
      const releaseLease = (s: LeaseStatus): void => {
        if (!releaseStatus) releaseStatus = s;
      };

      try {
        const { session, prompt } = await this.opts.workerFactory(
          item,
          lease,
          { releaseLease },
        );
        const runOpts = signal ? { signal } : {};
        const summary = await session.run(prompt, runOpts);

        let status: LeaseStatus;
        if (releaseStatus) {
          status = releaseStatus;
        } else if (summary.reason === "done") {
          status = "done";
        } else {
          status = "error";
        }

        if (status !== "done" && attempt < maxAttempts) {
          // retry：塞到队尾让其他 item 先跑（避免同 worker 立刻又拿到同一 item）
          pending.push(item);
          continue;
        }
        attempts.delete(item.id);
        finalizeItem(item, status, summary);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxAttempts) {
          pending.push(item);
          continue;
        }
        attempts.delete(item.id);
        finalizeItem(item, "error", undefined, error);
      }
    }
  }
}
