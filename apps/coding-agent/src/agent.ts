import { join, resolve, sep } from "node:path";
import {
  AgentSession,
  type Api,
  type HarnessTool,
  type Hook,
  type Model,
  type RunSummary,
  type SessionEvent,
  type SessionStore,
  type ToolCall,
  type Usage,
} from "@harness-pi/core";
import {
  compactSummarize,
  costTracker,
  emptyRunGuard,
  metrics,
  NdjsonFileSink,
  permissionGate,
  repeatedCallGuard,
  sessionLog,
  toolStats,
  trimHistory,
  type CompactSummarizeOptions,
  type CostStats,
  type CostTrackerOptions,
  type MetricsSink,
  type PermissionRule,
  type ToolStats,
} from "@harness-pi/plugins";
import { createModelSummarizer } from "./compaction.js";
import { redactCodingToolArgs } from "./log-redaction.js";
import { harnessPiGitignoreWarning } from "./workspace-safety.js";
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
  /**
   * session log 是否挂载。默认 true；false ⇒ 完全不挂 sessionLog（不落盘任何 event）。
   */
  log?: boolean;
  /**
   * session log 里 tool args 的记录方式。默认 "redacted"：write 内容 / edit 文本 / bash 命令仅记长度、
   * 不落原文（见 log-redaction.ts）。"full" ⇒ 记原始 args（仅本地调试）；"none" ⇒ 不记 args。
   */
  logArgs?: "redacted" | "full" | "none";
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
  /**
   * 会话持久化：给了即每个 turn 把新 messages append 进 store，崩溃后可用
   * `resumeCodingAgent`（同一 store + sessionId）续跑。
   *
   * store 与 sessionId **故意捆成一个子对象**：sessionId 既给落盘文件命名、又是日后 resume 的唯一句柄；
   * 二者拆开会出现"落了盘却拿不到 id（内核随机生成）从而无法 resume"的死角——合成子对象让这种非法状态不可表达。
   */
  persistence?: { store: SessionStore; sessionId: string };
  /**
   * 启用 compaction（compactSummarize view-transform：超阈值时把早期消息换成模型生成的摘要喂给 LLM，
   * 不毁原始历史）。给了即挂 hook；`maxMessages` 不给 = 阈值设为大哨兵（在位但不自动触发），靠
   * `requestCompaction()`（TUI 的 `/compact`）临时降阈强制压缩。one-shot 模式不传本项即完全不挂。
   */
  compaction?: { maxMessages?: number; keepRecent?: number };
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
  /** 手动触发压缩（/compact）：降低阈值，下一 turn 起把早期消息压成摘要。未启用 compaction 时 no-op。 */
  requestCompaction(): void;
  /** compaction 状态；未启用时 undefined。enabled = 阈值已降到会自动触发的程度。 */
  getCompactionState(): { enabled: boolean; maxMessages: number; keepRecent: number } | undefined;
  /** 注册"压缩发生"回调（每次实际跑 summarize 时以被压缩的早期消息条数调用）；用于 TUI 反馈。 */
  setCompactionListener(listener: (coveredCount: number) => void): void;
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

/**
 * 共享上下文：把 createCodingAgent / resumeCodingAgent 都要的 tools + hooks + deps + 装配闭包抽出来，
 * 这样"新建 session"和"从 store resume session"复用同一套 tools/hooks/accessor 闭包，只是 session 来源不同。
 */
interface AgentContext {
  /**
   * 喂给 `new AgentSession(...)` 或 `AgentSession.resume(...,deps)` 的构造参数。Omit 掉的四个键里
   * store/sessionId 由各入口自己补；initialMessages/resumedMessageCount 是 resume 内部独占（见
   * session.ts:996）——把它们一并 Omit 掉，编译器就能挡住"buildAgentContext 误塞 initialMessages 却被
   * resume 静默覆盖"这种隐患（与 `AgentSession.resume` 的 opts 形状精确对齐）。
   */
  deps: Omit<
    ConstructorParameters<typeof AgentSession>[0],
    "store" | "sessionId" | "initialMessages" | "resumedMessageCount"
  >;
  tools: HarnessTool[];
  /** 用一个已就绪的 session（新建或 resume 来的）装配出对外的 CodingAgent。**只能调一次**：闭包里的
   *  lastCostStats/approvalHandler 等是单会话可变状态，调两次会让两个 CodingAgent 共享同一份状态。 */
  assemble(session: AgentSession): CodingAgent;
}

function buildAgentContext(opts: CreateCodingAgentOptions): AgentContext {
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
  // .harness-pi 落盘安全守卫（#22）：会往 cwd/.harness-pi 落盘（默认 session log 在此，或挂了 resume
  // 存储）且该目录未被 gitignore 时，提示完整原文有被误提交的风险（resume 存储无法脱敏）。
  const harnessDir = join(cwd, ".harness-pi");
  const writesUnderHarnessPi =
    (opts.log !== false &&
      (logDir === harnessDir || logDir.startsWith(harnessDir + sep))) || // 路径边界，不误命中 .harness-pi-backup
    opts.persistence !== undefined;
  if (writesUnderHarnessPi) {
    const w = harnessPiGitignoreWarning(cwd);
    if (w) warnings.push(w);
  }
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

  // Compaction（P4）：用一个**可变** opts 对象——compactSummarize 在闭包里实时读 maxMessages/keepRecent，
  // 故 requestCompaction() 直接改 maxMessages 即可让 /compact 临时降阈、下一 turn 起强制压缩。
  // maxMessages 不给 = OFF 哨兵（hook 在位但永不自动触发，零额外 LLM 成本，专等手动 /compact）。
  const COMPACTION_OFF = Number.MAX_SAFE_INTEGER;
  let compactionListener: ((coveredCount: number) => void) | undefined;
  let compactionOpts: CompactSummarizeOptions | undefined;
  if (opts.compaction) {
    const baseSummarize = createModelSummarizer(opts.model, opts.llmOptions);
    compactionOpts = {
      maxMessages: opts.compaction.maxMessages ?? COMPACTION_OFF,
      keepRecent: opts.compaction.keepRecent ?? 8,
      async summarize(early, ctx) {
        const text = await baseSummarize(early, ctx.signal); // 抛错→fail-open；透传 signal 可中途取消
        compactionListener?.(early.length); // 成功才通知 TUI（抛错时不算"压缩发生"）
        return text;
      },
    };
  }

  // session log：默认挂；`log:false` 完全不挂。logArgs 控制 tool args 记录方式（默认 redacted 脱敏，
  // 防止 write 内容 / edit 文本 / bash 命令含密钥静默落盘到 .harness-pi/logs）。
  const logArgs = opts.logArgs ?? "redacted";
  const sessionLogOptions: Parameters<typeof sessionLog>[0] = { dir: logDir };
  if (logArgs === "redacted") sessionLogOptions.redactToolArgs = redactCodingToolArgs;
  else if (logArgs === "none") sessionLogOptions.redactToolArgs = () => "[args omitted]";
  // logArgs === "full"：不设 redactToolArgs，记原始 args。

  const hooks = [
    ...(opts.log === false ? [] : [sessionLog(sessionLogOptions)]),
    // compactSummarize 须排在 trimHistory 前：先把早期消息总结成 summary，再让 trimHistory 裁中段
    // toolResult（docs/09 §3.6「先 summarize 早期、再 trim 中段」的组合顺序）。未启用 compaction 时不挂。
    ...(compactionOpts ? [compactSummarize(compactionOpts)] : []),
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

  const deps: AgentContext["deps"] = {
    model: opts.model,
    tools,
    hooks,
    systemPrompt: opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
  };
  if (opts.maxTurns !== undefined) deps.maxTurns = opts.maxTurns;
  if (opts.llmOptions !== undefined) deps.llmOptions = opts.llmOptions;

  return {
    deps,
    tools,
    assemble(session) {
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
        requestCompaction() {
          if (!compactionOpts) return; // 未启用 compaction：no-op
          // 降到最低有效阈值（keepRecent+1）：下一 turn 起，超出 keepRecent 的早期消息都被压成摘要。
          compactionOpts.maxMessages = compactionOpts.keepRecent + 1;
        },
        getCompactionState() {
          if (!compactionOpts) return undefined;
          return {
            enabled: compactionOpts.maxMessages < COMPACTION_OFF,
            maxMessages: compactionOpts.maxMessages,
            keepRecent: compactionOpts.keepRecent,
          };
        },
        setCompactionListener(listener) {
          compactionListener = listener;
        },
      };
    },
  };
}

/**
 * 新建一个 coding agent。给了 `persistence` 即每个 turn 落盘，崩溃后可用 `resumeCodingAgent` 续跑。
 */
export function createCodingAgent(opts: CreateCodingAgentOptions): CodingAgent {
  const ctx = buildAgentContext(opts);
  const sessionOptions: ConstructorParameters<typeof AgentSession>[0] = {
    ...ctx.deps,
  };
  if (opts.persistence) {
    sessionOptions.store = opts.persistence.store;
    sessionOptions.sessionId = opts.persistence.sessionId;
  }
  return ctx.assemble(new AgentSession(sessionOptions));
}

/**
 * 从 store 的落盘历史 resume 一个 coding agent：复用同一套 tools/hooks/deps，
 * 经 `AgentSession.resume` 重建对话历史后装配出 CodingAgent，可直接续跑。
 * `persistence` 在此为必填（resume 必须知道从哪个 store、哪个 sessionId 回放）。
 */
export async function resumeCodingAgent(
  opts: CreateCodingAgentOptions & {
    persistence: { store: SessionStore; sessionId: string };
  },
): Promise<CodingAgent> {
  const ctx = buildAgentContext(opts);
  const { store, sessionId } = opts.persistence;
  const session = await AgentSession.resume(store, sessionId, ctx.deps);
  return ctx.assemble(session);
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
