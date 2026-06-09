/**
 * microcompact —— tool-result 级的廉价分档清理（issue #46，roadmap C2）。
 *
 * 借鉴 claude-code 的 microcompact：作为「full summarize」之前**便宜**的一手。它**不**调 LLM、**不**总结，
 * 只把「旧的、可重取的」白名单工具输出换成短占位符（原文仍由内核 durable 保存，模型若真需要可重新调用工具）。
 * 永远保留**最近 N 条** toolResult 原文不动——cache 友好、不破坏模型对近况的感知。
 *
 * 与 `trimHistory` 的关系：本插件是它的「按 token 体积 + 按工具白名单」升级版。trimHistory 按**条数**无条件
 * 裁剪所有 toolResult；microcompact 只在**体积超阈值**（或 cache 已冷）时动手、只清**白名单工具**、清到**目标
 * 体积**为止即停。两者都 view-only（只改本 turn 发给 LLM 的 view，绝不写 `session.messages`）。
 *
 * **⚠️ Hook 顺序：microcompact 应排在 `autoCompaction` 之前。** （**别**套用 `auto-compaction.ts` 里
 * 「autoCompaction 排在 `trimHistory` 等**裁剪型** transform 之前」那条规则来反推顺序——microcompact 不是那种
 * 无条件机械裁剪:它既不总结、也不按条数硬裁,而是**有条件地清掉可重取的白名单工具输出**,是比「总结」更廉价
 * 的一手,所以比 autoCompaction 还靠前。）理由:先让 microcompact 把白名单工具体积降下来,autoCompaction 再据
 * **清理后**的真实 view 决定是否还要花钱总结(体积已够低时直接 no-op)。反过来排会让昂贵总结多跑、甚至把本可
 * 廉价清掉的 tool 输出也卷进 summary。与 `trimHistory` 的取舍见下(microcompact 是其「按 token 体积 + 白名单 +
 * keepRecent」的升级版,一般二选一,不必同时挂)。
 *
 * **view-only（与 autoCompaction / trimHistory 同款）**：`transformMessagesBeforeLlm` 只改本次返回的 messages
 * 数组（copy-on-write），完整原始历史天然留在 store 里；不动 user 消息、assistant 推理、非白名单工具的 toolResult。
 */

import type { Hook } from "@harness-pi/core";
import type { Message } from "@earendil-works/pi-ai";
import { defaultTokenCounter, type TokenCounter } from "./auto-compaction.js";

export interface MicrocompactOptions {
  /** 只清这些工具产生的 toolResult。**不 hardcode 工具名**——由调用方传（domain-free）。string[] 会归一成 Set。 */
  compactableTools: Set<string> | string[];
  /** 估算 tokens 超过它才触发清理。须 > 0。 */
  triggerTokens: number;
  /**
   * 清理目标：从最旧开始清白名单 toolResult，清到估算体积 ≤ targetTokens 即停（不必全清）。
   * 默认 = triggerTokens（即「降回阈值以下」）。须 > 0 且 ≤ triggerTokens。
   */
  targetTokens?: number;
  /** 永远保留原样的最近 N 条 toolResult（不分工具）。默认 5。负数视为 0；非整数向下取整。 */
  keepRecent?: number;
  /**
   * 可选：距上次活动超过这么多分钟（cache 已冷），即使体积没超阈值也触发清理。
   * 用最后一条消息的 timestamp 与 `now()` 比较。须 > 0。不传则只按体积触发。
   */
  gapMinutes?: number;
  /** 当前时刻（ms）。默认 `Date.now`；测试可注入以走 `gapMinutes` 路径。 */
  now?: () => number;
  /**
   * Token 计数器（issue #55）。默认 {@link defaultTokenCounter}（请求级估算：messages + tool schema +
   * systemPrompt + 每消息开销）。触发判据与初始 running-total 据此算，故有 tools 时**触发点比旧 messages-only
   * 更早**。tools / systemPrompt 由内核经 `ctx.config` 提供。接真 tokenizer 时覆盖即可。
   */
  tokenCounter?: TokenCounter;
  /** 占位符文案（默认带工具名 + 原内容字符数提示）。 */
  placeholderText?: (toolName: string, originalChars: number) => string;
}

type ToolResult = Extract<Message, { role: "toolResult" }>;

/** toolResult 的 content 文本总字符数（占位符里给模型一个「原来多大」的提示）。 */
function contentChars(content: ToolResult["content"]): number {
  let n = 0;
  for (const b of content) {
    if (b.type === "text") n += b.text.length;
    else if (b.type === "image") n += 1; // 图片不按 base64 长度计，象征性记 1（避免占位符里报天文数字）
  }
  return n;
}

/**
 * 构造一个 microcompact hook。
 *
 * 触发判据（满足任一即动手）：
 *   1. **体积**：`tokenCounter.estimate({messages, tools, systemPrompt}) > triggerTokens`（请求级估算，含每请求随发的
 *      tool schema + systemPrompt）→ 从最旧白名单 toolResult 起清，降到 `targetTokens` 以下即停。
 *   2. **gap**（可选）：`now() - 最后一条消息的 timestamp > gapMinutes` 分钟（cache 已冷）→ 把**所有**可清的白名单
 *      toolResult 清掉（cache 反正要冷启重发，激进清以缩短下次冷启动 prompt，不受 targetTokens 早停约束）。
 *
 * 两种动作都永远跳过**最近 keepRecent 条** toolResult 与所有非白名单工具的 toolResult。
 */
export function microcompact(opts: MicrocompactOptions): Hook {
  const compactable =
    opts.compactableTools instanceof Set
      ? opts.compactableTools
      : new Set(opts.compactableTools);
  if (!(opts.triggerTokens > 0)) {
    throw new Error("microcompact: triggerTokens must be > 0");
  }
  const targetTokens = opts.targetTokens ?? opts.triggerTokens;
  if (!(targetTokens > 0 && targetTokens <= opts.triggerTokens)) {
    throw new Error("microcompact: targetTokens must be in (0, triggerTokens]");
  }
  const keepRecent = Math.max(0, Math.floor(opts.keepRecent ?? 5));
  if (opts.gapMinutes !== undefined && !(opts.gapMinutes > 0)) {
    throw new Error("microcompact: gapMinutes must be > 0");
  }
  const now = opts.now ?? Date.now;
  const counter = opts.tokenCounter ?? defaultTokenCounter;
  const placeholderText =
    opts.placeholderText ??
    ((tool, chars) => `[microcompact: ${tool} output cleared, ~${chars} chars]`);

  return {
    name: "microcompact",
    timeout: 50,

    transformMessagesBeforeLlm(messages, ctx) {
      // 请求级估算：messages 之外把每请求随发的 tool schema + systemPrompt 也计入（X1，issue #55）。
      // 这两项是**固定常量**（清消息不改它），故下面增量 running-total 的 delta 里会自然抵消（见 142 行注释）。
      const reqExtras = {
        tools: ctx.config.tools,
        systemPrompt: ctx.config.systemPrompt,
      };
      // 单消息估值（不含 tools/systemPrompt；其每消息开销常量在 delta 里抵消）——用于增量 running-total。
      const estimateOne = (m: Message): number => counter.estimate({ messages: [m] });

      // gap 判据：最后一条消息的 timestamp 距 now 超过 gapMinutes（cache 已冷）。
      let coldCache = false;
      if (opts.gapMinutes !== undefined && messages.length > 0) {
        const last = messages[messages.length - 1]!;
        const gapMs = now() - last.timestamp;
        coldCache = gapMs > opts.gapMinutes * 60_000;
      }

      // 体积没超阈值、且 cache 不冷 → 原样返回。
      if (
        counter.estimate({ messages, ...reqExtras }) <= opts.triggerTokens &&
        !coldCache
      )
        return undefined;

      // 找出**可清**的白名单 toolResult 下标（排除最近 keepRecent 条 toolResult）。
      const toolResultIdxs: number[] = [];
      for (let i = 0; i < messages.length; i++) {
        if (messages[i]?.role === "toolResult") toolResultIdxs.push(i);
      }
      const clearableLimit = toolResultIdxs.length - keepRecent; // 这之前的 toolResult 才允许清
      const clearable: number[] = [];
      for (let rank = 0; rank < clearableLimit; rank++) {
        const idx = toolResultIdxs[rank]!;
        const msg = messages[idx]!;
        if (msg.role === "toolResult" && compactable.has(msg.toolName)) {
          clearable.push(idx);
        }
      }
      if (clearable.length === 0) return undefined; // 没有可清的（全在 keepRecent 内 / 全非白名单）

      // 体积触发：从最旧开始清，清到 ≤ targetTokens 即停（不必全清）。
      // gap 触发（coldCache）：不设早停，把所有可清的都清掉（cache 反正冷了）。
      //
      // **增量 running total，不每轮全量重估。** estimateRequestTokens 在 messages 字符估算之上只加**固定常量**
      // （tool schema + systemPrompt + 每消息开销 ×N，N 不变）；其 messages 部分逐消息可加，故替换一条时
      // `estimateOne(原) - estimateOne(占位)` 正是整体估值的精确变化量——固定常量在差值里抵消，结果与
      // 全量 `counter.estimate({messages: out, ...reqExtras})` 重估**完全一致**，复杂度仍从 O(N·K) 降到 O(N+K)。
      // 这点很关键：本 transform 是**同步**的，`timeout:50` 拦不住同步循环（计时器在同步阻塞期间根本没机会
      // fire），而本插件正是为大文件读取场景设计、harness 又是多 session 跑在单 event loop（WorkPool/
      // LeaseQueue）——全量重估的 O(N·K) 会让一个 session 的压缩同步冻住其余所有 session。
      const out = messages.slice(); // copy-on-write，绝不改原数组 / session.messages
      let total = counter.estimate({ messages: out, ...reqExtras }); // 开头估一次（含固定常量）
      for (const idx of clearable) {
        if (!coldCache && total <= targetTokens) break; // O(1) 比较；降到目标即停（gap 路径不早停）
        const msg = out[idx]! as ToolResult;
        const chars = contentChars(msg.content);
        const placeholder: ToolResult = {
          ...msg,
          content: [{ type: "text" as const, text: placeholderText(msg.toolName, chars) }],
        };
        total -= estimateOne(msg) - estimateOne(placeholder); // 精确减去本条清理带来的体积下降（固定常量抵消）
        out[idx] = placeholder;
      }

      // 走到这里必然清了 ≥1 条：volume 路径的入口判据已保证 total > triggerTokens ≥ targetTokens（首轮不早停）；
      // cold 路径不早停、且 clearable 非空。故无需 cleared===0 的死分支。
      return out;
    },
  };
}
