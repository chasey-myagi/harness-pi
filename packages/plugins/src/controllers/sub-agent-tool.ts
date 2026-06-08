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

import type { AgentSession, Hook, HarnessTool, HookContext, Message } from "@harness-pi/core";
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

      // 父 signal 透传 → sub-agent 可被父的 abort 协作式取消。
      const sub = opts.sessionFactory(task, ctx);
      // 纵向深度透传：给子 session 挂一个 onSessionStart hook，把子 ctx.state 的深度设为 当前+1。
      // 子 session 自己的 subAgentTool（若有）execute 时就读到递增后的深度——多分支各自从父继承，
      // 互不串扰（每个子 session 有独立 ctx.state）。零内核改动：只用现成的 use()/onSessionStart。
      const depthInjector: Hook = {
        name: "subAgent.depth-injector",
        internal: true,
        onSessionStart(_input, subCtx) {
          subCtx.state.set(DEPTH_KEY, depth + 1);
        },
      };
      sub.use(depthInjector);
      const summary = await sub.run(task, { signal });
      const text = messageText(summary.lastMessage) || "(sub-agent produced no text output)";

      // 把子代理终态放进 details（trace/metrics 用），content 回灌父模型。
      return {
        content: [{ type: "text", text }],
        details: {
          subAgent: {
            reason: summary.reason,
            turns: summary.turns,
            usage: summary.usage,
            ...(summary.stopReason ? { stopReason: summary.stopReason } : {}),
          },
        },
      };
    },
  };
}
