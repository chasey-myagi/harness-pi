import { describe, expect, it } from "vitest";
import {
  parseGoalCommand,
  buildGoalPrompt,
  classifyGoalOutcome,
  checkGoalContinuation,
  parseGoalReason,
  parseGoalVerdict,
  goalKernelMaxTurns,
  goalTextFromMessage,
  formatGoalStartBanner,
  formatGoalRoundBanner,
  formatGoalFinalStatus,
} from "../goal.js";

describe("parseGoalCommand", () => {
  it("parses a bare goal text", () => {
    expect(parseGoalCommand("make the tests pass")).toEqual({
      goal: "make the tests pass",
      maxTurns: 5,
      budgetTokens: undefined,
      successHint: undefined,
    });
  });

  it("parses --max-turns", () => {
    expect(parseGoalCommand("fix the lint errors --max-turns 3")).toMatchObject({
      goal: "fix the lint errors",
      maxTurns: 3,
    });
  });

  it("parses --budget", () => {
    expect(parseGoalCommand("refactor module --budget 50000")).toMatchObject({
      goal: "refactor module",
      budgetTokens: 50000,
    });
  });

  it("parses --success hint (quoted)", () => {
    expect(parseGoalCommand('pass tests --success "npm test shows 0 failures"')).toMatchObject({
      goal: "pass tests",
      successHint: "npm test shows 0 failures",
    });
  });

  it("parses --success hint (unquoted, to end of flags)", () => {
    expect(parseGoalCommand("pass tests --success all tests green --max-turns 4")).toMatchObject({
      goal: "pass tests",
      successHint: "all tests green",
      maxTurns: 4,
    });
  });

  it("parses multiple flags together", () => {
    expect(
      parseGoalCommand("clean up types --max-turns 2 --budget 30000 --success no type errors"),
    ).toMatchObject({
      goal: "clean up types",
      maxTurns: 2,
      budgetTokens: 30000,
      successHint: "no type errors",
    });
  });

  it("returns null for empty input", () => {
    expect(parseGoalCommand("")).toBeNull();
    expect(parseGoalCommand("   ")).toBeNull();
  });

  it("clamps maxTurns to minimum 1", () => {
    const r = parseGoalCommand("some goal --max-turns 0");
    expect(r?.maxTurns).toBeGreaterThanOrEqual(1);
  });

  it("ignores negative budget (treats as no limit)", () => {
    const r = parseGoalCommand("some goal --budget -100");
    expect(r?.budgetTokens).toBeUndefined();
    expect(r?.goal).toBe("some goal");
  });

  it("ignores invalid --budget values without leaving flag text in the goal", () => {
    expect(parseGoalCommand("some goal --budget nope")).toEqual({
      goal: "some goal",
      maxTurns: 5,
      budgetTokens: undefined,
      successHint: undefined,
    });
  });

  it("ignores an invalid --max-turns value without leaving flag text in the goal", () => {
    expect(parseGoalCommand("fix flaky tests --max-turns abc")).toEqual({
      goal: "fix flaky tests",
      maxTurns: 5,
      budgetTokens: undefined,
      successHint: undefined,
    });
  });

  it("ignores decimal --max-turns values without leaving numeric residue in the goal", () => {
    expect(parseGoalCommand("fix flaky tests --max-turns 3.5")).toEqual({
      goal: "fix flaky tests",
      maxTurns: 5,
      budgetTokens: undefined,
      successHint: undefined,
    });
  });

  it("stops unquoted --success at a stray -- marker", () => {
    expect(parseGoalCommand("ship release --success all tests pass -- keep note")).toEqual({
      goal: "ship release -- keep note",
      maxTurns: 5,
      budgetTokens: undefined,
      successHint: "all tests pass",
    });
  });

  it("consumes all repeated --success flags (last wins, no literal leaks to goal)", () => {
    // 全局 replace：重复 flag 全部消费、last-wins；旧非全局只去首个、残留 `--success second pass` 发给 LLM。
    expect(parseGoalCommand("ship --success first pass --success second pass")).toEqual({
      goal: "ship",
      maxTurns: 5,
      budgetTokens: undefined,
      successHint: "second pass",
    });
  });

  it("consumes all repeated --budget flags (last wins, no literal leaks to goal)", () => {
    expect(parseGoalCommand("optimize --budget 100 --budget 200")).toEqual({
      goal: "optimize",
      maxTurns: 5,
      budgetTokens: 200,
      successHint: undefined,
    });
  });

  it("repeated --budget with later 0 clears the limit (last-wins, codex P2)", () => {
    // last-wins + `--budget 0`=无限：后者必须解除前者的 100，不能残留旧上限。
    expect(parseGoalCommand("optimize --budget 100 --budget 0")).toEqual({
      goal: "optimize",
      maxTurns: 5,
      budgetTokens: undefined,
      successHint: undefined,
    });
  });

  it('repeated --success with later "" clears the hint (last-wins, codex P3)', () => {
    // last-wins + 空=无 hint：空的后者必须解除前者，不能把旧 success criteria 织进 prompt。
    const r = parseGoalCommand('ship --success tests pass --success ""');
    expect(r?.successHint).toBeUndefined();
    expect(r?.goal).toBe("ship");
  });

  it("does not partial-match a flag-prefixed word (word boundary)", () => {
    // `--max-turns-doc` 不是 `--max-turns`：词边界挡住后续 `-`，整词原样留在 goal、maxTurns 取默认。
    expect(parseGoalCommand("write the --max-turns-doc section")).toEqual({
      goal: "write the --max-turns-doc section",
      maxTurns: 5,
      budgetTokens: undefined,
      successHint: undefined,
    });
  });

  it("treats --budget 0 as no limit (v>0 guard boundary)", () => {
    expect(parseGoalCommand("tidy up --budget 0")).toEqual({
      goal: "tidy up",
      maxTurns: 5,
      budgetTokens: undefined,
      successHint: undefined,
    });
  });

  it('treats empty --success "" as no hint (not present-but-empty)', () => {
    const r = parseGoalCommand('ship it --success ""');
    expect(r?.successHint).toBeUndefined();
    expect(r?.goal).toBe("ship it");
  });
});

describe("buildGoalPrompt", () => {
  it("includes the goal text", () => {
    const p = buildGoalPrompt({ goal: "make tests pass", maxTurns: 5 });
    expect(p).toContain("make tests pass");
  });

  it("includes GOAL_STATUS instructions", () => {
    const p = buildGoalPrompt({ goal: "fix lint", maxTurns: 5 });
    expect(p).toContain("GOAL_STATUS:");
    expect(p).toContain("REACHED");
    expect(p).toContain("NOT_REACHED");
  });

  it("includes successHint when provided", () => {
    const p = buildGoalPrompt({ goal: "fix lint", maxTurns: 5, successHint: "zero lint errors" });
    expect(p).toContain("zero lint errors");
  });

  it("does not include successHint section when not provided", () => {
    const p = buildGoalPrompt({ goal: "fix lint", maxTurns: 5 });
    expect(p).not.toContain("Success Criteria");
  });
});

describe("parseGoalVerdict", () => {
  it("detects REACHED", () => {
    expect(parseGoalVerdict("Did some work.\n\n---\nGOAL_STATUS: REACHED")).toBe("reached");
  });

  it("detects NOT_REACHED", () => {
    expect(parseGoalVerdict("---\nGOAL_STATUS: NOT_REACHED\nGOAL_REASON: need more work")).toBe(
      "not_reached",
    );
  });

  it("detects BLOCKED", () => {
    expect(parseGoalVerdict("Can't proceed.\n---\nGOAL_STATUS: BLOCKED")).toBe("blocked");
  });

  it("returns unknown when no GOAL_STATUS marker present", () => {
    expect(parseGoalVerdict("I did some things but didn't include the status block.")).toBe(
      "unknown",
    );
  });

  it("is case-insensitive for the status value", () => {
    expect(parseGoalVerdict("---\nGOAL_STATUS: reached")).toBe("reached");
    expect(parseGoalVerdict("GOAL_STATUS: Reached")).toBe("reached");
  });

  it("handles extra whitespace around the value", () => {
    expect(parseGoalVerdict("GOAL_STATUS:  REACHED  ")).toBe("reached");
  });

  it.each([
    ["GOAL_STATUS: **REACHED**", "reached"],
    ["GOAL_STATUS: `BLOCKED`", "blocked"],
    ["GOAL_STATUS: NOT_REACHED.", "not_reached"],
    ["GOAL_STATUS: __not_reached__", "not_reached"],
  ] as const)("tolerates markdown or punctuation around status values: %s", (text, expected) => {
    expect(parseGoalVerdict(text)).toBe(expected);
  });

  it("returns unknown for empty text", () => {
    expect(parseGoalVerdict("")).toBe("unknown");
  });

  it("multiple GOAL_STATUS markers: takes the last one", () => {
    expect(
      parseGoalVerdict(
        "Thinking...\nGOAL_STATUS: NOT_REACHED\nMore thinking.\nGOAL_STATUS: REACHED",
      ),
    ).toBe("reached");
    expect(
      parseGoalVerdict("GOAL_STATUS: REACHED\nOn second thought:\nGOAL_STATUS: NOT_REACHED"),
    ).toBe("not_reached");
  });

  it("uses the first status in the final delimiter block instead of echoed option text", () => {
    expect(
      parseGoalVerdict(
        [
          "Implemented the fix.",
          "---",
          "GOAL_STATUS: REACHED",
          "",
          "For reference, the valid values are:",
          "GOAL_STATUS: REACHED",
          "GOAL_STATUS: NOT_REACHED",
          "GOAL_STATUS: BLOCKED",
        ].join("\n"),
      ),
    ).toBe("reached");
  });
});

describe("parseGoalReason", () => {
  it("returns the last GOAL_REASON when multiple markers are present", () => {
    expect(
      parseGoalReason("GOAL_REASON: first\nwork log\nGOAL_REASON: final answer"),
    ).toBe("final answer");
  });

  it("returns undefined for empty or whitespace-only reasons", () => {
    expect(parseGoalReason("GOAL_REASON:   ")).toBeUndefined();
  });
});

describe("goal hook adapters", () => {
  it("goalTextFromMessage ignores thinking and toolCall blocks before verdict parsing", () => {
    const text = goalTextFromMessage({
      content: [
        { type: "thinking", thinking: "GOAL_STATUS: BLOCKED" },
        { type: "toolCall" },
        { type: "text", text: "done\n---\nGOAL_STATUS: REACHED" },
      ],
    });

    expect(parseGoalVerdict(text)).toBe("reached");
  });

  it("turnEndGuard check lets REACHED and BLOCKED stop", () => {
    expect(checkGoalContinuation("GOAL_STATUS: REACHED")).toEqual({ ok: true });
    expect(checkGoalContinuation("GOAL_STATUS: BLOCKED\nGOAL_REASON: no access")).toEqual({
      ok: true,
    });
  });

  it("turnEndGuard check forces continuation for NOT_REACHED and carries GOAL_REASON", () => {
    expect(
      checkGoalContinuation("GOAL_STATUS: NOT_REACHED\nGOAL_REASON: tests still fail"),
    ).toEqual({
      ok: false,
      message: "Goal is not reached yet: tests still fail",
    });
  });

  it("turnEndGuard check forces continuation when GOAL_STATUS is missing", () => {
    expect(checkGoalContinuation("I changed files but forgot the marker")).toMatchObject({
      ok: false,
      message: expect.stringContaining("GOAL_STATUS"),
    });
  });

  it("turnEndGuard check uses the default NOT_REACHED message when GOAL_REASON is absent", () => {
    expect(checkGoalContinuation("GOAL_STATUS: NOT_REACHED")).toEqual({
      ok: false,
      message: "Goal is not reached yet. Continue working and end with a GOAL_STATUS block.",
    });
  });
});

describe("goalKernelMaxTurns", () => {
  it("allocates twenty kernel turns per visible goal round", () => {
    expect(goalKernelMaxTurns({ goal: "fix tests", maxTurns: 3 })).toBe(60);
  });

  it("clamps zero maxTurns to at least one visible goal round", () => {
    expect(goalKernelMaxTurns({ goal: "fix tests", maxTurns: 0 })).toBeGreaterThanOrEqual(20);
  });

  it("keeps very large maxTurns inside the safe integer range", () => {
    const turns = goalKernelMaxTurns({ goal: "fix tests", maxTurns: Number.MAX_SAFE_INTEGER });

    expect(Number.isSafeInteger(turns)).toBe(true);
    expect(turns).toBeGreaterThan(0);
    expect(turns).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
  });
});

describe("formatGoalStartBanner", () => {
  it("uses the same kernel-turn unit as per-turn banners", () => {
    const text = formatGoalStartBanner({ goal: "fix tests", maxTurns: 3 });

    expect(text).toContain("max 60 kernel turns");
    expect(text).toContain("3 goal rounds");
  });

  it("includes budget when provided", () => {
    const text = formatGoalStartBanner({
      goal: "fix tests",
      maxTurns: 2,
      budgetTokens: 10000,
    });

    expect(text).toMatch(/10[,_.]?000/);
    expect(text).toContain("tokens");
  });
});

describe("formatGoalRoundBanner", () => {
  it("shows kernel turn/max without budget when no budget", () => {
    const text = formatGoalRoundBanner({ round: 2, maxTurns: 60 });
    expect(text).toContain("kernel turn 2 / 60");
    expect(text).not.toContain("budget");
  });

  it("shows budget info when provided", () => {
    const text = formatGoalRoundBanner({
      round: 1,
      maxTurns: 5,
      budgetTokens: 10000,
      usedTokens: 2500,
    });
    // toLocaleString() formats with locale separators; check partial match
    expect(text).toMatch(/2[,_.]?500/);
    expect(text).toMatch(/10[,_.]?000/);
    expect(text).toContain("25%");
  });
});

describe("classifyGoalOutcome", () => {
  it("classifies done + REACHED as success", () => {
    expect(
      classifyGoalOutcome(
        {
          turns: 1,
          continuations: 0,
          reason: "done",
          lastMessage: { role: "assistant", content: [{ type: "text", text: "GOAL_STATUS: REACHED" }] },
        } as any,
      ),
    ).toMatchObject({ verdict: "reached", aborted: false, budgetExhausted: false });
  });

  it("classifies done + NOT_REACHED as unfinished without interruption", () => {
    expect(
      classifyGoalOutcome(undefined, "GOAL_STATUS: NOT_REACHED\nGOAL_REASON: still failing"),
    ).toMatchObject({
      verdict: "not_reached",
      aborted: false,
      budgetExhausted: false,
      goalReason: "still failing",
    });
  });

  it("classifies done + BLOCKED as blocked without interruption", () => {
    expect(classifyGoalOutcome(undefined, "GOAL_STATUS: BLOCKED")).toMatchObject({
      verdict: "blocked",
      aborted: false,
      budgetExhausted: false,
    });
  });

  it("classifies token budget aborts as budget exhaustion", () => {
    expect(
      classifyGoalOutcome(
        {
          turns: 2,
          continuations: 1,
          reason: "aborted",
          abortReason: "token budget exhausted: 120/100",
        } as any,
        "GOAL_STATUS: NOT_REACHED",
      ),
    ).toMatchObject({
      verdict: "not_reached",
      aborted: false,
      budgetExhausted: true,
      abortReason: "token budget exhausted: 120/100",
    });
  });

  it("classifies explicit user aborts as interrupted", () => {
    expect(
      classifyGoalOutcome(
        {
          turns: 2,
          continuations: 1,
          reason: "aborted",
          abortReason: "caller signal aborted",
        } as any,
        "GOAL_STATUS: NOT_REACHED",
        true,
      ),
    ).toMatchObject({ verdict: "not_reached", aborted: true, budgetExhausted: false });
  });

  it("treats REACHED as success even if an abort reason mentions budget", () => {
    expect(
      classifyGoalOutcome(
        {
          turns: 1,
          continuations: 0,
          reason: "aborted",
          abortReason: "token budget exhausted: 120/100",
        } as any,
        "GOAL_STATUS: REACHED",
      ),
    ).toMatchObject({ verdict: "reached", aborted: false, budgetExhausted: false });
  });

  it("treats REACHED as success even when a user abort lands on the same turn", () => {
    // Esc 正好撞上 REACHED：success 优先于中断修饰符 → aborted=false（钉死 aborted=userAborted&&!success 简化）。
    expect(
      classifyGoalOutcome(
        { turns: 2, continuations: 1, reason: "aborted" } as any,
        "GOAL_STATUS: REACHED",
        true,
      ),
    ).toMatchObject({ verdict: "reached", aborted: false, budgetExhausted: false });
  });

  it.each([
    "token budget exhausted: 120/100",
    "diminishing returns: last continuations added <500 tokens each",
    "repeated-call-guard: read repeated 4 times",
    "empty-run-guard: 3 consecutive empty turns (no tool calls)",
    "caller signal aborted",
  ])("surfaces guard abort reason instead of treating it as user interruption: %s", (abortReason) => {
    const outcome = classifyGoalOutcome(
      {
        turns: 2,
        continuations: 0,
        reason: "aborted",
        abortReason,
      } as any,
      "GOAL_STATUS: NOT_REACHED",
      false,
    );

    expect(outcome).toMatchObject({
      verdict: "not_reached",
      aborted: false,
      abortReason,
    });
  });

  it("does not let unrelated abort reason text override a done verdict", () => {
    expect(
      classifyGoalOutcome(
        {
          turns: 2,
          continuations: 0,
          reason: "aborted",
          abortReason: "unrelated verifier: no progress",
        } as any,
        "GOAL_STATUS: NOT_REACHED",
      ),
    ).toMatchObject({
      verdict: "not_reached",
      aborted: false,
      budgetExhausted: false,
      abortReason: "unrelated verifier: no progress",
    });
  });
});

describe("formatGoalFinalStatus", () => {
  it("shows success message on reached", () => {
    const text = formatGoalFinalStatus("reached", 2);
    expect(text).toMatch(/✓|reached|目标/i);
  });

  it("shows failure message on not_reached with rounds", () => {
    const text = formatGoalFinalStatus("not_reached", 5);
    expect(text).toMatch(/✗|not.reached|未达成/i);
    expect(text).toContain("5");
  });

  it("shows blocked message on blocked", () => {
    const text = formatGoalFinalStatus("blocked", 2);
    expect(text).toMatch(/blocked|阻塞/i);
  });

  it("shows aborted message when aborted=true", () => {
    const text = formatGoalFinalStatus("unknown", 1, true);
    expect(text).toMatch(/abort|interrupt|中断/i);
  });

  it("shows budget exhausted when budget=true", () => {
    const text = formatGoalFinalStatus(
      "not_reached",
      3,
      false,
      true,
      "token budget exhausted: 120/100",
    );
    expect(text).toContain("token budget exhausted: 120/100");
  });

  it("shows guard abort reason without calling it interrupted", () => {
    const text = formatGoalFinalStatus(
      "not_reached",
      3,
      false,
      false,
      "repeated-call-guard: read repeated 4 times",
    );

    expect(text).toContain("repeated-call-guard: read repeated 4 times");
    expect(text).not.toMatch(/interrupt|中断/i);
  });
});
