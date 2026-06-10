/**
 * #14 subAgent tool factory + GapExplorer 覆盖率闭环控制器测试（docs/09 §4.7）。
 */

import { describe, it, expect, vi } from "vitest";
import { AgentSession, Type, type HarnessTool } from "@harness-pi/core";
import { createFakeModel, createTestContext } from "@harness-pi/core/testing";
import {
  subAgentTool,
  routedSubAgentTool,
  SubAgentRegistry,
  GapExplorer,
  type Gap,
  type ExplorerFinding,
  type AgentSpec,
} from "../controllers/index.js";

function blockText(content: unknown): string {
  return Array.isArray(content)
    ? content.map((b) => ("text" in b ? (b as { text: string }).text : "")).join("")
    : String(content ?? "");
}

/* ──────────────── subAgentTool ──────────────── */

describe("subAgentTool", () => {
  it("spawns a bounded sub-agent and returns its last assistant text + terminal details", async () => {
    const subFake = createFakeModel([
      { content: [{ type: "text", text: "sub answer" }], stopReason: "stop", usage: { input: 5, output: 3 } },
    ]);
    const tool = subAgentTool({
      sessionFactory: () => new AgentSession({ model: subFake, tools: [] }),
    });
    const { ctx } = createTestContext();
    const result = await tool.execute({ task: "do X" }, ctx, new AbortController().signal);

    expect(blockText(result.content)).toContain("sub answer");
    const details = result.details as { subAgent?: { reason?: string; turns?: number } } | undefined;
    expect(details?.subAgent?.reason).toBe("done");
    expect(details?.subAgent?.turns).toBe(1);
    subFake.teardown();
  });

  it("delivers the sub-agent sessionId + usage in details (typed delivery, S4)", async () => {
    const subFake = createFakeModel([
      { content: [{ type: "text", text: "ans" }], stopReason: "stop", usage: { input: 7, output: 4 } },
    ]);
    let subId = "";
    const tool = subAgentTool({
      sessionFactory: () => {
        const s = new AgentSession({ model: subFake, tools: [] });
        subId = s.id;
        return s;
      },
    });
    const { ctx } = createTestContext();
    const result = await tool.execute({ task: "do X" }, ctx, new AbortController().signal);
    const details = result.details as
      | { subAgent?: { sessionId?: string; usage?: { input?: number; output?: number } } }
      | undefined;
    expect(details?.subAgent?.sessionId).toBe(subId);
    expect(details?.subAgent?.usage?.input).toBe(7);
    expect(details?.subAgent?.usage?.output).toBe(4);
    subFake.teardown();
  });

  it("does NOT retain the sub-agent when no registry is wired (0.2.4 regression)", async () => {
    // 默认（不接 onSpawn）→ 子 session 跑完即弃。建一个 registry 但**不接到** tool 上：spawn 后 registry 仍为空，
    // 续聊该 id 报「未保留」。证明启用新能力前行为与现状一致：句柄不外泄、不被保留。
    const subFake = createFakeModel([{ content: [{ type: "text", text: "ok" }], stopReason: "stop" }]);
    const registry = new SubAgentRegistry();
    let subId = "";
    const tool = subAgentTool({
      sessionFactory: () => {
        const s = new AgentSession({ model: subFake, tools: [] });
        subId = s.id;
        return s;
      },
      // 故意不传 onSpawn —— 复刻 0.2.4 默认配置。
    });
    await tool.execute({ task: "t" }, createTestContext().ctx, new AbortController().signal);
    expect(registry.size).toBe(0);
    await expect(registry.continueSubAgent(subId, "more")).rejects.toThrow(/no retained sub-agent/);
    subFake.teardown();
  });

  it("passes the task + parent ctx to the sessionFactory", async () => {
    const subFake = createFakeModel([{ content: [{ type: "text", text: "ok" }], stopReason: "stop" }]);
    let gotTask = "";
    let gotCtx: unknown = null;
    const { ctx } = createTestContext();
    const tool = subAgentTool({
      sessionFactory: (task, c) => {
        gotTask = task;
        gotCtx = c;
        return new AgentSession({ model: subFake, tools: [] });
      },
    });
    await tool.execute({ task: "hello" }, ctx, new AbortController().signal);
    expect(gotTask).toBe("hello");
    expect(gotCtx).toBe(ctx);
    subFake.teardown();
  });

  it("throws on an empty/missing task (HarnessTool error contract)", async () => {
    const subFake = createFakeModel([]);
    const tool = subAgentTool({ sessionFactory: () => new AgentSession({ model: subFake, tools: [] }) });
    const { ctx } = createTestContext();
    const sig = new AbortController().signal;
    await expect(tool.execute({ task: "" }, ctx, sig)).rejects.toThrow(/empty task/);
    await expect(tool.execute({ task: "   " }, ctx, sig)).rejects.toThrow(/empty task/);
    await expect(tool.execute({}, ctx, sig)).rejects.toThrow(/empty task/);
    subFake.teardown();
  });

  it("enforces the maxSubAgents budget (fail-loud after the cap)", async () => {
    const subFake = createFakeModel([
      { content: [{ type: "text", text: "1" }], stopReason: "stop" },
    ]);
    const tool = subAgentTool({
      sessionFactory: () => new AgentSession({ model: subFake, tools: [] }),
      maxSubAgents: 1,
    });
    const { ctx } = createTestContext();
    const sig = new AbortController().signal;
    await tool.execute({ task: "a" }, ctx, sig); // spawned = 1
    await expect(tool.execute({ task: "b" }, ctx, sig)).rejects.toThrow(/budget exhausted/);
    subFake.teardown();
  });

  it("passes the parent signal to the sub-agent (cooperative cancel) → details.reason reflects abort", async () => {
    // 子代理里跑一个尊重 signal 的慢工具；父 signal abort 后子 run 以 reason "aborted" 收尾。
    const slow: HarnessTool = {
      name: "slow",
      description: "slow",
      parameters: Type.Object({}),
      async execute(_a, _c, sig: AbortSignal) {
        await new Promise<void>((res) => {
          const t = setTimeout(res, 1000);
          sig.addEventListener("abort", () => {
            clearTimeout(t);
            res();
          });
        });
        return { content: [{ type: "text", text: "r" }] };
      },
    };
    const subFake = createFakeModel([
      { content: [{ type: "toolCall", name: "slow", arguments: {} }] },
      { content: [{ type: "text", text: "after" }], stopReason: "stop" },
    ]);
    const tool = subAgentTool({
      sessionFactory: () => new AgentSession({ model: subFake, tools: [slow] }),
    });
    const { ctx } = createTestContext();
    const ctrl = new AbortController();
    const p = tool.execute({ task: "t" }, ctx, ctrl.signal);
    setTimeout(() => ctrl.abort(), 10);
    const result = await p;

    const details = result.details as { subAgent?: { reason?: string } } | undefined;
    expect(details?.subAgent?.reason).toBe("aborted"); // 信号确实到了子 session（非 done 终态也照常回灌）
    subFake.teardown();
  });

  it("falls back to a placeholder when the sub-agent produced no text", async () => {
    const subFake = createFakeModel([{ content: [], stopReason: "stop" }]); // lastMessage 无 text block
    const tool = subAgentTool({
      sessionFactory: () => new AgentSession({ model: subFake, tools: [] }),
    });
    const { ctx } = createTestContext();
    const result = await tool.execute({ task: "t" }, ctx, new AbortController().signal);
    expect(blockText(result.content)).toBe("(sub-agent produced no text output)");
    subFake.teardown();
  });
});

/* ──────────────── subAgentTool 跨层递归深度闸 (#45) ──────────────── */

describe("subAgentTool depth gate (#45)", () => {
  /**
   * 造一个**会嵌套挂 subAgentTool** 的 session：每层 fake model 先 toolCall("subAgent") 把任务再下派一层，
   * 子层 done 后本层回一句 text。所有 fake 收集起来供 teardown。`depthsSeen` 记录每次 spawn 时**父读到的当前深度**。
   * 这样从顶层（depth 0）run 起来，深度会沿 lineage 透传、自增，直到 maxDepth 把某层的 spawn 挡掉。
   */
  function makeNestedFactory(opts: {
    maxDepth?: number;
    maxSubAgents?: number;
    depthsSeen: number[];
    fakes: Array<ReturnType<typeof createFakeModel>>;
  }) {
    const build = (): AgentSession => {
      // 这层 model：先要求 spawn 一个 subAgent，拿到结果后回一句 text 收尾。
      const fake = createFakeModel([
        { content: [{ type: "toolCall", name: "subAgent", arguments: { task: "go deeper" } }] },
        { content: [{ type: "text", text: "layer done" }], stopReason: "stop" },
      ]);
      opts.fakes.push(fake);
      const tool = subAgentTool({
        ...(opts.maxDepth !== undefined ? { maxDepth: opts.maxDepth } : {}),
        ...(opts.maxSubAgents !== undefined ? { maxSubAgents: opts.maxSubAgents } : {}),
        // sessionFactory 拿到父 ctx → 记录父此刻读到的深度，再递归造下一层。
        sessionFactory: (_task, c) => {
          opts.depthsSeen.push(c.state.get("subAgent.depth") ?? 0);
          return build();
        },
      });
      return new AgentSession({ model: fake, tools: [tool] });
    };
    return build;
  }

  it("3rd layer spawn throws a readable depth-limit error (maxDepth=2)", async () => {
    // depth: 主(0)→子(1)→孙(2)。孙这层 execute 读到 depth=2 >= maxDepth=2 → throw，不再 spawn 第 4 层。
    const fakes: Array<ReturnType<typeof createFakeModel>> = [];
    const depthsSeen: number[] = [];
    const build = makeNestedFactory({ maxDepth: 2, depthsSeen, fakes });
    const root = build();
    const res = await root.run("start");
    expect(res.reason).toBe("done");

    // 孙(depth 2)层的 subAgent execute 抛错 → kernel 包成 isError toolResult 回灌孙的 model。
    // 在某个 fake 的收到的 context 里能找到这条可读错误。
    const allToolResults = fakes
      .flatMap((f) => f.getCalls())
      .flatMap((ctx) => ctx.messages)
      .filter((m) => m.role === "toolResult");
    const errText = allToolResults
      .map((m) => blockText((m as { content: unknown }).content))
      .join("\n");
    expect(errText).toContain("depth limit (maxDepth=2) reached");

    // spawn 只发生在 depth 0 和 1 两层（孙那层被挡，不进 sessionFactory）。
    expect(depthsSeen).toEqual([0, 1]);
    fakes.forEach((f) => f.teardown());
  });

  it("depth limit fires at the top level too when maxDepth=0 (no spawn at all)", async () => {
    // maxDepth=0：顶层（depth 0）execute 立刻读到 0 >= 0 → 直接 throw，sessionFactory 一次都不调。
    const subFake = createFakeModel([{ content: [{ type: "text", text: "x" }], stopReason: "stop" }]);
    let factoryCalls = 0;
    const tool = subAgentTool({
      maxDepth: 0,
      sessionFactory: () => {
        factoryCalls++;
        return new AgentSession({ model: subFake, tools: [] });
      },
    });
    const { ctx } = createTestContext();
    await expect(
      tool.execute({ task: "t" }, ctx, new AbortController().signal),
    ).rejects.toThrow(/depth limit \(maxDepth=0\) reached/);
    expect(factoryCalls).toBe(0);
    subFake.teardown();
  });

  it("horizontal maxSubAgents gate stays independent of the vertical depth gate", async () => {
    // 同一层（depth 0）连派 2 个 sub-agent：maxSubAgents=1 拦第 2 个（横向），而 maxDepth=2 这层（depth 0<2）
    // 本不该拦——证明两闸正交：横向耗尽不是「深度到顶」，错误文案也各自独立。
    const subFake = createFakeModel([
      { content: [{ type: "text", text: "1" }], stopReason: "stop" },
    ]);
    const tool = subAgentTool({
      maxSubAgents: 1,
      maxDepth: 2,
      sessionFactory: () => new AgentSession({ model: subFake, tools: [] }),
    });
    const { ctx } = createTestContext(); // depth 缺省 0
    const sig = new AbortController().signal;
    await tool.execute({ task: "a" }, ctx, sig); // spawned=1，depth 0<2 → OK
    await expect(tool.execute({ task: "b" }, ctx, sig)).rejects.toThrow(/budget exhausted/);
    subFake.teardown();
  });

  it("depth增量沿 lineage 透传：每层 = 父+1，闸停在 maxDepth", async () => {
    // 直接观察注入机制：每嵌套一层，子 session 的 ctx.state 深度比父 +1。makeNestedFactory 会一直递归下钻，
    // 故深度从 0 起逐层自增，直到读到 depth>=maxDepth 把该层 spawn 挡掉。maxDepth=5 → spawn 发生在 depth 0..4，
    // 严格连续自增的 [0,1,2,3,4] 同时钉死「逐层 +1 透传」与「闸恰在 maxDepth 截断」。
    const fakes: Array<ReturnType<typeof createFakeModel>> = [];
    const depthsSeen: number[] = [];
    const build = makeNestedFactory({ maxDepth: 5, depthsSeen, fakes });
    const root = build();
    await root.run("start");
    expect(depthsSeen).toEqual([0, 1, 2, 3, 4]);
    fakes.forEach((f) => f.teardown());
  });

  it("multi-branch siblings don't cross-talk: each child inherits parent depth independently", async () => {
    // 顶层（depth 0）连 spawn 两个**兄弟**子：两个子各自从父继承 depth+1=1，互不串扰（独立 ctx.state）。
    // 每个兄弟子里再 spawn 一层，应都读到 depth=1（而非把彼此的递增累加成 1、2）。
    const childDepths: number[] = [];
    const subFakes: Array<ReturnType<typeof createFakeModel>> = [];
    // 兄弟子的 model：spawn 一层孙后收尾。
    const buildChild = (): AgentSession => {
      const f = createFakeModel([
        { content: [{ type: "toolCall", name: "subAgent", arguments: { task: "grandchild" } }] },
        { content: [{ type: "text", text: "child done" }], stopReason: "stop" },
      ]);
      subFakes.push(f);
      const childTool = subAgentTool({
        maxDepth: 10,
        sessionFactory: (_t, c) => {
          childDepths.push(c.state.get("subAgent.depth") ?? 0); // 子里 spawn 孙时读到的深度
          const gf = createFakeModel([{ content: [{ type: "text", text: "gc" }], stopReason: "stop" }]);
          subFakes.push(gf);
          return new AgentSession({ model: gf, tools: [] });
        },
      });
      return new AgentSession({ model: f, tools: [childTool] });
    };

    // 顶层 model：连发两个 subAgent toolCall（同一 turn 内两次），再收尾。
    const rootFake = createFakeModel([
      {
        content: [
          { type: "toolCall", name: "subAgent", arguments: { task: "branch-A" } },
          { type: "toolCall", name: "subAgent", arguments: { task: "branch-B" } },
        ],
      },
      { content: [{ type: "text", text: "root done" }], stopReason: "stop" },
    ]);
    const rootTool = subAgentTool({
      maxDepth: 10,
      sessionFactory: () => buildChild(),
    });
    const root = new AgentSession({ model: rootFake, tools: [rootTool] });
    await root.run("start");

    // 两个兄弟子各自在自己层 spawn 孙，都应读到 depth=1（从顶层 0 各自 +1），不互相污染。
    expect(childDepths).toEqual([1, 1]);
    rootFake.teardown();
    subFakes.forEach((f) => f.teardown());
  });

  it("default maxDepth (=2) is harmless for existing single-level usage (regression)", async () => {
    // 不传 maxDepth：顶层（depth 0）spawn 一个子（depth 1）这类**现有**单层用法照常工作，不被默认闸误伤。
    const subFake = createFakeModel([
      { content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ]);
    const tool = subAgentTool({
      sessionFactory: () => new AgentSession({ model: subFake, tools: [] }),
    });
    const { ctx } = createTestContext(); // depth 缺省 0
    const result = await tool.execute({ task: "t" }, ctx, new AbortController().signal);
    expect(blockText(result.content)).toContain("ok");
    subFake.teardown();
  });
});

/* ──────────────── routedSubAgentTool (#59 / S3) ──────────────── */

describe("routedSubAgentTool (#59)", () => {
  /** 从 TypeBox Union(of Literals) schema 抽出枚举值（形如 anyOf:[{const},...]）。 */
  function enumValues(params: unknown): string[] {
    const props = (params as { properties?: Record<string, unknown> }).properties ?? {};
    const at = props["agent_type"] as { anyOf?: Array<{ const?: string }> } | undefined;
    return (at?.anyOf ?? []).map((b) => b.const).filter((c): c is string => typeof c === "string");
  }

  it("exposes agent_type as an enum of all spec types and folds each whenToUse into the description", () => {
    const specs: AgentSpec[] = [
      {
        type: "researcher",
        whenToUse: "use for open-ended investigation",
        sessionFactory: () => new AgentSession({ model: createFakeModel([]), tools: [] }),
      },
      {
        type: "coder",
        whenToUse: "use for writing or editing code",
        sessionFactory: () => new AgentSession({ model: createFakeModel([]), tools: [] }),
      },
    ];
    const tool = routedSubAgentTool({ specs });
    expect(enumValues(tool.parameters).sort()).toEqual(["coder", "researcher"]);
    // description 拼进每个 spec 的 whenToUse（含 type 标签），供模型路由。
    expect(tool.description).toContain("use for open-ended investigation");
    expect(tool.description).toContain("use for writing or editing code");
    expect(tool.description).toContain("researcher");
    expect(tool.description).toContain("coder");
  });

  it("routes a valid agent_type to that spec's sessionFactory (distinguishable results)", async () => {
    // 两个 spec 各自 fake 出可区分的终态文本 → 断言路由命中正确 factory。
    const aFake = createFakeModel([{ content: [{ type: "text", text: "ANSWER-A" }], stopReason: "stop" }]);
    const bFake = createFakeModel([{ content: [{ type: "text", text: "ANSWER-B" }], stopReason: "stop" }]);
    let aCalls = 0;
    let bCalls = 0;
    const tool = routedSubAgentTool({
      specs: [
        {
          type: "alpha",
          whenToUse: "alpha tasks",
          sessionFactory: () => {
            aCalls++;
            return new AgentSession({ model: aFake, tools: [] });
          },
        },
        {
          type: "beta",
          whenToUse: "beta tasks",
          sessionFactory: () => {
            bCalls++;
            return new AgentSession({ model: bFake, tools: [] });
          },
        },
      ],
    });
    const { ctx } = createTestContext();
    const sig = new AbortController().signal;

    const rb = await tool.execute({ agent_type: "beta", task: "do it" }, ctx, sig);
    expect(blockText(rb.content)).toContain("ANSWER-B");
    expect(bCalls).toBe(1);
    expect(aCalls).toBe(0); // 没误派给 alpha

    const ra = await tool.execute({ agent_type: "alpha", task: "do it" }, ctx, sig);
    expect(blockText(ra.content)).toContain("ANSWER-A");
    expect(aCalls).toBe(1);

    aFake.teardown();
    bFake.teardown();
  });

  it("passes the task + parent ctx to the routed sessionFactory", async () => {
    const subFake = createFakeModel([{ content: [{ type: "text", text: "ok" }], stopReason: "stop" }]);
    let gotTask = "";
    let gotCtx: unknown = null;
    const { ctx } = createTestContext();
    const tool = routedSubAgentTool({
      specs: [
        {
          type: "x",
          whenToUse: "x",
          sessionFactory: (task, c) => {
            gotTask = task;
            gotCtx = c;
            return new AgentSession({ model: subFake, tools: [] });
          },
        },
      ],
    });
    await tool.execute({ agent_type: "x", task: "hello" }, ctx, new AbortController().signal);
    expect(gotTask).toBe("hello");
    expect(gotCtx).toBe(ctx);
    subFake.teardown();
  });

  it("honors a custom tool name and description prefix (whenToUse folded after it)", async () => {
    const tool = routedSubAgentTool({
      name: "router",
      description: "Route to a specialist.",
      specs: [
        { type: "alpha", whenToUse: "alpha tasks", sessionFactory: () => new AgentSession({ model: createFakeModel([]), tools: [] }) },
      ],
    });
    expect(tool.name).toBe("router");
    // 自定义前缀在前，各 spec 的 whenToUse 折叠在 "Available agent types:" 之后。
    const prefixAt = tool.description.indexOf("Route to a specialist.");
    const typesAt = tool.description.indexOf("Available agent types:");
    expect(prefixAt).toBeGreaterThanOrEqual(0);
    expect(typesAt).toBeGreaterThan(prefixAt);
    expect(tool.description).toContain("alpha: alpha tasks");
  });

  it("throws a clear error on an unknown agent_type (fail-loud, no crash)", async () => {
    const subFake = createFakeModel([{ content: [{ type: "text", text: "ok" }], stopReason: "stop" }]);
    let factoryCalls = 0;
    const tool = routedSubAgentTool({
      specs: [
        {
          type: "known",
          whenToUse: "k",
          sessionFactory: () => {
            factoryCalls++;
            return new AgentSession({ model: subFake, tools: [] });
          },
        },
      ],
    });
    const { ctx } = createTestContext();
    const sig = new AbortController().signal;
    await expect(
      tool.execute({ agent_type: "nope", task: "t" }, ctx, sig),
    ).rejects.toThrow(/unknown agent_type "nope".*expected one of: known/);
    expect(factoryCalls).toBe(0); // 非法 type 绝不 spawn
    subFake.teardown();
  });

  it("throws a clear error on a missing agent_type", async () => {
    const subFake = createFakeModel([{ content: [{ type: "text", text: "ok" }], stopReason: "stop" }]);
    const tool = routedSubAgentTool({
      specs: [{ type: "k", whenToUse: "k", sessionFactory: () => new AgentSession({ model: subFake, tools: [] }) }],
    });
    const { ctx } = createTestContext();
    await expect(
      tool.execute({ task: "t" }, ctx, new AbortController().signal),
    ).rejects.toThrow(/unknown agent_type/);
    subFake.teardown();
  });

  it("throws on an empty/missing task (HarnessTool error contract)", async () => {
    const subFake = createFakeModel([]);
    const tool = routedSubAgentTool({
      specs: [{ type: "k", whenToUse: "k", sessionFactory: () => new AgentSession({ model: subFake, tools: [] }) }],
    });
    const { ctx } = createTestContext();
    const sig = new AbortController().signal;
    await expect(tool.execute({ agent_type: "k", task: "" }, ctx, sig)).rejects.toThrow(/empty task/);
    await expect(tool.execute({ agent_type: "k", task: "   " }, ctx, sig)).rejects.toThrow(/empty task/);
    subFake.teardown();
  });

  it("rejects empty specs and duplicate types at construction (fail-loud)", () => {
    expect(() => routedSubAgentTool({ specs: [] })).toThrow(/specs must not be empty/);
    const dup: AgentSpec[] = [
      { type: "dup", whenToUse: "a", sessionFactory: () => new AgentSession({ model: createFakeModel([]), tools: [] }) },
      { type: "dup", whenToUse: "b", sessionFactory: () => new AgentSession({ model: createFakeModel([]), tools: [] }) },
    ];
    expect(() => routedSubAgentTool({ specs: dup })).toThrow(/duplicate agent type "dup"/);
  });

  it("enforces the maxSubAgents budget across all types (fail-loud after the cap)", async () => {
    const subFake = createFakeModel([{ content: [{ type: "text", text: "1" }], stopReason: "stop" }]);
    const mk = () => new AgentSession({ model: subFake, tools: [] });
    const tool = routedSubAgentTool({
      maxSubAgents: 1,
      specs: [
        { type: "a", whenToUse: "a", sessionFactory: mk },
        { type: "b", whenToUse: "b", sessionFactory: mk },
      ],
    });
    const { ctx } = createTestContext();
    const sig = new AbortController().signal;
    await tool.execute({ agent_type: "a", task: "t" }, ctx, sig); // spawned=1
    // 即便换一种 type，横向预算是跨 type 合计 → 第 2 个被拦。
    await expect(
      tool.execute({ agent_type: "b", task: "t" }, ctx, sig),
    ).rejects.toThrow(/budget exhausted/);
    subFake.teardown();
  });

  it("honors the vertical depth gate (#45): top-level spawn blocked when maxDepth=0", async () => {
    const subFake = createFakeModel([{ content: [{ type: "text", text: "x" }], stopReason: "stop" }]);
    let factoryCalls = 0;
    const tool = routedSubAgentTool({
      maxDepth: 0,
      specs: [
        {
          type: "k",
          whenToUse: "k",
          sessionFactory: () => {
            factoryCalls++;
            return new AgentSession({ model: subFake, tools: [] });
          },
        },
      ],
    });
    const { ctx } = createTestContext(); // depth 缺省 0
    await expect(
      tool.execute({ agent_type: "k", task: "t" }, ctx, new AbortController().signal),
    ).rejects.toThrow(/depth limit \(maxDepth=0\) reached/);
    expect(factoryCalls).toBe(0);
    subFake.teardown();
  });

  it("propagates depth across layers (#45): nested routed spawn hits the depth limit at maxDepth", async () => {
    // 嵌套：每层 routed tool 先 spawn 一层再收尾。depth 沿 lineage +1，maxDepth=2 时孙(depth 2)被挡。
    const fakes: Array<ReturnType<typeof createFakeModel>> = [];
    const depthsSeen: number[] = [];
    const build = (): AgentSession => {
      const fake = createFakeModel([
        { content: [{ type: "toolCall", name: "subAgent", arguments: { agent_type: "worker", task: "deeper" } }] },
        { content: [{ type: "text", text: "layer done" }], stopReason: "stop" },
      ]);
      fakes.push(fake);
      const tool = routedSubAgentTool({
        maxDepth: 2,
        specs: [
          {
            type: "worker",
            whenToUse: "worker",
            sessionFactory: (_task, c) => {
              depthsSeen.push(c.state.get("subAgent.depth") ?? 0);
              return build();
            },
          },
        ],
      });
      return new AgentSession({ model: fake, tools: [tool] });
    };
    const root = build();
    const res = await root.run("start");
    expect(res.reason).toBe("done");

    // 孙(depth 2)层 execute 读到 depth=2>=2 → throw，kernel 包成 isError toolResult。
    const errText = fakes
      .flatMap((f) => f.getCalls())
      .flatMap((c) => c.messages)
      .filter((m) => m.role === "toolResult")
      .map((m) => blockText((m as { content: unknown }).content))
      .join("\n");
    expect(errText).toContain("depth limit (maxDepth=2) reached");
    // spawn 只发生在 depth 0、1（孙被挡，不进 sessionFactory）。
    expect(depthsSeen).toEqual([0, 1]);
    fakes.forEach((f) => f.teardown());
  });
});

/* ──────────────── GapExplorer ──────────────── */

describe("GapExplorer", () => {
  /** 每个 gap 一个 fresh fake（空队列 → 默认 done 响应），收集起来供 teardown。 */
  function freshFactory() {
    const fakes: Array<ReturnType<typeof createFakeModel>> = [];
    const factory = () => {
      const f = createFakeModel([{ content: [{ type: "text", text: "explored" }], stopReason: "stop" }]);
      fakes.push(f);
      return new AgentSession({ model: f, tools: [] });
    };
    const teardown = () => fakes.forEach((f) => f.teardown());
    return { factory, teardown };
  }

  it("explores fresh gaps in parallel and returns a finding per gap", async () => {
    const { factory, teardown } = freshFactory();
    const ex = new GapExplorer({ sessionFactory: factory });
    const r = await ex.explore([
      { id: "g1", prompt: "p1" },
      { id: "g2", prompt: "p2" },
    ]);
    expect(r.explored.map((f) => f.gap.id).sort()).toEqual(["g1", "g2"]);
    expect(r.explored.every((f) => f.terminal.reason === "done")).toBe(true);
    expect(r.promoted.map((f) => f.gap.id).sort()).toEqual(["g1", "g2"]); // 默认全 promote
    teardown();
  });

  it("dedups by gap.id across calls (second sighting → skipped:duplicate)", async () => {
    const { factory, teardown } = freshFactory();
    const ex = new GapExplorer({ sessionFactory: factory });
    await ex.explore([{ id: "g1", prompt: "p1" }]);
    const r = await ex.explore([
      { id: "g1", prompt: "p1-again" },
      { id: "g2", prompt: "p2" },
    ]);
    expect(r.skipped.duplicate).toEqual(["g1"]);
    expect(r.explored.map((f) => f.gap.id)).toEqual(["g2"]);
    teardown();
  });

  it("enforces maxExplorers (excess → skipped:budget) and budget-skipped is retryable next call", async () => {
    const { factory, teardown } = freshFactory();
    const ex = new GapExplorer({ sessionFactory: factory, maxExplorers: 2 });
    const gaps: Gap[] = [
      { id: "g1", prompt: "p" },
      { id: "g2", prompt: "p" },
      { id: "g3", prompt: "p" },
    ];
    const r1 = await ex.explore(gaps);
    expect(r1.explored.map((f) => f.gap.id)).toEqual(["g1", "g2"]);
    expect(r1.skipped.budget).toEqual(["g3"]);

    // g1/g2 现在 seen（去重），g3 budget-skip 过 → 可重试。
    const r2 = await ex.explore(gaps);
    expect(r2.skipped.duplicate.sort()).toEqual(["g1", "g2"]);
    expect(r2.explored.map((f) => f.gap.id)).toEqual(["g3"]);
    teardown();
  });

  it("honors the promote gate: rejected findings are not applied to KB", async () => {
    const { factory, teardown } = freshFactory();
    const applyToKb = vi.fn();
    const ex = new GapExplorer({
      sessionFactory: factory,
      promote: (f: ExplorerFinding) => f.gap.id !== "bad",
      applyToKb,
    });
    const r = await ex.explore([
      { id: "good", prompt: "p" },
      { id: "bad", prompt: "p" },
    ]);
    expect(r.promoted.map((f) => f.gap.id)).toEqual(["good"]);
    expect(r.rejected.map((f) => f.gap.id)).toEqual(["bad"]);
    expect(applyToKb).toHaveBeenCalledTimes(1);
    expect((applyToKb.mock.calls[0]![0] as ExplorerFinding).gap.id).toBe("good");
    teardown();
  });

  it("toReanswer is the deduped union of promoted findings' affects", async () => {
    const { factory, teardown } = freshFactory();
    const ex = new GapExplorer({
      sessionFactory: factory,
      promote: (f: ExplorerFinding) => f.gap.id !== "bad",
    });
    const r = await ex.explore([
      { id: "g1", prompt: "p", affects: ["q1", "q2"] },
      { id: "g2", prompt: "p", affects: ["q2", "q3"] },
      { id: "bad", prompt: "p", affects: ["q9"] }, // rejected → 不计入 toReanswer
    ]);
    expect(r.toReanswer.sort()).toEqual(["q1", "q2", "q3"]);
    expect(r.toReanswer).not.toContain("q9");
    teardown();
  });

  it("a failing explorer is reported in failed[] and its gap stays retryable", async () => {
    const { factory, teardown } = freshFactory();
    const ex = new GapExplorer({
      sessionFactory: (gap) => {
        if (gap.id === "boom") throw new Error("factory blew up");
        return factory();
      },
    });
    const r1 = await ex.explore([
      { id: "ok1", prompt: "p" },
      { id: "boom", prompt: "p" },
    ]);
    expect(r1.explored.map((f) => f.gap.id)).toEqual(["ok1"]);
    expect(r1.failed.map((f) => f.gap.id)).toEqual(["boom"]);

    // boom 失败 → 从 _seen 移除 → 下次可重试（不是 duplicate）。
    const r2 = await ex.explore([{ id: "boom", prompt: "p" }]);
    expect(r2.skipped.duplicate).toEqual([]);
    teardown();
  });

  it("rejects negative maxExplorers at construction", () => {
    const { factory, teardown } = freshFactory();
    expect(() => new GapExplorer({ sessionFactory: factory, maxExplorers: -1 })).toThrow(/maxExplorers/);
    teardown();
  });

  it("a non-done explorer (max_turns) goes to incomplete, NOT explored/promoted, and stays retryable", async () => {
    // AgentSession.run() 不 throw——这个 explorer 每轮都想调工具，maxTurns:1 → 以 reason "max_turns" 收尾
    // （status 仍 "ok"）。控制器必须据 terminal.reason 把它分到 incomplete、绝不当 finding 默认 promote 污染 KB。
    const fakes: Array<ReturnType<typeof createFakeModel>> = [];
    const applyToKb = vi.fn();
    const ex = new GapExplorer({
      sessionFactory: () => {
        const noop: HarnessTool = {
          name: "noop",
          description: "noop",
          parameters: Type.Object({}),
          async execute() {
            return { content: [{ type: "text", text: "r" }] };
          },
        };
        const f = createFakeModel([{ content: [{ type: "toolCall", name: "noop", arguments: {} }] }]);
        fakes.push(f);
        return new AgentSession({ model: f, tools: [noop], maxTurns: 1 });
      },
      applyToKb,
    });
    const r1 = await ex.explore([{ id: "g1", prompt: "p" }]);
    expect(r1.explored).toEqual([]);
    expect(r1.incomplete.map((f) => f.gap.id)).toEqual(["g1"]);
    expect(r1.incomplete[0]!.terminal.reason).toBe("max_turns");
    expect(r1.promoted).toEqual([]);
    expect(applyToKb).not.toHaveBeenCalled(); // 半成品绝不写 KB

    // incomplete 的 gap 从 _seen 移除 → 下次可重探（非 duplicate）。
    const r2 = await ex.explore([{ id: "g1", prompt: "p" }]);
    expect(r2.skipped.duplicate).toEqual([]);
    fakes.forEach((f) => f.teardown());
  });

  it("an explorer aborted mid-run lands in incomplete (signal reaches the explorer session)", async () => {
    const fakes: Array<ReturnType<typeof createFakeModel>> = [];
    const ctrl = new AbortController();
    const ex = new GapExplorer({
      signal: ctrl.signal,
      sessionFactory: () => {
        const slow: HarnessTool = {
          name: "slow",
          description: "slow",
          parameters: Type.Object({}),
          async execute(_a, _c, sig: AbortSignal) {
            await new Promise<void>((res) => {
              const t = setTimeout(res, 1000);
              sig.addEventListener("abort", () => {
                clearTimeout(t);
                res();
              });
            });
            return { content: [{ type: "text", text: "r" }] };
          },
        };
        const f = createFakeModel([
          { content: [{ type: "toolCall", name: "slow", arguments: {} }] },
          { content: [{ type: "text", text: "done" }], stopReason: "stop" },
        ]);
        fakes.push(f);
        return new AgentSession({ model: f, tools: [slow] });
      },
    });
    const p = ex.explore([{ id: "g1", prompt: "p" }]);
    setTimeout(() => ctrl.abort(), 10);
    const r = await p;

    expect(r.explored).toEqual([]); // 被中止的 explorer 不当成功 finding
    expect(r.incomplete.map((f) => f.gap.id)).toEqual(["g1"]);
    expect(r.incomplete[0]!.terminal.reason).toBe("aborted"); // signal 确实到了 explorer session
    fakes.forEach((f) => f.teardown());
  });

  it("promote can block asynchronously (applyToKb only fires after promote resolves)", async () => {
    const { factory, teardown } = freshFactory();
    let release: (v: boolean) => void = () => {};
    const gate = new Promise<boolean>((res) => {
      release = res;
    });
    const applyToKb = vi.fn();
    const ex = new GapExplorer({ sessionFactory: factory, promote: () => gate, applyToKb });

    const p = ex.explore([{ id: "g1", prompt: "p" }]);
    await new Promise((r) => setTimeout(r, 20)); // 让 explore 跑到 await promote
    expect(applyToKb).not.toHaveBeenCalled(); // promote 未 resolve（等人审）→ 还没写 KB
    release(true);
    const r = await p;
    expect(applyToKb).toHaveBeenCalledTimes(1);
    expect(r.promoted.map((f) => f.gap.id)).toEqual(["g1"]);
    teardown();
  });

  it("maxExplorers: 0 explores nothing (all budget-skipped, retryable)", async () => {
    const { factory, teardown } = freshFactory();
    const ex = new GapExplorer({ sessionFactory: factory, maxExplorers: 0 });
    const r = await ex.explore([{ id: "g1", prompt: "p" }]);
    expect(r.explored).toEqual([]);
    expect(r.skipped.budget).toEqual(["g1"]);
    const r2 = await ex.explore([{ id: "g1", prompt: "p" }]); // budget-skip 不入 _seen → 可重探
    expect(r2.skipped.duplicate).toEqual([]);
    teardown();
  });
});
