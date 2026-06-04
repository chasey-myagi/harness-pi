/**
 * Trim history —— 把 N 条之前的 toolResult content 替换成短占位符。
 *
 * 源自 bidding-agent v3.3 实测：turn 11+ input/turn 从 86K → 35K (-59%)。
 * 不动 session.messages，只改 LLM 看到的 view（通过 transformMessagesBeforeLlm）。
 *
 * 详见 docs/05-plugins.md §5.2。
 */

import type { Hook } from "@harness-pi/core";
import type { Message } from "@earendil-works/pi-ai";

export interface TrimHistoryOptions {
  /** 最近 N 条 toolResult 保留原样。N=0 全部 trim；负数视为 0；非整数向下取整。 */
  keepRecent: number;
  /** Placeholder 文案生成器（默认带 tool name 提示别再调用）。 */
  placeholderText?: (toolName: string) => string;
}

export function trimHistory(opts: TrimHistoryOptions): Hook {
  const keep = Math.max(0, Math.floor(opts.keepRecent));
  const placeholderText =
    opts.placeholderText ??
    ((tool) =>
      `[trimmed tool result: ${tool} — older context, do not re-call unless needed]`);

  return {
    name: "trim-history",
    timeout: 50,

    transformMessagesBeforeLlm(messages, _ctx) {
      const toolResultIdxs: number[] = [];
      for (let i = 0; i < messages.length; i++) {
        if (messages[i]?.role === "toolResult") toolResultIdxs.push(i);
      }
      if (toolResultIdxs.length <= keep) return undefined;

      const cutoff = toolResultIdxs[toolResultIdxs.length - keep - 1];
      if (cutoff === undefined) return undefined;

      return messages.map((m, i): Message => {
        if (i > cutoff || m.role !== "toolResult") return m;
        return {
          ...m,
          content: [
            {
              type: "text" as const,
              text: placeholderText(m.toolName ?? "(unknown)"),
            },
          ],
        };
      });
    },
  };
}
