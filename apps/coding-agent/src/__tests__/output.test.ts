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

  it("surfaces persistenceErrors（否则「done 但 transcript 不全」被静默吞掉）", () => {
    const out = renderRunReport(
      report({
        reason: "error",
        persistenceErrors: ["appendEntry(message): boom", "appendEntry(terminal): boom"],
      }),
    );
    expect(out).toContain("persistence errors (2)");
    expect(out).toContain("appendEntry(message): boom");
    expect(out).toContain("appendEntry(terminal): boom");
  });

  it("无 persistenceErrors 时不打该行", () => {
    expect(renderRunReport(report({ reason: "done" }))).not.toContain("persistence errors");
  });

  it("单条 persistenceError → (1) 计数 + 该条文案(钉住计数与分隔符渲染)", () => {
    const out = renderRunReport(report({ reason: "error", persistenceErrors: ["appendEntry(terminal): boom"] }));
    expect(out).toContain("persistence errors (1): appendEntry(terminal): boom");
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
