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
 *
 * **语义：view-only（#16 的结论）。** 本插件是**只读、非破坏**的——`transformMessagesBeforeLlm` 只压缩
 * 「本 turn 发给 LLM 的 view」，**绝不改写 `session.messages`**，故完整原始历史**天然**留在 store 里
 * （by construction 满足 #2「原始历史保留在 store」）。这与 `compactSummarize` 同款。
 * 因此 resume 时会重放全量历史、模型每 turn 看到的是重新总结的 view，本插件**不写** `compaction_boundary`
 * store 条目——那是另一条路径（**persistent boundary**）的职责：由 `compactRestartFresh` 控制器把 summary
 * 持久化进 store、resume 从 summary 起算、丢弃边界前缀，经 `abortOnOverflow` 抵达。两条路径分工明确，
 * 本插件刻意不再叠加写 store 的机制（会与 `compactRestartFresh` 冗余、并破坏内核 _flushToStore 不变量）。
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
  /**
   * token 估算器。默认 {@link estimateTokensByChars}：CJK 感知（≈ 1 token/字）+ 图片感知（每图扁平估值），
   * 整体偏**保守高估**（低估会漏触发压缩→窗口溢出，是安全 bug）；零依赖。接入真 tokenizer 可覆盖。
   */
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

/**
 * CJK 码点（含统一表意文字 + 常见 CJK 标点 / 全角字符）。这些码点在主流 tokenizer 里普遍 ≈ 1 token/字，
 * 远稠密于 ASCII 的 ≈ 4 char/token，故单独计数。范围按码点匹配（用 /u flag）：
 * 　-〿 CJK 符号与标点、㐀-䶿 扩展 A、一-鿿 统一表意文字、豈-﫿 兼容表意文字、＀-￯ 全角/半角形式。
 */
const CJK_RE = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]/gu;

/** 单张图片的保守、扁平 token 估算（issue #14）：宁可高估、不可低估，避免漏触发→窗口溢出。 */
const IMAGE_TOKENS = 1000;

/**
 * 估算单条文本的 token：CJK 码点按 ≈ 1 token/字计，其余字符按 ≈ 1/4 token 计（向上取整）。
 * 偏向**高估**——本数用于压缩触发判据，低估的代价是漏触发后 context 溢出（安全 bug，见 #14）。
 */
function estimateText(text: string): number {
  const cjk = (text.match(CJK_RE) ?? []).length;
  const rest = text.length - cjk;
  return cjk + Math.ceil(rest / 4);
}

/**
 * 默认 token 估算：CJK 感知 + 图片感知，整体偏保守（高估）。粗但单调、确定、零依赖。
 *
 * - **CJK**：每个 CJK 码点 ≈ 1 token（不是 chars/4）。`你好世界` → ≈ 4 token，不再被 4× 低估。
 * - **图片**：image content block（pi-ai 判别式 `type === "image"`）贡献**扁平** {@link IMAGE_TOKENS} token，
 *   既不按短 ref 的字符数低估、也不按内联 base64 `data` 的字符数疯狂高估。
 * - **其余文本**（ASCII 等）：≈ 1/4 token/字符（向上取整），故纯英文仍 ≈ chars/4。
 *
 * 想接真 tokenizer：覆盖 `estimateTokens` 选项即可。
 */
export function estimateTokensByChars(messages: Message[]): number {
  let tokens = 0;
  for (const m of messages) {
    if (typeof m.content === "string") {
      tokens += estimateText(m.content);
      continue;
    }
    for (const b of m.content) {
      if (b.type === "image") {
        tokens += IMAGE_TOKENS;
      } else if ("text" in b && typeof b.text === "string") {
        tokens += estimateText(b.text);
      } else {
        // 其余块（thinking / toolCall 等）按其 JSON 序列化长度粗估，仍走 1/4 规则。
        tokens += estimateText(JSON.stringify(b));
      }
    }
  }
  return tokens;
}

/**
 * 构造一个 autoCompaction hook。三条**使用须知**（issue #13，违反会得到悄无声息的错误压缩）：
 *
 * 1. **Hook 顺序**：本插件从 `transformMessagesBeforeLlm` 收到的 `messages`（≈ `session.messages`）估算
 *    token，故它必须排在 `trimHistory` 这类**内容裁剪型** transform **之前**。若 `trimHistory` 先跑、把
 *    旧 toolResult 换成了占位符，autoCompaction 读到的体积就是裁剪**后**的、与真实 context 不符的**陈旧值**，
 *    可能漏触发。准则：压缩型 hook 排在裁剪型 hook 前面。
 * 2. **与 compactSummarize 共存**：两者是**二选一**（pick one）。同一 session 的 hook 链里**同时**挂两个，
 *    会顺序各跑、各自维护**独立缓存**，产生**未定义的压缩边界**（谁先压、压到哪、summary 互相覆盖均无保证）。
 *    选一个用。
 * 3. **每 session 一个实例**：闭包缓存（`coveredCount` + summary 文本）假设**一个 hook 实例只服务一个 session**。
 *    把同一个实例**跨 session 复用**会让 `coveredCount` 被另一个 session 的前缀长度污染，导致 view 错位。
 *    每个 session 各 `autoCompaction(...)` 一次。
 */
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
