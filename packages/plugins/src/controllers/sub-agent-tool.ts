/**
 * subAgent tool factory —— 让模型把一个自包含子任务委派给一个 **bounded sub-agent**（docs/09 §4.7，#14）。
 *
 * 借 cc AgentTool / codex AgentControl 的形态，但**严格 bounded**：每个 tool 实例有 `maxSubAgents` 派发上限；
 * 单个 sub-agent 的轮数/预算由 `sessionFactory` 造的 AgentSession 自己限（maxTurns 等）。这是模型驱动的子代理
 * 原语——**不是顶层 meta-agent**：它就是一个普通 HarnessTool，复用 AgentSession 跑子任务、把结果回灌给父模型。
 *
 * **domain-free**：本工厂不认识任何业务（题/KB/证据）；子任务怎么跑、用什么 tools/systemPrompt 全在调用方的
 * `sessionFactory` 里。父 session 的 abort signal 透传给 sub-agent（协作式取消）。
 */

import type { AgentSession, Hook, HarnessTool, HookContext, Message, RunSummary, ToolExecResult } from "@harness-pi/core";
import { Type } from "@earendil-works/pi-ai";

/**
 * 跨层递归深度透传 key（#45）。父 session execute 时读它（缺省 0）；spawn 子 session 时把
 * 子 ctx.state 的同 key 设为 当前+1，故子若也挂 subAgentTool 读到的已是递增后的深度。
 * 注册进 HookStateRegistry → `ctx.state.get/set` 自动推断成 number，无需 cast。
 */
const DEPTH_KEY = "subAgent.depth";

declare module "@harness-pi/core" {
  interface HookStateRegistry {
    "subAgent.depth": number;
  }
}

export interface SubAgentToolOptions {
  /** tool name（默认 "subAgent"）。 */
  name?: string;
  /** tool description（给模型看的，默认通用文案）。 */
  description?: string;
  /** 造一个 sub-agent AgentSession 的工厂（拿到子任务 + 父 ctx）。bounded 由这里造的 session 自限轮数。 */
  sessionFactory: (task: string, ctx: HookContext) => AgentSession;
  /** 本 tool 实例最多派多少个 sub-agent（**横向**闸：防单层失控扇出）。默认 8。 */
  maxSubAgents?: number;
  /**
   * 跨层递归**纵向**深度闸（#45）：从顶层 session（depth 0）算起，最多嵌套到多少层 subAgent。
   * 默认 2 —— 主 session(0) → 子(1) → 孙(2) 这层 spawn 即被挡（孙再 spawn 才报错）。与 `maxSubAgents`
   * 正交：一纵一横，互不干扰。
   */
  maxDepth?: number;
  /**
   * **opt-in 续聊接缝（S4）**：每 spawn 完一个子 session（跑完首轮）就回调一次，让调用方留住句柄以便按 id
   * 续聊（典型：传 `SubAgentRegistry.retain`）。**默认不传 → 子 session 跑完即弃（0.2.4 逐字节一致）**。
   */
  onSpawn?: (session: AgentSession) => void;
}

/** 取一条 message 的纯文本（content 可能是 string 或 block 数组）。 */
function messageText(m: Message | undefined): string {
  if (!m) return "";
  return typeof m.content === "string"
    ? m.content
    : m.content
        .map((b) => ("text" in b && typeof b.text === "string" ? b.text : ""))
        .join("");
}

/**
 * 共享：把一次子 session run/continue 的终态整形成回灌父模型的 ToolExecResult。
 * spawn 路径与续聊路径（SubAgentRegistry.continueSubAgent）都走这里 → 两边 shape **逐字段一致**。
 *
 * content = 子最后一条 assistant 的纯文本（回灌父模型）；details.subAgent = 结构化终态（trace/metrics 用），
 * 含 `sessionId`（S4：父据此对该子 agent 续聊）+ 现有 reason/turns/usage/stopReason。
 */
export function subAgentResult(sub: AgentSession, summary: RunSummary): ToolExecResult {
  const text = messageText(summary.lastMessage) || "(sub-agent produced no text output)";
  return {
    content: [{ type: "text", text }],
    details: {
      subAgent: {
        sessionId: sub.id,
        reason: summary.reason,
        turns: summary.turns,
        usage: summary.usage,
        ...(summary.stopReason ? { stopReason: summary.stopReason } : {}),
      },
    },
  };
}

/**
 * 共享：spawn 一个 sub-agent session 并整形结果。单 factory 版与 routed 版（#59）都走这里——
 * 纵向深度透传（给子挂 onSessionStart hook 把深度设为 父+1）、父 signal 透传、子终态回灌全在此收口。
 * 横向/纵向闸由调用方在调用前各自判（错误文案各自独立），故本函数只管「确实要 spawn 时」的动作。
 *
 * `onSpawn`（opt-in）：spawn 完一拿到终态就回调，让调用方（如 SubAgentRegistry）把子 session 留住以便续聊。
 * 不传则子 session 跑完即弃（0.2.4 行为）。在 run 之后调 → 句柄已带完整首轮上下文。
 */
async function spawnSubAgent(
  sub: AgentSession,
  task: string,
  depth: number,
  signal: AbortSignal,
  onSpawn?: (session: AgentSession) => void,
): Promise<ToolExecResult> {
  // 纵向深度透传：给子 session 挂一个 onSessionStart hook，把子 ctx.state 的深度设为 当前+1。
  // 子 session 自己的（routed）subAgentTool（若有）execute 时就读到递增后的深度——多分支各自从父继承，
  // 互不串扰（每个子 session 有独立 ctx.state）。零内核改动：只用现成的 use()/onSessionStart。
  const depthInjector: Hook = {
    name: "subAgent.depth-injector",
    internal: true,
    onSessionStart(_input, subCtx) {
      subCtx.state.set(DEPTH_KEY, depth + 1);
    },
  };
  sub.use(depthInjector);
  // 父 signal 透传 → sub-agent 可被父的 abort 协作式取消。
  const summary = await sub.run(task, { signal });
  // opt-in 续聊：把跑完首轮的子 session 留住（默认不传 → 跑完即弃）。
  onSpawn?.(sub);
  return subAgentResult(sub, summary);
}

export function subAgentTool(opts: SubAgentToolOptions): HarnessTool {
  const max = opts.maxSubAgents ?? 8;
  const maxDepth = opts.maxDepth ?? 2;
  let spawned = 0;

  return {
    name: opts.name ?? "subAgent",
    description:
      opts.description ??
      "Delegate a self-contained sub-task to a bounded sub-agent and receive its final result.",
    parameters: Type.Object({
      task: Type.String({
        description: "A self-contained task for the sub-agent to carry out.",
      }),
    }),

    async execute(args, ctx, signal) {
      const task = typeof args.task === "string" ? args.task : "";
      // throw 是 HarnessTool 的错误合约（kernel 包成 isError 回灌模型）——空任务 / 超预算 / 超深都 fail-loud。
      if (task.trim().length === 0) {
        throw new Error("subAgent: empty task");
      }
      // 纵向闸（#45）：读**当前** session 深度（缺省 0）。到顶就不 spawn——挡在横向计数之前，
      // 让超深的尝试不消耗本层 maxSubAgents 预算（二闸正交）。
      const depth = ctx.state.get(DEPTH_KEY) ?? 0;
      if (depth >= maxDepth) {
        throw new Error(`subAgent: depth limit (maxDepth=${maxDepth}) reached`);
      }
      // 横向闸：本 tool 实例的扇出预算。
      if (spawned >= max) {
        throw new Error(`subAgent: budget exhausted (max ${max} sub-agents per tool)`);
      }
      spawned++;

      const sub = opts.sessionFactory(task, ctx);
      return spawnSubAgent(sub, task, depth, signal, opts.onSpawn);
    },
  };
}

/* ──────────────── routed 变体（#59 / S3） ──────────────── */

/**
 * 一种可路由的 sub-agent 规格（**domain-free**：只是「类型标识 + 选择依据 + 怎么造 session」，
 * 不含任何业务/文件布局概念）。父模型据 `whenToUse` 在多个 spec 间挑一个 `type` 来分派。
 */
export interface AgentSpec {
  /** 路由标识。父模型用它在 `agent_type` 参数里点名；同一 tool 内须唯一。 */
  type: string;
  /** 给模型看的选择依据——拼进 tool description，让模型据此决定派给哪种 agent。 */
  whenToUse: string;
  /**
   * 造这种 sub-agent 的 AgentSession 工厂——与单 factory 版 `SubAgentToolOptions.sessionFactory`
   * 同型 `(task, ctx)`。这种 sub-agent 的轮数/预算（maxTurns 等）由工厂在 `new AgentSession(...)`
   * 时自行闭包决定，不在 spec 上重复声明。
   */
  sessionFactory: (task: string, ctx: HookContext) => AgentSession;
}

export interface RoutedSubAgentToolOptions {
  /** 候选 agent 规格（至少一个）。`agent_type` 枚举 = 全部 spec 的 `type`。 */
  specs: AgentSpec[];
  /** tool name（默认 "subAgent"）。 */
  name?: string;
  /**
   * tool description 前缀（给模型看的总体说明）。各 spec 的 `whenToUse` 会**自动拼在其后**，
   * 故这里只写「这是个会路由的子代理工具」之类的总纲，不必重复每种 agent 的用途。
   */
  description?: string;
  /** 本 tool 实例最多派多少个 sub-agent（**横向**闸：跨所有 type 合计）。默认 8。 */
  maxSubAgents?: number;
  /** 跨层递归**纵向**深度闸（#45），语义同单 factory 版。默认 2。 */
  maxDepth?: number;
  /**
   * **opt-in 续聊接缝（S4）**：语义同单 factory 版——每 spawn 完一个子 session 就回调一次（跨所有 type）。
   * 默认不传 → 子 session 跑完即弃。
   */
  onSpawn?: (session: AgentSession) => void;
}

/**
 * routed sub-agent tool factory（#59）——在单 factory 版旁加一个**多规格、按 `agent_type` 路由**的变体。
 *
 * 与单 factory 版共享同一套 bounded 机制：横向 `maxSubAgents` 扇出闸 + 纵向 `maxDepth` 跨层深度闸（#45）
 * 都对 routed 变体同样生效（复用 `DEPTH_KEY` 透传 + `spawnSubAgent`）。差别只在：参数多一个 `agent_type`
 * 枚举（值 = 各 spec 的 `type`），description 拼进每个 spec 的 `whenToUse` 供模型路由，execute 时按
 * `agent_type` 分派到对应 spec 的 `sessionFactory`。
 *
 * **domain-free**：本工厂不认识任何业务；每种 sub-agent 用什么 tools/systemPrompt 全在调用方的 spec 里。
 */
export function routedSubAgentTool(opts: RoutedSubAgentToolOptions): HarnessTool {
  const specs = opts.specs;
  if (specs.length === 0) {
    throw new Error("routedSubAgentTool: specs must not be empty");
  }
  // type 须唯一——重复会让枚举/路由表二义，构造期 fail-loud 比运行时静默撞车好。
  const byType = new Map<string, AgentSpec>();
  for (const s of specs) {
    if (byType.has(s.type)) {
      throw new Error(`routedSubAgentTool: duplicate agent type "${s.type}"`);
    }
    byType.set(s.type, s);
  }

  const max = opts.maxSubAgents ?? 8;
  const maxDepth = opts.maxDepth ?? 2;
  let spawned = 0;

  const types = specs.map((s) => s.type);
  // description 拼进每个 spec 的 whenToUse → 模型据此挑 agent_type。
  const routingLines = specs.map((s) => `- ${s.type}: ${s.whenToUse}`).join("\n");
  const description =
    (opts.description ??
      "Delegate a self-contained sub-task to a bounded sub-agent, routed by agent_type.") +
    `\n\nAvailable agent types:\n${routingLines}`;

  return {
    name: opts.name ?? "subAgent",
    description,
    parameters: Type.Object({
      agent_type: Type.Union(
        types.map((t) => Type.Literal(t)),
        { description: `Which kind of sub-agent to route this task to. One of: ${types.join(", ")}.` },
      ),
      task: Type.String({
        description: "A self-contained task for the chosen sub-agent to carry out.",
      }),
    }),

    async execute(args, ctx, signal) {
      const task = typeof args.task === "string" ? args.task : "";
      // throw 是 HarnessTool 的错误合约（kernel 包成 isError 回灌模型）——空任务 / 非法 type / 超预算 / 超深都 fail-loud。
      if (task.trim().length === 0) {
        throw new Error("subAgent: empty task");
      }
      // 路由防御性校验：缺失 / 非枚举的 agent_type → 明确 error（不崩、不静默）。即使内核 validate 已按枚举
      // schema 拦过，这里仍兜一层，便于直接 execute（绕过内核）时也有清晰错误。
      const agentType = typeof args.agent_type === "string" ? args.agent_type : "";
      const spec = byType.get(agentType);
      if (!spec) {
        throw new Error(
          `subAgent: unknown agent_type "${agentType}" (expected one of: ${types.join(", ")})`,
        );
      }
      // 纵向闸（#45）：读**当前** session 深度（缺省 0）。到顶就不 spawn——挡在横向计数之前，
      // 让超深的尝试不消耗本层 maxSubAgents 预算（二闸正交）。
      const depth = ctx.state.get(DEPTH_KEY) ?? 0;
      if (depth >= maxDepth) {
        throw new Error(`subAgent: depth limit (maxDepth=${maxDepth}) reached`);
      }
      // 横向闸：本 tool 实例的扇出预算（跨所有 type 合计）。
      if (spawned >= max) {
        throw new Error(`subAgent: budget exhausted (max ${max} sub-agents per tool)`);
      }
      spawned++;

      const sub = spec.sessionFactory(task, ctx);
      return spawnSubAgent(sub, task, depth, signal, opts.onSpawn);
    },
  };
}
