/**
 * LifecycleRestart —— watchdog abort 后自动重启 session 继续，最多 maxRetries 次。
 *
 * 协议要点（来自 bidding-agent CLAUDE.md "this was a real prod bug"）：
 *   - 老 session abort 后捕捉 RunSummary
 *   - 把 messages 转给新 session 作为 initialMessages
 *   - 新 session.continue() 继续
 *   - 直到 reason !== "aborted" 或 retries 用尽
 *
 * 详见 docs/06-controllers.md §3。
 */

import type { AgentSession, RunSummary, Message } from "@harness-pi/core";

export interface LifecycleRestartOptions {
  /** 创建（或重建）session 的工厂；initialMessages 为续跑历史。 */
  sessionFactory: (initialMessages?: Message[]) => AgentSession;
  /** 最大重启次数。默认 3。 */
  maxRetries?: number;
  /** 重启间隔（ms）。默认 2000。 */
  retryDelayMs?: number;
  /** 判断 abortReason 是否可重启。默认匹配 "watchdog:" 前缀。 */
  isRetryable?: (abortReason: string) => boolean;
}

export interface LifecycleResult extends RunSummary {
  /** 实际重启次数（不含首次）。 */
  retries: number;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 2000;

export class LifecycleRestart {
  constructor(private readonly opts: LifecycleRestartOptions) {
    if ((opts.maxRetries ?? DEFAULT_MAX_RETRIES) < 0) {
      throw new Error("LifecycleRestart: maxRetries must be >= 0");
    }
  }

  async run(
    prompt: string,
    opts?: { signal?: AbortSignal },
  ): Promise<LifecycleResult> {
    const max = this.opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    const delay = this.opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    const isRetryable =
      this.opts.isRetryable ?? ((r: string) => r.startsWith("watchdog:"));

    let session = this.opts.sessionFactory();
    let attempt = 0;
    let summary: RunSummary;
    const runOpts = opts?.signal ? { signal: opts.signal } : {};
    summary = await session.run(prompt, runOpts);

    while (
      summary.reason === "aborted" &&
      summary.abortReason !== undefined &&
      isRetryable(summary.abortReason) &&
      attempt < max &&
      !opts?.signal?.aborted
    ) {
      attempt++;
      const carriedMessages = [...session.messages];
      if (delay > 0) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, delay);
          if (typeof (t as { unref?: () => void }).unref === "function") {
            (t as { unref: () => void }).unref();
          }
        });
      }
      if (opts?.signal?.aborted) break;
      session = this.opts.sessionFactory(carriedMessages);
      summary = await session.continue(runOpts);
    }

    return { ...summary, retries: attempt };
  }
}
