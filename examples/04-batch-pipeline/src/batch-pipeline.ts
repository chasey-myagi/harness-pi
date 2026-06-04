/**
 * 端到端参考样例：把 harness-pi 的编排原语 + 内核 + adapter 拼成一条「批量答题」流水线。
 *
 * 它**只用通用机制、不掺任何业务**（domain-free），目的是证明这些零件咬合、并给真实迁移（如 bidding）
 * 一个可照搬的骨架：
 *   - `pipeline()`（@harness-pi/plugins）—— 多阶段、bounded 并发、每 item 必返 typed outcome；
 *   - `AgentSession`（@harness-pi/core）—— 每个 work-item 一次 run；
 *   - `SessionStore`（内核协议）+ `AgentSession.resume()` —— 落盘 + 崩溃续跑；
 *   - `EventPump` + `WebSocketSink`（@harness-pi/adapters）—— 把 live/recorded 事件推到 WS。
 *
 * 真实下游要替换的只有两处 **seam**：`makeModel`（fake → 真 provider）与工具集（toy `lookupTool` → 业务工具）。
 *
 * **范围**：本样例证明的是「机制怎么咬合」。它**不**覆盖真 provider 的流式错误 / context-overflow /
 * 中途断流语义（那由 #6 overflow hook + compaction 策略管，且需真 provider 验，属另一条线）。`pipeline` 的
 * 任意-stage 失败归因由其自身单测覆盖；这里只演示 stage 0（答题）失败的隔离——stage 1（打分）是纯派生、无失败面。
 */

import {
  AgentSession,
  Type,
  type HarnessTool,
  type SessionStore,
  type RunSummary,
} from "@harness-pi/core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { pipeline, type PipelineOutcome } from "@harness-pi/plugins/controllers";
import { EventPump, type TransportSink } from "@harness-pi/adapters";

/** 一个 work-item：domain 中性的 { id, prompt }。 */
export interface BatchItem {
  id: string;
  prompt: string;
}

/** pipeline 末阶段产出的结果记录。 */
export interface BatchResult {
  id: string;
  answer: string;
  reason: RunSummary["reason"];
  score: number;
}

/** domain-free 的 toy 工具：把 key 映射成一句话「事实」。仅为演示 tool-call 经 live 轨流出。 */
export const lookupTool: HarnessTool = {
  name: "lookup",
  description: "Look up a fact by key (toy, domain-free).",
  parameters: Type.Object({ key: Type.String() }),
  async execute(args) {
    const key = String((args as { key?: unknown }).key ?? "");
    return { content: [{ type: "text", text: `fact:${key}` }] };
  },
};

export interface RunBatchOptions {
  items: readonly BatchItem[];
  /** 每题一个 session 落盘到这里（resume 的前提）。 */
  store: SessionStore;
  /** 每题事件经 EventPump 推到这里（如 `new WebSocketSink(socket)`）。 */
  sink: TransportSink;
  /** seam：测试用 fake model，生产换真 provider。 */
  makeModel: (item: BatchItem) => Model<Api>;
  /** 并发上限（默认 4）。 */
  concurrency?: number;
  /** seam：业务工具集（默认 toy `lookupTool`）。 */
  tools?: HarnessTool[];
}

/** 末 stage 拿到的中间产物（首 stage 的产出）。 */
interface Answered {
  item: BatchItem;
  summary: RunSummary;
}

/** 从终态的最后一条 assistant 消息里拼出纯文本。 */
function lastText(summary: RunSummary): string {
  const content = summary.lastMessage?.content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => ("text" in b ? (b as { text: string }).text : "")).join("");
}

/**
 * 跑一批 work-item：每个 item 独立流过两个 stage——
 *   stage 0「答题」：建一个 AgentSession（落盘到 store）+ EventPump 把 live 轨推到 sink，run 出终态；
 *   stage 1「打分」：从终态派生结果记录（纯计算，演示多阶段 pipeline）。
 * 返回与输入等长、按 index 有序的 typed outcomes —— 失败的 item 被隔离成 failed（带 stage），绝不静默丢。
 */
export async function runBatch(
  opts: RunBatchOptions,
): Promise<Array<PipelineOutcome<BatchItem, BatchResult>>> {
  const tools = opts.tools ?? [lookupTool];

  return pipeline<BatchItem, BatchResult>(
    opts.items,
    [
      // stage 0：答题。prev 即 item。
      async (_prev, item): Promise<Answered> => {
        const session = new AgentSession({
          model: opts.makeModel(item),
          tools,
          sessionId: item.id,
          store: opts.store,
        });
        const pump = new EventPump(session, { sink: opts.sink, tag: item.id });
        const detach = pump.attachLive();
        try {
          const summary = await session.run(item.prompt);
          return { item, summary };
        } finally {
          detach();
        }
      },
      // stage 1：打分。prev 是 stage 0 的 Answered。
      async (prev): Promise<BatchResult> => {
        const { item, summary } = prev as Answered;
        const answer = lastText(summary);
        return { id: item.id, answer, reason: summary.reason, score: answer.length };
      },
    ],
    { concurrency: opts.concurrency ?? 4 },
  );
}

export interface ResumeAndContinueOptions {
  store: SessionStore;
  sessionId: string;
  /** seam：续跑用的 model（可与首跑不同——模拟「进程重启后」新建）。 */
  makeModel: () => Model<Api>;
  /** 续跑追加的新 prompt。 */
  followUp: string;
  /** 可选：续跑时把 recorded 轨经 pumpRecorded 推到这里。 */
  sink?: TransportSink;
  tools?: HarnessTool[];
}

/**
 * 从 store resume 一个落盘过的 session，再追加一个 follow-up 续跑——演示「崩溃/重启后续跑」。
 * 若给了 sink，用 `runStreaming()` + `pumpRecorded()` 把 recorded 轨边跑边推；否则直接 run。
 * 返回终态 + 推出的 recorded 事件数。
 */
export async function resumeAndContinue(
  opts: ResumeAndContinueOptions,
): Promise<{ summary: RunSummary; recordedCount: number }> {
  const session = await AgentSession.resume(opts.store, opts.sessionId, {
    model: opts.makeModel(),
    tools: opts.tools ?? [lookupTool],
  });

  if (!opts.sink) {
    return { summary: await session.run(opts.followUp), recordedCount: 0 };
  }

  const pump = new EventPump(session, { sink: opts.sink, tag: opts.sessionId });
  const stream = session.runStreaming(opts.followUp);
  let recordedCount = 0;
  for await (const _ev of pump.pumpRecorded(stream)) {
    recordedCount++;
  }
  return { summary: await stream.finalSummary, recordedCount };
}
