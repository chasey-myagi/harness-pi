/**
 * WorkPool —— 把 N 个 work item 分组后并行跑到 K 个 session。
 *
 * 跟 LeaseQueue 的区别：WorkPool 把 items 静态分组（如按 heading），每 group
 * 一个 worker 跑完；LeaseQueue 是动态领单制，worker 持 lease 完了领下一题。
 *
 * 详见 docs/06-controllers.md §4。
 */

import type { AgentSession, RunSummary } from "@harness-pi/core";

export interface WorkItem {
  id: string;
}

export interface WorkGroup<I extends WorkItem> {
  id: string;
  items: I[];
}

export interface WorkPoolOptions<I extends WorkItem> {
  items: I[];
  /** 把 items 切成 groups。每个 group 一个 session 跑。 */
  partition: (items: I[]) => WorkGroup<I>[];
  /** 给某个 group 创建 session + prompt。 */
  workerFactory: (
    group: WorkGroup<I>,
  ) => Promise<{ session: AgentSession; prompt: string }>;
  /** 最大并发 worker 数。默认 = groups.length。 */
  maxConcurrency?: number;
  /** 单 group 完成回调（progress / metric）。 */
  onGroupComplete?: (groupId: string, summary: RunSummary) => void;
  /** 单 group 失败回调（factory 抛或 run 抛）。 */
  onGroupError?: (groupId: string, err: Error) => void;
}

export interface WorkPoolResult {
  groups: Array<{ id: string; summary?: RunSummary; error?: Error }>;
  totalItems: number;
  completedGroups: number;
  failedGroups: number;
}

export class WorkPool<I extends WorkItem> {
  constructor(private readonly opts: WorkPoolOptions<I>) {}

  async start(signal?: AbortSignal): Promise<WorkPoolResult> {
    const groups = this.opts.partition(this.opts.items);
    if (groups.length === 0) {
      return {
        groups: [],
        totalItems: this.opts.items.length,
        completedGroups: 0,
        failedGroups: 0,
      };
    }

    const concurrency = Math.max(
      1,
      Math.min(this.opts.maxConcurrency ?? groups.length, groups.length),
    );

    const queue = [...groups];
    const results: Array<{
      id: string;
      summary?: RunSummary;
      error?: Error;
    }> = [];
    const running = new Set<Promise<void>>();
    let completed = 0;
    let failed = 0;

    const runGroup = (g: WorkGroup<I>): Promise<void> =>
      (async () => {
        try {
          const { session, prompt } = await this.opts.workerFactory(g);
          const runOpts = signal ? { signal } : {};
          const summary = await session.run(prompt, runOpts);
          results.push({ id: g.id, summary });
          completed++;
          this.opts.onGroupComplete?.(g.id, summary);
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          results.push({ id: g.id, error: e });
          failed++;
          this.opts.onGroupError?.(g.id, e);
        }
      })();

    while (queue.length > 0 || running.size > 0) {
      if (signal?.aborted) break;
      while (running.size < concurrency && queue.length > 0) {
        const g = queue.shift()!;
        const task = runGroup(g);
        running.add(task);
        void task.finally(() => running.delete(task));
      }
      if (running.size === 0) break;
      // wait for at least one to settle so loop can refill
      await Promise.race(running);
    }

    // 即使 caller signal aborted，也要 drain in-flight workers 才能 return：
    // 否则它们继续 mutate `results / completed / failed`，caller 拿到的是 inconsistent snapshot。
    if (running.size > 0) {
      await Promise.allSettled([...running]);
    }

    return {
      groups: results,
      totalItems: this.opts.items.length,
      completedGroups: completed,
      failedGroups: failed,
    };
  }
}
