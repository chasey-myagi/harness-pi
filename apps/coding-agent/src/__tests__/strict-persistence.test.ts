import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySessionStore, type SessionEntry, type StoredEntry } from "@harness-pi/core";
import { createFakeModel } from "@harness-pi/core/testing";
import { createCodingAgent, resumeCodingAgent, runAgentPrompt } from "../agent.js";
import { renderRunReport } from "../output.js";

/**
 * #30：coding-agent 必须能把 core 的 strict persistence 接进来,并把 persistenceErrors 暴露出来。
 * 这些测试证明 `strictPersistence` 选项经 createCodingAgent / resumeCodingAgent 流到内核,
 * 且失败被如实暴露(而非「done 但 transcript 不全」静默吞掉)。
 */
class FailingStore extends MemorySessionStore {
  override async appendEntry(_sessionId: string, _entry: SessionEntry): Promise<StoredEntry> {
    throw new Error("disk on fire");
  }
}

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) await rm(d, { recursive: true, force: true });
  }
});
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "hpi-strict-"));
  dirs.push(d);
  return d;
}
const oneText = () => createFakeModel([{ content: [{ type: "text", text: "hi" }] }]);

describe("coding-agent strict persistence 接线 (#30)", () => {
  it("strictPersistence:true + 落盘失败 → reason 提级 error + persistenceErrors 暴露", async () => {
    const cwd = await tmp();
    const agent = createCodingAgent({
      cwd,
      model: oneText(),
      strictPersistence: true,
      persistence: { store: new FailingStore(), sessionId: "s1" },
    });
    const report = await runAgentPrompt(agent, "go");
    expect(report.summary.reason).toBe("error"); // strict 把「落盘不全的 done」提级
    expect(report.summary.persistenceErrors!.length).toBeGreaterThan(0);
    expect(report.summary.error!.message).toContain("strict persistence failed"); // 填的是 strict 失败原因
    expect(renderRunReport(report)).toContain("persistence errors"); // 报告里可见
  });

  it("默认(不传 strictPersistence)+ 落盘失败 → best-effort,reason 不变但 persistenceErrors 仍暴露", async () => {
    const cwd = await tmp();
    const agent = createCodingAgent({
      cwd,
      model: oneText(),
      persistence: { store: new FailingStore(), sessionId: "s1" },
    });
    const report = await runAgentPrompt(agent, "go");
    expect(report.summary.reason).toBe("done"); // best-effort 不劫持终态
    expect(report.summary.persistenceErrors!.length).toBeGreaterThan(0); // 但失败如实暴露
  });

  it("健康 store + strict → 不误伤(reason done,无 persistenceErrors)", async () => {
    const cwd = await tmp();
    const agent = createCodingAgent({
      cwd,
      model: oneText(),
      strictPersistence: true,
      persistence: { store: new MemorySessionStore(), sessionId: "s1" },
    });
    const report = await runAgentPrompt(agent, "go");
    expect(report.summary.reason).toBe("done");
    expect(report.summary.persistenceErrors).toBeUndefined();
  });

  it("resumeCodingAgent 也透传 strict(resume 是崩溃恢复路径,默认应 strict)", async () => {
    const cwd = await tmp();
    // 空历史 resume(store 无该 session)足以验证 strict 透传:续跑落盘失败 → reason error。
    const agent = await resumeCodingAgent({
      cwd,
      model: oneText(),
      strictPersistence: true,
      persistence: { store: new FailingStore(), sessionId: "s1" },
    });
    const report = await runAgentPrompt(agent, "go");
    expect(report.summary.reason).toBe("error");
    expect(report.summary.persistenceErrors!.length).toBeGreaterThan(0);
  });
});
