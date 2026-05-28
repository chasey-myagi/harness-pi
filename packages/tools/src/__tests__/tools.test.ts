import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession, type HarnessTool } from "@harness-pi/core";
import { createFakeModel } from "@harness-pi/core/testing";
import {
  createBashTool,
  createCodingTools,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadOnlyTools,
  createReadTool,
  createWriteTool,
  readTool,
} from "../index.js";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "harness-pi-tools-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function runTool(
  tool: HarnessTool,
  args: Record<string, unknown>,
): Promise<Awaited<ReturnType<HarnessTool["execute"]>>> {
  return tool.execute(args, {} as any, new AbortController().signal);
}

function text(result: Awaited<ReturnType<HarnessTool["execute"]>>): string {
  const first = result.content[0];
  if (first?.type !== "text") throw new Error("expected text result");
  return first.text;
}

describe("read tool", () => {
  it("reads text files with cwd-relative paths and offset/limit", async () => {
    await writeFile(
      path.join(dir, "notes.txt"),
      ["one", "two", "three", "four"].join("\n"),
    );
    const result = await runTool(createReadTool(dir), {
      path: "notes.txt",
      offset: 2,
      limit: 2,
    });
    expect(text(result)).toContain("two");
    expect(text(result)).toContain("three");
    expect(text(result)).not.toContain("one");
    expect(text(result)).toContain("1 more lines in file");
    expect(result.details).toBeUndefined();
  });

  it("uses read operations override", async () => {
    const tool = createReadTool(dir, {
      operations: {
        readFile: async () => Buffer.from("from override"),
        access: async () => undefined,
      },
    });
    const result = await runTool(tool, { path: "virtual.txt" });
    expect(text(result)).toBe("from override");
  });

  it("returns text note and image content for image files", async () => {
    await writeFile(
      path.join(dir, "pixel.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]),
    );
    const result = await runTool(createReadTool(dir), { path: "pixel.png" });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "Read image file [image/png]",
    });
    expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
  });

  it("truncates large text files by default", async () => {
    await writeFile(path.join(dir, "large.txt"), "x".repeat(60 * 1024));
    const result = await runTool(createReadTool(dir), { path: "large.txt" });
    expect(text(result).length).toBeLessThanOrEqual(50 * 1024);
    expect(result.details).toMatchObject({
      truncation: { totalBytes: 60 * 1024, firstLineExceedsLimit: true },
    });
  });

  it("throws for unreadable files", async () => {
    await expect(runTool(createReadTool(dir), { path: "missing.txt" })).rejects
      .toThrow(/not found|ENOENT/i);
  });

  it("throws when offset is beyond end of file", async () => {
    await writeFile(path.join(dir, "notes.txt"), "one\ntwo\n");
    await expect(
      runTool(createReadTool(dir), { path: "notes.txt", offset: 9 }),
    ).rejects.toThrow(/beyond end/i);
  });

  it("rejects paths outside cwd unless explicitly allowed", async () => {
    const outside = path.join(path.dirname(dir), `${path.basename(dir)}-outside.txt`);
    await writeFile(outside, "outside");
    await expect(runTool(createReadTool(dir), { path: outside })).rejects.toThrow(
      /escapes cwd/i,
    );
    const result = await runTool(createReadTool(dir, { allowOutsideCwd: true }), {
      path: outside,
    });
    expect(text(result)).toBe("outside");
  });

  it("rejects symlink escapes and bounded default exports reject outside cwd", async () => {
    const outside = path.join(path.dirname(dir), `${path.basename(dir)}-secret.txt`);
    await writeFile(outside, "secret");
    await symlink(outside, path.join(dir, "link.txt"));

    await expect(runTool(createReadTool(dir), { path: "link.txt" })).rejects
      .toThrow(/escapes cwd/i);
    await expect(runTool(readTool, { path: outside })).rejects.toThrow(
      /escapes cwd/i,
    );
  });
});

describe("write and edit tools", () => {
  it("writes files under cwd and creates parent directories", async () => {
    const result = await runTool(createWriteTool(dir), {
      path: "nested/output.txt",
      content: "hello",
    });
    expect(text(result)).toContain("File written successfully");
    await expect(readFile(path.join(dir, "nested/output.txt"), "utf8"))
      .resolves.toBe("hello");
  });

  it("honors write operations override", async () => {
    const calls: string[] = [];
    const result = await runTool(
      createWriteTool(dir, {
        operations: {
          mkdir: async (target) => {
            calls.push(`mkdir:${path.basename(target)}`);
          },
          writeFile: async (target, content) => {
            calls.push(`write:${path.basename(target)}:${content}`);
          },
        },
      }),
      { path: "fake/output.txt", content: "hello" },
    );
    expect(text(result)).toContain("File written successfully");
    expect(calls).toEqual(["mkdir:fake", "write:output.txt:hello"]);
  });

  it("propagates write operation failures", async () => {
    await expect(
      runTool(
        createWriteTool(dir, {
          operations: {
            mkdir: async () => {
              throw new Error("mkdir failed");
            },
          },
        }),
        { path: "nested/output.txt", content: "hello" },
      ),
    ).rejects.toThrow(/mkdir failed/);
  });

  it("rejects writes through symlinked directories outside cwd", async () => {
    const outsideDir = path.join(path.dirname(dir), `${path.basename(dir)}-outside-dir`);
    await mkdir(outsideDir);
    await symlink(outsideDir, path.join(dir, "link-dir"));
    await expect(
      runTool(createWriteTool(dir), {
        path: "link-dir/secret.txt",
        content: "nope",
      }),
    ).rejects.toThrow(/escapes cwd/i);
  });

  it("edits a unique text range and returns diff details", async () => {
    await writeFile(path.join(dir, "file.txt"), "alpha\nbeta\ngamma\n");
    const result = await runTool(createEditTool(dir), {
      path: "file.txt",
      oldText: "beta",
      newText: "BETA",
    });
    expect(text(result)).toContain("File edited successfully");
    await expect(readFile(path.join(dir, "file.txt"), "utf8")).resolves
      .toContain("BETA");
    expect(result.details).toMatchObject({ firstChangedLine: 2 });
    expect((result.details as any).diff).toContain("-beta");
    expect((result.details as any).diff).toContain("+BETA");
  });

  it("honors edit operations override", async () => {
    let written = "";
    const result = await runTool(
      createEditTool(dir, {
        operations: {
          access: async () => undefined,
          readFile: async () => Buffer.from("hello old"),
          writeFile: async (_target, content) => {
            written = content;
          },
        },
      }),
      { path: "virtual.txt", oldText: "old", newText: "new" },
    );
    expect(text(result)).toContain("File edited successfully");
    expect(written).toBe("hello new");
  });

  it("throws when oldText is empty or not found", async () => {
    await writeFile(path.join(dir, "file.txt"), "alpha\n");
    await expect(
      runTool(createEditTool(dir), {
        path: "file.txt",
        oldText: "",
        newText: "x",
      }),
    ).rejects.toThrow(/must not be empty/i);
    await expect(
      runTool(createEditTool(dir), {
        path: "file.txt",
        oldText: "missing",
        newText: "x",
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("throws when edit target is not unique", async () => {
    await writeFile(path.join(dir, "file.txt"), "same\nsame\n");
    await expect(
      runTool(createEditTool(dir), {
        path: "file.txt",
        oldText: "same",
        newText: "other",
      }),
    ).rejects.toThrow(/multiple/i);
  });
});

describe("grep, find, and ls tools", () => {
  beforeEach(async () => {
    await writeFile(path.join(dir, "alpha.txt"), "needle\nline two\n");
    await writeFile(path.join(dir, "omega.txt"), "tail\n");
    await writeFile(path.join(dir, "beta.md"), "Needle in markdown\n");
    await mkdir(path.join(dir, "docs"));
    await writeFile(path.join(dir, "docs", "guide.md"), "before\nneedle\nafter\n");
  });

  it("greps files with literal and ignoreCase options", async () => {
    const result = await runTool(createGrepTool(dir), {
      pattern: "needle",
      path: ".",
      literal: true,
      ignoreCase: true,
    });
    expect(text(result)).toContain("alpha.txt:1: needle");
    expect(text(result)).toContain("beta.md:1: Needle in markdown");
  });

  it("honors grep operations override", async () => {
    const result = await runTool(
      createGrepTool(dir, {
        operations: {
          isDirectory: async () => false,
          readFile: async () => "hello override\n",
        },
      }),
      { pattern: "override", path: "virtual.txt" },
    );
    expect(text(result)).toContain("virtual.txt:1: hello override");
  });

  it("requires listFiles when grep operations override handles directories", async () => {
    await expect(
      runTool(
        createGrepTool(dir, {
          operations: {
            isDirectory: async () => true,
            readFile: async () => "",
          },
        }),
        { pattern: "needle", path: "." },
      ),
    ).rejects.toThrow(/listFiles/i);
  });

  it("counts grep limit by match before expanding context", async () => {
    const result = await runTool(createGrepTool(dir), {
      pattern: "needle",
      path: "docs/guide.md",
      context: 1,
      limit: 1,
    });
    expect(text(result)).toContain("docs/guide.md-1- before");
    expect(text(result)).toContain("docs/guide.md:2: needle");
    expect(text(result)).toContain("docs/guide.md-3- after");
  });

  it("supports root-level ** globs and .gitignore filtering", async () => {
    await writeFile(path.join(dir, ".gitignore"), "ignored.txt\n");
    await writeFile(path.join(dir, "ignored.txt"), "needle\n");
    const result = await runTool(createGrepTool(dir), {
      pattern: "needle",
      path: ".",
      glob: "**/*.txt",
      literal: true,
    });
    expect(text(result)).toContain("alpha.txt");
    expect(text(result)).not.toContain("ignored.txt");
  });

  it("applies workspace .gitignore when grepping from a subdirectory", async () => {
    await writeFile(path.join(dir, ".gitignore"), "docs/ignored.md\n");
    await writeFile(path.join(dir, "docs", "ignored.md"), "needle\n");
    const result = await runTool(createGrepTool(dir), {
      pattern: "needle",
      path: "docs",
      glob: "*.md",
      literal: true,
    });
    expect(text(result)).toContain("docs/guide.md");
    expect(text(result)).not.toContain("ignored.md");
  });

  it("matches .gitignore path segments without substring false positives", async () => {
    await writeFile(path.join(dir, ".gitignore"), "dist\n");
    await mkdir(path.join(dir, "src"));
    await mkdir(path.join(dir, "dist"));
    await writeFile(path.join(dir, "src", "distance.ts"), "needle\n");
    await writeFile(path.join(dir, "dist", "hidden.ts"), "needle\n");

    const grepResult = await runTool(createGrepTool(dir), {
      pattern: "needle",
      path: ".",
      glob: "**/*.ts",
      literal: true,
    });
    expect(text(grepResult)).toContain("src/distance.ts");
    expect(text(grepResult)).not.toContain("dist/hidden.ts");
  });

  it("honors root-anchored .gitignore patterns when grepping", async () => {
    await writeFile(path.join(dir, ".gitignore"), "/dist\n");
    await mkdir(path.join(dir, "src", "dist"), { recursive: true });
    await mkdir(path.join(dir, "dist"));
    await writeFile(path.join(dir, "src", "dist", "visible.ts"), "needle\n");
    await writeFile(path.join(dir, "dist", "hidden.ts"), "needle\n");
    const result = await runTool(createGrepTool(dir), {
      pattern: "needle",
      path: ".",
      glob: "**/*.ts",
      literal: true,
    });
    expect(text(result)).toContain("src/dist/visible.ts");
    expect(text(result)).not.toContain("dist/hidden.ts");
  });

  it("honors nested .gitignore files when grepping", async () => {
    await writeFile(path.join(dir, "docs", ".gitignore"), "nested-hidden.md\n");
    await writeFile(path.join(dir, "docs", "nested-hidden.md"), "needle\n");
    const result = await runTool(createGrepTool(dir), {
      pattern: "needle",
      path: "docs",
      glob: "*.md",
      literal: true,
    });
    expect(text(result)).toContain("docs/guide.md");
    expect(text(result)).not.toContain("nested-hidden.md");
  });

  it("throws for invalid grep regex and missing paths", async () => {
    await expect(
      runTool(createGrepTool(dir), { pattern: "[", path: "." }),
    ).rejects.toThrow();
    await expect(
      runTool(createGrepTool(dir), { pattern: "x", path: "missing" }),
    ).rejects.toThrow(/ENOENT|not found/i);
  });

  it("finds cwd-relative paths and reports limit truncation", async () => {
    const result = await runTool(createFindTool(dir), {
      pattern: "*.txt",
      path: ".",
      limit: 1,
    });
    expect(text(result)).toContain("alpha.txt");
    expect(result.details).toMatchObject({ resultLimitReached: 1 });
  });

  it("returns find results relative to cwd, not search path", async () => {
    const result = await runTool(createFindTool(dir), {
      pattern: "*.md",
      path: "docs",
    });
    expect(text(result)).toContain("docs/guide.md");
  });

  it("supports root-level ** find patterns and .gitignore filtering", async () => {
    await writeFile(path.join(dir, ".gitignore"), "ignored.ts\n");
    await writeFile(path.join(dir, "root.ts"), "x");
    await writeFile(path.join(dir, "ignored.ts"), "x");
    const result = await runTool(createFindTool(dir), { pattern: "**/*.ts" });
    expect(text(result)).toContain("root.ts");
    expect(text(result)).not.toContain("ignored.ts");
  });

  it("applies workspace .gitignore when finding from a subdirectory", async () => {
    await writeFile(path.join(dir, ".gitignore"), "docs/ignored.md\n");
    await writeFile(path.join(dir, "docs", "ignored.md"), "x");
    const result = await runTool(createFindTool(dir), {
      pattern: "*.md",
      path: "docs",
    });
    expect(text(result)).toContain("docs/guide.md");
    expect(text(result)).not.toContain("ignored.md");
  });

  it("does not let .gitignore segment patterns hide substring matches in find", async () => {
    await writeFile(path.join(dir, ".gitignore"), "dist\n");
    await mkdir(path.join(dir, "src"));
    await mkdir(path.join(dir, "dist"));
    await writeFile(path.join(dir, "src", "distance.ts"), "x");
    await writeFile(path.join(dir, "dist", "hidden.ts"), "x");
    const result = await runTool(createFindTool(dir), { pattern: "**/*.ts" });
    expect(text(result)).toContain("src/distance.ts");
    expect(text(result)).not.toContain("dist/hidden.ts");
  });

  it("honors root-anchored and nested .gitignore patterns in find", async () => {
    await writeFile(path.join(dir, ".gitignore"), "/dist\n");
    await mkdir(path.join(dir, "src", "dist"), { recursive: true });
    await mkdir(path.join(dir, "dist"));
    await writeFile(path.join(dir, "src", "dist", "visible.ts"), "x");
    await writeFile(path.join(dir, "dist", "hidden.ts"), "x");
    let result = await runTool(createFindTool(dir), { pattern: "**/*.ts" });
    expect(text(result)).toContain("src/dist/visible.ts");
    expect(text(result)).not.toContain("dist/hidden.ts");

    await writeFile(path.join(dir, "docs", ".gitignore"), "nested-hidden.md\n");
    await writeFile(path.join(dir, "docs", "nested-hidden.md"), "x");
    result = await runTool(createFindTool(dir), {
      pattern: "*.md",
      path: "docs",
    });
    expect(text(result)).toContain("docs/guide.md");
    expect(text(result)).not.toContain("nested-hidden.md");
  });

  it("throws when find root is missing", async () => {
    await expect(
      runTool(createFindTool(dir), { pattern: "*.txt", path: "missing" }),
    ).rejects.toThrow(/not found/i);
  });

  it("honors find operations override", async () => {
    const result = await runTool(
      createFindTool(dir, {
        operations: {
          exists: async () => true,
          glob: async () => ["one.ts", "two.ts"],
        },
      }),
      { pattern: "*.ts" },
    );
    expect(text(result)).toBe("one.ts\ntwo.ts");
  });

  it("lists directories with stable ordering and limit metadata", async () => {
    const result = await runTool(createLsTool(dir), { path: ".", limit: 1 });
    expect(text(result)).toMatch(/alpha\.txt|beta\.md/);
    expect(result.details).toMatchObject({ entryLimitReached: 1 });
  });

  it("honors ls operations override and reports empty directories", async () => {
    const result = await runTool(
      createLsTool(dir, {
        operations: {
          exists: async () => true,
          stat: async () => ({ isDirectory: () => true }),
          readdir: async () => ["B", "a"],
        },
      }),
      { path: "." },
    );
    expect(text(result)).toBe("a/\nB/");

    const empty = await runTool(createLsTool(dir), { path: "docs", limit: 0 });
    expect(text(empty)).toBe("(empty directory)");
  });

  it("throws for missing ls path and file path", async () => {
    await expect(runTool(createLsTool(dir), { path: "missing" })).rejects.toThrow(
      /not found/i,
    );
    await expect(runTool(createLsTool(dir), { path: "alpha.txt" })).rejects.toThrow(
      /not a directory/i,
    );
  });
});

describe("bash tool", () => {
  it("executes a real command in cwd", async () => {
    const result = await runTool(createBashTool(dir), {
      command: "printf '%s' \"$PWD\"",
    });
    await expect(realpath(text(result))).resolves.toBe(await realpath(dir));
  });

  it("executes through operations override", async () => {
    const result = await runTool(
      createBashTool(dir, {
        operations: {
          exec: async (command, cwd, options) => {
            options.onData(Buffer.from(`${command} @ ${path.basename(cwd)}`));
            return { exitCode: 0 };
          },
        },
      }),
      { command: "echo ok" },
    );
    expect(text(result)).toContain("echo ok @");
  });

  it("throws on non-zero exit", async () => {
    await expect(
      runTool(
        createBashTool(dir, {
          operations: {
            exec: async (_command, _cwd, options) => {
              options.onData(Buffer.from("boom"));
              return { exitCode: 2 };
            },
          },
        }),
        { command: "bad" },
      ),
    ).rejects.toThrow(/exited with code 2/i);
  });

  it("handles null exit and operation-level abort", async () => {
    await expect(
      runTool(
        createBashTool(dir, {
          operations: {
            exec: async () => ({ exitCode: null }),
          },
        }),
        { command: "killed" },
      ),
    ).rejects.toThrow(/killed by signal/i);

    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      createBashTool(dir).execute({ command: "echo no" }, {} as any, ctrl.signal),
    ).rejects.toThrow(/aborted/i);
  });

  it("passes timeout in seconds to operations override", async () => {
    let seenTimeout: number | undefined;
    await runTool(
      createBashTool(dir, {
        operations: {
          exec: async (_command, _cwd, options) => {
            seenTimeout = options.timeout;
            return { exitCode: 0 };
          },
        },
      }),
      { command: "echo ok", timeout: 3 },
    );
    expect(seenTimeout).toBe(3);
  });

  it("hard-stops commands that ignore TERM after timeout", async () => {
    const started = Date.now();
    await expect(
      runTool(createBashTool(dir), {
        command: "trap '' TERM; sleep 10",
        timeout: 1,
      }),
    ).rejects.toThrow(/timeout:1/);
    expect(Date.now() - started).toBeLessThan(6_000);
  });
});

describe("composite tools", () => {
  it("can disable every default tool", () => {
    expect(
      createCodingTools(dir, { disabled: ["read", "bash", "edit", "write"] }),
    ).toEqual([]);
    expect(
      createReadOnlyTools(dir, { disabled: ["read", "grep", "find", "ls"] }),
    ).toEqual([]);
  });

  it("runs read-only tools through AgentSession and preserves real details", async () => {
    await writeFile(path.join(dir, "large.txt"), "x".repeat(60 * 1024));
    await writeFile(path.join(dir, "small.txt"), "needle\n");
    const model = createFakeModel([
      {
        content: [
          { type: "toolCall", name: "read", arguments: { path: "large.txt" } },
          { type: "toolCall", name: "grep", arguments: { pattern: "needle", path: "." } },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({
      model,
      tools: createReadOnlyTools(dir),
    });
    const summary = await session.run("go");
    expect(summary.reason).toBe("done");
    const results = session.messages.filter((m) => m.role === "toolResult");
    expect(results.map((m) => m.toolName)).toEqual(["read", "grep"]);
    expect((results[0] as any).details.truncation.totalBytes).toBe(60 * 1024);
  });
});
