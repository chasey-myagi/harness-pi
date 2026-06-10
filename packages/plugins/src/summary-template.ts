/**
 * summary-template —— 可覆盖的 9 段 summary 模板 + `defaultSummarize` 工厂（C4，docs/09 §4.2）。
 *
 * `compactSummarize` / `autoCompaction` 的 `summarize` 契约是「把一批早期消息总结成一段文本」，但**怎么
 * 总结**留给调用方。本文件提供一个**默认实现**：借鉴 Claude Code compaction 的「9 段结构化回顾」模板，
 * 但**完全 domain-free**（不硬编任何业务），让模型把早期对话压成高保真的结构化 summary。
 *
 * **接缝**：summarize 跑在 `transformMessagesBeforeLlm` 内、需要再调一次 LLM，但 `HookContext` 不暴露
 * 「调 LLM」的能力（内核刻意不把 model 句柄塞进 ctx）。故工厂要求调用方注入一个最薄的
 * `complete: (prompt) => Promise<string>`——它把 prompt 发给某个 model、拿回纯文本。调用方用 pi-ai
 * 的 `complete()` / 自己的 model wrapper 实现它（plugins 层不依赖 pi-ai 的 complete API，保持 seam 干净）。
 */

import type { HookContext } from "@harness-pi/core";
import type { Message } from "@earendil-works/pi-ai";

/**
 * 默认 9 段 summary 模板（domain-free）。`{transcript}` 是唯一占位符，渲染时替换成早期消息文本。
 * 借鉴 Claude Code compaction 的结构化回顾，但去掉一切业务/工具专属措辞——只要求模型按 9 段组织。
 */
export const DEFAULT_SUMMARY_TEMPLATE = `You are compacting an earlier portion of a conversation into a structured summary so the work can continue without losing context. Read the transcript below and produce a summary organized into these 9 numbered sections. Be specific and faithful; do not invent details, and preserve exact names, paths, and identifiers.

1. Primary Request and Intent: What the user originally asked for and what they are ultimately trying to achieve.
2. Key Concepts: The important technical concepts, terms, and ideas that came up.
3. Files and Resources: The specific files, directories, URLs, or other resources referenced or modified, and why each matters.
4. Errors and Fixes: Any errors, failures, or problems encountered and how each was (or was not) resolved.
5. Problem Solving: The reasoning, approaches, and decisions made while working through the task.
6. All User Messages: A faithful list of every message the user sent (paraphrased but complete), so their guidance is not lost.
7. Pending Tasks: Work that was explicitly requested but is not yet done.
8. Current Work: What was being worked on at the very end of this transcript.
9. Next Step: The single most logical next step to continue the work.

<transcript>
{transcript}
</transcript>`;

/** 把一条 message 渲染成 transcript 里的一行（role: text）。toolResult 也带上工具名，便于模型对账。 */
function renderMessage(m: Message): string {
  const text =
    typeof m.content === "string"
      ? m.content
      : m.content
          .map((b) => {
            if ("text" in b && typeof b.text === "string") return b.text;
            if (b.type === "toolCall")
              return `[toolCall ${b.name} ${JSON.stringify(b.arguments)}]`;
            if (b.type === "image") return "[image]";
            return JSON.stringify(b);
          })
          .join("");
  if (m.role === "toolResult") return `toolResult(${m.toolName}): ${text}`;
  return `${m.role}: ${text}`;
}

/** 把一批早期消息渲染进模板的 `{transcript}` 占位符，得到最终 prompt。导出供测试/调用方复用。 */
export function renderSummaryPrompt(
  earlyMessages: Message[],
  template: string = DEFAULT_SUMMARY_TEMPLATE,
): string {
  const transcript = earlyMessages.map(renderMessage).join("\n");
  return template.replace("{transcript}", transcript);
}

export interface DefaultSummarizeOptions {
  /**
   * 把一段 prompt 发给某个 model、拿回纯文本的最薄 seam（调用方注入；可调真 LLM）。
   * plugins 层不依赖 pi-ai 的 complete API，调用方用 pi-ai `complete()` / 自己的 wrapper 实现它。
   */
  complete: (prompt: string) => Promise<string>;
  /** 覆盖默认 9 段模板。须含 `{transcript}` 占位符（否则早期消息不会被注入）。 */
  template?: string;
}

/**
 * 工厂：返回一个**兼容 `CompactSummarizeOptions.summarize` / `AutoCompactionOptions.summarize`** 的函数。
 * 内部把 earlyMessages 渲染进 9 段 prompt（或 `opts.template` 覆盖的模板），再调注入的 `complete` 拿回 summary。
 */
export function defaultSummarize(
  opts: DefaultSummarizeOptions,
): (earlyMessages: Message[], ctx: HookContext) => Promise<string> {
  const template = opts.template ?? DEFAULT_SUMMARY_TEMPLATE;
  return async (earlyMessages: Message[]) => {
    const prompt = renderSummaryPrompt(earlyMessages, template);
    return opts.complete(prompt);
  };
}
