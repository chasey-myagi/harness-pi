import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeModel } from "@harness-pi/core/testing";
import { JsonlSessionStore } from "@harness-pi/adapters";
import { createCodingAgent, resumeCodingAgent, runAgentPrompt } from "../agent.js";

const dirs: string[] = [];
async function repo(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "hpi-resume-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function answer(text: string): ReturnType<typeof createFakeModel> {
  return createFakeModel([{ content: [{ type: "text", text }], stopReason: "stop" }]);
}

/** 一轮 toolCall + tool 结果 + 收尾文本——用来验 tool-result 消息形状能穿过 Jsonl 落盘/回放。 */
function lsThenAnswer(text: string): ReturnType<typeof createFakeModel> {
  return createFakeModel([
    { content: [{ type: "toolCall", name: "ls", arguments: {} }] },
    { content: [{ type: "text", text }], stopReason: "stop" },
  ]);
}

describe("createCodingAgent / resumeCodingAgent (JsonlSessionStore 崩溃续跑)", () => {
  it("给 persistence 时,一轮对话落盘到 <id> 命名的文件", async () => {
    const cwd = await repo();
    const file = join(cwd, "s1.jsonl");
    const fake = answer("first answer");
    const agent = createCodingAgent({
      cwd,
      model: fake,
      persistence: { store: new JsonlSessionStore(file), sessionId: "sess-1" },
    });
    expect(agent.session.id).toBe("sess-1");
    await runAgentPrompt(agent, "hello there");
    await agent.close();
    fake.teardown();
    expect(await exists(file)).toBe(true); // 落盘了
  });

  it("崩溃后用全新 store 从同一文件 resume:对话历史被完整重建", async () => {
    const cwd = await repo();
    const file = join(cwd, "s2.jsonl");
    const fake = answer("first answer");
    const a1 = createCodingAgent({
      cwd,
      model: fake,
      persistence: { store: new JsonlSessionStore(file), sessionId: "sess-2" },
    });
    await runAgentPrompt(a1, "remember the number 42");
    await a1.close();
    fake.teardown();

    // 模拟崩溃后新进程:全新 store 实例从同一文件回放 + resume。
    const fake2 = answer("second answer");
    const a2 = await resumeCodingAgent({
      cwd,
      model: fake2,
      persistence: { store: new JsonlSessionStore(file), sessionId: "sess-2" },
    });
    expect(a2.session.id).toBe("sess-2");
    const history = JSON.stringify(a2.session.snapshot().messages);
    expect(history).toContain("remember the number 42"); // 原 user prompt
    expect(history).toContain("first answer"); // 原 assistant 答案
    await a2.close();
    fake2.teardown();
  });

  it("resume 后能续跑:重建的历史确实喂进了续跑那一 turn 的 LLM 上下文", async () => {
    const cwd = await repo();
    const file = join(cwd, "s3.jsonl");
    const fake = answer("answer one");
    const a1 = createCodingAgent({
      cwd,
      model: fake,
      persistence: { store: new JsonlSessionStore(file), sessionId: "sess-3" },
    });
    await runAgentPrompt(a1, "turn one prompt");
    await a1.close();
    fake.teardown();

    const fake2 = answer("answer two");
    const a2 = await resumeCodingAgent({
      cwd,
      model: fake2,
      persistence: { store: new JsonlSessionStore(file), sessionId: "sess-3" },
    });
    await runAgentPrompt(a2, "turn two prompt");

    // 续跑那一 turn 的 LLM 调用真收到了 resume 重建的前缀(不只是躺在 _messages 里)。
    const sentToLlm = JSON.stringify(fake2.getCalls()[0]?.messages ?? []);
    expect(sentToLlm).toContain("turn one prompt"); // resume 来的前缀进了模型上下文
    expect(sentToLlm).toContain("answer one");
    expect(sentToLlm).toContain("turn two prompt"); // 本轮新 prompt

    const history = JSON.stringify(a2.session.snapshot().messages);
    expect(history).toContain("answer two"); // 本轮答案落进历史
    await a2.close();
    fake2.teardown();
  });

  it("tool-call turn 也能 resume:toolCall + tool 结果穿过 Jsonl 落盘/回放都活着", async () => {
    const cwd = await repo();
    const file = join(cwd, "s4.jsonl");
    const fake = lsThenAnswer("listed files");
    const a1 = createCodingAgent({
      cwd,
      model: fake,
      persistence: { store: new JsonlSessionStore(file), sessionId: "sess-4" },
    });
    await runAgentPrompt(a1, "list the files");
    await a1.close();
    fake.teardown();

    const fake2 = answer("ok");
    const a2 = await resumeCodingAgent({
      cwd,
      model: fake2,
      persistence: { store: new JsonlSessionStore(file), sessionId: "sess-4" },
    });
    const history = JSON.stringify(a2.session.snapshot().messages);
    expect(history).toContain("list the files"); // user prompt
    expect(history).toContain("ls"); // assistant 的 toolCall
    expect(history).toContain("toolResult"); // 工具结果消息形状（含 role: toolResult）
    await a2.close();
    fake2.teardown();
  });

  it("不给 persistence 时不落盘:之后无论用哪个 store 都 resume 不出历史", async () => {
    const cwd = await repo();
    const fake = answer("ok");
    const agent = createCodingAgent({ cwd, model: fake });
    await runAgentPrompt(agent, "no persistence");
    const ranId = agent.session.id;
    await agent.close();
    fake.teardown();

    // 行为断言:没给 store → 这个 id 在任何全新 store 里都回放出空历史(只有新 prompt 没旧的)。
    const fake2 = answer("ok2");
    const a2 = await resumeCodingAgent({
      cwd,
      model: fake2,
      persistence: {
        store: new JsonlSessionStore(join(cwd, "fresh.jsonl")),
        sessionId: ranId,
      },
    });
    expect(JSON.stringify(a2.session.snapshot().messages)).not.toContain(
      "no persistence",
    );
    await a2.close();
    fake2.teardown();
  });
});
