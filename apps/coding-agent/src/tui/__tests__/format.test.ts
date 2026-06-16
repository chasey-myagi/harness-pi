import { describe, it, expect } from "vitest";
import {
  truncate,
  formatToolCall,
  formatToolCalls,
  formatToolResult,
  formatStatusBar,
  formatTokenCount,
  formatContextGauge,
  formatApprovalPreview,
  buildLineDiff,
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

describe("buildLineDiff", () => {
  it("shows removed and added lines for a simple replacement", () => {
    const diff = buildLineDiff("foo", "bar");
    const stripped = diff.map(strip);
    expect(stripped).toContain("-foo");
    expect(stripped).toContain("+bar");
  });

  it("preserves common prefix/suffix as context lines", () => {
    const old = "a\nb\nc\nd";
    const neu = "a\nb\nX\nd";
    const diff = buildLineDiff(old, neu);
    const stripped = diff.map(strip);
    expect(stripped).toContain(" a");
    expect(stripped).toContain(" b");
    expect(stripped).toContain("-c");
    expect(stripped).toContain("+X");
    expect(stripped).toContain(" d");
  });

  it("shows ellipsis for long common prefix beyond 3 context lines", () => {
    const prefix = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n");
    const old = `${prefix}\nOLD`;
    const neu = `${prefix}\nNEW`;
    const diff = buildLineDiff(old, neu);
    const stripped = diff.map(strip);
    expect(stripped.some((l) => l.includes("unchanged lines"))).toBe(true);
    expect(stripped).toContain("-OLD");
    expect(stripped).toContain("+NEW");
  });

  it("handles new file (empty oldText)", () => {
    const diff = buildLineDiff("", "hello\nworld");
    const stripped = diff.map(strip);
    expect(stripped).toContain("-");
    expect(stripped).toContain("+hello");
    expect(stripped).toContain("+world");
  });

  it("handles deletion (empty newText)", () => {
    const diff = buildLineDiff("hello\nworld", "");
    const stripped = diff.map(strip);
    expect(stripped).toContain("-hello");
    expect(stripped).toContain("-world");
    expect(stripped).toContain("+");
  });
});

describe("formatApprovalPreview", () => {
  it("edit: shows path header and colored diff", () => {
    const out = strip(
      formatApprovalPreview({
        name: "edit",
        arguments: { path: "src/index.ts", oldText: "const a = 1;", newText: "const a = 2;" },
      }),
    );
    expect(out).toContain("src/index.ts");
    expect(out).toContain("-const a = 1;");
    expect(out).toContain("+const a = 2;");
  });

  it("edit: truncates long diffs", () => {
    const oldText = Array.from({ length: 50 }, (_, i) => `old-${i}`).join("\n");
    const newText = Array.from({ length: 50 }, (_, i) => `new-${i}`).join("\n");
    const out = formatApprovalPreview({
      name: "edit",
      arguments: { path: "big.ts", oldText, newText },
    });
    expect(strip(out)).toContain("more lines");
  });

  it("write: shows path, line count, and content preview", () => {
    const content = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const out = strip(
      formatApprovalPreview({ name: "write", arguments: { path: "out.ts", content } }),
    );
    expect(out).toContain("out.ts");
    expect(out).toContain("50 lines");
    expect(out).toContain("line 0");
    expect(out).toContain("more lines");
  });

  it("write: short content shows fully without truncation hint", () => {
    const out = strip(
      formatApprovalPreview({ name: "write", arguments: { path: "a.ts", content: "hello" } }),
    );
    expect(out).toContain("a.ts");
    expect(out).toContain("1 lines");
    expect(out).toContain("hello");
    expect(out).not.toContain("more lines");
  });

  it("bash: shows full command", () => {
    const out = strip(
      formatApprovalPreview({ name: "bash", arguments: { command: "rm -rf /tmp/junk" } }),
    );
    expect(out).toContain("bash");
    expect(out).toContain("rm -rf /tmp/junk");
  });

  it("bash: shows multiline command fully", () => {
    const cmd = "echo hello\necho world";
    const out = strip(formatApprovalPreview({ name: "bash", arguments: { command: cmd } }));
    expect(out).toContain("echo hello");
    expect(out).toContain("echo world");
  });

  it("returns empty for unknown tools", () => {
    expect(formatApprovalPreview({ name: "read", arguments: { path: "a" } })).toBe("");
  });
});
