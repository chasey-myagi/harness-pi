/**
 * 包的**公开出口面**——期望 `tsc` 零退出。
 *
 * 本 issue 阶段这个包除了类型出口没有任何运行时行为，所以「能不能从包入口拿到这些类型」
 * 就是它唯一的交付物。`src/contract/index.ts` 用的是 `export type *`（刻意不手维护名单），
 * 正因为它是自动的，出口断链更需要机器钉住：把 `src/index.ts` 改成 `export {}`，
 * 或漏掉一条 `export type *`，本 fixture 会立刻变红。
 */
import type {
  MirrorAssistantMessage,
  MirrorLiveEvent,
  MirrorRunSummary,
  MirrorSessionEvent,
  MirrorStopReason,
  MirrorTextContent,
  MirrorThinkingContent,
  MirrorToolCall,
  MirrorToolExecResult,
  MirrorUsage,
  SnapshotEnvelope,
  Watermark,
} from "../../src/index.js";

// 每个名字都用一次——只 import 不用，`noUnusedLocals` 没开时不会报错，等于没测。
const _a: MirrorSessionEvent = { type: "turn-start", turnIdx: 0 };
const _b: MirrorLiveEvent = { type: "message_start" };
const _c: MirrorStopReason = "toolUse";
const _d: MirrorTextContent = { type: "text", text: "" };
const _e: MirrorThinkingContent = { type: "thinking", thinking: "" };
const _f: MirrorToolCall = { type: "toolCall", id: "", name: "", arguments: {} };
const _g: MirrorUsage["cost"] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const _h: MirrorToolExecResult = { content: [{ type: "text", text: "" }] };
const _i: Pick<MirrorRunSummary, "reason"> = { reason: "done" };
const _j: Pick<MirrorAssistantMessage, "role" | "model"> = { role: "assistant", model: "" };
const _k: Watermark = { seq: 0, epoch: "" };
const _l: SnapshotEnvelope<null> = { watermark: _k, state: null };

void _a; void _b; void _c; void _d; void _e; void _f;
void _g; void _h; void _i; void _j; void _k; void _l;
