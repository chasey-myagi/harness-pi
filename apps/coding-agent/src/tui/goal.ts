/**
 * /goal 命令 —— 目标 + verifier + 预算的 loop-engineering 循环（纯逻辑，可测）。
 *
 * 与浅 /loop 的区别：每轮结束后解析模型自报的 GOAL_STATUS 结构化标记（verifier），
 * 而不是单纯重复执行 prompt N 次。配合 maxTurns / budgetTokens 两道硬上限。
 */

import type { RunSummary } from "@harness-pi/core";

export interface GoalOptions {
  /** 目标描述（主体文本）。 */
  goal: string;
  /** 最大 act→verify 轮数（默认 5，最小 1）。 */
  maxTurns: number;
  /** Token 预算硬上限（undefined = 不限）。 */
  budgetTokens?: number;
  /** 额外成功判据提示，注入进 prompt。 */
  successHint?: string;
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

  // --max-turns <N>
  text = text.replace(/--max-turns\s+(\d+)/i, (_, n: string) => {
    maxTurns = Math.max(1, parseInt(n, 10));
    return "";
  });

  // --budget <N>
  text = text.replace(/--budget\s+(\d+)/i, (_, n: string) => {
    const v = parseInt(n, 10);
    if (v > 0) budgetTokens = v;
    return "";
  });

  // --success "quoted" or --success until next flag or end
  text = text.replace(/--success\s+"([^"]+)"/i, (_, hint: string) => {
    successHint = hint.trim();
    return "";
  });
  if (successHint === undefined) {
    text = text.replace(/--success\s+(.+?)(?=\s+--|$)/i, (_, hint: string) => {
      successHint = hint.trim();
      return "";
    });
    // Handle --success at end without another flag following
    if (successHint === undefined) {
      text = text.replace(/--success\s+(.+)/i, (_, hint: string) => {
        successHint = hint.trim();
        return "";
      });
    }
  }

  const goal = text.replace(/\s+/g, " ").trim();
  if (goal.length === 0) return null;

  const opts: GoalOptions = { goal, maxTurns };
  if (budgetTokens !== undefined) opts.budgetTokens = budgetTokens;
  if (successHint !== undefined) opts.successHint = successHint;
  return opts;
}

/** 构建第一轮 prompt：包含目标 + verifier 格式要求。 */
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

/** 构建第 round 轮（>1）的 continuation prompt。 */
export function buildContinuationPrompt(round: number, opts: GoalOptions): string {
  return [
    `## Goal (round ${round})`,
    opts.goal,
    "",
    `You have completed round ${round - 1}. Continue working towards the goal.`,
    "Resume where you left off and keep making progress.",
    "",
    "When done (or blocked), end with the GOAL_STATUS block:",
    "",
    "---",
    "GOAL_STATUS: REACHED",
    "",
    "or NOT_REACHED / BLOCKED with GOAL_REASON.",
  ].join("\n");
}

/** Model-reported goal status extracted from response text. */
export type GoalVerdict = "reached" | "not_reached" | "blocked" | "unknown";

export interface GoalProgressJudgement {
  reached: boolean;
  hasProgress?: boolean;
  message?: string;
}

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

/**
 * 从 session 最终文本中提取 GOAL_STATUS 标记。
 * 查找文本中最后一个 `GOAL_STATUS:` 行（容许前后空白）。
 */
export function parseGoalVerdict(text: string): GoalVerdict {
  const match = text.match(/GOAL_STATUS:\s*(\S+)/gi);
  if (!match || match.length === 0) return "unknown";
  // 取最后一个匹配（模型可能在思考中也写了，取最终结论）
  const last = match[match.length - 1]!;
  const value = last.replace(/GOAL_STATUS:\s*/i, "").trim().toLowerCase();
  if (value === "reached") return "reached";
  if (value === "not_reached") return "not_reached";
  if (value === "blocked") return "blocked";
  return "unknown";
}

/** 提取最后一个 GOAL_REASON 行，供续跑阻断消息和终态说明使用。 */
export function parseGoalReason(text: string): string | undefined {
  const matches = [...text.matchAll(/GOAL_REASON:\s*(.+)$/gim)];
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

/** progressVerifier.judge 的纯逻辑：只负责判定达标/停滞，不负责续跑。 */
export function judgeGoalProgress(text: string): GoalProgressJudgement {
  const verdict = parseGoalVerdict(text);
  const reason = parseGoalReason(text);
  if (verdict === "reached") {
    return { reached: true, ...(reason ? { message: reason } : {}) };
  }
  if (verdict === "not_reached") {
    return {
      reached: false,
      hasProgress: true,
      ...(reason ? { message: reason } : {}),
    };
  }
  if (verdict === "blocked") {
    return {
      reached: false,
      hasProgress: false,
      message: reason ?? "GOAL_STATUS: BLOCKED",
    };
  }
  return {
    reached: false,
    hasProgress: false,
    message: "missing GOAL_STATUS block",
  };
}

/** turnEndGuard.check 的纯逻辑：模型想停时，未达标则回灌阻断消息并强制续跑。 */
export function checkGoalContinuation(text: string): GoalContinuationCheck {
  const verdict = parseGoalVerdict(text);
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

/** 把 hook 驱动的 session 终态映射回 TUI 展示所需的最终状态。 */
export function classifyGoalOutcome(
  summary: RunSummary | undefined,
  fallbackAssistantText = "",
): {
  verdict: GoalVerdict;
  aborted: boolean;
  budgetExhausted: boolean;
} {
  const text = fallbackAssistantText || goalTextFromMessage(summary?.lastMessage);
  const verdict = parseGoalVerdict(text);
  const abortReason = summary?.abortReason ?? "";
  const budgetExhausted =
    verdict !== "reached" && /token budget exhausted/i.test(abortReason);
  const aborted =
    summary?.reason === "aborted" &&
    verdict !== "reached" &&
    !budgetExhausted &&
    !/^progressVerifier:/i.test(abortReason);
  return { verdict, aborted, budgetExhausted };
}

/** 格式化每轮开始时 TUI 显示的进度行。 */
export function formatGoalRoundBanner(opts: {
  round: number;
  maxTurns: number;
  budgetTokens?: number;
  usedTokens?: number;
}): string {
  const roundPart = `第 ${opts.round} 轮 / ${opts.maxTurns}`;
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
): string {
  if (aborted) return `⊘ /goal interrupted after round ${rounds}`;
  if (budgetExhausted) return `⊘ /goal budget exhausted after round ${rounds} (not_reached)`;
  if (verdict === "reached") return `✓ /goal 目标达成（第 ${rounds} 轮完成）`;
  if (verdict === "blocked") return `✗ /goal blocked after round ${rounds}`;
  return `✗ /goal 未达成（${rounds} 轮耗尽）`;
}
