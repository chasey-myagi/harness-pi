import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isMainModule, parseArgs } from "../cli.js";

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

  it("--no-log sets noLog", () => {
    expect(parseArgs(["--no-log"]).noLog).toBe(true);
  });

  it("--log-args parses redacted | full | none", () => {
    expect(parseArgs(["--log-args", "redacted"]).logArgs).toBe("redacted");
    expect(parseArgs(["--log-args", "full"]).logArgs).toBe("full");
    expect(parseArgs(["--log-args", "none"]).logArgs).toBe("none");
  });

  it("--log-args defaults to undefined (agent applies the default)", () => {
    expect(parseArgs([]).logArgs).toBeUndefined();
  });

  it("--log-args with an invalid value throws", () => {
    expect(() => parseArgs(["--log-args", "bogus"])).toThrow(/Invalid --log-args/);
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

describe("isMainModule — recognizes the npm bin symlink", () => {
  const dirs: string[] = [];
  function tmp(): string {
    const d = mkdtempSync(join(tmpdir(), "hpi-main-"));
    dirs.push(d);
    return d;
  }
  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("matches when argv[1] is a symlink to the module (the .bin/hpi case)", () => {
    const dir = tmp();
    const real = join(dir, "cli.js");
    writeFileSync(real, "// entry");
    const link = join(dir, "hpi");
    symlinkSync(real, link); // mimics node_modules/.bin/hpi -> dist/cli.js
    // metaUrl is the resolved real file (as Node sets import.meta.url); argv[1] is the symlink.
    expect(isMainModule(pathToFileURL(real).href, link)).toBe(true);
  });

  it("matches a direct invocation and rejects unrelated / missing argv[1]", () => {
    const dir = tmp();
    const real = join(dir, "cli.js");
    writeFileSync(real, "// entry");
    const other = join(dir, "other.js");
    writeFileSync(other, "// other");
    expect(isMainModule(pathToFileURL(real).href, real)).toBe(true);
    expect(isMainModule(pathToFileURL(real).href, other)).toBe(false);
    expect(isMainModule(pathToFileURL(real).href, undefined)).toBe(false);
  });
});
