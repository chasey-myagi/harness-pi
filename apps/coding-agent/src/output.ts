import type { CostStats, ToolStats } from "@harness-pi/plugins";
import type { RunSummary, SessionEvent } from "@harness-pi/core";

export interface RunReport {
  summary: RunSummary;
  wallTimeMs: number;
  cwd: string;
  model: string;
  costKnown: boolean;
  readOnly: boolean;
  logPath: string;
  metricsPath?: string | undefined;
  warnings?: string[] | undefined;
  costEstimate?: RunCostEstimate | undefined;
  costStats?: CostStats | undefined;
  toolStats?: ToolStats | undefined;
}

export interface RunCostEstimate {
  amount: number;
  currency: "USD" | "CNY";
  source: string;
}

export function renderRunReport(report: RunReport): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("Run Report");
  lines.push("==========");
  lines.push(`cwd: ${report.cwd}`);
  lines.push(`model: ${report.model}`);
  lines.push(`mode: ${report.readOnly ? "read-only" : "full"}`);
  lines.push(`reason: ${report.summary.reason}`);
  // 失败终态把原因打出来——否则只剩 "reason: error"，piped/captured 的报告完全丢失原因。
  if (report.summary.error) lines.push(`error: ${report.summary.error.message}`);
  if (report.summary.abortReason) lines.push(`abort reason: ${report.summary.abortReason}`);
  // 持久化失败如实暴露（两种模式都填）——否则「done 但 transcript 不全」会被静默吞掉，resume 拿残缺状态。
  if (report.summary.persistenceErrors?.length) {
    lines.push(
      `persistence errors (${report.summary.persistenceErrors.length}): ${report.summary.persistenceErrors.join("; ")}`,
    );
  }
  lines.push(`turns: ${report.summary.turns}`);
  lines.push(`continuations: ${report.summary.continuations}`);
  lines.push(`run wall time: ${formatMs(report.wallTimeMs)}`);
  lines.push(`log: ${report.logPath}`);
  if (report.metricsPath) lines.push(`metrics: ${report.metricsPath}`);

  // 合并调用方告警 + 上下文溢出告警：stopReason "length" = 答案被窗口/输出上限截断（headless 模式
  // 没挂 compaction，溢出会以 reason:done 静默收尾，这里显式提示答案可能不完整）。
  const warnings = [...(report.warnings ?? [])];
  if (report.summary.stopReason === "length") {
    warnings.push(
      "response hit the context/output limit — the answer may be truncated. Use --tui with /compact for long sessions.",
    );
  }
  if (warnings.length > 0) {
    lines.push("");
    lines.push("Warnings");
    lines.push("--------");
    for (const warning of warnings) lines.push(`- ${warning}`);
  }

  if (report.costStats) {
    lines.push("");
    lines.push("LLM Stats (session cumulative)");
    lines.push("------------------------------");
    lines.push(`calls: ${report.costStats.llmCallCount}`);
    lines.push(
      `tokens: input=${report.costStats.inputTokens} output=${report.costStats.outputTokens} cached=${report.costStats.cachedTokens}`,
    );
    lines.push(`cost: ${formatCost(report.costStats.costUSD, report)}`);
    lines.push(
      `active llm time: ${formatMs(report.costStats.llmDurationMs)} avg=${formatMs(report.costStats.avgLlmDurationMs)}`,
    );
    for (const [model, stats] of report.costStats.byModel) {
      lines.push(
        `  ${model}: calls=${stats.calls} input=${stats.input} output=${stats.output} cached=${stats.cached} cost=${formatModelCost(stats.costUSD, report)} active=${formatMs(stats.durationMs)}`,
      );
    }
  }

  if (report.toolStats) {
    lines.push("");
    lines.push("Tool Stats (session cumulative)");
    lines.push("-------------------------------");
    lines.push(
      `calls=${report.toolStats.totalCalls} ok=${report.toolStats.ok} error=${report.toolStats.error} total=${formatMs(report.toolStats.totalDurationMs)} avg=${formatMs(report.toolStats.avgDurationMs)} max=${formatMs(report.toolStats.maxDurationMs)}`,
    );
    lines.push(
      `truncations=${report.toolStats.truncationCount} fullOutputPath=${report.toolStats.fullOutputPathCount} estimatedParallelSavings=${formatMs(report.toolStats.estimatedParallelSavingsMs)}`,
    );
    for (const [tool, stats] of report.toolStats.byTool) {
      lines.push(
        `  ${tool}: calls=${stats.calls} ok=${stats.ok} error=${stats.error} total=${formatMs(stats.durationMs)} avg=${formatMs(stats.avgDurationMs)} max=${formatMs(stats.maxDurationMs)}`,
      );
    }
  }

  if (!report.readOnly) {
    lines.push("");
    lines.push(
      "Warning: bash runs on the host shell. This app is not a sandbox; run it only in workspaces you intend to modify.",
    );
  }

  return lines.join("\n");
}

function formatCost(value: number, report: RunReport): string {
  if (report.costEstimate) {
    return `${formatCurrency(report.costEstimate)} (${report.costEstimate.source})`;
  }
  if (!report.costKnown) return `n/a (no pricing for ${report.model})`;
  return `$${value.toFixed(6)}`;
}

function formatModelCost(value: number, report: RunReport): string {
  if (report.costEstimate?.currency === "CNY") return "included in CNY estimate";
  return formatCost(value, report);
}

function formatCurrency(cost: RunCostEstimate): string {
  if (cost.currency === "USD") return `$${cost.amount.toFixed(6)}`;
  return `¥${cost.amount.toFixed(6)} CNY`;
}

export function renderSessionEvent(event: SessionEvent): string | undefined {
  switch (event.type) {
    case "session-start":
      return `[session] ${event.source}`;
    case "turn-start":
      return `[turn ${event.turnIdx}] start`;
    case "llm-end":
      return `[llm] ${event.msg.model} ${formatMs(event.durationMs)} stop=${event.msg.stopReason}`;
    case "tool-end": {
      const status = event.result.isError ? "error" : "ok";
      return `[tool] ${event.call.name} ${status} ${formatMs(event.durationMs)}`;
    }
    case "turn-end":
      return `[turn ${event.turnIdx}] end tools=${event.toolResultsCount} stop=${event.stopReason}`;
    case "continuation-check":
      return `[continue] turns=${event.turns} continuations=${event.continuations}`;
    case "session-end":
      return `[session] end reason=${event.summary.reason}`;
    case "error":
      return `[error] ${event.phase}: ${event.message}`;
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

function formatMs(value: number): string {
  if (!Number.isFinite(value)) return "0ms";
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(2)}s`;
}
