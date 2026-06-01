/**
 * WorkItemAggregator —— 按 `workItemId` 归账的 MetricsSink（docs/09 §4.4，#11）。
 *
 * 消费 `metrics` 插件 emit 的事件（每条带 `workItemId`，由编排层经 `metrics({ workItemId })` 注入），
 * 把 token / cost-相关 usage、tool 调用、错误按 work-item 累加成 rollup。**domain 中性**——只认
 * `workItemId`，不认 question/evidence；业务层（bidding）把 workItemId 映射成 questionId 自行归账。
 *
 * 用法：既可当**终端 sink**（直接收事件），也可 `forward` 给下游 sink（如 NdjsonFileSink）做透传 +
 * 顺带聚合。没带 `workItemId` 的事件只透传、不计入任何 rollup。
 */

import type { MetricEvent, MetricsSink } from "../types.js";

/** 单个 work-item 的累计归账。 */
export interface WorkItemRollup {
  workItemId: string;
  /** llm.called 次数。 */
  llmCalls: number;
  /** tool.called 次数。 */
  toolCalls: number;
  /** isError=true 的 tool.called 次数。 */
  toolErrors: number;
  /**
   * error.observed 次数。**与 toolErrors 口径独立、可能对同一次失败双计**——一次 tool 失败既进
   * toolErrors（tool.called isError=true），也可能触发 error.observed 进 errors。别把两者相加当总错误数。
   */
  errors: number;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  /** llm.called 的 durationMs 之和。 */
  llmDurationMs: number;
  /** tool.called 的 durationMs 之和。 */
  toolDurationMs: number;
}

export interface WorkItemAggregatorOptions {
  /** 透传下游 sink（聚合的同时把原始事件转发出去）。不给则只聚合。 */
  forward?: MetricsSink;
}

function num(x: unknown): number {
  return typeof x === "number" && Number.isFinite(x) ? x : 0;
}

function emptyRollup(workItemId: string): WorkItemRollup {
  return {
    workItemId,
    llmCalls: 0,
    toolCalls: 0,
    toolErrors: 0,
    errors: 0,
    tokensInput: 0,
    tokensOutput: 0,
    tokensCacheRead: 0,
    llmDurationMs: 0,
    toolDurationMs: 0,
  };
}

export class WorkItemAggregator implements MetricsSink {
  private readonly _rollups = new Map<string, WorkItemRollup>();

  constructor(private readonly opts: WorkItemAggregatorOptions = {}) {}

  enqueue(event: MetricEvent): void {
    this.opts.forward?.enqueue(event);

    const workItemId = event.workItemId;
    if (typeof workItemId !== "string") return; // 未归属 work-item 的事件不计
    // 只有归账类事件才建/更 rollup —— session/turn 等即便带 workItemId 也不创建空 rollup（只透传）。
    if (
      event.kind !== "llm.called" &&
      event.kind !== "tool.called" &&
      event.kind !== "error.observed"
    ) {
      return;
    }

    const r = this._rollups.get(workItemId) ?? emptyRollup(workItemId);
    switch (event.kind) {
      case "llm.called":
        r.llmCalls++;
        r.tokensInput += num(event.tokensInput);
        r.tokensOutput += num(event.tokensOutput);
        r.tokensCacheRead += num(event.tokensCacheRead);
        r.llmDurationMs += num(event.durationMs);
        break;
      case "tool.called":
        r.toolCalls++;
        if (event.isError === true) r.toolErrors++;
        r.toolDurationMs += num(event.durationMs);
        break;
      case "error.observed":
        r.errors++;
        break;
    }
    this._rollups.set(workItemId, r);
  }

  /** 取某 work-item 的归账；从未见过返回 undefined。 */
  rollup(workItemId: string): WorkItemRollup | undefined {
    const r = this._rollups.get(workItemId);
    return r ? { ...r } : undefined;
  }

  /** 全部 work-item 的归账（拷贝）。 */
  all(): WorkItemRollup[] {
    return [...this._rollups.values()].map((r) => ({ ...r }));
  }

  async flush(): Promise<void> {
    await this.opts.forward?.flush?.();
  }

  async close(): Promise<void> {
    await this.opts.forward?.close?.();
  }
}
