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
import type { Message, Tool } from "@earendil-works/pi-ai";
import { POST_COMPACT_PENDING_KEY } from "./post-compact-file-reread.js";

export interface AutoCompactionOptions {
  /**
   * context token 预算（百分比触发路径）。须 > 0。
   *
   * **触发路径优先级（X2 / #57）**：
   *   - 显式给了 `maxContextTokens` → 永远走百分比路径 `> maxContextTokens * triggerRatio`（尊重调用方的显式上限，
   *     与旧行为一致；现有测试多走此路径）。
   *   - 未给 `maxContextTokens`、但 `ctx.config.model.contextWindow > 0` → 走**绝对窗口路径**
   *     `> contextWindow − reserveForOutput − safetyBuffer`（X2 的有效窗口阈值，更贴近真实窗口压力）。
   *   - 两者都不可得（无 maxContextTokens 且 contextWindow 为 0/缺）→ 算不出阈值，本 turn 不压缩
   *     （contextWindow 是运行时值、构造期无从校验，故退化为 no-op 而非构造期报错）。
   *
   * 即：**显式 maxContextTokens 压过窗口路径**；窗口路径是「没显式上限时用模型自带窗口」的兜底主路。
   */
  maxContextTokens?: number;
  /** 触发比例（百分比路径）：估算 tokens > `maxContextTokens * triggerRatio` 才压缩。默认 0.8，须 ∈ (0, 1]。 */
  triggerRatio?: number;
  /**
   * 窗口路径（X2 / #57）给模型输出 + summary/续答预留的 token 数（从 contextWindow 里扣掉）。
   * 默认 `Math.min(model.maxTokens, 4096)`——既不超模型实际能输出的上限、又给个合理保底。须 ≥ 0。
   */
  reserveForOutput?: number;
  /**
   * 窗口路径（X2 / #57）的绝对安全缓冲（再从 contextWindow 里多扣一截，吸收估算误差）。默认 0，须 ≥ 0。
   */
  safetyBuffer?: number;
  /** 压缩后原样保留的最近消息条数（recent tail）。默认 6，须 ≥ 1。 */
  keepRecent?: number;
  /** 把一批早期消息总结成文本（可 async / 调 LLM）——与 compactSummarize 同契约。 */
  summarize: (
    earlyMessages: Message[],
    ctx: HookContext,
  ) => string | Promise<string>;
  /**
   * Token 计数器（issue #55）。默认 {@link defaultTokenCounter}：`estimate` = {@link estimateRequestTokens}，
   * 在 messages 字符估算之上**加回** tool schema + systemPrompt + 每消息格式开销（只数消息会低估真 usage ~7x）。
   * 触发判据据此算，故有 tools 时**触发点比旧 messages-only 更早 = 更贴近真实窗口压力**（0.x 可接受的行为变更）。
   * tools / systemPrompt 由内核经 `ctx.config` 提供，无需调用方传。接入真 tokenizer 时覆盖本选项即可。
   */
  tokenCounter?: TokenCounter;
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
 * 单个 CJK 码点判定（含统一表意文字 + 常见 CJK 标点 / 全角字符）。这些码点在主流 tokenizer 里普遍
 * ≈ 1 token/字，远稠密于 ASCII 的 ≈ 4 char/token，故单独计数。**非 global**，用于逐码点 `.test`：
 * 　-〿 CJK 符号与标点、㐀-䶿 扩展 A、一-鿿 统一表意文字、豈-﫿 兼容表意文字、＀-￯ 全角/半角形式，
 * 以及 \u{20000}-\u{2ffff} 扩展 B–F（代理对，需 /u flag + 按码点迭代才能正确命中，否则被当 2 个 ASCII）。
 */
const CJK_CP = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]|[\u{20000}-\u{2ffff}]/u;

/** 单张图片的保守、扁平 token 估算（issue #14）：宁可高估、不可低估，避免漏触发→窗口溢出。 */
const IMAGE_TOKENS = 1000;

/**
 * 估算单条文本的 token：CJK 码点按 ≈ 1 token/字计，其余字符按 ≈ 1/4 token 计（向上取整）。
 * 偏向**高估**——本数用于压缩触发判据，低估的代价是漏触发后 context 溢出（安全 bug，见 #14）。
 *
 * **按码点迭代**（`for...of`）而非按 `.length`（UTF-16 码元）：这样扩展 B+ 的代理对 CJK（如 𠀀）算 1 个
 * 码点 = 1 token（否则 `.length===2` 会被当 2 个 ASCII 字符），且 CJK/ASCII 混排时 `rest` 计数单位一致。
 */
function estimateText(text: string): number {
  let cjk = 0;
  let rest = 0;
  for (const ch of text) {
    if (CJK_CP.test(ch)) cjk++;
    else rest++;
  }
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
 * **仅数消息文本**——不含每请求随发的 tool schema / systemPrompt / 格式开销（那些会**严重低估**真 usage，
 * 见 {@link estimateRequestTokens}）。保留本函数原样是为向后兼容；消费插件默认走请求级的 {@link defaultTokenCounter}。
 * 想接真 tokenizer：覆盖插件的 `tokenCounter` 选项即可。
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

/** 每条消息的固定格式开销（role / 分隔符 / 模板包装），主流 chat 模板约 3–4 tok/消息，取保守 4。 */
export const PER_MESSAGE_OVERHEAD = 4;

/** {@link estimateRequestTokens} 的输入：一次 LLM 请求随发的三部分（tools / systemPrompt 每请求都发）。 */
export interface RequestTokenInput {
  messages: Message[];
  /** 本次请求随发的 tool schema（pi-ai `Tool`：name + description + parameters）。 */
  tools?: ReadonlyArray<Tool>;
  /** 本次请求的 system prompt。 */
  systemPrompt?: string;
}

/**
 * 估算**整次 LLM 请求**的 token —— 在 {@link estimateTokensByChars}(messages) 之上，**加回**那些每请求随发、
 * 却被「只数消息文本」漏掉的固定开销（issue #55 / D0 实测：只数消息低估真 usage ~7x，根因正是漏了下面三项）：
 *
 *   1. **tool schema**：每个 tool 的 `name` + `description` + `JSON.stringify(parameters)` 字符估算（走 1/4 规则）。
 *      工具一多、parameters schema 一深，这块就是估算盲区里最大的一块。
 *   2. **systemPrompt**：整段 system prompt 的字符估算（复用 CJK 感知的 {@link estimateTokensByChars}）。
 *   3. **每消息格式开销**：每条消息一个小常量（{@link PER_MESSAGE_OVERHEAD}），覆盖 role / 分隔符 / 模板包装。
 *
 * CJK / image / chars-1/4 规则全部沿用 estimateTokensByChars，整体仍偏**保守高估**（压缩触发判据宁高勿低）。
 * tools / systemPrompt **不传**时本函数退化为「estimateTokensByChars(messages) + 每消息常量」——比纯 messages-only
 * 仍多算每消息常量，但语义一致。
 */
export function estimateRequestTokens(input: RequestTokenInput): number {
  let tokens = estimateTokensByChars(input.messages);
  tokens += input.messages.length * PER_MESSAGE_OVERHEAD;
  if (input.systemPrompt) {
    tokens += estimateText(input.systemPrompt);
  }
  if (input.tools) {
    for (const t of input.tools) {
      tokens += estimateText(t.name);
      tokens += estimateText(t.description);
      tokens += estimateText(JSON.stringify(t.parameters));
    }
  }
  return tokens;
}

/**
 * Token 计数 seam（issue #55）。`estimate` = 同步、零依赖的字符估算（默认 {@link estimateRequestTokens}）；
 * `count` = 未来 opt-in 的**真** tokenizer（async）。
 *
 * **当前不实现 `count`**：pi-ai 0.74.2 无 `countTokens`（D0 已核），保留可选签名只为留一个不破坏 API 的接入口
 * （将来接真 tokenizer / provider count endpoint 时填它，消费方按需 `await counter.count?.(...)`）。
 *
 * **`estimate` 的 additivity 契约（自定义实现须遵守）**：`microcompact` 的增量 running-total
 * （`total -= estimate({messages:[原]}) - estimate({messages:[占位]})`）只有在「`estimate` 对 messages 逐条可加、
 * 且 tools/systemPrompt/每消息开销是**与单条消息无关的固定常量**」时才与全量重估逐 token 等价。默认
 * {@link estimateRequestTokens} 满足。**非可加的真 BPE tokenizer 不满足**（token 跨消息边界、request framing 非线性）——
 * 注入这类 counter 会让 microcompact 的体积早停漂移。届时应让 microcompact 改为每步全量 `estimate(整段)`，或只在
 * autoCompaction（无增量假设）里用它。
 */
export interface TokenCounter {
  estimate(input: RequestTokenInput): number;
  count?(input: RequestTokenInput): Promise<number>;
}

/** 默认 TokenCounter：`estimate` = {@link estimateRequestTokens}；不提供 `count`。 */
export const defaultTokenCounter: TokenCounter = {
  estimate: estimateRequestTokens,
};

/**
 * 混合 token 计量（issue #13 / C5）：取 messages 里**最近一条带真 `Usage` 的 assistant** 作基线
 * （`input + cacheRead + cacheWrite + output` —— 那一刻真实的 prompt+output 体积，**已含 tools/systemPrompt**），
 * 只对其后的消息走字符估算补尾（{@link estimateTokensByChars}，messages-only，**不再加 tools/systemPrompt**：
 * 它们已计在真基线里，再加会双重计）。有真 usage 时基线精确——修掉 D0 实测的残差（messages-only 低估
 * ~7x；X1 加回 tools/sys 后仍 ~2x，因 chat 模板/tool schema 自有格式比 char/4 重）。
 *
 * 无可用真 usage 时退回 {@link estimateRequestTokens}（X1，含 tools/systemPrompt）：(a) turn-0 还没 assistant；
 * (b) assistant `usage` 全 0（fake-model / provider 未回 usage）—— 视为「无真值」而非「真的 0」。这保证不挂真
 * provider 时（如 fake-model 测试）行为与 {@link defaultTokenCounter} 完全一致。
 *
 * **不满足 additivity 契约**（基线随「最近 assistant」跳变、非逐条可加）——故**别**用作 microcompact 的增量
 * counter；它专给 autoCompaction（每 turn 全量 estimate、无增量假设）做更准的触发判据。
 */
export const hybridTokenCounter: TokenCounter = {
  estimate(input: RequestTokenInput): number {
    const msgs = input.messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m === undefined || m.role !== "assistant") continue;
      const u = m.usage;
      // 判别「有无真值」**故意只看 input+output、忽略 cache**：fake-model / 未回 usage 的标志是
      // input==output==0(testing.ts zeroUsage);真 assistant 输出内容必有 output>0。别把判别改成含
      // cacheRead/cacheWrite —— 否则纯缓存命中(理论上 input=output=0、cacheRead>0)会被误判为真值,
      // 且会让 fake 全 0 的 parity 假设变脆。continue(非 break):越过零-usage 继续往前找最近真值。
      if (!u || u.input + u.output <= 0) continue;
      // 基线 = 那一刻真实 prompt+output footprint(= pi-ai 自己的 totalTokens;input 已排除 cached,故 +cache)。
      const baseline = u.input + u.cacheRead + u.cacheWrite + u.output;
      // 补尾只数后缀消息字符(messages-only)。注:未加后缀的每消息 framing(~4tok/条),故对后缀略偏低估;
      // 后缀在 turn 间有界(就最近几条)、基线主导且精确,这点偏差对「宁高勿低」的触发阈值可忽略。
      return baseline + estimateTokensByChars(msgs.slice(i + 1));
    }
    return estimateRequestTokens(input);
  },
};

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
  // maxContextTokens 可选（X2）：给了就走百分比路径(并须 > 0)；不给则走窗口路径(阈值来自 ctx.config.model)。
  if (opts.maxContextTokens !== undefined && !(opts.maxContextTokens > 0)) {
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
  if (opts.reserveForOutput !== undefined && opts.reserveForOutput < 0) {
    throw new Error("autoCompaction: reserveForOutput must be >= 0");
  }
  if (opts.safetyBuffer !== undefined && opts.safetyBuffer < 0) {
    throw new Error("autoCompaction: safetyBuffer must be >= 0");
  }
  // 默认走混合计量（C5）：有真 usage 用真基线（更准、修 D0 残差），无真 usage（turn-0 / fake）退回 X1。
  const counter = opts.tokenCounter ?? hybridTokenCounter;
  const safetyBuffer = opts.safetyBuffer ?? 0;
  // 百分比路径阈值是构造期常量；窗口路径阈值依赖 ctx.config.model.contextWindow，须每请求算。
  const percentThreshold =
    opts.maxContextTokens !== undefined ? opts.maxContextTokens * triggerRatio : undefined;
  const wrap =
    opts.summaryText ??
    ((summary, n) => `[auto-compacted summary of ${n} earlier messages]\n${summary}`);

  // 闭包缓存：上次 summary 覆盖到的前缀长度 + 文本。session 级（每 session 一个 hook 实例）。
  let cache: { coveredCount: number; text: string } | null = null;

  return {
    name: "autoCompaction",

    async transformMessagesBeforeLlm(messages, ctx) {
      // 触发阈值（X2 #57，优先级：显式 maxContextTokens 压过窗口路径）：
      //   - 给了 maxContextTokens → 百分比路径常量 percentThreshold（旧行为，尊重显式上限）。
      //   - 否则用 model.contextWindow > 0 → 窗口路径 contextWindow − reserveForOutput − safetyBuffer。
      //   - 两者都不可得 → 算不出阈值，本 turn 不压缩（return undefined）。
      let threshold = percentThreshold;
      if (threshold === undefined) {
        const contextWindow = ctx.config.model.contextWindow;
        if (contextWindow > 0) {
          const reserveForOutput = opts.reserveForOutput ?? Math.min(ctx.config.model.maxTokens, 4096);
          const w = contextWindow - reserveForOutput - safetyBuffer;
          // 防 footgun:reserve+safetyBuffer >= contextWindow 时 w<=0,直接用会让 estimated(>=0)永远 > 阈值
          // → 每 turn 都压缩(过度激进)。视为「算不出有意义阈值」→ 本 turn no-op(下面 threshold===undefined 兜底)。
          // 这种 misconfig 需 window < reserve(本就荒谬),no-op 比每 turn 空压更安全、更可诊断。
          if (w > 0) threshold = w;
        }
      }
      if (threshold === undefined) return undefined;

      // 未到 token 阈值 → 原样。tools / systemPrompt 由 ctx.config 提供，计入每请求随发的固定开销（X1）。
      // deferredTools 在场时，本 turn 实际随发的是激活子集（deferred.activeListing），按它估更准；
      // 无 deferredTools 则退回 ctx.config.tools 全集（0.2.x 行为）。
      const estimated = counter.estimate({
        messages,
        tools: ctx.state.get("deferred.activeListing") ?? ctx.config.tools,
        systemPrompt: ctx.config.systemPrompt,
      });
      if (estimated <= threshold) return undefined;
      // 已经压无可压（tail 即全部）→ 总结救不了，交给 overflow 兜底，不在这里空转。
      if (messages.length <= keepRecent) return undefined;

      const targetCover = messages.length - keepRecent; // 想把前 targetCover 条总结掉

      if (cache === null || targetCover - cache.coveredCount >= resummarizeEvery) {
        // summarize 抛错让其冒泡：内核 pipe 对 transform 是 fail-open（记一笔后退化为不压缩）。
        // 赋值在 await 之后，抛错时 cache 不被脏写。
        const text = await opts.summarize(messages.slice(0, targetCover), ctx);
        cache = { coveredCount: targetCover, text };
        // 仅在**本 turn 真跑了一次新总结**时标记，供 postCompactFileReread 下一 turn 重读关键文件
        // （opt-in，缺该插件无副作用）。**不可**放在分支外：messages 是 append-only 原始 _messages，
        // 一旦越阈值就永久在阈值之上，分支外 set 会让每个越界 turn 都重置标记 → 重读每 turn 重复注入。
        ctx.state.set(POST_COMPACT_PENDING_KEY, ctx.turnIdx);
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
