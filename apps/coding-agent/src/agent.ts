import { join, resolve } from "node:path";
import {
  AgentSession,
  type Api,
  type HarnessTool,
  type Hook,
  type Model,
  type RunSummary,
  type SessionEvent,
  type ToolCall,
  type Usage,
} from "@harness-pi/core";
import {
  costTracker,
  emptyRunGuard,
  metrics,
  NdjsonFileSink,
  permissionGate,
  repeatedCallGuard,
  sessionLog,
  toolStats,
  trimHistory,
  type CostStats,
  type CostTrackerOptions,
  type MetricsSink,
  type PermissionRule,
  type ToolStats,
} from "@harness-pi/plugins";
import { defaultPermissionRules } from "./tui/permissions.js";
import {
  createAllTools,
  readOnlyToolNames,
  toolNames,
  type ToolName,
  type ToolsOptions,
} from "@harness-pi/tools";
import {
  calculateCost,
  getEnvApiKey,
  getModels,
  getProviders,
} from "@mariozechner/pi-ai";
import type { RunReport } from "./output.js";
import {
  estimateDashScopeCostCny,
  isDashScopeProviderAlias,
  resolveDashScopeModel,
  type DashScopeCostEstimate,
} from "./providers/dashscope.js";

export interface CreateCodingAgentOptions {
  cwd: string;
  model: Model<Api>;
  readOnly?: boolean;
  disabledTools?: ToolName[];
  logDir?: string;
  metricsFile?: string;
  systemPrompt?: string;
  toolsOptions?: ToolsOptions;
  llmOptions?: Record<string, unknown>;
  maxTurns?: number;
  costModel?: CostTrackerOptions["costModel"];
  /**
   * 启用 tool 审批门（permissionGate）。给了即挂；onAsk 默认 deny，调用方经
   * `setApprovalHandler` 注入真正的"问人"实现（TUI 弹窗）。`--yolo` 等价于不给本项。
   */
  permission?: { rules?: PermissionRule[]; timeoutMs?: number };
}

export interface CodingAgent {
  session: AgentSession;
  tools: HarnessTool[];
  cwd: string;
  model: Model<Api>;
  costKnown: boolean;
  warnings: string[];
  readOnly: boolean;
  logPath: string;
  metricsPath?: string | undefined;
  metricsSink?: MetricsSink | undefined;
  close(): Promise<void>;
  getCostEstimate(): RunReport["costEstimate"];
  getCostStats(): CostStats | undefined;
  getToolStats(): ToolStats | undefined;
  /** 注入 tool 审批"问人"实现（permissionGate.onAsk 经 holder 委托到它）；返回 true=allow once。 */
  setApprovalHandler(handler: (call: ToolCall) => Promise<boolean>): void;
}

export interface RunAgentPromptOptions {
  onEvent?: (event: SessionEvent) => void | Promise<void>;
}

export interface ResolvedModelRuntime {
  model: Model<Api>;
  llmOptions?: Record<string, unknown>;
}

const DEFAULT_SYSTEM_PROMPT = [
  "You are @harness-pi/coding-agent, a dogfood coding agent for harness-pi.",
  "Use the available tools to inspect and edit the target repository.",
  "Keep changes scoped to the user's request and summarize what changed.",
].join("\n");

export function resolveModelSpec(
  cliModel: string | undefined,
  env: { HARNESS_PI_MODEL?: string | undefined } = process.env,
): string {
  const model = cliModel ?? env.HARNESS_PI_MODEL;
  if (!model || model.trim().length === 0) {
    throw new Error(
      "Missing model. Pass --model provider:modelId or set HARNESS_PI_MODEL.",
    );
  }
  return model.trim();
}

export function resolveModel(
  spec: string,
  env: {
    DASHSCOPE_API_KEY?: string | undefined;
    QWEN_API_KEY?: string | undefined;
  } = process.env,
): Model<Api> {
  const runtime = resolveModelRuntime(spec, env);
  if (runtime.llmOptions) {
    throw new Error(
      `resolveModel("${spec}") requires runtime LLM options; use resolveModelRuntime() instead.`,
    );
  }
  return runtime.model;
}

export function resolveModelRuntime(
  spec: string,
  env: {
    DASHSCOPE_API_KEY?: string | undefined;
    QWEN_API_KEY?: string | undefined;
  } = process.env,
): ResolvedModelRuntime {
  const sep = spec.indexOf(":");
  if (sep <= 0 || sep === spec.length - 1) {
    throw new Error(`Invalid model "${spec}". Expected provider:modelId.`);
  }

  const provider = spec.slice(0, sep);
  const modelId = spec.slice(sep + 1);
  if (isDashScopeProviderAlias(provider)) {
    return resolveDashScopeModel(modelId, env);
  }

  const providers = getProviders() as string[];
  if (!providers.includes(provider)) {
    throw new Error(
      `Unknown provider "${provider}". Known providers: ${providers.concat("dashscope", "qwen").join(", ")}`,
    );
  }

  const knownModels = getModels(provider as never);
  const model = knownModels.find((candidate) => candidate.id === modelId);
  if (!model) {
    const known = knownModels.map((candidate) => candidate.id);
    throw new Error(
      `Unknown model "${modelId}" for provider "${provider}". Known models: ${known.join(", ")}`,
    );
  }

  if (!getEnvApiKey(provider)) {
    throw new Error(
      `Missing API credentials for provider "${provider}". Set the provider's pi-ai environment variable before running.`,
    );
  }
  return { model: model as Model<Api> };
}

export function createPiAiCostModel(
  model: Model<Api>,
): NonNullable<CostTrackerOptions["costModel"]> {
  return (_modelId, usage) => {
    const piUsage: Usage = {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cached,
      cacheWrite: 0,
      totalTokens: usage.input + usage.output + usage.cached,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    };
    return calculateCost(model, piUsage).total;
  };
}

export function createCodingAgent(opts: CreateCodingAgentOptions): CodingAgent {
  const cwd = resolve(opts.cwd);
  const readOnly = opts.readOnly ?? false;
  const toolModeOptions: {
    readOnly?: boolean;
    disabledTools?: ToolName[];
    toolsOptions?: ToolsOptions;
  } = { readOnly };
  if (opts.disabledTools !== undefined) {
    toolModeOptions.disabledTools = opts.disabledTools;
  }
  if (opts.toolsOptions !== undefined) {
    toolModeOptions.toolsOptions = opts.toolsOptions;
  }
  const tools = createToolsForMode(cwd, toolModeOptions);
  const logDir = opts.logDir ?? join(cwd, ".harness-pi", "logs");
  const metricsSink = opts.metricsFile
    ? new NdjsonFileSink({ path: opts.metricsFile, batchSize: 1 })
    : undefined;
  const costKnown = opts.costModel !== undefined || hasModelPricing(opts.model);
  const resolvedCostModel =
    opts.costModel ?? (costKnown ? createPiAiCostModel(opts.model) : undefined);
  let lastCostStats: CostStats | undefined;
  let lastToolStats: ToolStats | undefined;
  const warnings: string[] = [];
  const dashScopeCost = createDashScopeCostAccumulator(opts.model, opts.llmOptions);
  const costTrackerOptions: CostTrackerOptions = {
    mode: "lifetime",
    onSessionFinalized(_ctx, stats) {
      lastCostStats = cloneCostStats(stats);
    },
  };
  if (resolvedCostModel) costTrackerOptions.costModel = resolvedCostModel;

  // 审批 holder：permissionGate.onAsk 委托到它；默认 deny（安全），TUI 经 setApprovalHandler 注入弹窗。
  let approvalHandler: (call: ToolCall) => Promise<boolean> = async () => false;
  const permission = opts.permission;

  const hooks = [
    sessionLog({ dir: logDir }),
    trimHistory({ keepRecent: 12 }),
    emptyRunGuard({ maxEmptyTurns: 3 }),
    repeatedCallGuard({
      threshold: 4,
      windowSize: 20,
      onRepeat(ctx, pattern) {
        ctx.abort(
          `repeated-call-guard: ${pattern.tool} repeated ${pattern.count} times`,
        );
      },
    }),
    costTracker(costTrackerOptions),
    ...(dashScopeCost ? [dashScopeCost.hook] : []),
    toolStats({
      onSessionFinalized(_ctx, stats) {
        lastToolStats = cloneToolStats(stats);
      },
    }),
    ...(metricsSink ? [metrics({ sink: metricsSink })] : []),
    ...(permission
      ? [
          permissionGate({
            rules: permission.rules ?? defaultPermissionRules(),
            fallback: "deny",
            onAsk: (call) => approvalHandler(call),
            // onAsk 要等用户在弹窗里拍板，远超内核 decision 默认 200ms——放大避免必然超时判 deny。
            timeout: permission.timeoutMs ?? 600_000,
          }),
        ]
      : []),
  ];

  const sessionOptions: ConstructorParameters<typeof AgentSession>[0] = {
    model: opts.model,
    tools,
    hooks,
    systemPrompt: opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
  };
  if (opts.maxTurns !== undefined) sessionOptions.maxTurns = opts.maxTurns;
  if (opts.llmOptions !== undefined) sessionOptions.llmOptions = opts.llmOptions;
  const session = new AgentSession(sessionOptions);

  return {
    session,
    tools,
    cwd,
    model: opts.model,
    costKnown,
    warnings,
    readOnly,
    logPath: join(logDir, `${session.id}.ndjson`),
    metricsPath: opts.metricsFile,
    metricsSink,
    async close() {
      await closeSink(metricsSink);
    },
    getCostEstimate() {
      if (dashScopeCost) return dashScopeCost.getEstimate();
      const stats = lastCostStats;
      if (!costKnown || !stats) return undefined;
      return {
        amount: stats.costUSD,
        currency: "USD",
        source: "pi-ai model cost table",
      };
    },
    getCostStats() {
      return lastCostStats;
    },
    getToolStats() {
      return lastToolStats;
    },
    setApprovalHandler(handler) {
      approvalHandler = handler;
    },
  };
}

export async function runAgentPrompt(
  agent: CodingAgent,
  prompt: string,
  opts: RunAgentPromptOptions = {},
): Promise<RunReport> {
  const startMs = Date.now();
  const stream = agent.session.runStreaming(prompt);
  for await (const event of stream) {
    await opts.onEvent?.(event);
  }
  const summary = await stream.finalSummary;
  await flushAgent(agent);
  return buildReport(agent, summary, Date.now() - startMs);
}

export function createToolsForMode(
  cwd: string,
  opts: {
    readOnly?: boolean;
    disabledTools?: ToolName[];
    toolsOptions?: ToolsOptions;
  } = {},
): HarnessTool[] {
  const all = createAllTools(cwd, opts.toolsOptions);
  const names = opts.readOnly ? readOnlyToolNames : toolNames;
  const disabled = new Set(opts.disabledTools ?? []);
  return names
    .filter((name) => !disabled.has(name))
    .map((name) => {
      const tool = all[name];
      if (!tool) {
        throw new Error(`Tool factory did not create required tool "${name}".`);
      }
      return tool;
    });
}

async function flushAgent(agent: CodingAgent): Promise<void> {
  const sink = agent.metricsSink;
  if (!sink?.flush) return;
  for (let i = 0; i < 10; i++) {
    await sink.flush();
    const stats = sink.stats?.();
    if (!stats || stats.pending === 0) return;
  }
  const stats = sink.stats?.();
  const pending = stats?.pending ?? "unknown";
  agent.warnings.push(
    `metrics sink still has ${pending} pending event(s) after flush drain`,
  );
}

async function closeSink(sink: MetricsSink | undefined): Promise<void> {
  await sink?.close?.();
}

function buildReport(
  agent: CodingAgent,
  summary: RunSummary,
  wallTimeMs: number,
): RunReport {
  return {
    summary,
    wallTimeMs,
    cwd: agent.cwd,
    model: `${agent.model.provider}:${agent.model.id}`,
    costKnown: agent.costKnown,
    readOnly: agent.readOnly,
    logPath: agent.logPath,
    metricsPath: agent.metricsPath,
    warnings: agent.warnings,
    costEstimate: agent.getCostEstimate(),
    costStats: agent.getCostStats(),
    toolStats: agent.getToolStats(),
  };
}

function hasModelPricing(model: Model<Api>): boolean {
  return (
    model.cost.input > 0 ||
    model.cost.output > 0 ||
    model.cost.cacheRead > 0 ||
    model.cost.cacheWrite > 0
  );
}

function cloneCostStats(stats: CostStats): CostStats {
  return {
    ...stats,
    byModel: new Map(
      [...stats.byModel.entries()].map(([model, value]) => [
        model,
        { ...value },
      ]),
    ),
  };
}

function cloneToolStats(stats: ToolStats): ToolStats {
  return {
    ...stats,
    spans: stats.spans.map((span) => ({ ...span })),
    byTool: new Map(
      [...stats.byTool.entries()].map(([tool, value]) => [
        tool,
        { ...value },
      ]),
    ),
  };
}

function createDashScopeCostAccumulator(
  model: Model<Api>,
  llmOptions: Record<string, unknown> | undefined,
):
  | {
      hook: Hook;
      getEstimate(): DashScopeCostEstimate | undefined;
    }
  | undefined {
  if (model.provider !== "dashscope") return undefined;

  let total = 0;
  let source: string | undefined;
  const thinking = typeof llmOptions?.["reasoningEffort"] === "string";
  return {
    hook: {
      name: "dashscope-cost-estimator",
      internal: true,
      onLlmEnd(input) {
        const estimate = estimateDashScopeCostCny(model.id, input.msg.usage, {
          thinking,
        });
        if (!estimate) return;
        total += estimate.amount;
        source = estimate.source;
      },
    },
    getEstimate() {
      if (!source) return undefined;
      return { amount: total, currency: "CNY", source };
    },
  };
}
