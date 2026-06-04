import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeModel } from "@harness-pi/core/testing";
import {
  harnessPiGitignoreWarning,
  isHarnessPiGitIgnored,
} from "../workspace-safety.js";
import { createCodingAgent } from "../agent.js";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) await rm(d, { recursive: true, force: true });
  }
});
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "harness-pi-wssafety-"));
  dirs.push(d);
  return d;
}
function gitInit(cwd: string): void {
  // 无 commit 也能 check-ignore；配最小 identity 防某些环境报 warning。
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "t@t.t"], { cwd });
  execFileSync("git", ["config", "user.name", "t"], { cwd });
}

describe("workspace-safety: .harness-pi gitignore 守卫 (#22)", () => {
  it("git 仓库未忽略 .harness-pi → 报未忽略 + 出告警", async () => {
    const cwd = await tmp();
    gitInit(cwd);
    expect(isHarnessPiGitIgnored(cwd)).toBe(false);
    const w = harnessPiGitignoreWarning(cwd);
    expect(w).toContain(".gitignore");
    expect(w).toContain(".harness-pi");
  });

  it("git 仓库已忽略 .harness-pi → 报已忽略 + 无告警", async () => {
    const cwd = await tmp();
    gitInit(cwd);
    await writeFile(join(cwd, ".gitignore"), ".harness-pi/\n");
    expect(isHarnessPiGitIgnored(cwd)).toBe(true);
    expect(harnessPiGitignoreWarning(cwd)).toBeNull();
  });

  it("非 git 仓库 → null（无 git 泄漏面，不告警）", async () => {
    const cwd = await tmp();
    expect(isHarnessPiGitIgnored(cwd)).toBeNull();
    expect(harnessPiGitignoreWarning(cwd)).toBeNull();
  });

  it("createCodingAgent 默认在未忽略的 git repo → agent.warnings 含 gitignore 告警", async () => {
    const cwd = await tmp();
    gitInit(cwd);
    const agent = createCodingAgent({ cwd, model: createFakeModel([]) });
    expect(agent.warnings.some((w) => w.includes(".harness-pi") && w.includes(".gitignore"))).toBe(
      true,
    );
  });

  it("log:false 且无 resume 存储 → 不往 .harness-pi 落盘 → 即便未忽略也不告警", async () => {
    const cwd = await tmp();
    gitInit(cwd);
    const agent = createCodingAgent({ cwd, model: createFakeModel([]), log: false });
    expect(agent.warnings.some((w) => w.includes(".harness-pi"))).toBe(false);
  });

  it("已忽略的 git repo → createCodingAgent 默认不产生 gitignore 告警", async () => {
    const cwd = await tmp();
    gitInit(cwd);
    await writeFile(join(cwd, ".gitignore"), ".harness-pi/\n");
    const agent = createCodingAgent({ cwd, model: createFakeModel([]) });
    expect(agent.warnings.some((w) => w.includes(".harness-pi"))).toBe(false);
  });
});
