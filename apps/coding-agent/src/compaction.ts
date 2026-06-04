/**
 * Compaction 支撑（P4）：把"早期消息 → 一段摘要"的 summarize 实现成调真实模型的一次性 complete。
 *
 * compactSummarize 插件（@harness-pi/plugins）是 view-transform：在 transformMessagesBeforeLlm 里
 * 把超出阈值的早期消息换成一条 summary（不毁原始历史，只压"发给 LLM 的视图"）。这里提供它需要的
 * `summarize(earlyMessages) => string`，用 pi-ai 的 complete() 跑一次无工具的总结调用。
 */

import { complete, type Context } from "@earendil-works/pi-ai";
import {
  createUserMessage,
  type Api,
  type Message,
  type Model,
} from "@harness-pi/core";

const SUMMARY_SYSTEM =
  "You compress a coding-agent conversation into a dense briefing for the agent to continue from.";

const SUMMARY_INSTRUCTION = [
  "Summarize the conversation so far into a compact briefing that preserves everything needed to continue:",
  "- the user's goal(s) and any constraints",
  "- key decisions, file paths, and code/identifiers touched",
  "- tool results that still matter and what's left to do",
  "Be terse and factual. No preamble. Output only the briefing.",
].join("\n");

/** 从一条 assistant 消息里抽出纯文本（拼接所有 text block）。 */
function assistantText(message: { content: Message["content"] }): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * 造一个 summarize 函数：拿早期消息 + 一条总结指令，调一次模型（无工具），返回摘要文本。
 *
 * **失败必须抛**：pi-ai 的 complete() 在 provider 报错 / 限流 / 超窗(length) / 中途 abort 时**不抛**，
 * 而是 resolve 出一条 `stopReason !== "stop"`、content 为空的 AssistantMessage。若此时静默返回空串，
 * compactSummarize 会把这个"空摘要"缓存下来、并用它**替换掉早期 N 条真实消息**——早期上下文被无声丢光、
 * 且因为进了 cache 会持续多轮。compactSummarize 的 fail-open 只在 summarize **抛错**时触发（抛错时它不写脏
 * cache、退化为发全量未压缩消息）。所以这里：非正常收尾 / 空文本一律抛，把控制权交回 fail-open。
 *
 * 透传 `signal`：summary 调用是一次独立 LLM 请求，用户中途 Esc/Ctrl-C 时应能及时取消（否则白跑一次）。
 */
export function createModelSummarizer(
  model: Model<Api>,
  llmOptions?: Record<string, unknown>,
): (earlyMessages: Message[], signal?: AbortSignal) => Promise<string> {
  return async (earlyMessages, signal) => {
    const context: Context = {
      messages: [...earlyMessages, createUserMessage(SUMMARY_INSTRUCTION)],
      tools: [],
      systemPrompt: SUMMARY_SYSTEM,
    };
    const options: Record<string, unknown> = { ...llmOptions };
    if (signal) options.signal = signal;
    const result = await complete(model, context, options);
    const text = assistantText(result);
    if (result.stopReason !== "stop" || text.length === 0) {
      throw new Error(
        `compaction summarize failed (stopReason=${result.stopReason})` +
          (result.errorMessage ? `: ${result.errorMessage}` : ""),
      );
    }
    return text;
  };
}
