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

import type { AgentSession, HarnessTool, HookContext, Message } from "@harness-pi/core";
import { Type } from "@mariozechner/pi-ai";

export interface SubAgentToolOptions {
  /** tool name（默认 "subAgent"）。 */
  name?: string;
  /** tool description（给模型看的，默认通用文案）。 */
  description?: string;
  /** 造一个 sub-agent AgentSession 的工厂（拿到子任务 + 父 ctx）。bounded 由这里造的 session 自限轮数。 */
  sessionFactory: (task: string, ctx: HookContext) => AgentSession;
  /** 本 tool 实例最多派多少个 sub-agent（防失控递归/扇出）。默认 8。 */
  maxSubAgents?: number;
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
      // throw 是 HarnessTool 的错误合约（kernel 包成 isError 回灌模型）——空任务 / 超预算都 fail-loud。
      if (task.trim().length === 0) {
        throw new Error("subAgent: empty task");
      }
      if (spawned >= max) {
        throw new Error(`subAgent: budget exhausted (max ${max} sub-agents per tool)`);
      }
      spawned++;

      // 父 signal 透传 → sub-agent 可被父的 abort 协作式取消。
      const sub = opts.sessionFactory(task, ctx);
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
