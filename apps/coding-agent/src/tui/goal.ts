/**
 * /goal 命令 —— 目标 + would-be-done guard + 预算的 loop-engineering 循环（纯逻辑，可测）。
 *
 * 与浅 /loop 的区别：session 想自然停止时解析模型自报的 GOAL_STATUS 结构化标记；
 * 未达成则由 turnEndGuard 回灌原因并续跑。配合内核 turn 上限与 token budget 两道硬上限。
 */

import type { RunSummary } from "@harness-pi/core";

export interface GoalOptions {
  /** 目标描述（主体文本）。 */
  goal: string;
  /** 最大 would-be-done 续跑次数（默认 5，最小 1）。 */
  maxTurns: number;
  /** Token 预算硬上限（undefined = 不限）。 */
  budgetTokens?: number;
  /** 额外成功判据提示，注入进 prompt。 */
  successHint?: string;
}

/** 每个 goal 续跑轮给内层工具调用预留的 turn 数，避免回落到内核默认 200。 */
const TURNS_PER_GOAL_ROUND = 20;
const MAX_GOAL_ROUNDS = Math.floor(Number.MAX_SAFE_INTEGER / TURNS_PER_GOAL_ROUND);

export function clampGoalMaxTurns(maxTurns: number): number {
  const finite = Number.isFinite(maxTurns) ? Math.trunc(maxTurns) : 1;
  return Math.min(MAX_GOAL_ROUNDS, Math.max(1, finite));
}

/** /goal session 的内核 turn 硬上限：用于约束 tool-call turns，不等同于续跑轮数。 */
export function goalKernelMaxTurns(opts: GoalOptions): number {
  return clampGoalMaxTurns(opts.maxTurns) * TURNS_PER_GOAL_ROUND;
}

/**
 * 解析 `/goal <text> [--max-turns N] [--budget N] [--success <hint>]`。
 * 返回 null 当且仅当目标文本（去掉所有 flag 后）为空。
 */
export function parseGoalCommand(rest: string): GoalOptions | null {
  let text = rest.trim();
  if (text.length === 0) return null;

  let maxTurns = 5;
  let budgetTokens: number | undefined = undefined;
  let successHint: string | undefined = undefined;

  // --max-turns <N>；非法值忽略并清掉完整 token，避免污染 goal 文本（如 3.5 残留 .5）。
  text = text.replace(/--max-turns(?=\s|$)(?:\s+((?!--)\S+))?/i, (_, n: string | undefined) => {
    if (n !== undefined && /^[+-]?\d+$/.test(n)) maxTurns = Math.max(1, parseInt(n, 10));
    return "";
  });

  // --budget <N>；非法值也消费掉完整 token，避免把 flag 原样发给 LLM。
  text = text.replace(/--budget(?=\s|$)(?:\s+((?!--)\S+))?/i, (_, n: string | undefined) => {
    if (n !== undefined && /^[+-]?\d+$/.test(n)) {
      const v = parseInt(n, 10);
      if (v > 0) budgetTokens = v;
    }
    return "";
  });

  // --success "quoted" or --success until next flag / stray -- / end.
  text = text.replace(
    /--success\s+(?:"([^"]+)"|(.+?))(?=\s+--|$)/i,
    (_match: string, quoted: string | undefined, unquoted: string | undefined) => {
      successHint = (quoted ?? unquoted ?? "").trim();
      return "";
    },
  );

  const goal = text.replace(/\s+/g, " ").trim();
  if (goal.length === 0) return null;

  const opts: GoalOptions = { goal, maxTurns };
  if (budgetTokens !== undefined) opts.budgetTokens = budgetTokens;
  if (successHint !== undefined) opts.successHint = successHint;
  return opts;
}

/** 构建第一轮 prompt：包含目标 + GOAL_STATUS 格式要求。 */
export function buildGoalPrompt(opts: GoalOptions): string {
  const lines: string[] = [
    "## Goal",
    opts.goal,
  ];

  if (opts.successHint) {
    lines.push("", "## Success Criteria", opts.successHint);
  }

  lines.push(
    "",
    "Work towards this goal using the available tools. Inspect, edit, and run as needed.",
    "",
    "When you have completed your work — or when you cannot make further progress — end your",
    "response with **exactly** this block (no trailing text after it):",
    "",
    "---",
    "GOAL_STATUS: REACHED",
    "",
    "or:",
    "",
    "---",
    "GOAL_STATUS: NOT_REACHED",
    "GOAL_REASON: <brief description of what still needs doing>",
    "",
    "or:",
    "",
    "---",
    "GOAL_STATUS: BLOCKED",
    "GOAL_REASON: <description of why you cannot proceed>",
    "",
    "Do not omit the GOAL_STATUS block — it is required for the loop to evaluate progress.",
  );

  return lines.join("\n");
}

/** Model-reported goal status extracted from response text. */
export type GoalVerdict = "reached" | "not_reached" | "blocked" | "unknown";

export interface GoalContinuationCheck {
  ok: boolean;
  message?: string;
}

export interface GoalTextMessage {
  content:
    | string
    | Array<{
        type: string;
        text?: string;
        thinking?: string;
      }>;
}

function finalGoalStatusBlock(text: string): { block: string; hasDelimiter: boolean } {
  const parts = text.split(/^---\s*$/m);
  if (parts.length <= 1) return { block: text, hasDelimiter: false };
  return { block: parts.at(-1) ?? "", hasDelimiter: true };
}

function verdictFromValue(value: string): GoalVerdict {
  let normalized = value.trim();
  for (const marker of ["**", "__", "`"] as const) {
    while (normalized.startsWith(marker) && normalized.endsWith(marker)) {
      normalized = normalized.slice(marker.length, -marker.length).trim();
    }
  }
  normalized = normalized
    .replace(/^[\s`*_~"'([{<,:;.!?]+/, "")
    .replace(/[\s`*_~"')\]}>,:;.!?]+$/, "")
    .toLowerCase();
  if (normalized === "reached") return "reached";
  if (normalized === "not_reached") return "not_reached";
  if (normalized === "blocked") return "blocked";
  return "unknown";
}

/**
 * 从 session 最终文本中提取 GOAL_STATUS 标记。
 * 有 `---` 分隔块时，只读取最后一个分隔块里的首个状态行，避免模型尾部回显选项说明误判。
 */
export function parseGoalVerdict(text: string): GoalVerdict {
  const { block, hasDelimiter } = finalGoalStatusBlock(text);
  const matches = [...block.matchAll(/GOAL_STATUS:\s*(\S+)/gi)];
  if (matches.length === 0) return "unknown";
  const selected = hasDelimiter ? matches[0] : matches.at(-1);
  const value = selected?.[1];
  if (!value) return "unknown";
  return verdictFromValue(value);
}

/** 提取最后一个 GOAL_REASON 行，供续跑阻断消息和终态说明使用。 */
export function parseGoalReason(text: string): string | undefined {
  const { block } = finalGoalStatusBlock(text);
  const matches = [...block.matchAll(/GOAL_REASON:\s*(.+)$/gim)];
  const last = matches.at(-1)?.[1]?.trim();
  return last && last.length > 0 ? last : undefined;
}

/** 从 assistant message 中提取文本块；toolCall / thinking 不参与 GOAL_STATUS 判定。 */
export function goalTextFromMessage(message: GoalTextMessage | undefined): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("\n");
}

/** turnEndGuard.check 的纯逻辑：模型想停时，未达标则回灌阻断消息并强制续跑。 */
export function checkGoalContinuation(text: string): GoalContinuationCheck {
  const verdict = parseGoalVerdict(text);
  // BLOCKED 允许自然停止；GOAL_REASON 会在最终 classify 阶段保留用于展示。
  if (verdict === "reached" || verdict === "blocked") return { ok: true };
  if (verdict === "not_reached") {
    const reason = parseGoalReason(text);
    return {
      ok: false,
      message: reason
        ? `Goal is not reached yet: ${reason}`
        : "Goal is not reached yet. Continue working and end with a GOAL_STATUS block.",
    };
  }
  return {
    ok: false,
    message:
      "Missing GOAL_STATUS block. Continue working, then end with GOAL_STATUS: REACHED, NOT_REACHED, or BLOCKED.",
  };
}

export interface GoalOutcome {
  verdict: GoalVerdict;
  /** true 只表示调用方 AbortSignal 触发的用户中断。 */
  aborted: boolean;
  budgetExhausted: boolean;
  /** hook / guard 自我中止时保留内核给出的真实原因。 */
  abortReason?: string;
  goalReason?: string;
}

/** 把 hook 驱动的 session 终态映射回 TUI 展示所需的最终状态。 */
export function classifyGoalOutcome(
  summary: RunSummary | undefined,
  fallbackAssistantText = "",
  userAborted = false,
): GoalOutcome {
  const text = fallbackAssistantText || goalTextFromMessage(summary?.lastMessage);
  const verdict = parseGoalVerdict(text);
  const goalReason = parseGoalReason(text);
  const rawAbortReason = summary?.abortReason?.trim();
  const runAborted = summary?.reason === "aborted" || userAborted;
  const success = verdict === "reached";
  const aborted = runAborted && userAborted && !success;
  const guardAborted = runAborted && !userAborted && !success;
  const budgetExhausted =
    guardAborted && rawAbortReason !== undefined && /token budget exhausted/i.test(rawAbortReason);

  const outcome: GoalOutcome = { verdict, aborted, budgetExhausted };
  if (guardAborted && rawAbortReason) outcome.abortReason = rawAbortReason;
  if (goalReason) outcome.goalReason = goalReason;
  return outcome;
}

/** 格式化 /goal 开始横幅；使用内核 turn 口径，与逐 turn banner 保持一致。 */
export function formatGoalStartBanner(opts: GoalOptions): string {
  const kernelTurns = goalKernelMaxTurns(opts);
  const goalRounds = Math.max(1, opts.maxTurns);
  const roundWord = goalRounds === 1 ? "round" : "rounds";
  const budgetPart = opts.budgetTokens
    ? ` · budget ${opts.budgetTokens.toLocaleString()} tokens`
    : "";
  return `⟳ /goal start · max ${kernelTurns} kernel turns (${goalRounds} goal ${roundWord})${budgetPart}`;
}

/** 格式化每轮开始时 TUI 显示的进度行。 */
export function formatGoalRoundBanner(opts: {
  round: number;
  maxTurns: number;
  budgetTokens?: number;
  usedTokens?: number;
}): string {
  const roundPart = `kernel turn ${opts.round} / ${opts.maxTurns}`;
  if (opts.budgetTokens && opts.usedTokens !== undefined) {
    const pct = Math.round((opts.usedTokens / opts.budgetTokens) * 100);
    return `⟳ /goal ${roundPart}  ·  预算 ${opts.usedTokens.toLocaleString()} / ${opts.budgetTokens.toLocaleString()} (${pct}%)`;
  }
  return `⟳ /goal ${roundPart}`;
}

/**
 * 格式化最终状态行（达标 / 未达标 / 阻塞 / 中断 / 预算耗尽）。
 * `aborted` 和 `budgetExhausted` 是终止原因修饰符，优先于 verdict 显示。
 */
export function formatGoalFinalStatus(
  verdict: GoalVerdict,
  rounds: number,
  aborted = false,
  budgetExhausted = false,
  abortReason?: string,
  goalReason?: string,
): string {
  if (aborted) return `⊘ /goal interrupted after round ${rounds}`;
  if (budgetExhausted) {
    return `⊘ /goal stopped after round ${rounds}: ${abortReason ?? "token budget exhausted"} (${verdict})`;
  }
  if (abortReason) return `⊘ /goal stopped after round ${rounds}: ${abortReason} (${verdict})`;
  if (verdict === "reached") return `✓ /goal 目标达成（第 ${rounds} 轮完成）`;
  if (verdict === "blocked") {
    return goalReason
      ? `✗ /goal blocked after round ${rounds}: ${goalReason}`
      : `✗ /goal blocked after round ${rounds}`;
  }
  return goalReason
    ? `✗ /goal 未达成（${rounds} 轮耗尽）: ${goalReason}`
    : `✗ /goal 未达成（${rounds} 轮耗尽）`;
}
