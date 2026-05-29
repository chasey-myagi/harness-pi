/**
 * Tool stats —— session-scoped aggregation from real tool execution spans.
 *
 * Uses only wrapToolExec so start/end timestamps come from the same clock window
 * and overlapping spans can estimate parallel wall-clock savings.
 */

import type {
  Hook,
  HookContext,
  ToolCall,
  ToolExecResult,
} from "@harness-pi/core";
import { emitMetric } from "./metrics/index.js";

declare module "@harness-pi/core" {
  interface HookStateRegistry {
    "tool-stats.stats": ToolStats;
    "tool-stats.currentTurnSpans": ToolSpan[];
  }
}

declare module "./metrics/types.js" {
  interface UserMetricKinds {
    "tool.stats": {
      totalCalls: number;
      ok: number;
      error: number;
      totalDurationMs: number;
      estimatedParallelSavingsMs: number;
      cumulative: true;
    };
  }
}

export interface ToolStatsOptions {
  onSessionFinalized?: (ctx: HookContext, stats: ToolStats) => void;
  /** Recent raw spans retained for debugging. Aggregates stay lifetime; raw spans are bounded. Default 200. */
  retainRecentSpans?: number;
}

export interface ToolSpan {
  turnIdx: number;
  callId: string;
  toolName: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  isError: boolean;
  truncated: boolean;
  fullOutputPath?: string | undefined;
}

export interface ToolStatsByTool {
  calls: number;
  ok: number;
  error: number;
  durationMs: number;
  avgDurationMs: number;
  maxDurationMs: number;
  truncationCount: number;
  fullOutputPathCount: number;
}

export interface ToolStats {
  totalCalls: number;
  ok: number;
  error: number;
  totalDurationMs: number;
  avgDurationMs: number;
  maxDurationMs: number;
  truncationCount: number;
  fullOutputPathCount: number;
  estimatedParallelSavingsMs: number;
  spans: ToolSpan[];
  byTool: Map<string, ToolStatsByTool>;
}

const KEY = "tool-stats.stats" as const;
const KEY_TURN_SPANS = "tool-stats.currentTurnSpans" as const;
const DEFAULT_RETAIN_RECENT_SPANS = 200;

function newStats(): ToolStats {
  return {
    totalCalls: 0,
    ok: 0,
    error: 0,
    totalDurationMs: 0,
    avgDurationMs: 0,
    maxDurationMs: 0,
    truncationCount: 0,
    fullOutputPathCount: 0,
    estimatedParallelSavingsMs: 0,
    spans: [],
    byTool: new Map(),
  };
}

export function toolStats(opts: ToolStatsOptions = {}): Hook {
  const retainRecentSpans = Math.max(
    0,
    Math.floor(opts.retainRecentSpans ?? DEFAULT_RETAIN_RECENT_SPANS),
  );

  const retainSpan = (stats: ToolStats, span: ToolSpan): void => {
    if (retainRecentSpans === 0) return;
    stats.spans.push(span);
    while (stats.spans.length > retainRecentSpans) stats.spans.shift();
  };

  const recordSpan = (
    ctx: HookContext,
    call: ToolCall,
    startMs: number,
    endMs: number,
    result?: ToolExecResult,
    thrown = false,
  ): void => {
    const stats = ctx.state.get(KEY);
    if (!stats) return;

    const durationMs = Math.max(0, endMs - startMs);
    const isError = thrown || result?.isError === true;
    const details = result?.details;
    const truncated = hasTruncation(details);
    const fullOutputPath = getFullOutputPath(details);

    stats.totalCalls += 1;
    if (isError) stats.error += 1;
    else stats.ok += 1;
    stats.totalDurationMs += durationMs;
    stats.avgDurationMs = stats.totalDurationMs / stats.totalCalls;
    stats.maxDurationMs = Math.max(stats.maxDurationMs, durationMs);
    if (truncated) stats.truncationCount += 1;
    if (fullOutputPath) stats.fullOutputPathCount += 1;

    const span: ToolSpan = {
      turnIdx: ctx.turnIdx,
      callId: call.id,
      toolName: call.name,
      startMs,
      endMs,
      durationMs,
      isError,
      truncated,
      ...(fullOutputPath ? { fullOutputPath } : {}),
    };
    retainSpan(stats, span);

    const turnSpans = ctx.state.get(KEY_TURN_SPANS);
    if (turnSpans) turnSpans.push(span);

    const byTool = stats.byTool.get(call.name) ?? {
      calls: 0,
      ok: 0,
      error: 0,
      durationMs: 0,
      avgDurationMs: 0,
      maxDurationMs: 0,
      truncationCount: 0,
      fullOutputPathCount: 0,
    };
    byTool.calls += 1;
    if (isError) byTool.error += 1;
    else byTool.ok += 1;
    byTool.durationMs += durationMs;
    byTool.avgDurationMs = byTool.durationMs / byTool.calls;
    byTool.maxDurationMs = Math.max(byTool.maxDurationMs, durationMs);
    if (truncated) byTool.truncationCount += 1;
    if (fullOutputPath) byTool.fullOutputPathCount += 1;
    stats.byTool.set(call.name, byTool);
  };

  const finalizeCurrentTurn = (ctx: HookContext, stats: ToolStats): void => {
    const turnSpans = ctx.state.get(KEY_TURN_SPANS);
    if (!turnSpans || turnSpans.length === 0) return;
    stats.estimatedParallelSavingsMs += estimateParallelSavings(turnSpans);
    ctx.state.set(KEY_TURN_SPANS, []);
  };

  return {
    name: "tool-stats",
    internal: true,

    onSessionStart(_input, ctx) {
      if (!ctx.state.has(KEY)) {
        ctx.state.set(KEY, newStats());
      }
      ctx.state.set(KEY_TURN_SPANS, []);
    },

    onTurnStart(_input, ctx) {
      ctx.state.set(KEY_TURN_SPANS, []);
    },

    onTurnEnd(_input, ctx) {
      const stats = ctx.state.get(KEY);
      if (stats) finalizeCurrentTurn(ctx, stats);
    },

    async wrapToolExec(call, ctx, next) {
      const startMs = Date.now();
      try {
        const result = await next();
        recordSpan(ctx, call, startMs, Date.now(), result);
        return result;
      } catch (err) {
        recordSpan(ctx, call, startMs, Date.now(), undefined, true);
        throw err;
      }
    },

    onSessionEnd(_input, ctx) {
      const stats = ctx.state.get(KEY);
      if (!stats) return;
      finalizeCurrentTurn(ctx, stats);
      opts.onSessionFinalized?.(ctx, stats);
      emitMetric(ctx, {
        kind: "tool.stats",
        ts: Date.now(),
        sessionId: ctx.sessionId,
        cumulative: true,
        totalCalls: stats.totalCalls,
        ok: stats.ok,
        error: stats.error,
        totalDurationMs: stats.totalDurationMs,
        estimatedParallelSavingsMs: stats.estimatedParallelSavingsMs,
      });
    },
  };
}

export function getToolStats(ctx: HookContext): ToolStats | undefined {
  return ctx.state.get(KEY);
}

function hasTruncation(details: unknown): boolean {
  if (!isRecord(details)) return false;
  const truncation = details["truncation"];
  return isRecord(truncation) && truncation["truncated"] === true;
}

function getFullOutputPath(details: unknown): string | undefined {
  if (!isRecord(details)) return undefined;
  const value = details["fullOutputPath"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function estimateParallelSavings(spans: readonly ToolSpan[]): number {
  const byTurn = new Map<number, ToolSpan[]>();
  for (const span of spans) {
    const list = byTurn.get(span.turnIdx) ?? [];
    list.push(span);
    byTurn.set(span.turnIdx, list);
  }

  let savings = 0;
  for (const turnSpans of byTurn.values()) {
    const sum = turnSpans.reduce((acc, span) => acc + span.durationMs, 0);
    const union = unionDuration(turnSpans);
    savings += Math.max(0, sum - union);
  }
  return savings;
}

function unionDuration(spans: readonly ToolSpan[]): number {
  if (spans.length === 0) return 0;
  const sorted = [...spans].sort((a, b) => a.startMs - b.startMs);
  let total = 0;
  let currentStart = sorted[0]?.startMs ?? 0;
  let currentEnd = sorted[0]?.endMs ?? currentStart;

  for (const span of sorted.slice(1)) {
    if (span.startMs <= currentEnd) {
      currentEnd = Math.max(currentEnd, span.endMs);
      continue;
    }
    total += currentEnd - currentStart;
    currentStart = span.startMs;
    currentEnd = span.endMs;
  }
  total += currentEnd - currentStart;
  return Math.max(0, total);
}
