/**
 * compactResumeFromBoundary —— compactRestartFresh 的兄弟（docs/09 §4.2），同样建在内核
 * `onContextOverflow` → `compactOnOverflow()` abort 之上，但**恢复方式相反**：
 *
 *   - `compactRestartFresh`：overflow 时 abort + **fresh 重跑同一 prompt**，丢掉整段越界 ReAct trace。
 *     便宜，但每次都从零开始——压缩成果（trace 里已做的工作）全部作废。
 *   - `compactResumeFromBoundary`（本控制器）：overflow 时 abort 后，把当下 live messages **总结成一条
 *     覆盖全量的 summary**、写一条 `compaction_boundary` entry，再 `AgentSession.resume()` 从 boundary
 *     **续跑**（`continue()`）。**保留压缩后的成果**——summary 把越界 trace 浓缩成一条，从这条接着干。
 *
 * 二者都复用 `compactOnOverflow`（Hook）+ `isCompactionRestart`（谓词），区别仅在 abort 之后怎么恢复。
 *
 * 为什么不像 fresh 那样可能死循环：boundary **覆盖它之前的全部前缀**，resume 重建出的 messages 就是
 * `[summary]` 一条——最大压缩。只要 summarize 真把内容压短，每次 resume 的起点都比上次小，进展有保证；
 * 不像 fresh「重跑同一 prompt」在 **初始 prompt 本身过大** 时会反复同样越界。
 *
 * ⚠️ 诚实边界：
 *   - **需要 `store`**：boundary 必须落盘，`resume()` 从 store 重建。compactRestartFresh 不需 store。
 *   - **`maxRestarts` 耗尽**：若持续 overflow（如单条 summary 仍超窗），控制器在耗尽后返回**最后一次的
 *     aborted summary**（不假装恢复成功）。
 *   - **signal 只透传给 `run`/`continue`**：其余 run 选项不穿透（与 compactRestartFresh 一致）。
 *   - **domain-free**：`summarize` 由调用方提供（可调 LLM），控制器/内核都不内置 LLM 调用。
 *   - **`summarize` 抛错**：`run()` 直接 reject（fail-loud，caller 自负 summarize 错误）。因 summarize 在
 *     `appendEntry` 之前调用，抛错时**不留半成品 orphan boundary**——store 不损坏。
 */

import { AgentSession, type AgentSessionOptions, type Message, type RunSummary, type SessionStore } from "@harness-pi/core";
import { isCompactionRestart } from "./compact-restart-fresh.js";

export interface CompactResumeFromBoundaryOptions {
  /** 落盘 store（resume 从它读重建）。必需。 */
  store: SessionStore;
  /** session id（首跑 + resume 同一 lineage 用同一个）。必需。 */
  sessionId: string;
  /**
   * 造首个 session + resume 都用的会话选项（model/tools/hooks/...）。
   * **务必在 hooks 里装 `compactOnOverflow()`** —— 否则 overflow 不会变成 compaction abort、控制器无从感知。
   */
  sessionOptions: Omit<
    AgentSessionOptions,
    "store" | "sessionId" | "initialMessages" | "resumedMessageCount"
  >;
  /**
   * 把 abort 时的 live messages 总结成一条覆盖全量的 summary message。可 async（调 LLM）。domain-free。
   */
  summarize: (messages: ReadonlyArray<Message>) => Message | Promise<Message>;
  /** 最大重启次数（不含首跑），默认 3。 */
  maxRestarts?: number;
}

export interface CompactResumeResult extends RunSummary {
  /** 实际 resume-continue 次数。 */
  restarts: number;
}

const DEFAULT_MAX_RESTARTS = 3;

export class CompactResumeFromBoundary {
  constructor(private readonly opts: CompactResumeFromBoundaryOptions) {
    if ((opts.maxRestarts ?? DEFAULT_MAX_RESTARTS) < 0) {
      throw new Error("CompactResumeFromBoundary: maxRestarts must be >= 0");
    }
  }

  /**
   * 跑 prompt；overflow-abort 则写 boundary（summary 覆盖全量）→ resume → continue 续跑，直到非
   * compaction abort 或 maxRestarts 耗尽。耗尽返回最后一次的 aborted summary（不假装恢复）。
   * 注意：只代理 `signal` 给每次 `run`/`continue`，其余 run 选项不穿透（与 compactRestartFresh 同）。
   */
  async run(
    prompt: string,
    opts?: { signal?: AbortSignal },
  ): Promise<CompactResumeResult> {
    const { store, sessionId, sessionOptions, summarize } = this.opts;
    const max = this.opts.maxRestarts ?? DEFAULT_MAX_RESTARTS;
    const runOpts = opts?.signal ? { signal: opts.signal } : {};

    let session = new AgentSession({ ...sessionOptions, store, sessionId });
    let summary = await session.run(prompt, runOpts);
    let restarts = 0;

    while (
      summary.reason === "aborted" &&
      isCompactionRestart(summary.abortReason) &&
      restarts < max &&
      !opts?.signal?.aborted
    ) {
      restarts++;
      // 把越界 trace 总结成一条覆盖全量的 summary，写 boundary（覆盖它之前的全部前缀）。
      const boundary = await summarize(session.messages);
      await store.appendEntry(sessionId, { kind: "compaction_boundary", summary: boundary });
      // 从 boundary resume：重建出的 messages 就是 [summary] 一条，从这条 continue 续跑。
      session = await AgentSession.resume(store, sessionId, sessionOptions);
      summary = await session.continue(runOpts);
    }

    return { ...summary, restarts };
  }
}
