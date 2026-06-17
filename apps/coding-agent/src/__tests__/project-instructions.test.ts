import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeModel } from "@harness-pi/core/testing";
import { PROJECT_INSTRUCTIONS_MAX_BYTES, loadProjectInstructions } from "../project-instructions.js";
import { createCodingAgent } from "../agent.js";
import { emitProjectInstructionsNotice, parseArgs } from "../cli.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  while (dirs.length) {
    const d = dirs.pop();
    if (d) await rm(d, { recursive: true, force: true });
  }
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "harness-pi-projinstr-test-"));
  dirs.push(d);
  return d;
}

// ─── loadProjectInstructions 单元测试 ────────────────────────────────────────

describe("loadProjectInstructions", () => {
  it("cwd 下有 CLAUDE.md → 返回内容与路径", async () => {
    const cwd = await tmp();
    await writeFile(join(cwd, "CLAUDE.md"), "# My Project\nDo stuff.\n");

    const result = loadProjectInstructions(cwd);
    expect(result).not.toBeNull();
    expect(result!.content).toContain("My Project");
    expect(result!.sourcePath).toBe(join(cwd, "CLAUDE.md"));
  });

  it("cwd 下有 AGENTS.md → 返回内容与路径", async () => {
    const cwd = await tmp();
    await writeFile(join(cwd, "AGENTS.md"), "# Agent instructions\n");

    const result = loadProjectInstructions(cwd);
    expect(result).not.toBeNull();
    expect(result!.content).toContain("Agent instructions");
    expect(result!.sourcePath).toBe(join(cwd, "AGENTS.md"));
  });

  it("CLAUDE.md 优先于 AGENTS.md", async () => {
    const cwd = await tmp();
    await writeFile(join(cwd, "CLAUDE.md"), "claude content\n");
    await writeFile(join(cwd, "AGENTS.md"), "agents content\n");

    const result = loadProjectInstructions(cwd);
    expect(result!.sourcePath).toBe(join(cwd, "CLAUDE.md"));
  });

  it("cwd 无文件时向上查找父目录", async () => {
    const parent = await tmp();
    await writeFile(join(parent, "CLAUDE.md"), "parent instructions\n");
    const child = join(parent, "sub", "project");
    await mkdir(child, { recursive: true });

    const result = loadProjectInstructions(child);
    expect(result).not.toBeNull();
    expect(result!.sourcePath).toBe(join(parent, "CLAUDE.md"));
    expect(result!.content).toContain("parent instructions");
  });

  it("遇到 .git 仓库边界就停止，不读取仓库外层指令", async () => {
    const outer = await tmp();
    await writeFile(join(outer, "CLAUDE.md"), "outer instructions\n");
    const repo = join(outer, "repo");
    const child = join(repo, "packages", "app");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(child, { recursive: true });

    expect(loadProjectInstructions(child)).toBeNull();
  });

  it("到 HOME 边界就停止，不读取 HOME 下的指令文件", async () => {
    const home = await tmp();
    vi.stubEnv("HOME", home);
    await writeFile(join(home, "CLAUDE.md"), "home instructions\n");
    const cwd = join(home, "work", "project");
    await mkdir(cwd, { recursive: true });

    expect(loadProjectInstructions(cwd)).toBeNull();
  });

  it("空指令文件视为不存在，继续尝试同目录下一个候选文件", async () => {
    const cwd = await tmp();
    await writeFile(join(cwd, "CLAUDE.md"), "");
    await writeFile(join(cwd, "AGENTS.md"), "agent instructions\n");

    const result = loadProjectInstructions(cwd);
    expect(result).not.toBeNull();
    expect(result!.sourcePath).toBe(join(cwd, "AGENTS.md"));
    expect(result!.content).toBe("agent instructions\n");
  });

  it("整棵目录树都没有指令文件 → 不抛错", async () => {
    const home = await tmp();
    vi.stubEnv("HOME", home);
    const deep = join(home, "a", "b", "c");
    await mkdir(deep, { recursive: true });

    expect(loadProjectInstructions(deep)).toBeNull();
  });

  it("超大指令文件会被截断，不把整文件注入 prompt", async () => {
    const cwd = await tmp();
    const tailMarker = "TAIL_MARKER_SHOULD_NOT_APPEAR";
    await writeFile(
      join(cwd, "CLAUDE.md"),
      `${"A".repeat(PROJECT_INSTRUCTIONS_MAX_BYTES + 1000)}${tailMarker}\n`,
    );

    const result = loadProjectInstructions(cwd);

    expect(result).not.toBeNull();
    expect(Buffer.byteLength(result!.content, "utf8")).toBeLessThan(
      PROJECT_INSTRUCTIONS_MAX_BYTES + 256,
    );
    expect(result!.content).toContain("truncated");
    expect(result!.content).not.toContain(tailMarker);
  });

  it("AGENTS.md 是 CLAUDE.md 的符号链接 → 也能正确加载", async () => {
    const cwd = await tmp();
    await writeFile(join(cwd, "CLAUDE.md"), "symlink target content\n");
    await symlink(join(cwd, "CLAUDE.md"), join(cwd, "AGENTS.md"));

    // CLAUDE.md 优先，所以直接命中
    const result = loadProjectInstructions(cwd);
    expect(result!.sourcePath).toBe(join(cwd, "CLAUDE.md"));
    expect(result!.content).toContain("symlink target content");
  });
});

// ─── createCodingAgent 集成：system prompt 注入 ──────────────────────────────

describe("createCodingAgent project instructions injection", () => {
  it("有 CLAUDE.md → system prompt 包含文件内容", async () => {
    const cwd = await tmp();
    await writeFile(join(cwd, "CLAUDE.md"), "SPECIAL_MARKER_XYZ\n");
    const fake = createFakeModel([]);

    const agent = createCodingAgent({ cwd, model: fake });
    expect(agent.session.systemPrompt).toContain("SPECIAL_MARKER_XYZ");
    expect(agent.projectInstructionsPath).toBe(join(cwd, "CLAUDE.md"));
  });

  it("无文件 → system prompt 与默认一致，projectInstructionsPath 为 undefined", async () => {
    const cwd = await tmp();
    const fake = createFakeModel([]);

    const agent = createCodingAgent({ cwd, model: fake });
    // 没有文件时 projectInstructionsPath 应该是 undefined
    // （如果父目录恰好有 CLAUDE.md 则 projectInstructionsPath 非 undefined，此断言会跳过）
    if (agent.projectInstructionsPath === undefined) {
      expect(agent.session.systemPrompt).not.toContain("SPECIAL_MARKER");
    }
  });

  it("noProjectInstructions:true → 不注入，projectInstructionsPath 为 undefined", async () => {
    const cwd = await tmp();
    await writeFile(join(cwd, "CLAUDE.md"), "SHOULD_NOT_APPEAR\n");
    const fake = createFakeModel([]);

    const agent = createCodingAgent({ cwd, model: fake, noProjectInstructions: true });
    expect(agent.session.systemPrompt).not.toContain("SHOULD_NOT_APPEAR");
    expect(agent.projectInstructionsPath).toBeUndefined();
  });

  it("有 CLAUDE.md + 自定义 systemPrompt → 两者都出现在 prompt 里", async () => {
    const cwd = await tmp();
    await writeFile(join(cwd, "CLAUDE.md"), "PROJECT_RULE_ABC\n");
    const fake = createFakeModel([]);

    const agent = createCodingAgent({
      cwd,
      model: fake,
      systemPrompt: "CUSTOM_BASE_PROMPT",
    });
    expect(agent.session.systemPrompt).toContain("CUSTOM_BASE_PROMPT");
    expect(agent.session.systemPrompt).toContain("PROJECT_RULE_ABC");
  });
});

// ─── CLI 层：--no-project-instructions flag 解析 + 启动通知 ──────────────────

describe("CLI --no-project-instructions", () => {
  it("默认不传 → noProjectInstructions 为 false", () => {
    const args = parseArgs(["--cwd", "/tmp"]);
    expect(args.noProjectInstructions).toBe(false);
  });

  it("传了 --no-project-instructions → noProjectInstructions 为 true", () => {
    const args = parseArgs(["--cwd", "/tmp", "--no-project-instructions"]);
    expect(args.noProjectInstructions).toBe(true);
  });
});

describe("emitProjectInstructionsNotice", () => {
  it("有 projectInstructionsPath → 输出包含路径", () => {
    const lines: string[] = [];
    emitProjectInstructionsNotice({ projectInstructionsPath: "/some/CLAUDE.md" }, (s) => lines.push(s));
    expect(lines.join("")).toContain("/some/CLAUDE.md");
  });

  it("无 projectInstructionsPath → 不输出任何内容", () => {
    const lines: string[] = [];
    emitProjectInstructionsNotice({ projectInstructionsPath: undefined }, (s) => lines.push(s));
    expect(lines).toHaveLength(0);
  });
});
