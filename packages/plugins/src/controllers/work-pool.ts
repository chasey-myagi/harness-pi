/**
 * WorkPool —— 把 N 个 work item 分组后并行跑到 K 个 session。
 *
 * 跟 LeaseQueue 的区别：WorkPool 把 items 静态分组（如按 heading），每 group
 * 一个 worker 跑完；LeaseQueue 是动态领单制，worker 持 lease 完了领下一题。
 *
 * **abort 必给终态**：abort 时 in-flight group drain 收尾，未启动的 group 进 `results` 标
 * `skipped:"aborted"` 并触发 `onGroupSkipped`——每个 group 都有终态,
 * `completedGroups + failedGroups + skippedGroups === groups 总数`,不静默丢 group。
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
  /** abort 时未启动的 group 被跳过的回调（与 complete/error 对称,保证每个 group 都有终态信号,不静默消失）。 */
  onGroupSkipped?: (groupId: string, reason: "aborted") => void;
}

export interface WorkPoolResult {
  /** 每个 group 恰一条终态：summary（完成）/ error（失败）/ skipped（abort 时未启动）。 */
  groups: Array<{ id: string; summary?: RunSummary; error?: Error; skipped?: "aborted" }>;
  totalItems: number;
  completedGroups: number;
  failedGroups: number;
  /** abort 时未启动而被给终态的 group 数。completed+failed+skipped === groups 总数。 */
  skippedGroups: number;
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
        skippedGroups: 0,
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
      skipped?: "aborted";
    }> = [];
    const running = new Set<Promise<void>>();
    let completed = 0;
    let failed = 0;
    let skippedGroups = 0;

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

    // abort 后 queue 里未启动的 group 必须给终态(进 results + 计数 + 回调)——否则它们静默消失,
    // 调用方按 group 归账时漏项(#31)。每个 group 至此恰一条终态:跑过的在 runGroup 里 push、未启动的在此。
    while (queue.length > 0) {
      const g = queue.shift()!;
      results.push({ id: g.id, skipped: "aborted" });
      skippedGroups++;
      this.opts.onGroupSkipped?.(g.id, "aborted");
    }

    return {
      groups: results,
      totalItems: this.opts.items.length,
      completedGroups: completed,
      failedGroups: failed,
      skippedGroups,
    };
  }
}
