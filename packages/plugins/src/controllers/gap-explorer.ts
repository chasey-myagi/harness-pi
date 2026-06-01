/**
 * GapExplorer —— 覆盖率反馈闭环控制器（docs/09 §4.7，#14，对应 roadmap 的 sideQuestion controller）。
 *
 * 给 Hybrid 的反馈闭环用：检测到 gap（调用方判定 uncertain/pending/coverage_gap 后给出 Gap 列表）→ 派
 * **bounded explorer** 去补 KB → 受影响题重答。explorer **复用编排层 parallel()（#8）+ AgentSession**——
 * **不是顶层 meta-agent**，就是「每个 gap 一次 AgentSession.run」的确定性 fan-out。借 cc AgentTool /
 * codex AgentControl，但严格 bounded：
 *   - **budget 闸**：单次 explore 最多派 maxExplorers 个（超出的 settle 成 skipped:"budget"，下次可再来）。
 *   - **去重**：同一 gap.id 探索过就不再探（_seen）；失败/中止/超预算的会从 _seen 移除以便重试。
 *   - **人审 promote 作闸**：explorer 产出的 finding 先过 promote(finding)（可 async，阻塞等人审）才
 *     applyToKb；拒掉的不写 KB、也不再重探（gap 算「探过但没过审」）。
 *
 * **domain-free**：本控制器不认识题/证据/KB——gap 怎么判、explorer 怎么跑（systemPrompt/tools）、finding
 * 怎么写 KB、谁来 promote，全在调用方注入的回调里。控制器只提供 bounded fan-out + 去重 + promote 闸 +
 * 算出「该重答哪些 work-item」（promoted 的 affects 并集）的骨架。
 */

import type { AgentSession, RunSummary } from "@harness-pi/core";
import { parallel } from "./orchestrate.js";

export interface Gap {
  /** 去重 + 归因用的稳定 id。 */
  id: string;
  /** 给 explorer 的探索任务（prompt）。 */
  prompt: string;
  /** 受此 gap 影响、补 KB 后应重答的 work-item id（domain 中性，可空）。 */
  affects?: string[];
}

export interface ExplorerFinding {
  gap: Gap;
  /** explorer run 的终态（含 lastMessage / usage / reason）；promote / applyToKb 从这里取产出。 */
  terminal: RunSummary;
}

export interface GapExplorerOptions {
  /** 造一个 explorer AgentSession 的工厂（每个 gap 一个 bounded explorer；轮数等由它自限）。 */
  sessionFactory: (gap: Gap) => AgentSession;
  /** explorer 并发上限。默认 4。 */
  concurrency?: number;
  /** 单次 explore() 最多派多少个 explorer（budget 闸）。默认不限。 */
  maxExplorers?: number;
  /** 人审 promote 闸：给定 finding 返回是否 promote 进 KB（可 async，阻塞等人审）。默认全 promote。 */
  promote?: (finding: ExplorerFinding) => boolean | Promise<boolean>;
  /** 把 promote 通过的 finding 写进 KB（domain，由调用方实现）。 */
  applyToKb?: (finding: ExplorerFinding) => void | Promise<void>;
  /** 透传给每个 explorer run 的 abort signal。 */
  signal?: AbortSignal;
}

export interface GapExplorerResult {
  /**
   * explorer run **以 reason==="done" 收尾**的 finding（只有这些进 promote）。
   *
   * ⚠️ `reason==="done"` 只表示 turn loop 自然收尾、没被 abort/max_turns 打断；**它不等于「答案完整」**——
   * 内核契约里 provider 截断（stopReason==="length"，context-overflow）和 provider error（stopReason==="error"）
   * 仍以 reason:"done" 收尾。本控制器 domain-free、不替你判「完整性」；若要排掉被截断/出错的半成品，在注入的
   * `promote(finding)` 里查 `finding.terminal.stopReason`（"length"/"error"）自行拒掉。
   */
  explored: ExplorerFinding[];
  /**
   * explorer 跑了、但**没干净收尾**（terminal.reason 是 aborted/error/max_turns/max_continuations）。
   * 不进 promote（绝不拿半成品补 KB），且其 gap 已从 _seen 移除 → 下次 explore 可重探。
   */
  incomplete: ExplorerFinding[];
  /** 过了人审、已 applyToKb 的。 */
  promoted: ExplorerFinding[];
  /** 人审拒掉的（不写 KB）。 */
  rejected: ExplorerFinding[];
  /** explorer run 抛错（run 回调 throw，如 sessionFactory 抛）的 gap。 */
  failed: Array<{ gap: Gap; error: unknown }>;
  /** 跳过的 gap id：duplicate=去重命中；budget=超 maxExplorers。 */
  skipped: { duplicate: string[]; budget: string[] };
  /** 需重答的 work-item id（promoted findings 的 affects 并集，去重）。 */
  toReanswer: string[];
}

const DEFAULT_CONCURRENCY = 4;

export class GapExplorer {
  private readonly _seen = new Set<string>();

  constructor(private readonly opts: GapExplorerOptions) {
    if ((opts.maxExplorers ?? Infinity) < 0) {
      throw new Error("GapExplorer: maxExplorers must be >= 0");
    }
  }

  async explore(gaps: Gap[]): Promise<GapExplorerResult> {
    // 1. 去重 vs _seen（乐观加入；下面对没成功探索的再移除以便重试）。
    const duplicate: string[] = [];
    const fresh: Gap[] = [];
    for (const g of gaps) {
      if (this._seen.has(g.id)) duplicate.push(g.id);
      else {
        fresh.push(g);
        this._seen.add(g.id);
      }
    }

    // 2. budget 闸（计数）：超出的不派、从 _seen 移除（下次 explore 可再来）。
    const max = this.opts.maxExplorers ?? Infinity;
    const toExplore = fresh.slice(0, max);
    const budgetGaps = fresh.slice(max);
    for (const g of budgetGaps) this._seen.delete(g.id);
    const budget = budgetGaps.map((g) => g.id);

    // 3. 复用编排层 parallel() 跑 explorer（每个 gap 一次 AgentSession.run）。
    const signal = this.opts.signal;
    const outcomes = await parallel(toExplore, {
      concurrency: this.opts.concurrency ?? DEFAULT_CONCURRENCY,
      run: async (gap): Promise<ExplorerFinding> => {
        const session = this.opts.sessionFactory(gap);
        const terminal = await session.run(
          gap.prompt,
          signal ? { signal } : {},
        );
        return { gap, terminal };
      },
      ...(signal ? { signal } : {}),
    });

    const explored: ExplorerFinding[] = [];
    const incomplete: ExplorerFinding[] = [];
    const failed: Array<{ gap: Gap; error: unknown }> = [];
    for (const o of outcomes) {
      if (o.status === "ok") {
        // ⚠️ AgentSession.run() **不 throw**——abort / max_turns / LLM error 都 resolve 出对应 reason 的
        // RunSummary（不是抛异常），所以这些 explorer 全部以 status==="ok" 回来。**必须看 terminal.reason**：
        // 只有 "done" 才算有效 finding（绝不拿半成品/被截断的 run 补 KB）；非 done → incomplete、从 _seen
        // 移除以便重探（否则该重探的 gap 会被当 done 留在 _seen、漏重探，且半成品被默认 promote 污染 KB）。
        if (o.value.terminal.reason === "done") {
          explored.push(o.value);
        } else {
          this._seen.delete(o.value.gap.id);
          incomplete.push(o.value);
        }
      } else if (o.status === "failed") {
        // run 回调 throw（如 sessionFactory 抛）：从 _seen 移除以便重试。
        this._seen.delete(o.item.id);
        failed.push({ gap: o.item, error: o.error });
      } else {
        // skipped:"aborted" —— parallel 因 signal abort 未派发的 item，从未跑，可重试。
        this._seen.delete(o.item.id);
      }
    }

    // 4. 人审 promote 闸 + applyToKb。拒掉的留在 _seen（探过但没过审，不再重探）。
    const promoteFn = this.opts.promote ?? (() => true);
    const promoted: ExplorerFinding[] = [];
    const rejected: ExplorerFinding[] = [];
    for (const finding of explored) {
      if (await promoteFn(finding)) {
        await this.opts.applyToKb?.(finding);
        promoted.push(finding);
      } else {
        rejected.push(finding);
      }
    }

    // 5. 该重答哪些 work-item：promoted findings 的 affects 并集（去重）。
    const toReanswer = [
      ...new Set(promoted.flatMap((f) => f.gap.affects ?? [])),
    ];

    return {
      explored,
      incomplete,
      promoted,
      rejected,
      failed,
      skipped: { duplicate, budget },
      toReanswer,
    };
  }
}
