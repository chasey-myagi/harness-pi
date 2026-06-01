/**
 * 声明式编排原语（设计依据 docs/09 §4.1，「分水岭」）。
 *
 * `parallel()` 把一个**已知** work-list 用 bounded concurrency 跑完，每个 item **必返回一个
 * typed outcome**（ok / failed / skipped）—— 由编排层统一 settle，绝不静默丢 item。可选 budget
 * 在花费达上限时停止派发新 item，可选 AbortSignal 停止派发，onProgress 报进度。
 *
 * 这是有意保持 **domain-free + 与 AgentSession 解耦** 的：`run` 回调由调用方提供（里面可以
 * 建一个 AgentSession 跑一题、shell 出子进程、或任何 async 工作）。它替换的是「手搓 lease/
 * work pool + 散落的 onComplete 回调」那一坨命令式编排（bidding-agent 的 god-file 病根之一），
 * 把「每个 work-item 必 settle」从注释纪律变成原语级保证。
 *
 * 取舍（对照 CC dynamic-workflows）：只取**声明式原语**形态（已知 work-list → 确定性 fan-out
 * + budget + 进度），**不**让模型 runtime 决定 fan-out —— work-list 已知时那是零信息增益。
 */

/** 一个 work-item 的终态。`index` 是它在输入数组里的下标（outcomes 按 index 有序）。 */
export type ItemOutcome<I, R> =
  | { item: I; index: number; status: "ok"; value: R }
  | { item: I; index: number; status: "failed"; error: unknown }
  | { item: I; index: number; status: "skipped"; reason: "budget" | "aborted" };

export interface ParallelOptions<I, R> {
  /** 处理单个 item。throw 会被 catch 成 `status:"failed"`，不会让整个 parallel reject。 */
  run: (item: I, index: number) => Promise<R>;
  /** 最大并发（默认 1）。会被夹到 [1, items.length]。 */
  concurrency?: number;
  /** abort 后停止**派发新 item**；已在跑的 item 跑完，未派发的 settle 成 `skipped:"aborted"`。 */
  signal?: AbortSignal;
  /**
   * 可选预算：`cost(value, item)` 把每个成功结果折算成花费累加；累计 **达到/超过 `total`** 后
   * 停止派发新 item（未派发的 settle 成 `skipped:"budget"`）。budget 是**派发阈值、非硬上限**。
   *
   * ⚠️ **超支语义**：派发决策在 item *开始前*、计费在 *完成后*。所以高并发下，多个 worker 会在
   * `spent` 还是 0 时同时通过阈值检查、同时派发 —— **超支上限 ≈ 在跑的并发数**（不是「小幅」）。
   * `concurrency:1` 时最多超 1 个；要硬上限请把 concurrency 调小或在 `run` 内自查。对齐 CC budget
   * 的「派发阈值」语义（失败的 item 不计费——只有 `ok` 结果累加 `cost`）。
   * `cost` 应返回非负值（返回负值会让 `spent` 倒退、budget 可能永不触发——调用方自负）。
   */
  budget?: { total: number; cost: (value: R, item: I) => number };
  /** 每个 item settle 后回调一次（done/total/已花费）。listener 抛错不影响编排。 */
  onProgress?: (p: { done: number; total: number; spent: number }) => void;
}

/**
 * 跑完 `items`，返回与输入**等长、按 index 有序**的 outcomes。保证：每个 item 恰好一个 outcome，
 * 永不静默丢失；`run` 抛错 → `failed`；budget 耗尽 / aborted → 未派发的 `skipped`。
 */
export async function parallel<I, R>(
  items: readonly I[],
  opts: ParallelOptions<I, R>,
): Promise<Array<ItemOutcome<I, R>>> {
  const n = items.length;
  const outcomes: Array<ItemOutcome<I, R>> = new Array(n);
  let cursor = 0;
  let done = 0;
  let spent = 0;
  // sticky：一旦因 abort/budget 停止派发就锁死原因，不被后续覆盖（`??=`）。
  let stopReason: "budget" | "aborted" | null = null;

  const report = (): void => {
    if (!opts.onProgress) return;
    try {
      opts.onProgress({ done, total: n, spent });
    } catch {
      /* progress listener 抛错不影响编排 */
    }
  };

  if (n === 0) {
    report();
    return outcomes;
  }

  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 1, n));

  const worker = async (): Promise<void> => {
    // 单线程 JS：`cursor++` 读改写之间无 await，每个 index 被唯一一个 worker 领取。
    while (cursor < n) {
      if (opts.signal?.aborted) stopReason ??= "aborted";
      else if (opts.budget && spent >= opts.budget.total) stopReason ??= "budget";

      const i = cursor++;
      const item = items[i]!; // i < n 由 while 守卫，必存在（消 noUncheckedIndexedAccess）

      if (stopReason) {
        outcomes[i] = { item, index: i, status: "skipped", reason: stopReason };
        done++;
        report();
        continue;
      }

      try {
        const value = await opts.run(item, i);
        outcomes[i] = { item, index: i, status: "ok", value };
        if (opts.budget) spent += opts.budget.cost(value, item);
      } catch (error) {
        outcomes[i] = { item, index: i, status: "failed", error };
      }
      done++;
      report();
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return outcomes;
}
