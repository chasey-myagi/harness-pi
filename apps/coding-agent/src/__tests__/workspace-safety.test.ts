import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFakeModel } from "@harness-pi/core/testing";
import { MemorySessionStore } from "@harness-pi/core";
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
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "t@t.t"], { cwd });
  execFileSync("git", ["config", "user.name", "t"], { cwd });
}
async function gitRepo(gitignore?: string): Promise<string> {
  const cwd = await tmp();
  gitInit(cwd);
  if (gitignore !== undefined) await writeFile(join(cwd, ".gitignore"), gitignore);
  return cwd;
}
const persistence = () => ({ store: new MemorySessionStore(), sessionId: "s1" });
const hasGitignoreWarn = (ws: string[]): boolean =>
  ws.some((w) => w.includes(".harness-pi") && w.includes(".gitignore"));

describe("isHarnessPiGitIgnored", () => {
  it("git 仓库未忽略 → false", async () => {
    expect(isHarnessPiGitIgnored(await gitRepo())).toBe(false);
  });

  it("非 git 仓库 → null（无 git 泄漏面）", async () => {
    expect(isHarnessPiGitIgnored(await tmp())).toBeNull();
  });

  it("cwd 不存在 / git 不可用 → null（不抛、不误报）", () => {
    // 不存在的 cwd 让 execFileSync ENOENT，status 既非 1 也非 128 → 防御回退 null。
    expect(isHarnessPiGitIgnored("/no/such/dir/xyz-harness-pi-test")).toBeNull();
  });

  it.each([
    [".harness-pi/\n", "目录型尾斜杠"],
    [".harness-pi\n", "无尾斜杠（文件或目录同名）"],
    ["/.harness-pi/\n", "root-anchored"],
    ["# c\n\n.harness-pi/\n", "含注释与空行"],
  ])("多种 gitignore 写法都命中 → true（%s: %s）", async (pattern) => {
    expect(isHarnessPiGitIgnored(await gitRepo(pattern))).toBe(true);
  });
});

describe("harnessPiGitignoreWarning", () => {
  it("未忽略的 git 仓库 → 告警含 .gitignore / .harness-pi / resume 语义", async () => {
    const w = harnessPiGitignoreWarning(await gitRepo());
    expect(w).not.toBeNull();
    expect(w).toContain(".gitignore");
    expect(w).toContain(".harness-pi");
    expect(w).toContain("resume"); // 必须点出 resume 存储（无法脱敏的完整原文）这一真正安全点
  });

  it("已忽略 → null；非 git → null", async () => {
    expect(harnessPiGitignoreWarning(await gitRepo(".harness-pi/\n"))).toBeNull();
    expect(harnessPiGitignoreWarning(await tmp())).toBeNull();
  });
});

describe("createCodingAgent → agent.warnings 的 .harness-pi 落盘门控", () => {
  it("默认（log on）+ 未忽略 git repo → 出告警，且恰一条（不重复堆叠）", async () => {
    const cwd = await gitRepo();
    const agent = createCodingAgent({ cwd, model: createFakeModel([]) });
    const gw = agent.warnings.filter((w) => w.includes(".harness-pi") && w.includes(".gitignore"));
    expect(gw).toHaveLength(1);
    // CLI 启动期 stderr 门控依赖这条恒等：harnessPiGitignoreWarning(resolve(cwd)) 必在 agent.warnings 里。
    expect(agent.warnings).toContain(harnessPiGitignoreWarning(resolve(cwd)));
  });

  it("persistence（resume 存储）+ 未忽略 → 出告警（头号泄漏面）", async () => {
    const cwd = await gitRepo();
    const agent = createCodingAgent({ cwd, model: createFakeModel([]), persistence: persistence() });
    expect(hasGitignoreWarn(agent.warnings)).toBe(true);
  });

  it("log:false 但挂了 persistence + 未忽略 → 仍出告警（resume 存储照样落原文）", async () => {
    const cwd = await gitRepo();
    const agent = createCodingAgent({
      cwd,
      model: createFakeModel([]),
      log: false,
      persistence: persistence(),
    });
    expect(hasGitignoreWarn(agent.warnings)).toBe(true); // log:false ≠ 安全
  });

  it("log:false 且无 persistence + 未忽略 → 不落盘 → 不告警", async () => {
    const cwd = await gitRepo();
    const agent = createCodingAgent({ cwd, model: createFakeModel([]), log: false });
    expect(hasGitignoreWarn(agent.warnings)).toBe(false);
    // 这条同时锁住 CLI 启动期 stderr 不会假阳性（它只在告警进了 agent.warnings 时才打）。
    expect(agent.warnings).not.toContain(harnessPiGitignoreWarning(resolve(cwd)));
  });

  it("自定义 logDir 落在 .harness-pi 之外 + 无 persistence → 不告警", async () => {
    const cwd = await gitRepo();
    const agent = createCodingAgent({
      cwd,
      model: createFakeModel([]),
      logDir: join(cwd, "logs-elsewhere"),
    });
    expect(hasGitignoreWarn(agent.warnings)).toBe(false);
  });

  it("相对 --log-dir 指回 .harness-pi（如 .harness-pi/logs2）→ 仍告警（不漏报）", async () => {
    // 相对 logDir 真会落进 cwd/.harness-pi；门控须先 resolve(cwd, logDir) 再比，否则相对 vs 绝对恒 false → 假阴性。
    const cwd = await gitRepo();
    const agent = createCodingAgent({
      cwd,
      model: createFakeModel([]),
      logDir: join(".harness-pi", "logs2"), // 相对路径
    });
    expect(hasGitignoreWarn(agent.warnings)).toBe(true);
  });

  it("相对 --log-dir 落在 .harness-pi 之外（如 logs-elsewhere）→ 不告警", async () => {
    const cwd = await gitRepo();
    const agent = createCodingAgent({
      cwd,
      model: createFakeModel([]),
      logDir: "logs-elsewhere", // 相对、不在 .harness-pi 下
    });
    expect(hasGitignoreWarn(agent.warnings)).toBe(false);
  });

  it("自定义 logDir 是同前缀兄弟目录 .harness-pi-backup → 不误命中、不告警", async () => {
    // 路径边界判定：.harness-pi-backup 以 '.harness-pi' 开头但不是 .harness-pi 的子路径，不应触发。
    const cwd = await gitRepo();
    const agent = createCodingAgent({
      cwd,
      model: createFakeModel([]),
      logDir: join(cwd, ".harness-pi-backup", "logs"),
    });
    expect(hasGitignoreWarn(agent.warnings)).toBe(false);
  });

  it("自定义 logDir 仍在 cwd/.harness-pi 下 + 未忽略 → 告警", async () => {
    const cwd = await gitRepo();
    const agent = createCodingAgent({
      cwd,
      model: createFakeModel([]),
      logDir: join(cwd, ".harness-pi", "custom-logs"),
    });
    expect(hasGitignoreWarn(agent.warnings)).toBe(true);
  });

  it("已忽略 .harness-pi 的 git repo → 默认不告警", async () => {
    const cwd = await gitRepo(".harness-pi/\n");
    const agent = createCodingAgent({ cwd, model: createFakeModel([]) });
    expect(hasGitignoreWarn(agent.warnings)).toBe(false);
  });

  it("非 git 仓库 → 不告警（无 git 泄漏面）", async () => {
    const cwd = await tmp();
    const agent = createCodingAgent({ cwd, model: createFakeModel([]) });
    expect(hasGitignoreWarn(agent.warnings)).toBe(false);
  });
});
