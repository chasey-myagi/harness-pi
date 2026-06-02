import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeModel } from "@harness-pi/core/testing";
import { createCodingAgent, runAgentPrompt } from "../agent.js";

const dirs: string[] = [];
async function repo(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "hpi-perm-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function fileExists(p: string): Promise<boolean> {
  try {
    await readFile(p);
    return true;
  } catch {
    return false;
  }
}

function bashThenDone(command: string): ReturnType<typeof createFakeModel> {
  return createFakeModel([
    { content: [{ type: "toolCall", name: "bash", arguments: { command } }] },
    { content: [{ type: "text", text: "done" }], stopReason: "stop" },
  ]);
}

describe("createCodingAgent permission gate (real permissionGate + real bash tool)", () => {
  it("DENY: a mutating bash call is blocked — the side effect never happens", async () => {
    const cwd = await repo();
    const fake = bashThenDone("echo hi > marker.txt");
    const agent = createCodingAgent({ cwd, model: fake, permission: {} });
    agent.setApprovalHandler(async () => false); // deny
    await runAgentPrompt(agent, "make a marker");
    expect(await fileExists(join(cwd, "marker.txt"))).toBe(false); // 被拦：文件没建
    await agent.close();
    fake.teardown();
  });

  it("ALLOW: approval handler returns true → the bash call runs and the side effect happens", async () => {
    const cwd = await repo();
    const fake = bashThenDone("echo hi > marker.txt");
    const agent = createCodingAgent({ cwd, model: fake, permission: {} });
    agent.setApprovalHandler(async () => true); // allow once
    await runAgentPrompt(agent, "make a marker");
    expect(await fileExists(join(cwd, "marker.txt"))).toBe(true); // 放行：文件建了
    await agent.close();
    fake.teardown();
  });

  it("without setApprovalHandler set, the holder defaults to deny (mutating tool blocked)", async () => {
    const cwd = await repo();
    const fake = bashThenDone("echo hi > nohandler.txt");
    const agent = createCodingAgent({ cwd, model: fake, permission: {} });
    // 故意不调 setApprovalHandler —— holder 默认 async()=>false（安全 deny）。
    await runAgentPrompt(agent, "make it");
    expect(await fileExists(join(cwd, "nohandler.txt"))).toBe(false);
    await agent.close();
    fake.teardown();
  });

  it("read tools (ls) are allowed without consulting the approval handler", async () => {
    const cwd = await repo();
    const fake = createFakeModel([
      { content: [{ type: "toolCall", name: "ls", arguments: {} }] },
      { content: [{ type: "text", text: "done" }], stopReason: "stop" },
    ]);
    const agent = createCodingAgent({ cwd, model: fake, permission: {} });
    let asked = false;
    agent.setApprovalHandler(async () => {
      asked = true;
      return false;
    });
    await runAgentPrompt(agent, "list");
    expect(asked).toBe(false); // ls = allow 规则，不问人
    await agent.close();
    fake.teardown();
  });

  it("without permission option (yolo): a bash call runs even with a deny handler set (no gate)", async () => {
    const cwd = await repo();
    const fake = bashThenDone("echo hi > yolo.txt");
    const agent = createCodingAgent({ cwd, model: fake }); // 无 permission → 无门
    agent.setApprovalHandler(async () => false); // 设了也没用（没挂 gate）
    await runAgentPrompt(agent, "make it");
    expect(await fileExists(join(cwd, "yolo.txt"))).toBe(true);
    await agent.close();
    fake.teardown();
  });
});
