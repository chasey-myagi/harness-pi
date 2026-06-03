import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeModel } from "@harness-pi/core/testing";
import { redactCodingToolArgs } from "../log-redaction.js";
import { createCodingAgent, runAgentPrompt } from "../agent.js";

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

  it("空字符串 content → 0 chars（零值边界）", () => {
    expect(redactCodingToolArgs("write", { path: "a", content: "" })).toEqual({
      path: "a",
      content: "[redacted content, 0 chars]",
    });
    expect(redactCodingToolArgs("edit", { path: "a", oldText: "", newText: "x" })).toEqual({
      path: "a",
      oldText: "[redacted text, 0 chars]",
      newText: "[redacted text, 1 chars]",
    });
  });

  it("非字符串高危字段也脱敏（堵住对象/数组内容泄漏，不靠 schema 校验）", () => {
    // 模型发来错误类型的 content：若只对 string 脱敏，对象内容会原文落盘——必须照样脱敏。
    expect(
      redactCodingToolArgs("write", { path: "a", content: { secret: "leak" } }),
    ).toEqual({ path: "a", content: "[redacted content]" });
    expect(
      redactCodingToolArgs("bash", { command: ["echo", "$TOKEN"] }),
    ).toEqual({ command: "[redacted command]" });
  });

  it("edit 只给单边 → 只脱敏存在的字段，不引入 undefined", () => {
    const onlyOld = redactCodingToolArgs("edit", { path: "a", oldText: "abc" });
    expect(onlyOld).toEqual({ path: "a", oldText: "[redacted text, 3 chars]" });
    expect("newText" in (onlyOld as object)).toBe(false); // 不凭空加 newText

    const onlyNew = redactCodingToolArgs("edit", { path: "a", newText: "abcd" });
    expect(onlyNew).toEqual({ path: "a", newText: "[redacted text, 4 chars]" });
    expect("oldText" in (onlyNew as object)).toBe(false);
  });

  it("长度按 .length（UTF-16 code unit）计：emoji/中文是 surrogate/多码元", () => {
    // 🔑 是 UTF-16 代理对 → .length === 2；中文每字 1 个码元。钉住语义，避免误以为是字节/字符数。
    expect(redactCodingToolArgs("write", { content: "🔑" })).toEqual({
      content: "[redacted content, 2 chars]",
    });
    expect(redactCodingToolArgs("write", { content: "你好" })).toEqual({
      content: "[redacted content, 2 chars]",
    });
  });

  it("数组 args 原样返回（不被浅拷成丢失数组性的对象）", () => {
    const arr = ["a", "b"];
    expect(redactCodingToolArgs("write", arr)).toBe(arr); // 同一引用、仍是数组
  });

  it("工具名精确匹配（大小写敏感）——真实第一方工具名均小写", () => {
    // 'Write'（大写）不是已注册工具名，故不脱敏、原样透传。真实工具名是小写 write/edit/bash。
    expect(redactCodingToolArgs("Write", { content: "x" })).toEqual({ content: "x" });
  });

  it("无副作用：不原地 mutate 传入的 args", () => {
    const input = { path: "a", content: "secret" };
    const out = redactCodingToolArgs("write", input);
    expect(input.content).toBe("secret"); // 原对象未被改
    expect(out).not.toBe(input); // 返回的是副本
    expect((out as { content: string }).content).toBe("[redacted content, 6 chars]");
  });
});

/* ─────────── 端到端：createCodingAgent 各 logArgs/log 分支真正落盘行为 ─────────── */

describe("coding-agent session-log 脱敏（端到端，走真 redactCodingToolArgs）", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    while (dirs.length) {
      const d = dirs.pop();
      if (d) await rm(d, { recursive: true, force: true });
    }
  });
  async function tempRepo(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), "harness-pi-logredact-"));
    dirs.push(d);
    return d;
  }

  const SECRET = "SUPER-SECRET-PAYLOAD-9f3a-do-not-leak";
  // 一次 write（写入 secret 内容）+ 一句收尾文本。write 真执行（落到临时 cwd），与日志无关。
  const makeFake = () =>
    createFakeModel([
      { content: [{ type: "toolCall", name: "write", arguments: { path: "out.txt", content: SECRET } }] },
      { content: [{ type: "text", text: "done" }] },
    ]);
  const findPre = (log: string, tool: string): { args: unknown } =>
    log
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .find((e) => e.event === "preToolUse" && e.tool === tool);
  // session log 是异步 WriteStream，onSessionEnd 里 end() 后给一拍让数据落盘。
  const settle = () => new Promise((r) => setTimeout(r, 50));

  it("默认（不传 logArgs）：write.content 在 .ndjson 被脱敏，原文不落盘", async () => {
    const cwd = await tempRepo();
    const report = await runAgentPrompt(createCodingAgent({ cwd, model: makeFake() }), "go");
    await settle();
    const log = readFileSync(report.logPath, "utf-8");
    expect(log).not.toContain(SECRET); // 核心安全契约：默认就不落原文
    expect((findPre(log, "write").args as { content: string }).content).toMatch(
      /^\[redacted content, \d+ chars\]$/,
    );
  });

  it('logArgs="none"：args 记为 [args omitted]，原文不落盘', async () => {
    const cwd = await tempRepo();
    const report = await runAgentPrompt(
      createCodingAgent({ cwd, model: makeFake(), logArgs: "none" }),
      "go",
    );
    await settle();
    const log = readFileSync(report.logPath, "utf-8");
    expect(log).not.toContain(SECRET);
    expect(findPre(log, "write").args).toBe("[args omitted]");
  });

  it('logArgs="full"：原始 args 原样落盘（显式 opt-in，与默认成对照）', async () => {
    const cwd = await tempRepo();
    const report = await runAgentPrompt(
      createCodingAgent({ cwd, model: makeFake(), logArgs: "full" }),
      "go",
    );
    await settle();
    const log = readFileSync(report.logPath, "utf-8");
    expect(log).toContain(SECRET); // full 模式确实记原文
    expect(findPre(log, "write").args).toEqual({ path: "out.txt", content: SECRET });
  });

  it("log:false：sessionLog 完全不挂，不产生任何 .ndjson 文件", async () => {
    const cwd = await tempRepo();
    const report = await runAgentPrompt(
      createCodingAgent({ cwd, model: makeFake(), log: false }),
      "go",
    );
    await settle();
    expect(existsSync(report.logPath)).toBe(false); // --no-log 的核心契约：根本不落盘
  });
});
