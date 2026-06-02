import { describe, expect, it } from "vitest";
import { parseSlashCommand } from "../slash.js";

describe("parseSlashCommand", () => {
  it("returns null for non-slash input (normal prompt)", () => {
    expect(parseSlashCommand("hello world")).toBeNull();
    expect(parseSlashCommand("  fix the bug /compact later")).toBeNull(); // 斜杠不在开头
  });

  it("parses /compact (case-insensitive, ignores trailing args)", () => {
    expect(parseSlashCommand("/compact")).toEqual({ kind: "compact" });
    expect(parseSlashCommand("  /COMPACT  ")).toEqual({ kind: "compact" });
    expect(parseSlashCommand("/compact now please")).toEqual({ kind: "compact" });
  });

  it("parses /help", () => {
    expect(parseSlashCommand("/help")).toEqual({ kind: "help" });
  });

  it("reports unknown slash commands by name", () => {
    expect(parseSlashCommand("/bogus")).toEqual({ kind: "unknown", name: "bogus" });
  });

  it("treats fat-finger slashes as unknown, not compact", () => {
    expect(parseSlashCommand("/")).toEqual({ kind: "unknown", name: "" }); // 裸斜杠
    expect(parseSlashCommand("/ compact")).toEqual({ kind: "unknown", name: "" }); // 斜杠后有空格
  });
});
