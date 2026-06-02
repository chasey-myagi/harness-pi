import { describe, it, expect } from "vitest";
import {
  truncate,
  formatToolCall,
  formatToolCalls,
  formatToolResult,
  formatStatusBar,
  formatTokenCount,
  formatContextGauge,
} from "../format.js";

// 剥 ANSI 颜色，断言结构而非具体转义码。
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("format helpers", () => {
  it("truncate caps line count with a remainder hint", () => {
    const out = truncate(Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n"), 10);
    expect(out.split("\n").length).toBe(11); // 10 + 提示行
    expect(out).toContain("more lines");
    expect(out).toContain("line0");
    expect(out).not.toContain("line99");
  });

  it("truncate caps char count", () => {
    const out = truncate("x".repeat(5000), 100, 100);
    expect(out).toContain("more chars");
    expect(out.length).toBeLessThan(200);
  });

  it("truncate leaves short text untouched", () => {
    expect(truncate("hello\nworld")).toBe("hello\nworld");
  });

  it("formatToolCall summarizes name + args one-line", () => {
    expect(strip(formatToolCall({ name: "read", arguments: { path: "a.ts" } }))).toBe("read(path: a.ts)");
    expect(strip(formatToolCall({ name: "ls", arguments: {} }))).toBe("ls()");
  });

  it("formatToolCall flattens multiline/JSON args", () => {
    const out = strip(formatToolCall({ name: "bash", arguments: { cmd: "echo a\necho b" } }));
    expect(out).toBe("bash(cmd: echo a echo b)");
  });

  it("formatToolCalls joins multiple calls on one line", () => {
    const out = strip(
      formatToolCalls([
        { name: "read", arguments: { path: "a" } },
        { name: "bash", arguments: { cmd: "ls" } },
      ]),
    );
    expect(out).toContain("read(path: a)");
    expect(out).toContain("bash(cmd: ls)");
    expect(out.split("\n").length).toBe(1);
  });

  it("formatToolResult shows ✓/name/duration + indented output", () => {
    const ok = strip(formatToolResult("bash", true, "a.ts\nb.ts", 12));
    expect(ok).toContain("✓");
    expect(ok).toContain("bash");
    expect(ok).toContain("12ms");
    expect(ok).toContain("a.ts");
  });

  it("formatToolResult marks failure with ✗", () => {
    const bad = strip(formatToolResult("bash", false, "boom", 3));
    expect(bad).toContain("✗");
    expect(bad).toContain("boom");
  });

  it("formatToolResult with empty output is just the header (no trailing body)", () => {
    const out = strip(formatToolResult("ls", true, "", 1));
    expect(out).toContain("ls");
    expect(out.split("\n").length).toBe(1);
  });

  it("formatStatusBar shows model, tokens, cost, tool stats", () => {
    const out = strip(
      formatStatusBar({ model: "qwen-turbo", input: 123, output: 45, costText: "¥0.0012", toolCalls: 3, toolErrors: 1 }),
    );
    expect(out).toContain("qwen-turbo");
    expect(out).toContain("↑123 ↓45");
    expect(out).toContain("¥0.0012");
    expect(out).toContain("🔧 3/1");
  });

  it("formatStatusBar omits absent segments", () => {
    const out = strip(formatStatusBar({ model: "m" }));
    expect(out).toBe("m");
  });

  it("formatTokenCount uses compact k/M units", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(950)).toBe("950");
    expect(formatTokenCount(1200)).toBe("1.2k");
    expect(formatTokenCount(12_000)).toBe("12k");
    expect(formatTokenCount(200_000)).toBe("200k");
    expect(formatTokenCount(1_500_000)).toBe("1.5M");
  });

  it("formatContextGauge shows used/window and percent", () => {
    expect(strip(formatContextGauge(12_000, 200_000))).toBe("ctx 12k/200k (6%)");
  });

  it("formatStatusBar includes the context gauge when window is known", () => {
    const out = strip(
      formatStatusBar({ model: "m", input: 50_000, contextTokens: 50_000, contextWindow: 200_000 }),
    );
    expect(out).toContain("ctx 50k/200k (25%)");
  });

  it("formatStatusBar omits the gauge when window is unknown or zero", () => {
    expect(strip(formatStatusBar({ model: "m", contextTokens: 50_000 }))).toBe("m");
    expect(strip(formatStatusBar({ model: "m", contextTokens: 50_000, contextWindow: 0 }))).toBe("m");
  });
});
