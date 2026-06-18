import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, type Model, type Usage } from "@harness-pi/core";
import { createFakeModel } from "@harness-pi/core/testing";
import { getProviders } from "@earendil-works/pi-ai";
import {
  createCodingAgent,
  createPiAiCostModel,
  resolveModel,
  resolveModelRuntime,
  resolveModelSpec,
  runAgentPrompt,
} from "../agent.js";
import { parseArgs } from "../cli.js";
import { renderRunReport } from "../output.js";
import { buildGoalPrompt, classifyGoalOutcome, type GoalOptions } from "../tui/goal.js";
import {
  estimateDashScopeCostCny,
  getDashScopeModelMetadata,
} from "../providers/dashscope.js";

const tempDirs: string[] = [];

async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "harness-pi-coding-agent-test-"));
  tempDirs.push(dir);
  await writeFile(join(dir, "README.md"), "hello needle\nold text\n");
  await writeFile(join(dir, "package.json"), "{\"scripts\":{\"test\":\"node --version\"}}\n");
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("coding-agent dogfood app", () => {
  it("runs a fake one-shot coding flow through real read/grep/bash/edit/write tools and renders a report", async () => {
    const cwd = await tempRepo();
    const fake = createFakeModel([
      {
        content: [
          { type: "toolCall", name: "read", arguments: { path: "README.md" } },
          {
            type: "toolCall",
            name: "grep",
            arguments: { path: ".", pattern: "needle", literal: true },
          },
          { type: "toolCall", name: "bash", arguments: { command: "test -f README.md" } },
          {
            type: "toolCall",
            name: "write",
            arguments: { path: "notes.txt", content: "created by dogfood test\n" },
          },
          {
            type: "toolCall",
            name: "edit",
            arguments: {
              path: "README.md",
              oldText: "old text",
              newText: "new text",
            },
          },
        ],
        usage: { input: 100, output: 50 },
      },
      {
        content: [{ type: "text", text: "summary" }],
        usage: { input: 80, output: 40 },
      },
    ]);
    const agent = createCodingAgent({
      cwd,
      model: fake,
      logDir: join(cwd, ".harness-pi", "logs"),
      metricsFile: join(cwd, ".harness-pi", "metrics.ndjson"),
    });

    const report = await runAgentPrompt(agent, "inspect and update this repo");
    const text = renderRunReport(report);

    expect(report.summary.reason).toBe("done");
    expect(report.costStats?.inputTokens).toBe(180);
    expect(report.toolStats?.byTool.get("read")?.ok).toBe(1);
    expect(report.toolStats?.byTool.get("grep")?.ok).toBe(1);
    expect(report.toolStats?.byTool.get("bash")?.ok).toBe(1);
    expect(report.toolStats?.byTool.get("write")?.ok).toBe(1);
    expect(report.toolStats?.byTool.get("edit")?.ok).toBe(1);
    expect(await readFile(join(cwd, "README.md"), "utf8")).toContain("new text");
    expect(await readFile(join(cwd, "notes.txt"), "utf8")).toContain("created by dogfood");
    const metrics = await readFile(join(cwd, ".harness-pi", "metrics.ndjson"), "utf8");
    expect(metrics).toContain('"kind":"tool.stats"');
    expect(metrics).toContain('"cumulative":true');
    expect(text).toContain("host shell");
    expect(text).toContain("Tool Stats (session cumulative)");
    await agent.close();
    fake.teardown();
  });

  it("uses read-only tools when requested and supports disabling tools", async () => {
    const cwd = await tempRepo();
    const fake = createFakeModel([]);

    const readOnly = createCodingAgent({ cwd, model: fake, readOnly: true });
    expect(readOnly.tools.map((tool) => tool.name)).toEqual([
      "read",
      "grep",
      "find",
      "ls",
    ]);

    const disabled = createCodingAgent({
      cwd,
      model: fake,
      disabledTools: ["bash", "write"],
    });
    expect(disabled.tools.map((tool) => tool.name)).toEqual([
      "read",
      "edit",
      "grep",
      "find",
      "ls",
    ]);
    await readOnly.close();
    await disabled.close();
    fake.teardown();
  });

  it("returns clear errors for missing and unknown model specs", () => {
    expect(() => resolveModelSpec(undefined, {})).toThrow(/--model/);
    expect(() => resolveModel("unknown-provider:model-x")).toThrow(/Unknown provider/);
    const provider = getProviders()[0];
    if (provider) {
      expect(() => resolveModel(`${provider}:definitely-not-a-model`)).toThrow(
        /Unknown model/,
      );
    }
    expect(() => resolveModelRuntime("dashscope:qwen-plus", {})).toThrow(
      /DASHSCOPE_API_KEY/,
    );
  });

  it("resolves DashScope Qwen API through pi-ai openai-completions with llmOptions apiKey", () => {
    const runtime = resolveModelRuntime("qwen:qwen-plus", {
      DASHSCOPE_API_KEY: "test-key",
    });

    expect(runtime.model).toMatchObject({
      id: "qwen-plus",
      api: "openai-completions",
      provider: "dashscope",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      contextWindow: 1_000_000,
      maxTokens: 32_768,
      reasoning: true,
    });
    expect(runtime.llmOptions?.apiKey).toBe("test-key");
    expect(() =>
      resolveModel("qwen:qwen-plus", {
        DASHSCOPE_API_KEY: "test-key",
      }),
    ).toThrow(/resolveModelRuntime/);
  });

  it("keeps DashScope metadata and CNY pricing out of the pi-ai USD cost table", () => {
    const metadata = getDashScopeModelMetadata("qwen-plus");
    const usage: Usage = {
      input: 100_000,
      output: 50_000,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 150_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };

    const runtime = resolveModelRuntime("qwen:qwen-plus", {
      DASHSCOPE_API_KEY: "test-key",
    });
    const estimate = estimateDashScopeCostCny("qwen-plus", usage);

    expect(metadata.contextWindow).toBe(1_000_000);
    expect(metadata.maxTokens).toBe(32_768);
    expect(runtime.model.cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(estimate?.amount).toBeCloseTo(0.18);
    expect(estimate?.currency).toBe("CNY");
  });

  it("accepts pnpm script separator before CLI flags", () => {
    expect(parseArgs(["--", "--help"]).help).toBe(true);
  });

  it("--resume <id> captures the id and implies --tui", () => {
    const args = parseArgs(["--resume", "sess-abc"]);
    expect(args.resume).toBe("sess-abc");
    expect(args.tui).toBe(true);
  });

  it("--resume without an id throws", () => {
    expect(() => parseArgs(["--resume"])).toThrow(/--resume requires a value/);
  });

  it("--compact sets compact and implies --tui", () => {
    const args = parseArgs(["--compact"]);
    expect(args.compact).toBe(true);
    expect(args.tui).toBe(true);
  });

  it("reuses one AgentSession history across interactive prompts with lifetime cost stats", async () => {
    const cwd = await tempRepo();
    const fake = createFakeModel([
      {
        content: [{ type: "text", text: "first" }],
        usage: { input: 10, output: 5 },
      },
      {
        content: [{ type: "text", text: "second" }],
        usage: { input: 20, output: 7 },
      },
    ]);
    const agent = createCodingAgent({ cwd, model: fake });

    await runAgentPrompt(agent, "first prompt");
    const second = await runAgentPrompt(agent, "second prompt");
    const calls = fake.getCalls();

    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1]?.messages)).toContain("first prompt");
    expect(JSON.stringify(calls[1]?.messages)).toContain("second prompt");
    expect(second.costStats?.inputTokens).toBe(30);
    expect(second.costStats?.outputTokens).toBe(12);
    expect(renderRunReport(second)).toContain("LLM Stats (session cumulative)");
    await agent.close();
    fake.teardown();
  });

  // #106: trimHistory 默认关（opt-in）——每轮改写旧 toolResult 会破坏 prompt-cache 前缀、在缓存
  // provider 上净亏。下面两条钉死「默认不裁」与「显式开了才裁」。
  const threeBashThenDone = () =>
    createFakeModel([
      { content: [{ type: "toolCall", name: "bash", arguments: { command: "echo MARKER_0" } }] },
      { content: [{ type: "toolCall", name: "bash", arguments: { command: "echo MARKER_1" } }] },
      { content: [{ type: "toolCall", name: "bash", arguments: { command: "echo MARKER_2" } }] },
      { content: [{ type: "text", text: "done" }] },
    ]);

  it("does NOT trim tool-result history by default (preserves prompt-cache prefix, #106)", async () => {
    const cwd = await tempRepo();
    const fake = threeBashThenDone();
    const agent = createCodingAgent({ cwd, model: fake, log: false });
    await runAgentPrompt(agent, "run three echo commands");
    const lastMsgs = JSON.stringify(fake.getCalls().at(-1)?.messages);
    expect(lastMsgs).toContain("MARKER_0"); // 最旧的 toolResult 仍完整
    expect(lastMsgs).toContain("MARKER_2");
    expect(lastMsgs).not.toContain("trimmed tool result"); // 没有任何裁剪占位符
    await agent.close();
    fake.teardown();
  });

  it("trims older tool results only when trimHistory is opted in", async () => {
    const cwd = await tempRepo();
    const fake = threeBashThenDone();
    const agent = createCodingAgent({ cwd, model: fake, log: false, trimHistory: { keepRecent: 1 } });
    await runAgentPrompt(agent, "run three echo commands");
    const lastMsgs = JSON.stringify(fake.getCalls().at(-1)?.messages);
    // 3 个 toolResult，keepRecent:1 → 最旧的 2 个 toolResult 内容被换成占位符（最近 1 条保留）。
    // 注：占位符只替换 toolResult 内容；assistant 的 toolCall 参数(echo MARKER_N)不动，故不按 MARKER 断言。
    expect((lastMsgs?.match(/trimmed tool result/g) ?? []).length).toBe(2);
    await agent.close();
    fake.teardown();
  });

  it("createGoalSession stops naturally when the final GOAL_STATUS is REACHED", async () => {
    const cwd = await tempRepo();
    const goal: GoalOptions = { goal: "make tests pass", maxTurns: 3 };
    const fake = createFakeModel([
      {
        content: [{ type: "text", text: "done\n---\nGOAL_STATUS: REACHED" }],
        usage: { input: 10, output: 5 },
      },
    ]);
    const agent = createCodingAgent({ cwd, model: fake, log: false });

    const summary = await agent.createGoalSession(goal).run(buildGoalPrompt(goal));

    expect(summary.reason).toBe("done");
    expect(summary.abortReason).toBeUndefined();
    expect(summary.turns).toBe(1);
    await agent.close();
    fake.teardown();
  });

  it("createGoalSession forces continuation via turnEndGuard until GOAL_STATUS reaches REACHED", async () => {
    const cwd = await tempRepo();
    const goal: GoalOptions = { goal: "finish issue", maxTurns: 3 };
    const fake = createFakeModel([
      {
        content: [
          {
            type: "text",
            text: "partial\n---\nGOAL_STATUS: NOT_REACHED\nGOAL_REASON: one test still fails",
          },
        ],
      },
      {
        content: [{ type: "text", text: "fixed\n---\nGOAL_STATUS: REACHED" }],
      },
    ]);
    const agent = createCodingAgent({ cwd, model: fake, log: false });

    const summary = await agent.createGoalSession(goal).run(buildGoalPrompt(goal));

    expect(summary.reason).toBe("done");
    expect(summary.abortReason).toBeUndefined();
    expect(summary.continuations).toBe(1);
    expect(fake.getCalls()).toHaveLength(2);
    expect(JSON.stringify(fake.getCalls()[1]?.messages)).toContain("Goal is not reached yet");
    await agent.close();
    fake.teardown();
  });

  it("createGoalSession allows multiple tool-call turns before the final GOAL_STATUS: REACHED", async () => {
    const cwd = await tempRepo();
    const goal: GoalOptions = { goal: "inspect repo and finish", maxTurns: 2 };
    const fake = createFakeModel([
      {
        content: [{ type: "toolCall", name: "read", arguments: { path: "README.md" } }],
      },
      {
        content: [{ type: "toolCall", name: "read", arguments: { path: "package.json" } }],
      },
      {
        content: [{ type: "text", text: "inspected\n---\nGOAL_STATUS: REACHED" }],
      },
    ]);
    const agent = createCodingAgent({ cwd, model: fake, log: false });

    const summary = await agent.createGoalSession(goal).run(buildGoalPrompt(goal));

    expect(summary.reason).toBe("done");
    expect(summary.abortReason).toBeUndefined();
    expect(summary.turns).toBe(3);
    expect(fake.getCalls()).toHaveLength(3);
    await agent.close();
    fake.teardown();
  });

  it("createGoalSession stops through tokenBudget when usage exceeds budget", async () => {
    const cwd = await tempRepo();
    const goal: GoalOptions = { goal: "spend less", maxTurns: 3, budgetTokens: 100 };
    const fake = createFakeModel([
      {
        content: [
          {
            type: "text",
            text: "not done\n---\nGOAL_STATUS: NOT_REACHED\nGOAL_REASON: needs more work",
          },
        ],
        usage: { input: 80, output: 30 },
      },
    ]);
    const agent = createCodingAgent({ cwd, model: fake, log: false });

    const summary = await agent.createGoalSession(goal).run(buildGoalPrompt(goal));

    expect(summary.reason).toBe("aborted");
    expect(summary.abortReason).toContain("token budget exhausted");
    await agent.close();
    fake.teardown();
  });

  it("createGoalSession caps an unproductive NOT_REACHED loop", async () => {
    const cwd = await tempRepo();
    const goal: GoalOptions = { goal: "finish safely", maxTurns: 3 };
    const fake = createFakeModel(
      Array.from({ length: 10 }, (_, i) => ({
        content: [
          {
            type: "text" as const,
            text: `still not done ${i}\n---\nGOAL_STATUS: NOT_REACHED\nGOAL_REASON: needs another pass`,
          },
        ],
      })),
    );
    const agent = createCodingAgent({ cwd, model: fake, log: false });

    const summary = await agent.createGoalSession(goal).run(buildGoalPrompt(goal));

    expect(["aborted", "max_continuations"]).toContain(summary.reason);
    expect(summary.continuations).toBeLessThanOrEqual(goal.maxTurns);
    expect(fake.getCalls().length).toBeLessThanOrEqual(goal.maxTurns + 1);
    expect(classifyGoalOutcome(summary)).toMatchObject({
      verdict: "not_reached",
      aborted: false,
      budgetExhausted: false,
    });
    await agent.close();
    fake.teardown();
  });

  it("createGoalSession clamps public maxTurns input before wiring guards", async () => {
    const cwd = await tempRepo();
    const goal: GoalOptions = { goal: "finish once", maxTurns: 0 };
    const fake = createFakeModel([
      {
        content: [{ type: "text", text: "done\n---\nGOAL_STATUS: REACHED" }],
      },
    ]);
    const agent = createCodingAgent({ cwd, model: fake, log: false });

    const summary = await agent.createGoalSession(goal).run(buildGoalPrompt(goal));

    expect(summary.reason).toBe("done");
    expect(fake.getCalls()).toHaveLength(1);
    await agent.close();
    fake.teardown();
  });

  it("adapts pi-ai calculateCost output into the costTracker number callback shape", () => {
    const model = {
      id: "priced-model",
      name: "Priced Model",
      api: "priced-api" as Api,
      provider: "priced-provider",
      baseUrl: "https://example.invalid",
      reasoning: false,
      input: ["text"],
      cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 10 },
      contextWindow: 1000,
      maxTokens: 1000,
    } as Model<Api>;

    const costModel = createPiAiCostModel(model);

    expect(
      costModel("ignored", {
        input: 1_000_000,
        output: 2_000_000,
        cached: 3_000_000,
      }),
    ).toBe(6.5);
  });

  it("renders DashScope CNY pricing without pretending it is USD", () => {
    const runtime = resolveModelRuntime("dashscope:qwen-plus", {
      DASHSCOPE_API_KEY: "test-key",
    });
    const agent = createCodingAgent({
      cwd: process.cwd(),
      model: runtime.model,
      llmOptions: runtime.llmOptions ?? {},
    });

    const text = renderRunReport({
      summary: {
        turns: 1,
        continuations: 0,
        reason: "done",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
      wallTimeMs: 1,
      cwd: agent.cwd,
      model: "dashscope:qwen-plus",
      readOnly: false,
      logPath: agent.logPath,
      costKnown: agent.costKnown,
      costEstimate: {
        amount: 0.18,
        currency: "CNY",
        source: "test pricing",
      },
      costStats: {
        inputTokens: 100,
        outputTokens: 50,
        cachedTokens: 0,
        costUSD: 0,
        durationMs: 1,
        llmDurationMs: 1,
        avgLlmDurationMs: 1,
        llmCallCount: 1,
        byModel: new Map([
          [
            "qwen-plus",
            {
              input: 100,
              output: 50,
              cached: 0,
              costUSD: 0,
              calls: 1,
              durationMs: 1,
            },
          ],
        ]),
      },
    });

    expect(text).toContain("cost: ¥0.180000 CNY (test pricing)");
    expect(text).toContain("cost=included in CNY estimate");
    expect(text).not.toContain("cost: $0.000000");
  });

  it("renders unknown DashScope model pricing as n/a instead of fake zero dollars", () => {
    const runtime = resolveModelRuntime("dashscope:qwen-unknown-local", {
      DASHSCOPE_API_KEY: "test-key",
    });
    const agent = createCodingAgent({
      cwd: process.cwd(),
      model: runtime.model,
      llmOptions: runtime.llmOptions ?? {},
    });

    const text = renderRunReport({
      summary: {
        turns: 1,
        continuations: 0,
        reason: "done",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
      wallTimeMs: 1,
      cwd: agent.cwd,
      model: "dashscope:qwen-unknown-local",
      readOnly: false,
      logPath: agent.logPath,
      costKnown: agent.costKnown,
      costStats: {
        inputTokens: 100,
        outputTokens: 50,
        cachedTokens: 0,
        costUSD: 0,
        durationMs: 1,
        llmDurationMs: 1,
        avgLlmDurationMs: 1,
        llmCallCount: 1,
        byModel: new Map(),
      },
    });

    expect(text).toContain("cost: n/a");
    expect(text).not.toContain("cost: $0.000000");
  });
});

describe("DashScope pricing math", () => {
  const usage = (input: number, output: number, cacheRead = 0): Usage => ({
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    totalTokens: input + output + cacheRead,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });

  it("selects the qwen-plus pricing tier by input length", () => {
    // tier 1 (input <= 128k): 0.8 / 2 CNY per Mtok → 0.1*0.8 + 0.05*2
    expect(
      estimateDashScopeCostCny("qwen-plus", usage(100_000, 50_000))?.amount,
    ).toBeCloseTo(0.18);
    // tier 2 (128k < input <= 256k): 2.4 / 20 → 0.2*2.4 + 0.1*20
    expect(
      estimateDashScopeCostCny("qwen-plus", usage(200_000, 100_000))?.amount,
    ).toBeCloseTo(2.48);
    // tier 3 (256k < input <= 1M): 4.8 / 48 → 0.5*4.8 + 0.1*48
    expect(
      estimateDashScopeCostCny("qwen-plus", usage(500_000, 100_000))?.amount,
    ).toBeCloseTo(7.2);
  });

  it("clamps to the highest tier when input exceeds every tier ceiling", () => {
    // input 2M > 1M ceiling → falls back to tier 3 (4.8 input rate): 2.0*4.8
    expect(
      estimateDashScopeCostCny("qwen-plus", usage(2_000_000, 0))?.amount,
    ).toBeCloseTo(9.6);
  });

  it("matches the single open-ended tier for qwen-turbo", () => {
    // qwen-turbo has one tier with no maxInputTokens: 0.3 / 0.6 → 1*0.3 + 1*0.6
    expect(
      estimateDashScopeCostCny("qwen-turbo", usage(1_000_000, 1_000_000))
        ?.amount,
    ).toBeCloseTo(0.9);
  });

  it("prices qwen3.7-max at one tier with no separate thinking rate", () => {
    // 12 input / 36 output per Mtok: 0.1*12 + 0.05*36 = 1.2 + 1.8 = 3.0
    const u = usage(100_000, 50_000);
    expect(estimateDashScopeCostCny("qwen3.7-max", u)?.amount).toBeCloseTo(3.0);
    // 思维链+回答 share the 36 rate → thinking flag must not change the cost
    expect(
      estimateDashScopeCostCny("qwen3.7-max", u, { thinking: true })?.amount,
    ).toBeCloseTo(3.0);
    // cached read still gets the 20% discount: fresh 50k@12 + cached 50k@2.4
    expect(
      estimateDashScopeCostCny("qwen3.7-max", usage(50_000, 0, 50_000))?.amount,
    ).toBeCloseTo(0.72);
  });

  it("bills cached-read input at the 20% implicit-cache rate", () => {
    // tier 1, total 100k input. fresh 50k @ 0.8 + cached 50k @ 0.8*0.2(=0.16)
    // = 0.04 + 0.008 = 0.048 (would be 0.08 if cached were billed at full rate)
    expect(
      estimateDashScopeCostCny("qwen-plus", usage(50_000, 0, 50_000))?.amount,
    ).toBeCloseTo(0.048);
    // pure-cached read is exactly 20% of the equivalent fresh-input cost
    expect(
      estimateDashScopeCostCny("qwen-plus", usage(0, 0, 100_000))?.amount,
    ).toBeCloseTo(0.016);
  });

  it("applies the thinking output rate only when requested", () => {
    const u = usage(100_000, 50_000);
    expect(
      estimateDashScopeCostCny("qwen-plus", u, { thinking: false })?.amount,
    ).toBeCloseTo(0.18);
    // tier 1 thinking output rate is 8 (vs 2): 0.1*0.8 + 0.05*8 = 0.48
    expect(
      estimateDashScopeCostCny("qwen-plus", u, { thinking: true })?.amount,
    ).toBeCloseTo(0.48);
  });

  it("returns undefined for unpriced models and missing usage", () => {
    expect(
      estimateDashScopeCostCny("qwen-unknown-local", usage(100, 50)),
    ).toBeUndefined();
    expect(
      getDashScopeModelMetadata("qwen-unknown-local").pricingCny,
    ).toBeUndefined();
    expect(estimateDashScopeCostCny("qwen-plus", undefined)).toBeUndefined();
  });
});
