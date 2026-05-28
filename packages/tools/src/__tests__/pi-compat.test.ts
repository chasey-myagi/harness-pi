import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  allTools,
  bashTool,
  codingTools,
  createAllTools,
  createCodingTools,
  createReadOnlyTools,
  createReadTool,
  createBashTool,
  createEditTool,
  createWriteTool,
  createGrepTool,
  createFindTool,
  createLsTool,
  editTool,
  findTool,
  grepTool,
  lsTool,
  readOnlyTools,
  readTool,
  toolNames,
  writeTool,
} from "../index.js";

const PI_053_TOOL_NAMES = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;

const PI_053_CODING_DEFAULTS = ["read", "bash", "edit", "write"] as const;
const PI_053_READ_ONLY_DEFAULTS = ["read", "grep", "find", "ls"] as const;

const PI_053_SCHEMA_KEYS = {
  read: ["path", "offset", "limit"],
  bash: ["command", "timeout"],
  edit: ["path", "oldText", "newText"],
  write: ["path", "content"],
  grep: [
    "pattern",
    "path",
    "glob",
    "ignoreCase",
    "literal",
    "context",
    "limit",
  ],
  find: ["pattern", "path", "limit"],
  ls: ["path", "limit"],
} as const;

const PI_053_REQUIRED = {
  read: ["path"],
  bash: ["command"],
  edit: ["path", "oldText", "newText"],
  write: ["path", "content"],
  grep: ["pattern"],
  find: ["pattern"],
  ls: [],
} as const;

function schemaKeys(tool: ReturnType<typeof createReadTool>): string[] {
  return Object.keys((tool.parameters as any).properties ?? {});
}

function requiredKeys(tool: ReturnType<typeof createReadTool>): string[] {
  return (tool.parameters as any).required ?? [];
}

describe("pi-coding-agent 0.53 compatibility", () => {
  it("exports the same first-party tool names", () => {
    const all = createAllTools("/tmp");
    expect(Object.keys(all)).toEqual([...PI_053_TOOL_NAMES]);
    expect([...toolNames]).toEqual([...PI_053_TOOL_NAMES]);
    expect(Object.keys(allTools)).toEqual([...PI_053_TOOL_NAMES]);
  });

  it("keeps composite factory defaults aligned", () => {
    expect(createCodingTools("/tmp").map((t) => t.name)).toEqual([
      ...PI_053_CODING_DEFAULTS,
    ]);
    expect(createReadOnlyTools("/tmp").map((t) => t.name)).toEqual([
      ...PI_053_READ_ONLY_DEFAULTS,
    ]);
    expect(codingTools.map((t) => t.name)).toEqual([...PI_053_CODING_DEFAULTS]);
    expect(readOnlyTools.map((t) => t.name)).toEqual([
      ...PI_053_READ_ONLY_DEFAULTS,
    ]);
  });

  it("supports disabling defaults from composite factories", () => {
    expect(
      createCodingTools("/tmp", { disabled: ["bash", "write"] }).map(
        (t) => t.name,
      ),
    ).toEqual(["read", "edit"]);
    expect(
      createReadOnlyTools("/tmp", { disabled: ["grep"] }).map((t) => t.name),
    ).toEqual(["read", "find", "ls"]);
  });

  it("keeps TypeBox schema property names aligned", () => {
    const tools = {
      read: createReadTool("/tmp"),
      bash: createBashTool("/tmp"),
      edit: createEditTool("/tmp"),
      write: createWriteTool("/tmp"),
      grep: createGrepTool("/tmp"),
      find: createFindTool("/tmp"),
      ls: createLsTool("/tmp"),
    };
    for (const name of PI_053_TOOL_NAMES) {
      expect(schemaKeys(tools[name])).toEqual([...PI_053_SCHEMA_KEYS[name]]);
      expect(requiredKeys(tools[name])).toEqual([...PI_053_REQUIRED[name]]);
    }
  });

  it("keeps labels and concurrency-safety aligned", () => {
    const all = createAllTools("/tmp");
    expect(PI_053_TOOL_NAMES.map((name) => all[name].label)).toEqual([
      ...PI_053_TOOL_NAMES,
    ]);
    expect(
      ["read", "grep", "find", "ls"].map((name) =>
        all[name as keyof typeof all].isConcurrencySafe?.({}),
      ),
    ).toEqual([true, true, true, true]);
    expect(
      ["bash", "edit", "write"].map((name) =>
        all[name as keyof typeof all].isConcurrencySafe?.({}),
      ),
    ).toEqual([false, false, false]);
  });

  it("exports per-tool default constants without pi-coding-agent dependency", () => {
    expect([
      readTool.name,
      bashTool.name,
      editTool.name,
      writeTool.name,
      grepTool.name,
      findTool.name,
      lsTool.name,
    ]).toEqual([...PI_053_TOOL_NAMES]);

    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies).not.toHaveProperty("@mariozechner/pi-coding-agent");
  });
});
