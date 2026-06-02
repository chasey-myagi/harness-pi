import { describe, expect, it } from "vitest";
import { parseSlashCommand, SLASH_COMMANDS, SLASH_HELP } from "../slash.js";

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

  it("SLASH_COMMANDS lists the executable commands and every name parses back", () => {
    const names = SLASH_COMMANDS.map((c) => c.name);
    expect(names).toContain("compact");
    expect(names).toContain("help");
    // 每条命令名都能被 parseSlashCommand 解析回对应 kind（autocomplete 填的文本提交后能执行）。
    for (const name of names) {
      expect(parseSlashCommand(`/${name}`)).toEqual({ kind: name });
    }
  });

  it("SLASH_HELP is derived from SLASH_COMMANDS (no drift)", () => {
    for (const c of SLASH_COMMANDS) {
      expect(SLASH_HELP).toContain(`/${c.name}`);
      expect(SLASH_HELP).toContain(c.description);
    }
  });
});
