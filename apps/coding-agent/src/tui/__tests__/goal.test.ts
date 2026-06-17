import { describe, expect, it } from "vitest";
import {
  parseGoalCommand,
  buildGoalPrompt,
  classifyGoalOutcome,
  checkGoalContinuation,
  parseGoalReason,
  parseGoalVerdict,
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
  });

  it("ignores an invalid --max-turns value without leaving flag text in the goal", () => {
    expect(parseGoalCommand("fix flaky tests --max-turns abc")).toEqual({
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

  it("uses the first --success flag and leaves later repeated flags as goal text", () => {
    expect(parseGoalCommand("ship --success first pass --success second pass")).toEqual({
      goal: "ship --success second pass",
      maxTurns: 5,
      budgetTokens: undefined,
      successHint: "first pass",
    });
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

});

describe("formatGoalRoundBanner", () => {
  it("shows round/max without budget when no budget", () => {
    const text = formatGoalRoundBanner({ round: 2, maxTurns: 5 });
    expect(text).toContain("2");
    expect(text).toContain("5");
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
    ).toEqual({ verdict: "reached", aborted: false, budgetExhausted: false });
  });

  it("classifies done + NOT_REACHED as unfinished without interruption", () => {
    expect(
      classifyGoalOutcome(undefined, "GOAL_STATUS: NOT_REACHED\nGOAL_REASON: still failing"),
    ).toEqual({ verdict: "not_reached", aborted: false, budgetExhausted: false });
  });

  it("classifies done + BLOCKED as blocked without interruption", () => {
    expect(classifyGoalOutcome(undefined, "GOAL_STATUS: BLOCKED")).toEqual({
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
    ).toEqual({ verdict: "not_reached", aborted: false, budgetExhausted: true });
  });

  it("classifies user aborts as interrupted", () => {
    expect(
      classifyGoalOutcome(
        {
          turns: 2,
          continuations: 1,
          reason: "aborted",
          abortReason: "caller signal aborted",
        } as any,
        "GOAL_STATUS: NOT_REACHED",
      ),
    ).toEqual({ verdict: "not_reached", aborted: true, budgetExhausted: false });
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
    ).toEqual({ verdict: "reached", aborted: false, budgetExhausted: false });
  });

  it("does not special-case legacy progressVerifier abort reason strings", () => {
    expect(
      classifyGoalOutcome(
        {
          turns: 2,
          continuations: 0,
          reason: "aborted",
          abortReason: "progressVerifier: no progress",
        } as any,
        "GOAL_STATUS: NOT_REACHED",
      ),
    ).toEqual({ verdict: "not_reached", aborted: true, budgetExhausted: false });
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
    const text = formatGoalFinalStatus("not_reached", 3, false, true);
    expect(text).toMatch(/budget|预算/i);
  });
});
