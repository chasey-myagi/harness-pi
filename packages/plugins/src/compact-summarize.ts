/**
 * compactSummarize —— compaction 策略之一（docs/09 §4.2，#10），与 compactRestartFresh 互补。
 *
 * 在 `transformMessagesBeforeLlm`（内核 §3.6 指定的「compaction 改写消息」唯一 hook 点）里：当消息条数
 * 超过阈值，用调用方提供的 `summarize` 函数（可调 LLM）把**早期**消息总结成一条 summary，拼上最近的
 * recent tail 一起发给模型。**不动 session.messages**——只改模型看到的 view（与 trim-history 同款无副作用
 * 模式）；完整历史仍由内核留在 _messages + store 里（durable / 可 resume）。
 *
 * 与 trim-history 的区别：trim-history 机械地把旧 toolResult 换占位符（不花钱）；compactSummarize 语义压缩、
 * 花一次 LLM 调用换更高保真的浓缩。两者可叠用（先 summarize 早期、再 trim 中段 toolResult）。
 *
 * **缓存**：summary 按它覆盖的前缀长度缓存；只有当「想覆盖到的前缀」比上次缓存增长 ≥ `resummarizeEvery`
 * 才重算——否则复用旧 summary，把 summary 之后的消息原样带上。避免每个 turn 都重花一次 LLM。
 *
 * **范围**：本 hook 压缩的是**模型 view**（省 token）。doc §4.2 提到的「写 compaction 边界进 store」
 * 是 resume 优化、属编排层职责（内核刻意不给 hook store 写权限，避免破坏 _flushToStore 的高水位不变量）。
 */

import type { Hook, HookContext } from "@harness-pi/core";
import { createUserMessage } from "@harness-pi/core";
import type { Message } from "@earendil-works/pi-ai";
import { POST_COMPACT_PENDING_KEY } from "./post-compact-file-reread.js";

export interface CompactSummarizeOptions {
  /** 触发阈值：messages 条数 > maxMessages 才压缩。须 > keepRecent。 */
  maxMessages: number;
  /** 压缩后原样保留的最近消息条数（recent tail）。须 ≥ 1。 */
  keepRecent: number;
  /** 把一批早期消息总结成一段文本（可 async / 调 LLM）。 */
  summarize: (
    earlyMessages: Message[],
    ctx: HookContext,
  ) => string | Promise<string>;
  /**
   * 「想覆盖的前缀」比上次缓存增长达到这么多条才重新 summarize；默认 = keepRecent。
   * 调大省 LLM 调用（view 里未总结的尾巴更长），调小更省 token。须 ≥ 1。
   */
  resummarizeEvery?: number;
  /** summary 消息的文案包装（默认带「已压缩 N 条」前缀）。 */
  summaryText?: (summary: string, coveredCount: number) => string;
}

export function compactSummarize(opts: CompactSummarizeOptions): Hook {
  if (opts.keepRecent < 1) {
    throw new Error("compactSummarize: keepRecent must be >= 1");
  }
  if (opts.maxMessages <= opts.keepRecent) {
    throw new Error("compactSummarize: maxMessages must be > keepRecent");
  }
  const resummarizeEvery = opts.resummarizeEvery ?? opts.keepRecent;
  if (resummarizeEvery < 1) {
    throw new Error("compactSummarize: resummarizeEvery must be >= 1");
  }
  const wrap =
    opts.summaryText ??
    ((summary, n) => `[compacted summary of ${n} earlier messages]\n${summary}`);

  // 闭包缓存：上次 summary 覆盖到的前缀长度 + 文本。session 级（每 session 一个 hook 实例）。
  let cache: { coveredCount: number; text: string } | null = null;

  return {
    name: "compactSummarize",

    async transformMessagesBeforeLlm(messages, ctx) {
      // 注意：messages 是 firePipeMessages 的入参 = [..._messages, ..._pendingAttachments]，
      // 不是纯 _messages。attachments 通常少且 transient，对阈值判定影响可忽略。
      if (messages.length <= opts.maxMessages) return undefined; // 未超阈值，原样

      // 进到这里必有 messages.length > maxMessages > keepRecent ⇒ targetCover ≥ 2，不再需要下界防御。
      const targetCover = messages.length - opts.keepRecent; // 想把前 targetCover 条总结掉

      if (
        cache === null ||
        targetCover - cache.coveredCount >= resummarizeEvery
      ) {
        // summarize 可能抛（调 LLM 超时/限流）。让它冒泡——内核 pipe 对 transform 是 fail-open：
        // 错误被 failureSink 记一笔后丢弃本 hook 输出，未压缩的全量 messages 原样流给模型（退化为不压缩）。
        // 关键：赋值在 await 之后，抛错时 cache 不被脏写，下次成功调用从头算。
        const text = await opts.summarize(messages.slice(0, targetCover), ctx);
        cache = { coveredCount: targetCover, text };
        // 仅在**本 turn 真跑了一次新总结**时标记，供 postCompactFileReread 下一 turn 重读关键文件
        // （opt-in，缺该插件无副作用）。**不可**放在分支外：messages 是 append-only 原始 _messages，
        // 一旦越阈值就永久在阈值之上，分支外 set 会让每个越界 turn 都重置标记 → 重读每 turn 重复注入。
        ctx.state.set(POST_COMPACT_PENDING_KEY, ctx.turnIdx);
      }

      // summary 用 role:"user" 承载（一条"用户从没发过的回顾 turn"）——对齐 Claude Code 的 compaction
      // 惯例，且 pi-ai 无独立 system role；不用 attachment 是因为它要稳定占据前缀、参与 cache。
      const summaryMsg = createUserMessage(wrap(cache.text, cache.coveredCount));
      // view = [summary(覆盖前 coveredCount 条)] + 其后全部原样（含未重算的早期 + recent tail）。
      // 无缝无重叠：slice 起点正是 coveredCount。stable-state 下 tail 在两次重算间从 keepRecent
      // 涨到 keepRecent + resummarizeEvery - 1，故 keepRecent 是 tail 下界、非恒定长度。
      return [summaryMsg, ...messages.slice(cache.coveredCount)];
    },
  };
}
