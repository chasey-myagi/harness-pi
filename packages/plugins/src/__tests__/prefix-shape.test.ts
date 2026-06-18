/**
 * prefix-shape 单测：纯函数（hash 稳定性 + 变更分类）+ 插件行为（createTestContext 直调 hook）
 * + 真管线冒烟（AgentSession + createFakeModel，证实装配顺序下 active tools 引用稳定 → hash 稳定）。
 */

import { describe, it, expect } from "vitest";
import {
  AgentSession,
  Type,
  type HarnessTool,
  type Hook,
  type HookContext,
  type Tool,
} from "@harness-pi/core";
import { createFakeModel, createTestContext } from "@harness-pi/core/testing";
import {
  prefixShape,
  getPrefixShapeState,
  computeDurablePrefix,
  classifyPrefixChange,
  stableHash,
  type PrefixChangeReason,
  type PrefixShapeDiagnostic,
  type CacheReconcileInfo,
} from "../prefix-shape.js";

/** 裸 Tool（name/description/parameters）——纯函数 / createTestContext 用。parameters 当普通数据处理。 */
function tool(name: string, parameters: unknown): Tool {
  return { name, description: `${name} tool`, parameters } as Tool;
}

/** 可执行 HarnessTool ——AgentSession 冒烟用。 */
function trivialTool(name: string): HarnessTool {
  return {
    name,
    description: `${name} tool`,
    parameters: Type.Object({}),
    isConcurrencySafe: () => true,
    async execute() {
      return { content: [{ type: "text", text: `${name} ran` }] };
    },
  };
}

const M = { id: "m", provider: "p" };

describe("prefix-shape 纯函数", () => {
  it("stableHash：键序无关、数组顺序敏感", () => {
    expect(stableHash({ a: 1, b: 2 })).toBe(stableHash({ b: 2, a: 1 }));
    expect(stableHash([1, 2])).not.toBe(stableHash([2, 1]));
  });

  it("tool schema 内 required/enum 数组乱序 → 同 hash（canonicalize 只排这俩 key）", () => {
    const a = tool("x", { type: "object", required: ["a", "b"], properties: {} });
    const b = tool("x", { type: "object", required: ["b", "a"], properties: {} });
    const ha = computeDurablePrefix({ model: M, systemPrompt: "", activeTools: [a] });
    const hb = computeDurablePrefix({ model: M, systemPrompt: "", activeTools: [b] });
    expect(ha.toolSchemaHash).toBe(hb.toolSchemaHash);
  });

  it("tool 线上顺序敏感：重排两个工具 → toolSchemaHash 变（如实反映前缀被破坏）", () => {
    const a = tool("a", { type: "object" });
    const b = tool("b", { type: "object" });
    const ab = computeDurablePrefix({ model: M, systemPrompt: "", activeTools: [a, b] });
    const ba = computeDurablePrefix({ model: M, systemPrompt: "", activeTools: [b, a] });
    expect(ab.toolSchemaHash).not.toBe(ba.toolSchemaHash);
  });

  it("classifyPrefixChange：各分支 + 优先级 model>system>tools>providerOptions", () => {
    const tA = tool("A", { type: "object" });
    const tB = tool("B", { type: "object" });
    const base = computeDurablePrefix({ model: M, systemPrompt: "s", activeTools: [tA] });

    expect(classifyPrefixChange(base, undefined)).toBe("first_turn");
    expect(classifyPrefixChange(base, base)).toBe("stable");

    const sys = computeDurablePrefix({ model: M, systemPrompt: "s2", activeTools: [tA] });
    expect(classifyPrefixChange(sys, base)).toBe("system_prompt_changed");

    const mdl = computeDurablePrefix({ model: { id: "m2", provider: "p" }, systemPrompt: "s", activeTools: [tA] });
    expect(classifyPrefixChange(mdl, base)).toBe("model_or_provider_changed");

    const tls = computeDurablePrefix({ model: M, systemPrompt: "s", activeTools: [tA, tB] });
    expect(classifyPrefixChange(tls, base)).toBe("tool_schema_changed");

    const poBase = computeDurablePrefix({ model: M, systemPrompt: "s", activeTools: [tA], providerOptions: { temperature: 0.1 } });
    const poNew = computeDurablePrefix({ model: M, systemPrompt: "s", activeTools: [tA], providerOptions: { temperature: 0.9 } });
    expect(classifyPrefixChange(poNew, poBase)).toBe("provider_options_changed");

    // 全变 → model 优先胜出
    const all = computeDurablePrefix({ model: { id: "m2", provider: "p" }, systemPrompt: "s2", activeTools: [tA, tB] });
    expect(classifyPrefixChange(all, base)).toBe("model_or_provider_changed");
  });

  it("providerOptions 缺省 → 跨 turn stable（默认盲区，不误报 provider_options_changed）", () => {
    const tA = tool("A", { type: "object" });
    const a = computeDurablePrefix({ model: M, systemPrompt: "s", activeTools: [tA] });
    const b = computeDurablePrefix({ model: M, systemPrompt: "s", activeTools: [tA] });
    expect(classifyPrefixChange(b, a)).toBe("stable");
  });

  it("空 tools 数组：跨 turn stable；[]→[x] 判 tool_schema_changed（空集是合法 prior，非 first_turn）", () => {
    const e1 = computeDurablePrefix({ model: M, systemPrompt: "s", activeTools: [] });
    const e2 = computeDurablePrefix({ model: M, systemPrompt: "s", activeTools: [] });
    expect(classifyPrefixChange(e2, e1)).toBe("stable");
    const withTool = computeDurablePrefix({ model: M, systemPrompt: "s", activeTools: [tool("x", { type: "object" })] });
    expect(classifyPrefixChange(withTool, e1)).toBe("tool_schema_changed");
  });

  it("canonicalize 只排 required/enum：其他数组字段（examples）乱序 → hash 变（钉死 shouldSortArray 边界）", () => {
    const a = tool("x", { type: "object", properties: { tags: { type: "array", examples: ["p", "q"] } } });
    const b = tool("x", { type: "object", properties: { tags: { type: "array", examples: ["q", "p"] } } });
    const ha = computeDurablePrefix({ model: M, systemPrompt: "", activeTools: [a] });
    const hb = computeDurablePrefix({ model: M, systemPrompt: "", activeTools: [b] });
    expect(ha.toolSchemaHash).not.toBe(hb.toolSchemaHash);
  });

  it("回归哨兵：TypeBox schema 无 symbol key（toolShapeForDiagnostics 直传 parameters 的确定性前提；上游换 TypeBox 即红）", () => {
    expect(Object.getOwnPropertySymbols(Type.Object({ a: Type.String() }))).toHaveLength(0);
  });
});

describe("prefixShape 插件行为（createTestContext 直调）", () => {
  it("首 turn → first_turn，passthrough 返回 void（不改写 tools）", () => {
    const h = createTestContext({ captureLog: true });
    const ret = prefixShape().transformToolsBeforeLlm!([tool("read", {})], h.ctx);
    expect(ret).toBeUndefined();
    expect(getPrefixShapeState(h.ctx)?.changeReason).toBe("first_turn");
    expect(h.logs).toHaveLength(0); // first_turn 不 log
  });

  it("同 tools 跨 turn → stable，不 log、不触发 onPrefixChange", () => {
    const changes: PrefixShapeDiagnostic[] = [];
    const h = createTestContext({ captureLog: true });
    const hook = prefixShape({ onPrefixChange: (_c, d) => changes.push(d) });
    const tools = [tool("read", {}), tool("bash", {})];
    hook.transformToolsBeforeLlm!(tools, h.ctx); // first_turn
    h.setTurnIdx(1);
    hook.transformToolsBeforeLlm!(tools, h.ctx); // stable
    expect(getPrefixShapeState(h.ctx)?.changeReason).toBe("stable");
    expect(changes).toHaveLength(0);
    expect(h.logs).toHaveLength(0);
  });

  it("少一个 tool → tool_schema_changed，log 一行 + onPrefixChange（toolCount 正确）", () => {
    const changes: PrefixShapeDiagnostic[] = [];
    const h = createTestContext({ captureLog: true });
    const hook = prefixShape({ onPrefixChange: (_c, d) => changes.push(d) });
    hook.transformToolsBeforeLlm!([tool("read", {}), tool("bash", {})], h.ctx); // first_turn, count 2
    h.setTurnIdx(1);
    hook.transformToolsBeforeLlm!([tool("read", {})], h.ctx); // tool_schema_changed, count 1
    expect(getPrefixShapeState(h.ctx)?.changeReason).toBe("tool_schema_changed");
    expect(changes).toHaveLength(1);
    expect(changes[0]!.toolCount).toBe(1);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]!.level).toBe("info");
    expect(h.logs[0]!.fields.reason).toBe("tool_schema_changed");
  });

  it("log:false → 不 log，但 onPrefixChange 仍触发", () => {
    const changes: PrefixShapeDiagnostic[] = [];
    const h = createTestContext({ captureLog: true });
    const hook = prefixShape({ log: false, onPrefixChange: (_c, d) => changes.push(d) });
    hook.transformToolsBeforeLlm!([tool("read", {})], h.ctx);
    h.setTurnIdx(1);
    hook.transformToolsBeforeLlm!([tool("read", {}), tool("bash", {})], h.ctx);
    expect(getPrefixShapeState(h.ctx)?.changeReason).toBe("tool_schema_changed");
    expect(changes).toHaveLength(1);
    expect(h.logs).toHaveLength(0);
  });

  it("providerOptions opt-in：跨 turn 改值 → provider_options_changed", () => {
    let temp = 0.1;
    const h = createTestContext({ captureLog: true });
    const hook = prefixShape({ providerOptions: () => ({ temperature: temp }) });
    const tools = [tool("read", {})];
    hook.transformToolsBeforeLlm!(tools, h.ctx); // first_turn
    h.setTurnIdx(1);
    temp = 0.9;
    hook.transformToolsBeforeLlm!(tools, h.ctx); // provider_options_changed
    expect(getPrefixShapeState(h.ctx)?.changeReason).toBe("provider_options_changed");
  });

  it("state 跨 context 隔离：h1 跑过后 h2 仍 undefined（诊断不串味）", () => {
    const h1 = createTestContext();
    const h2 = createTestContext();
    prefixShape().transformToolsBeforeLlm!([tool("a", {})], h1.ctx);
    expect(getPrefixShapeState(h1.ctx)?.changeReason).toBe("first_turn");
    expect(getPrefixShapeState(h2.ctx)).toBeUndefined();
  });
});

describe("prefixShape onLlmEnd 对账 + 真管线", () => {
  it("用真实 usage.cacheRead 做预测 vs 实测对账", async () => {
    const recon: CacheReconcileInfo[] = [];
    const fake = createFakeModel([
      {
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
        usage: { input: 100, output: 10, cached: 900 },
      },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [trivialTool("read")],
      hooks: [prefixShape({ onCacheReconcile: (_c, info) => recon.push(info) })],
    });
    await session.run("go");
    expect(recon).toHaveLength(1);
    expect(recon[0]!.cacheReadTokens).toBe(900);
    expect(recon[0]!.inputTokens).toBe(100);
    expect(recon[0]!.cacheHitRatio).toBeCloseTo(0.9);
    expect(recon[0]!.changeReason).toBe("first_turn");
    fake.teardown();
  });

  it("无 onCacheReconcile → onLlmEnd 早退、run 正常收尾（不抛）", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "done" }], stopReason: "stop" },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [trivialTool("read")],
      hooks: [prefixShape()],
    });
    const summary = await session.run("go");
    expect(summary.reason).toBe("done");
    fake.teardown();
  });

  it("真装配管线：两 turn 同 tools → turn-2 stable（active 引用稳定 → hash 稳定）", async () => {
    const reasons: PrefixChangeReason[] = [];
    const probe: Hook = {
      name: "probe",
      onLlmEnd(_input, ctx: HookContext) {
        const d = getPrefixShapeState(ctx);
        if (d) reasons.push(d.changeReason);
      },
    };
    const fake = createFakeModel([
      { content: [{ type: "toolCall", name: "read", arguments: {} }], stopReason: "toolUse" },
      { content: [{ type: "text", text: "done" }], stopReason: "stop" },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [trivialTool("read")],
      hooks: [prefixShape(), probe],
    });
    await session.run("go");
    expect(reasons).toEqual(["first_turn", "stable"]);
    fake.teardown();
  });

  it("多-turn reconcile：changeReason 随 turn 推进而变（证 onLlmEnd 读的是当前 turn 诊断）", async () => {
    const recon: CacheReconcileInfo[] = [];
    // turn-2 砍掉一个 tool（active listing 变）→ prefixShape 判 tool_schema_changed
    const shrink: Hook = {
      name: "shrink",
      transformToolsBeforeLlm(tools, ctx: HookContext) {
        return ctx.turnIdx === 0 ? undefined : tools.slice(0, 1);
      },
    };
    const fake = createFakeModel([
      { content: [{ type: "toolCall", name: "read", arguments: {} }], stopReason: "toolUse" },
      { content: [{ type: "text", text: "done" }], stopReason: "stop" },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [trivialTool("read"), trivialTool("bash")],
      hooks: [shrink, prefixShape({ onCacheReconcile: (_c, i) => recon.push(i) })], // shrink 先于 prefixShape
    });
    await session.run("go");
    expect(recon.map((r) => r.changeReason)).toEqual(["first_turn", "tool_schema_changed"]);
    fake.teardown();
  });

  it("usage 缺失（denom 0）→ cacheHitRatio 为 0 而非 NaN", async () => {
    const recon: CacheReconcileInfo[] = [];
    const fake = createFakeModel([
      { content: [{ type: "text", text: "done" }], stopReason: "stop" }, // 默认 zeroUsage
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [trivialTool("read")],
      hooks: [prefixShape({ onCacheReconcile: (_c, i) => recon.push(i) })],
    });
    await session.run("go");
    expect(recon).toHaveLength(1);
    expect(recon[0]!.cacheHitRatio).toBe(0);
    expect(recon[0]!.inputTokens).toBe(0);
    expect(recon[0]!.cacheReadTokens).toBe(0);
    fake.teardown();
  });

  it("fail-open：providerOptions 回调抛错（transformToolsBeforeLlm 内）→ run 仍正常收尾", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "done" }], stopReason: "stop" },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [trivialTool("read")],
      hooks: [
        prefixShape({
          providerOptions: () => {
            throw new Error("boom");
          },
        }),
      ],
    });
    const summary = await session.run("go");
    expect(summary.reason).toBe("done");
    fake.teardown();
  });

  it("fail-open：onCacheReconcile 回调抛错（onLlmEnd 内）→ run 仍正常收尾", async () => {
    const fake = createFakeModel([
      {
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
        usage: { input: 100, output: 1, cached: 900 },
      },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [trivialTool("read")],
      hooks: [
        prefixShape({
          onCacheReconcile: () => {
            throw new Error("boom");
          },
        }),
      ],
    });
    const summary = await session.run("go");
    expect(summary.reason).toBe("done");
    fake.teardown();
  });
});
