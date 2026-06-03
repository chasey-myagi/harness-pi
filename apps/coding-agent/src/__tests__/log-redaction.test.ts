import { describe, expect, it } from "vitest";
import { redactCodingToolArgs } from "../log-redaction.js";

describe("redactCodingToolArgs", () => {
  it("write.content → 仅记长度", () => {
    const out = redactCodingToolArgs("write", {
      path: "src/a.ts",
      content: "hello world",
    });
    expect(out).toEqual({
      path: "src/a.ts",
      content: "[redacted content, 11 chars]",
    });
  });

  it("edit.oldText + newText → 各自仅记长度", () => {
    const out = redactCodingToolArgs("edit", {
      path: "src/a.ts",
      oldText: "abc",
      newText: "abcde",
    });
    expect(out).toEqual({
      path: "src/a.ts",
      oldText: "[redacted text, 3 chars]",
      newText: "[redacted text, 5 chars]",
    });
  });

  it("bash.command → 仅记长度", () => {
    const out = redactCodingToolArgs("bash", {
      command: "echo $TOKEN",
    });
    expect(out).toEqual({ command: "[redacted command, 11 chars]" });
  });

  it("read.path 透传不变（低危字段）", () => {
    const out = redactCodingToolArgs("read", { path: "src/a.ts" });
    expect(out).toEqual({ path: "src/a.ts" });
  });

  it("非对象 args 原样返回", () => {
    expect(redactCodingToolArgs("write", "raw")).toBe("raw");
    expect(redactCodingToolArgs("write", null)).toBeNull();
    expect(redactCodingToolArgs("write", undefined)).toBeUndefined();
  });

  it("未知工具原样透传", () => {
    const out = redactCodingToolArgs("grep", {
      pattern: "TODO",
      path: "src",
      glob: "*.ts",
    });
    expect(out).toEqual({ pattern: "TODO", path: "src", glob: "*.ts" });
  });
});
