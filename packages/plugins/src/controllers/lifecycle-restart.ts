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

import { AgentSession } from "@harness-pi/core";
import type { RunSummary, Message, SessionStore } from "@harness-pi/core";

export interface LifecycleRestartOptions {
  /**
   * 创建（或重建）session 的工厂；initialMessages 为续跑历史（**内存**搬历史，仅同进程恢复）。
   * 与 `resume` **二选一**。
   */
  sessionFactory?: (initialMessages?: Message[]) => AgentSession;
  /**
   * **持久化 resume 模式**（与 `sessionFactory` 二选一）：每次（重）启用 `AgentSession.resume(store,
   * sessionId, deps)` 从注入的 `SessionStore` 重建历史——能跨**进程崩溃**恢复（内存搬历史做不到）。
   * 语义：`run(prompt)` 时若该 sessionId 在 store 里**已有历史**（典型：崩溃后冷启动），则**忽略 prompt**、
   * 直接 `continue()` 续跑那次中断的 run；否则按新 session 跑 `run(prompt)`。每次可重试 abort 后都重新
   * resume + continue（始终从落盘历史续，不靠内存）。`deps` 即 resume 的第三参（model/tools/hooks/…，
   * 不含 store/sessionId）。
   */
  resume?: {
    store: SessionStore;
    sessionId: string;
    deps: Parameters<typeof AgentSession.resume>[2];
  };
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
    // 恰好二选一：内存搬历史（sessionFactory）或持久化 resume（resume），不能都给或都不给。
    if (!!opts.sessionFactory === !!opts.resume) {
      throw new Error(
        "LifecycleRestart: provide exactly one of { sessionFactory, resume }",
      );
    }
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

    const runOpts = opts?.signal ? { signal: opts.signal } : {};
    let attempt = 0;
    let session: AgentSession;
    let summary: RunSummary;

    if (this.opts.resume) {
      const { store, sessionId, deps } = this.opts.resume;
      session = await AgentSession.resume(store, sessionId, deps);
      // 判据与重放结果**同源**：直接看 resume 实际重放出的 messages 是否非空，而不是 `getLeafId!==null`
      //（leaf 可能是 resume 会忽略的 terminal entry——那是"有没有 entry"，不是"重放出有没有消息"）。
      // 非空 = 崩溃冷启动恢复 → continue 续跑中断的那次；空（未知/全新 session）→ run(prompt)。
      summary =
        session.messages.length > 0
          ? await session.continue(runOpts)
          : await session.run(prompt, runOpts);
    } else {
      session = this.opts.sessionFactory!();
      summary = await session.run(prompt, runOpts);
    }

    while (
      summary.reason === "aborted" &&
      summary.abortReason !== undefined &&
      isRetryable(summary.abortReason) &&
      attempt < max &&
      !opts?.signal?.aborted
    ) {
      attempt++;
      // 内存模式在 delay 前先抓历史快照；resume 模式无需快照（历史在 store 里）。
      const carriedMessages = this.opts.resume ? undefined : [...session.messages];
      if (delay > 0) {
        // 不要 unref：这个 timer 是被 await 的控制流，unref 后独立 worker 的事件循环可能在重试
        // 触发前就退出（#11.4）。abort 时立即唤醒，让取消能及时退出循环。
        await new Promise<void>((resolve) => {
          const signal = opts?.signal;
          if (signal?.aborted) return resolve();
          const onAbort = (): void => {
            clearTimeout(t);
            resolve();
          };
          const t = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          }, delay);
          signal?.addEventListener("abort", onAbort, { once: true });
        });
      }
      if (opts?.signal?.aborted) break;
      session = this.opts.resume
        ? await AgentSession.resume(
            this.opts.resume.store,
            this.opts.resume.sessionId,
            this.opts.resume.deps,
          )
        : this.opts.sessionFactory!(carriedMessages);
      summary = await session.continue(runOpts);
    }

    // ⚠️ usage 语义：每次重试都换 session 并把历史带进去——内存模式经 `sessionFactory(carriedMessages)`
    // 搬入，**resume 模式经 `AgentSession.resume` 重放落盘历史**。两种模式下新 session 的 RunSummary.usage
    // 都是「该 session 至今全部 assistant」的累加（含带进来的历史），因此重启间 usage **同样重叠累加**
    //（resume 模式别误以为干净——重叠成因是重放历史 assistant 的 usage）。这里返回的 `usage` 是「末次
    // session 视角的累计」而非「各 attempt 真消耗之和」。要精确对账 budget，调用方应累加每个 attempt 的
    // usage delta，或把本字段当成上界。（内核 _accumulatedUsage 契约自洽，重叠源于换 session + 带历史。）
    return { ...summary, retries: attempt };
  }
}
