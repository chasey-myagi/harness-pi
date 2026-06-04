/**
 * around hook（wrapTurn / wrapToolExec）超时语义（docs/09 §3.7 杂项「around-hook 超时」的结论）。
 *
 * around hook 包裹 next()——next() 就是整个 turn / 单次 tool exec，时长合法可变，故内核**故意不**给它们
 * 套 per-hook timeout（不像 event/decision/pipe）。要「太久了就停」，用协作式 ctx.abort（watchdog 插件就是
 * 一个 setTimeout 后 ctx.abort 的 wrapTurn）——signal 会穿进 LLM stream + tool.execute 让它们尽快停。
 *
 * 这两条测试钉死该设计：声明了极短 `timeout` 的 around hook **不会**被超时打断（跑到完），防止有人日后
 * 「顺手给 around hook 加 timeout」破坏合法长任务。
 */

import { describe, it, expect } from "vitest";
import { AgentSession } from "../session.js";
import { createFakeModel } from "../testing.js";
import { Type } from "@earendil-works/pi-ai";
import type { Hook } from "../hook.js";
import type { HarnessTool } from "../types.js";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("around-hook timeout semantics", () => {
  it("wrapTurn ignores the per-hook timeout field (runs to completion, bounded only by ctx.abort)", async () => {
    let completed = false;
    const slowWrap: Hook = {
      name: "slow-wrap",
      timeout: 10, // 显式极短 timeout —— 若 around hook 受 timeout 约束，50ms 的 wrap 会被杀
      async wrapTurn(_ctx, next) {
        await delay(50);
        await next();
        completed = true;
      },
    };
    const fake = createFakeModel([
      { content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ]);
    const session = new AgentSession({ model: fake, tools: [], hooks: [slowWrap] });
    const summary = await session.run("hi");

    expect(summary.reason).toBe("done"); // timeout:10 没杀它
    expect(completed).toBe(true); // around hook 跑到完，不受 per-hook timeout 约束
    fake.teardown();
  });

  it("wrapToolExec ignores the per-hook timeout field too", async () => {
    let wrapped = false;
    const tool: HarnessTool = {
      name: "echo",
      description: "echo",
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text", text: "r" }] };
      },
    };
    const slowToolWrap: Hook = {
      name: "slow-tool-wrap",
      timeout: 10,
      async wrapToolExec(_call, _ctx, next) {
        await delay(50);
        const r = await next();
        wrapped = true;
        return r;
      },
    };
    const fake = createFakeModel([
      { content: [{ type: "toolCall", name: "echo", arguments: {} }] },
      { content: [{ type: "text", text: "done" }], stopReason: "stop" },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [tool],
      hooks: [slowToolWrap],
    });
    const summary = await session.run("go");

    expect(summary.reason).toBe("done");
    expect(wrapped).toBe(true); // wrapToolExec 也跑到完，不被 timeout 打断
    fake.teardown();
  });

  it("a wrapTurn bounds the turn cooperatively via ctx.abort (the correct mechanism)", async () => {
    // 一个 tool 会跑很久；wrapTurn 在 next() 前挂个定时器，到点 ctx.abort——即 watchdog 的内核级形态。
    const slowTool: HarnessTool = {
      name: "slow",
      description: "slow",
      parameters: Type.Object({}),
      async execute(_args, _ctx, signal) {
        // 尊重 signal：被 abort 时尽快停（协作式取消）。
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 1000);
          signal.addEventListener("abort", () => {
            clearTimeout(t);
            resolve();
          });
        });
        return { content: [{ type: "text", text: "late" }] };
      },
    };
    const boundWrap: Hook = {
      name: "bound-wrap",
      async wrapTurn(ctx, next) {
        const t = setTimeout(() => ctx.abort("wrap:turn-too-long"), 20);
        try {
          await next();
        } finally {
          clearTimeout(t);
        }
      },
    };
    const fake = createFakeModel([
      { content: [{ type: "toolCall", name: "slow", arguments: {} }] },
      { content: [{ type: "text", text: "done" }], stopReason: "stop" },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [slowTool],
      hooks: [boundWrap],
    });
    const summary = await session.run("go");

    expect(summary.reason).toBe("aborted");
    expect(summary.abortReason).toBe("wrap:turn-too-long");
    fake.teardown();
  });
});
