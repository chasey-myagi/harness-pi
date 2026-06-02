import { describe, expect, it } from "vitest";
import { renderRunReport, type RunReport } from "../output.js";
import type { RunSummary } from "@harness-pi/core";

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function report(summary: Partial<RunSummary>): RunReport {
  return {
    summary: {
      turns: 1,
      continuations: 0,
      reason: "done",
      usage: ZERO_USAGE,
      ...summary,
    } as RunSummary,
    wallTimeMs: 10,
    cwd: "/tmp/x",
    model: "qwen:qwen-plus",
    costKnown: false,
    readOnly: true,
    logPath: "/tmp/x/log.ndjson",
  };
}

describe("renderRunReport — failure & overflow surfacing", () => {
  it("prints the error message on reason=error (not just 'reason: error')", () => {
    const out = renderRunReport(report({ reason: "error", error: new Error("rate limited 429") }));
    expect(out).toContain("reason: error");
    expect(out).toContain("error: rate limited 429");
  });

  it("prints the abort reason on reason=aborted", () => {
    const out = renderRunReport(report({ reason: "aborted", abortReason: "watchdog:timeout" }));
    expect(out).toContain("abort reason: watchdog:timeout");
  });

  it("warns when the answer was truncated by the context/output limit (stopReason length)", () => {
    const out = renderRunReport(report({ reason: "done", stopReason: "length" }));
    expect(out).toMatch(/Warnings/);
    expect(out).toMatch(/truncated/i);
  });

  it("a clean run shows no error/abort/truncation lines", () => {
    const out = renderRunReport(report({ reason: "done", stopReason: "stop" }));
    expect(out).not.toContain("error:");
    expect(out).not.toMatch(/truncated/i);
  });
});
