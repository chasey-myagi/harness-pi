/**
 * autoCompaction —— 「自动压缩」标准策略（roadmap core-parity #2，docs/09 §4.2 的孪生件）。
 *
 * 与 `compactSummarize` 同款无副作用 view 压缩（在 `transformMessagesBeforeLlm` 里把早期消息总结成一条
 * summary + 保留 recent tail，不动 `session.messages`，完整历史仍由内核 durable 保存），但**触发判据
 * 从「消息条数」换成「估算的 context token 体积」**——这才是 context 压力的真实信号：一段超长 tool
 * 输出或大文档会让很少几条消息就逼近窗口，按条数根本测不出来。
 *
 * 可选地，在内核 fire 真实 `onContextOverflow` 时 `ctx.abort("compaction: ...")`，把恢复交给
 * `compactRestartFresh` 控制器兜底（`compaction:` 前缀是它识别重启的契约）。默认关闭。
 *
 * 与 `compactSummarize` 的关系：两者互补、可二选一。条数阈值直观；token 阈值贴近真实窗口压力，
 * 是 Claude Code 式 auto-compaction 的「自动」所在。summary 后端仍由调用方 `summarize` 提供（与
 * `compactSummarize` 同契约）；本插件负责的是「何时压缩」这条标准策略，不再要业务侧手搓触发逻辑。
 */

import type { Hook, HookContext } from "@harness-pi/core";
import { createUserMessage } from "@harness-pi/core";
import type { Message } from "@mariozechner/pi-ai";

export interface AutoCompactionOptions {
  /** context token 预算（通常 = 模型上下文窗口，或你愿意用满的上限）。须 > 0。 */
  maxContextTokens: number;
  /** 触发比例：估算 tokens > `maxContextTokens * triggerRatio` 才压缩。默认 0.8，须 ∈ (0, 1]。 */
  triggerRatio?: number;
  /** 压缩后原样保留的最近消息条数（recent tail）。默认 6，须 ≥ 1。 */
  keepRecent?: number;
  /** 把一批早期消息总结成文本（可 async / 调 LLM）——与 compactSummarize 同契约。 */
  summarize: (
    earlyMessages: Message[],
    ctx: HookContext,
  ) => string | Promise<string>;
  /** token 估算器。默认按消息文本字符数 / 4 粗估（保守、零依赖；接入真 tokenizer 可覆盖）。 */
  estimateTokens?: (messages: Message[]) => number;
  /**
   * 「想覆盖的前缀」比上次缓存增长达到这么多条才重算 summary；默认 = keepRecent。
   * 调大省 LLM 调用，调小更省 token。须 ≥ 1。
   */
  resummarizeEvery?: number;
  /** summary 消息的文案包装（默认带「auto-compacted N 条」前缀）。 */
  summaryText?: (summary: string, coveredCount: number) => string;
  /**
   * 命中真实 `onContextOverflow` 时 `ctx.abort("compaction: ...")`，交给 compactRestartFresh 兜底。
   * 默认 false（纯主动压缩，不改控制流）。仅在配套 compactRestartFresh 时开启才有恢复意义。
   */
  abortOnOverflow?: boolean;
}

function messageText(m: Message): string {
  if (typeof m.content === "string") return m.content;
  return m.content
    .map((b) => ("text" in b && typeof b.text === "string" ? b.text : JSON.stringify(b)))
    .join("");
}

/** 默认 token 估算：所有消息文本字符数 / 4 向上取整。粗但单调、零依赖。 */
export function estimateTokensByChars(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) chars += messageText(m).length;
  return Math.ceil(chars / 4);
}

export function autoCompaction(opts: AutoCompactionOptions): Hook {
  if (!(opts.maxContextTokens > 0)) {
    throw new Error("autoCompaction: maxContextTokens must be > 0");
  }
  const triggerRatio = opts.triggerRatio ?? 0.8;
  if (!(triggerRatio > 0 && triggerRatio <= 1)) {
    throw new Error("autoCompaction: triggerRatio must be in (0, 1]");
  }
  const keepRecent = opts.keepRecent ?? 6;
  if (keepRecent < 1) {
    throw new Error("autoCompaction: keepRecent must be >= 1");
  }
  const resummarizeEvery = opts.resummarizeEvery ?? keepRecent;
  if (resummarizeEvery < 1) {
    throw new Error("autoCompaction: resummarizeEvery must be >= 1");
  }
  const estimate = opts.estimateTokens ?? estimateTokensByChars;
  const threshold = opts.maxContextTokens * triggerRatio;
  const wrap =
    opts.summaryText ??
    ((summary, n) => `[auto-compacted summary of ${n} earlier messages]\n${summary}`);

  // 闭包缓存：上次 summary 覆盖到的前缀长度 + 文本。session 级（每 session 一个 hook 实例）。
  let cache: { coveredCount: number; text: string } | null = null;

  return {
    name: "autoCompaction",

    async transformMessagesBeforeLlm(messages, ctx) {
      // 未到 token 阈值 → 原样。
      if (estimate(messages) <= threshold) return undefined;
      // 已经压无可压（tail 即全部）→ 总结救不了，交给 overflow 兜底，不在这里空转。
      if (messages.length <= keepRecent) return undefined;

      const targetCover = messages.length - keepRecent; // 想把前 targetCover 条总结掉

      if (cache === null || targetCover - cache.coveredCount >= resummarizeEvery) {
        // summarize 抛错让其冒泡：内核 pipe 对 transform 是 fail-open（记一笔后退化为不压缩）。
        // 赋值在 await 之后，抛错时 cache 不被脏写。
        const text = await opts.summarize(messages.slice(0, targetCover), ctx);
        cache = { coveredCount: targetCover, text };
      }

      const summaryMsg = createUserMessage(wrap(cache.text, cache.coveredCount));
      return [summaryMsg, ...messages.slice(cache.coveredCount)];
    },

    onContextOverflow(input, ctx) {
      if (!opts.abortOnOverflow) return;
      // `compaction:` 前缀 = compactRestartFresh 识别重启的契约（见 hook.ts ContextOverflowInput 注释）。
      ctx.abort(
        `compaction: context overflow at turn ${input.turnIdx} (stopReason=${input.stopReason})`,
      );
    },
  };
}
