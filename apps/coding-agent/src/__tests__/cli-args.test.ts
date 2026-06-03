import { describe, expect, it } from "vitest";
import { parseArgs } from "../cli.js";

describe("parseArgs — v0.1.0 flags", () => {
  it("defaults: no tui/repl/version/list flags set", () => {
    const a = parseArgs([]);
    expect(a).toMatchObject({ tui: false, repl: false, version: false, listProviders: false });
    expect(a.listModels).toBeUndefined();
    expect(a.envFile).toBeUndefined();
  });

  it("--version / -V set version", () => {
    expect(parseArgs(["--version"]).version).toBe(true);
    expect(parseArgs(["-V"]).version).toBe(true);
  });

  it("--list-providers sets the flag", () => {
    expect(parseArgs(["--list-providers"]).listProviders).toBe(true);
  });

  it("--list-models takes a provider value", () => {
    expect(parseArgs(["--list-models", "anthropic"]).listModels).toBe("anthropic");
  });

  it("--list-models without a value throws", () => {
    expect(() => parseArgs(["--list-models"])).toThrow(/requires a value/);
  });

  it("--env-file takes a path", () => {
    expect(parseArgs(["--env-file", ".env.local"]).envFile).toBe(".env.local");
  });

  it("--repl sets repl (plain REPL opt-in)", () => {
    expect(parseArgs(["--repl"]).repl).toBe(true);
  });

  it("still parses existing flags alongside new ones", () => {
    const a = parseArgs(["--model", "qwen:qwen-plus", "--tui", "do a thing"]);
    expect(a.model).toBe("qwen:qwen-plus");
    expect(a.tui).toBe(true);
    expect(a.task).toBe("do a thing");
  });

  it("rejects unknown options", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/Unknown option/);
  });

  it("ignores a leading `--` (pnpm separator) and still parses following flags", () => {
    const a = parseArgs(["--", "--model", "qwen:qwen-plus", "--tui"]);
    expect(a.model).toBe("qwen:qwen-plus");
    expect(a.tui).toBe(true);
  });
});
