/**
 * LeaseQueue —— 单 item lease 模型；K 个 worker 各持一个 lease，处理完领下一个。
 *
 * 跟 WorkPool 的区别：动态领单，适合 item 完成时间分布极不均的场景。
 * 失败的 item 可重试（attempt 计数 + maxAttempts 兜底）。
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

export type LeaseStatus = "done" | "error" | "conflict";

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

    const workerCount = Math.min(
      this.opts.concurrency,
      this.opts.items.length,
    );
    const workers: Promise<void>[] = [];

    for (let i = 0; i < workerCount; i++) {
      const workerId = `worker-${i}`;
      workers.push(
        this._workerLoop(
          workerId,
          pending,
          attempts,
          maxAttempts,
          signal,
          (item, status, summary, error) => {
            if (status === "done") completed++;
            else if (status === "conflict") conflicted++;
            else failed++;
            this.opts.onItemComplete?.(item, status, summary, error);
          },
        ),
      );
    }

    await Promise.all(workers);

    return {
      totalItems: this.opts.items.length,
      completed,
      failed,
      conflicted,
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
