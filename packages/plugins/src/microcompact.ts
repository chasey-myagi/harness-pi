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
 * **⚠️ Hook 顺序：本插件必须排在 `autoCompaction` 之前。** 与「压缩型 hook 排在裁剪型 hook 之前」准则一致——
 * microcompact 是廉价的「先清可重取的旧 tool 输出」，autoCompaction 是昂贵的「总结剩下的早期对话」。先让
 * microcompact 把白名单工具的体积降下来，autoCompaction 再据**裁剪后**的真实 view 决定是否还需要总结。反过来
 * 排（autoCompaction 在前）会让昂贵总结多跑、甚至把本可廉价清掉的 tool 输出也卷进 summary。
 *
 * **view-only（与 autoCompaction / trimHistory 同款）**：`transformMessagesBeforeLlm` 只改本次返回的 messages
 * 数组（copy-on-write），完整原始历史天然留在 store 里；不动 user 消息、assistant 推理、非白名单工具的 toolResult。
 *
 * 详见 docs/05-plugins.md。
 */

import type { Hook } from "@harness-pi/core";
import type { Message } from "@earendil-works/pi-ai";
import { estimateTokensByChars } from "./auto-compaction.js";

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
  /** token 估算器。默认 {@link estimateTokensByChars}（与 autoCompaction 同款、保守高估）。 */
  estimateTokens?: (messages: Message[]) => number;
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
 *   1. **体积**：`estimateTokens(messages) > triggerTokens` → 从最旧白名单 toolResult 起清，降到 `targetTokens` 以下即停。
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
  const estimate = opts.estimateTokens ?? estimateTokensByChars;
  const placeholderText =
    opts.placeholderText ??
    ((tool, chars) => `[microcompact: ${tool} output cleared, ~${chars} chars]`);

  return {
    name: "microcompact",
    timeout: 50,

    transformMessagesBeforeLlm(messages, _ctx) {
      // gap 判据：最后一条消息的 timestamp 距 now 超过 gapMinutes（cache 已冷）。
      let coldCache = false;
      if (opts.gapMinutes !== undefined && messages.length > 0) {
        const last = messages[messages.length - 1]!;
        const gapMs = now() - last.timestamp;
        coldCache = gapMs > opts.gapMinutes * 60_000;
      }

      // 体积没超阈值、且 cache 不冷 → 原样返回。
      if (estimate(messages) <= opts.triggerTokens && !coldCache) return undefined;

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
      const out = messages.slice(); // copy-on-write，绝不改原数组 / session.messages
      let cleared = 0;
      for (const idx of clearable) {
        if (!coldCache && estimate(out) <= targetTokens) break; // 体积已降到目标（gap 路径不早停）
        const msg = out[idx]! as ToolResult;
        const chars = contentChars(msg.content);
        out[idx] = {
          ...msg,
          content: [{ type: "text" as const, text: placeholderText(msg.toolName, chars) }],
        };
        cleared++;
      }

      if (cleared === 0) return undefined; // 体积本就 ≤ target 且非 coldCache → 无需清
      return out;
    },
  };
}
