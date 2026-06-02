/**
 * 纯显示格式化函数（可单测）。把 TuiAction 的数据折成给 pi-tui 组件用的字符串——
 * 所有"长什么样"的逻辑集中在这里，app.ts 只负责把字符串塞进组件 + 触发渲染。
 */

import type { ToolCall } from "@harness-pi/core";
import { color } from "./theme.js";

/** 截断长文本，超出附 `… (+N more lines)` 提示，避免把整屏刷爆（pi-tui 超宽/超高会很糟）。 */
export function truncate(text: string, maxLines = 24, maxChars = 4000): string {
  let out = text;
  if (out.length > maxChars) out = out.slice(0, maxChars) + ` … (+${text.length - maxChars} more chars)`;
  const lines = out.split("\n");
  if (lines.length > maxLines) {
    return lines.slice(0, maxLines).join("\n") + `\n… (+${lines.length - maxLines} more lines)`;
  }
  return out;
}

/** 把工具参数压成单行摘要：`read(path: a.ts)` / `bash(cmd: ls -la)`。 */
export function formatToolCall(call: Pick<ToolCall, "name" | "arguments">): string {
  const args = call.arguments ?? {};
  const parts = Object.entries(args)
    .map(([k, v]) => `${k}: ${oneLine(String(typeof v === "string" ? v : JSON.stringify(v)), 60)}`)
    .join(", ");
  return `${call.name}(${parts})`;
}

/** 一行"助手要调这些工具"摘要。 */
export function formatToolCalls(calls: ReadonlyArray<Pick<ToolCall, "name" | "arguments">>): string {
  return color.cyan("→ ") + calls.map(formatToolCall).join(color.dim("  ·  "));
}

/** 一条工具结果：`✓ bash · 12ms` 标题 + 截断输出。ok=false 用 ✗ 红色。 */
export function formatToolResult(name: string, ok: boolean, output: string, durationMs: number): string {
  const mark = ok ? color.green("✓") : color.red("✗");
  const head = `${mark} ${color.bold(name)} ${color.dim(`· ${durationMs}ms`)}`;
  const body = truncate(output.trimEnd());
  return body.length > 0 ? `${head}\n${color.dim(indent(body))}` : head;
}

/** 紧凑 token 计数：950 / 12k / 1.2M。给状态栏的上下文占用读数用。 */
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return (k < 10 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k).toString()) + "k";
  }
  const m = n / 1_000_000;
  return (m < 10 ? m.toFixed(1).replace(/\.0$/, "") : Math.round(m).toString()) + "M";
}

/**
 * 上下文占用读数：`ctx 12k/200k (6%)`。用最近一次 LLM 调用的 input tokens 近似"当前上下文大小"
 * （它含整段历史）。逼近窗口上限时变色提醒（>90% 红、>75% 黄），是 compaction 的可视前哨。
 */
export function formatContextGauge(contextTokens: number, contextWindow: number): string {
  const pct = contextWindow > 0 ? Math.round((contextTokens / contextWindow) * 100) : 0;
  const text = `ctx ${formatTokenCount(contextTokens)}/${formatTokenCount(contextWindow)} (${pct}%)`;
  if (pct >= 90) return color.red(text);
  if (pct >= 75) return color.yellow(text);
  return color.dim(text);
}

/** 底部状态栏单行：`qwen-turbo · ↑123 ↓45 · ctx 12k/200k (6%) · ¥0.0012 · 🔧 3/0`。 */
export function formatStatusBar(p: {
  model: string;
  input?: number | undefined;
  output?: number | undefined;
  contextTokens?: number | undefined;
  contextWindow?: number | undefined;
  costText?: string | undefined;
  toolCalls?: number | undefined;
  toolErrors?: number | undefined;
  state?: string | undefined;
}): string {
  const seg: string[] = [color.cyan(p.model)];
  if (p.input !== undefined || p.output !== undefined)
    seg.push(color.dim(`↑${p.input ?? 0} ↓${p.output ?? 0}`));
  if (p.contextTokens !== undefined && p.contextWindow !== undefined && p.contextWindow > 0)
    seg.push(formatContextGauge(p.contextTokens, p.contextWindow));
  if (p.costText) seg.push(color.dim(p.costText));
  if (p.toolCalls !== undefined)
    seg.push(color.dim(`🔧 ${p.toolCalls}/${p.toolErrors ?? 0}`));
  if (p.state) seg.push(color.yellow(p.state));
  return seg.join(color.dim(" · "));
}

function indent(text: string, prefix = "  "): string {
  return text
    .split("\n")
    .map((l) => prefix + l)
    .join("\n");
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}
