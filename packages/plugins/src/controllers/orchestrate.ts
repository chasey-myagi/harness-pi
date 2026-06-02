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

/**
 * `pipeline()` —— 多阶段版的 `parallel()`：每个 item **独立**流过一串有序 `stages`，**stage 之间无 barrier**
 * （item A 可以已经在 stage 2，而 item B 还在 stage 0）。并发上限管的是「同时在管线里的 item 数」，不是
 * 每个 stage 的并发。每个 item 仍**必返回一个 typed outcome**（ok / failed / skipped），失败时额外记下
 * **是哪个 stage 抛的**（`stage`，0-based）。budget / signal / onProgress / 有序 outcomes 语义与 `parallel()`
 * **完全一致**——本函数就是搭在 `parallel()` 上的（per-item「跑完所有 stage」当作 parallel 的一个 run），
 * 复用它全部已测的并发 / 派发阈值 / abort / 进度逻辑，只在外面补一层 stage 归因。
 *
 * 对应 docs/09 §4.1 的「benchmark 5 阶段固定 pipeline」这类多段流水：parse→answer→score→diff→report。
 * （单题 L0→L1→L2 cascade 是 **AgentSession 回合循环内**的 ReAct，不是本原语的用法——别拿 pipeline 去套。）
 *
 * 语义要点：
 *  - **第一个 stage 的 `prev` 是 item 本身**；之后每个 stage 的 `prev` 是上一个 stage 的返回值；终值 = 最后一个
 *    stage 的返回值（空 `stages` ⇒ identity，value === item）。`prev` 类型是 `unknown`，stage 作者按管线
 *    顺序自行收窄（这是动态原语的代价，换来不靠脆弱的变长元组类型推导）。
 *  - **某个 stage 抛错** ⇒ 该 item `failed`、`error` 原样保留、`stage` = 抛错的 stage 下标，**其余 stage 不再跑**；
 *    不影响其它 item。
 *  - **abort 只挡新 item 派发**：已经进了管线的 item 会**跑完它剩下的所有 stage**（无中途取消，避免半截产物）；
 *    stage 想响应 abort 自己 close over signal。pre-aborted ⇒ 全部 `skipped:"aborted"`，一个 stage 都不跑。
 *  - **budget 是派发阈值**（同 `parallel()`）：`cost(终值, item)` 累加，达 `total` 后未派发的 `skipped:"budget"`；
 *    失败的 item 不计费（没产生终值）。高并发下超支上限 ≈ 在跑的并发数（见 `parallel()` 注释）。
 */
export type PipelineStage<I> = (
  prev: unknown,
  item: I,
  index: number,
) => Promise<unknown>;

export type PipelineOutcome<I, R> =
  | { item: I; index: number; status: "ok"; value: R }
  | { item: I; index: number; status: "failed"; error: unknown; stage: number }
  | { item: I; index: number; status: "skipped"; reason: "budget" | "aborted" };

export interface PipelineOptions<I, R> {
  /** 最大并发（同时在管线里的 item 数，默认 1）。会被夹到 [1, items.length]。 */
  concurrency?: number;
  /** abort 后停止派发新 item；已进管线的 item 跑完剩余 stage，未派发的 settle 成 `skipped:"aborted"`。 */
  signal?: AbortSignal;
  /** 预算：`cost(终值, item)` 折算每个**成功**结果的花费累加，达 `total` 后停止派发（派发阈值，非硬上限）。 */
  budget?: { total: number; cost: (value: R, item: I) => number };
  /** 每个 item settle 后回调一次（done/total/已花费）。listener 抛错不影响编排。 */
  onProgress?: (p: { done: number; total: number; spent: number }) => void;
}

/** 内部载体：把「哪个 stage 抛的」穿过 `parallel()` 的 catch（parallel 只给 error，拿不到 stage）。 */
class StageError {
  constructor(
    readonly stage: number,
    readonly cause: unknown,
  ) {}
}

/**
 * 跑完 `items`，每个 item 串行流过 `stages`，返回与输入**等长、按 index 有序**的 outcomes。
 * 保证：每个 item 恰好一个 outcome，永不静默丢失。
 */
export async function pipeline<I, R = unknown>(
  items: readonly I[],
  stages: ReadonlyArray<PipelineStage<I>>,
  opts: PipelineOptions<I, R> = {},
): Promise<Array<PipelineOutcome<I, R>>> {
  // run = per-item「串行跑完所有 stage」。其余字段透传给 parallel；exactOptionalPropertyTypes 下
  // 只在定义时挂上去（不能把 undefined 显式塞进可选字段）。
  const parallelOpts: ParallelOptions<I, R> = {
    run: async (item, index) => {
      let prev: unknown = item; // 第一个 stage 的 prev 即 item；空 stages ⇒ 终值 = item（identity）
      for (let s = 0; s < stages.length; s++) {
        try {
          prev = await stages[s]!(prev, item, index);
        } catch (cause) {
          throw new StageError(s, cause); // 携带 stage 下标穿过 parallel 的 catch
        }
      }
      return prev as R;
    },
  };
  if (opts.concurrency !== undefined) parallelOpts.concurrency = opts.concurrency;
  if (opts.signal !== undefined) parallelOpts.signal = opts.signal;
  if (opts.budget !== undefined) parallelOpts.budget = opts.budget;
  if (opts.onProgress !== undefined) parallelOpts.onProgress = opts.onProgress;

  const outcomes = await parallel<I, R>(items, parallelOpts);

  return outcomes.map((o): PipelineOutcome<I, R> => {
    if (o.status === "failed") {
      const e = o.error;
      // run() 只该抛 StageError（整个 run body 就是被包住的 stage 循环）。这行 instanceof 把该不变量
      // 从「靠注释维持」升级成「靠代码强制」并让 TS 收窄类型：未来若有人往 run body 加了会抛别的东西
      // 的代码，宁可在此大声抛出（暴露 pipeline 内部 bug），也绝不静默产出 stage=undefined 的坏 outcome。
      if (!(e instanceof StageError)) throw e;
      return {
        item: o.item,
        index: o.index,
        status: "failed",
        error: e.cause,
        stage: e.stage,
      };
    }
    return o; // ok / skipped 的形状与 PipelineOutcome 完全一致，原样透传
  });
}
