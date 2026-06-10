/**
 * O5 — 子 agent 生命周期 event（onSubagentStart / onSubagentEnd）。
 *
 * 全部经公共接口断言可观测行为：真**父** AgentSession（fake-model 脚本：调一次 subAgent 工具 → 收尾）
 * + 一个监听 onSubagentStart/End 的探针 hook 挂在父 session 上 + subAgentTool / routedSubAgentTool 造子。
 * 子 session 用独立 fake-model。父 loop 执行工具时把**父** ctx 传进 execute → 工具内 ctx.fireSubagent*
 * 把事件派回父 session 的探针 hook。
 *
 * 回归：不 spawn 子的 session 永不 fire；未挂探针 hook 时 subAgentTool 行为与 0.3.0 逐字节一致。
 */

import { describe, it, expect } from "vitest";
import { AgentSession, type Hook, type OnSubagentStartInput, type OnSubagentEndInput } from "@harness-pi/core";
import { createFakeModel } from "@harness-pi/core/testing";
import { subAgentTool, routedSubAgentTool } from "../controllers/index.js";

interface ProbeEvent {
  kind: "start" | "end";
  input: OnSubagentStartInput | OnSubagentEndInput;
}

/** 收集 onSubagentStart/End 的探针 hook（保留 fire 顺序）。 */
function makeProbe(): { hook: Hook; events: ProbeEvent[] } {
  const events: ProbeEvent[] = [];
  return {
    events,
    hook: {
      name: "subagent-probe",
      onSubagentStart(input) {
        events.push({ kind: "start", input });
      },
      onSubagentEnd(input) {
        events.push({ kind: "end", input });
      },
    },
  };
}

describe("subAgent lifecycle events (O5)", () => {
  it("fires onSubagentStart before the sub runs and onSubagentEnd after, with correct fields", async () => {
    const probe = makeProbe();
    // 子 fake：单轮返回 "child-answer"，1 turn done。
    const subFake = createFakeModel([
      { content: [{ type: "text", text: "child-answer" }], stopReason: "stop", usage: { input: 5, output: 7 } },
    ]);
    let subId = "";
    // sessionFactory 在 spawn 时被调；记下子 id 以核对事件里的 agentId。
    const tool = subAgentTool({
      sessionFactory: () => {
        const s = new AgentSession({ model: subFake, tools: [] });
        subId = s.id;
        return s;
      },
    });
    // 父 fake：调一次 subAgent 工具 → 收尾。
    const parentFake = createFakeModel([
      { content: [{ type: "toolCall", name: "subAgent", arguments: { task: "delegate this" } }] },
      { content: [{ type: "text", text: "parent done" }], stopReason: "stop" },
    ]);
    const parent = new AgentSession({ model: parentFake, tools: [tool], hooks: [probe.hook] });
    await parent.run("go");

    // 两个事件都 fire，start 先于 end。
    expect(probe.events.map((e) => e.kind)).toEqual(["start", "end"]);

    const start = probe.events[0]!.input as OnSubagentStartInput;
    expect(start.agentId).toBe(subId);
    expect(start.task).toBe("delegate this");
    expect(start.depth).toBe(1); // 顶层(0) → 子(1)

    const end = probe.events[1]!.input as OnSubagentEndInput;
    expect(end.agentId).toBe(subId);
    expect(end.task).toBe("delegate this");
    expect(end.depth).toBe(1);
    expect(end.reason).toBe("done");
    expect(end.turns).toBe(1);
    expect(end.usage.input).toBe(5);
    expect(end.usage.output).toBe(7);
    expect(end.summaryText).toBe("child-answer");

    parentFake.teardown();
    subFake.teardown();
  });

  it("fires onSubagentStart strictly before the sub session has run", async () => {
    // 用一个会在 sub.run 期间观测「start 是否已 fire」的子 hook：子的 onSessionStart 跑时，父的 start 必已 fire。
    const probe = makeProbe();
    let startFiredWhenSubStarted = false;
    const subFake = createFakeModel([
      { content: [{ type: "text", text: "x" }], stopReason: "stop" },
    ]);
    const tool = subAgentTool({
      sessionFactory: () => {
        const s = new AgentSession({ model: subFake, tools: [] });
        s.use({
          name: "observe-start-order",
          onSessionStart() {
            // 子 session 一启动，父的 onSubagentStart 必已 fire（fireSubagentStart 在 sub.run 之前 await）。
            startFiredWhenSubStarted = probe.events.some((e) => e.kind === "start");
          },
        });
        return s;
      },
    });
    const parentFake = createFakeModel([
      { content: [{ type: "toolCall", name: "subAgent", arguments: { task: "t" } }] },
      { content: [{ type: "text", text: "done" }], stopReason: "stop" },
    ]);
    const parent = new AgentSession({ model: parentFake, tools: [tool], hooks: [probe.hook] });
    await parent.run("go");
    expect(startFiredWhenSubStarted).toBe(true);
    parentFake.teardown();
    subFake.teardown();
  });

  it("routedSubAgentTool fires the same lifecycle events", async () => {
    const probe = makeProbe();
    const subFake = createFakeModel([
      { content: [{ type: "text", text: "routed-answer" }], stopReason: "stop" },
    ]);
    let subId = "";
    const tool = routedSubAgentTool({
      specs: [
        {
          type: "worker",
          whenToUse: "for any work",
          sessionFactory: () => {
            const s = new AgentSession({ model: subFake, tools: [] });
            subId = s.id;
            return s;
          },
        },
      ],
    });
    const parentFake = createFakeModel([
      { content: [{ type: "toolCall", name: "subAgent", arguments: { agent_type: "worker", task: "routed task" } }] },
      { content: [{ type: "text", text: "parent done" }], stopReason: "stop" },
    ]);
    const parent = new AgentSession({ model: parentFake, tools: [tool], hooks: [probe.hook] });
    await parent.run("go");

    expect(probe.events.map((e) => e.kind)).toEqual(["start", "end"]);
    const start = probe.events[0]!.input as OnSubagentStartInput;
    expect(start.agentId).toBe(subId);
    expect(start.task).toBe("routed task");
    expect(start.depth).toBe(1);
    const end = probe.events[1]!.input as OnSubagentEndInput;
    expect(end.agentId).toBe(subId);
    expect(end.summaryText).toBe("routed-answer");

    parentFake.teardown();
    subFake.teardown();
  });

  it("observe-only end-to-end: a throwing onSubagent hook breaks neither the parent run nor sibling hooks", async () => {
    // 端到端背书核心主张「现有 plugin 在父 session 上统一观测子生命周期」：一个在 onSubagentStart/End 里
    // throw 的 hook 不该中断父 run、不该挡住同批其它 hook、不该丢子结果（fireEvent 并行 observe + fail-open）。
    const probe = makeProbe();
    const thrower: Hook = {
      name: "thrower",
      onSubagentStart() {
        throw new Error("boom-start");
      },
      onSubagentEnd() {
        throw new Error("boom-end");
      },
    };
    const subFake = createFakeModel([
      { content: [{ type: "text", text: "child" }], stopReason: "stop" },
    ]);
    const tool = subAgentTool({
      sessionFactory: () => new AgentSession({ model: subFake, tools: [] }),
    });
    const parentFake = createFakeModel([
      { content: [{ type: "toolCall", name: "subAgent", arguments: { task: "t" } }] },
      { content: [{ type: "text", text: "parent done" }], stopReason: "stop" },
    ]);
    // thrower 排在 probe 之前 → 它 throw 不该挡住 probe 收事件。
    const parent = new AgentSession({ model: parentFake, tools: [tool], hooks: [thrower, probe.hook] });
    const summary = await parent.run("go"); // 不抛
    expect(summary.reason).toBe("done"); // 父正常收尾
    expect(probe.events.map((e) => e.kind)).toEqual(["start", "end"]); // sibling 仍收到两事件
    // 子结果仍正常回灌父。
    const tr = parent.messages.find((m) => m.role === "toolResult") as { content: unknown } | undefined;
    const text = Array.isArray(tr!.content)
      ? tr!.content.map((b) => ("text" in b ? (b as { text: string }).text : "")).join("")
      : "";
    expect(text).toBe("child");
    parentFake.teardown();
    subFake.teardown();
  });

  it("transports a non-done reason (max_turns) faithfully to onSubagentEnd", async () => {
    // reason 是 summary.reason 直透；非 done 分支也得如实传到父 hook。让子撞 maxTurns=1 → reason=max_turns。
    const probe = makeProbe();
    const noopTool = {
      name: "noop",
      description: "noop",
      parameters: { type: "object", properties: {} } as never,
      execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
    };
    // 子每轮都发 toolCall（想继续），maxTurns=1 → 子以 max_turns 收尾。
    const subFake = createFakeModel([
      { content: [{ type: "toolCall", name: "noop", arguments: {} }], stopReason: "toolUse" },
      { content: [{ type: "toolCall", name: "noop", arguments: {} }], stopReason: "toolUse" },
    ]);
    const tool = subAgentTool({
      sessionFactory: () => new AgentSession({ model: subFake, tools: [noopTool as never], maxTurns: 1 }),
    });
    const parentFake = createFakeModel([
      { content: [{ type: "toolCall", name: "subAgent", arguments: { task: "t" } }] },
      { content: [{ type: "text", text: "done" }], stopReason: "stop" },
    ]);
    const parent = new AgentSession({ model: parentFake, tools: [tool], hooks: [probe.hook] });
    await parent.run("go");

    expect(probe.events.map((e) => e.kind)).toEqual(["start", "end"]); // start 仍先于 end
    const end = probe.events[1]!.input as OnSubagentEndInput;
    expect(end.reason).toBe("max_turns"); // 非 done reason 如实直透
    parentFake.teardown();
    subFake.teardown();
  });

  it("regression: a session that never spawns a sub fires neither event", async () => {
    const probe = makeProbe();
    // 父只回一句话收尾，从不调 subAgent。
    const parentFake = createFakeModel([
      { content: [{ type: "text", text: "no delegation" }], stopReason: "stop" },
    ]);
    const tool = subAgentTool({
      sessionFactory: () => new AgentSession({ model: createFakeModel([]), tools: [] }),
    });
    const parent = new AgentSession({ model: parentFake, tools: [tool], hooks: [probe.hook] });
    await parent.run("go");
    expect(probe.events).toEqual([]);
    parentFake.teardown();
  });

  it("regression: without a probe hook, subAgentTool behaves byte-for-byte as 0.3.0", async () => {
    // 没挂任何 onSubagentStart/End hook → fire* 走 no-op 路径，工具结果 shape 不变。
    const subFake = createFakeModel([
      { content: [{ type: "text", text: "child" }], stopReason: "stop", usage: { input: 1, output: 2 } },
    ]);
    const tool = subAgentTool({
      sessionFactory: () => new AgentSession({ model: subFake, tools: [] }),
    });
    const parentFake = createFakeModel([
      { content: [{ type: "toolCall", name: "subAgent", arguments: { task: "t" } }] },
      { content: [{ type: "text", text: "done" }], stopReason: "stop" },
    ]);
    const parent = new AgentSession({ model: parentFake, tools: [tool] }); // 无 hooks
    await parent.run("go");
    const tr = parent.messages.find((m) => m.role === "toolResult") as
      | { content: unknown; details?: unknown }
      | undefined;
    expect(tr).toBeDefined();
    const text = Array.isArray(tr!.content)
      ? tr!.content.map((b) => ("text" in b ? (b as { text: string }).text : "")).join("")
      : "";
    expect(text).toBe("child"); // 回灌父模型的文本 = 子最后一条 assistant
    const details = tr!.details as { subAgent?: { reason?: string; turns?: number } };
    expect(details.subAgent?.reason).toBe("done");
    expect(details.subAgent?.turns).toBe(1);
    parentFake.teardown();
    subFake.teardown();
  });
});
