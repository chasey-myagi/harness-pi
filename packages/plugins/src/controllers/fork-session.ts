/**
 * ForkSession —— 从父 session 拷贝当前 messages snapshot，跑一个独立子 session。
 *
 * 跟 LifecycleRestart 的区别：lifecycle 是同一逻辑 session 跨 worker 的状态续传；
 * fork 是同时刻派生 N 个**独立探索**子 session（"我有 3 个候选方案，平行 try 一遍"）。
 *
 * 跟 WorkPool 的区别：WorkPool 是不同 work item 的横向并行；fork 是同一 item 的纵向探索。
 *
 * 设计要点：
 *   - 子 session 拿父 session 的 `snapshot().messages` 作为 initialMessages
 *   - 父 session **不暂停**——fork 是 read-only snapshot；父子并行没问题
 *   - 父子可挂不同 hooks / tools / system prompt；只共享 messages 历史
 *   - 子完成后 summary + final messages 返回；caller 决定如何 merge（不自动 merge）
 *
 * 借鉴 Claude Code `forkedAgent` + `CacheSafeParams`（[08-claude-code-lessons](docs/08-claude-code-lessons.md) §4.1）。
 */

import type { AgentSession, Message, RunSummary } from "@harness-pi/core";

export interface ForkOptions {
  /** 给子 session 单独发的 prompt。如果不传，用 `continue()` 跑（直接从历史接着算）。 */
  prompt?: string;
  /** 子 session 自己的 abort signal（独立于父）。 */
  signal?: AbortSignal;
}

export interface ForkResult {
  /** 子 session 跑完的 summary。 */
  summary: RunSummary;
  /** 子 session 跑完时的完整 messages（含父历史 + 子新增）。 */
  messages: Message[];
}

/**
 * 从父 session 的当前 snapshot 派生一个子 session 并跑它。子 session 由 factory 构造
 * （让 caller 决定挂什么 hooks / tools / model）。
 *
 * @param parent 父 session（不会被修改 / 暂停）
 * @param factory 给定 initialMessages 构造子 session
 * @param opts.prompt 子 session 的 prompt；不传走 continue()
 * @param opts.signal 子 session 的 abort signal
 *
 * @example
 *   const child = await forkSession(parent, (init) => new AgentSession({
 *     model: parent.model,
 *     tools: parent.tools,
 *     initialMessages: init,
 *     hooks: [exploreHook],
 *   }), { prompt: "try approach A" });
 */
export async function forkSession(
  parent: AgentSession,
  factory: (initialMessages: Message[]) => AgentSession,
  opts: ForkOptions = {},
): Promise<ForkResult> {
  // 拷贝 snapshot —— 父 session 不会被 child 影响（initialMessages 是 [...父messages] copy）
  const snapshot = parent.snapshot();
  const child = factory(snapshot.messages);

  const runOpts = opts.signal ? { signal: opts.signal } : {};
  const summary = opts.prompt
    ? await child.run(opts.prompt, runOpts)
    : await child.continue(runOpts);

  return {
    summary,
    messages: [...child.messages],
  };
}

/**
 * 并行跑多个 fork。每个 fork 独立——失败一个不影响其他。
 *
 * @returns Promise.allSettled 风格：每个 fork 一个 settled 状态
 */
export async function forkSessionAll(
  parent: AgentSession,
  forks: Array<{
    factory: (initialMessages: Message[]) => AgentSession;
    opts?: ForkOptions;
  }>,
): Promise<
  Array<
    | { status: "fulfilled"; value: ForkResult }
    | { status: "rejected"; reason: Error }
  >
> {
  return Promise.all(
    forks.map(async (f) => {
      try {
        const value = await forkSession(parent, f.factory, f.opts);
        return { status: "fulfilled" as const, value };
      } catch (err) {
        return {
          status: "rejected" as const,
          reason: err instanceof Error ? err : new Error(String(err)),
        };
      }
    }),
  );
}
