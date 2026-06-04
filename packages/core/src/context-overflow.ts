/**
 * Context-overflow 错误分类（docs/09 §3.6）。
 *
 * 当 LLM 调用以 `stopReason==="error"` 结束时，内核需要判断这条错误**是不是** context-overflow
 * （prompt-too-long / 超窗），从而决定要不要 fire `onContextOverflow`。这是一段 provider 特定的
 * 启发式字符串匹配——内核给一个覆盖主流 provider 的**默认**实现，但 §3.6 的原则是「内核绝不选边」，
 * 所以它经 `AgentSessionOptions.isContextOverflow` **可整体替换**：新 provider 文案没覆盖到、或想用
 * 结构化错误码判定的，传自己的谓词即可。
 *
 * `stopReason==="length"`（输出被截断）是无歧义的 overflow，不走这个分类器——内核直接当 overflow。
 *
 * **检测归属**：默认实现**委托 pi-ai 维护的 `isContextOverflow()`**（覆盖十几个 provider 的 overflow 文案，
 * 见 pi-ai `getOverflowPatterns()`），而非内核平行手维护一份——升级 pi-ai 即自动跟进它的列表与排除规则，
 * 不再漂移。这里包成本函数是为了：(1) 把签名收成内核惯用的 `(errorMessage) => boolean`；(2) **补一条
 * pi-ai 列表暂缺的 DashScope/Qwen 文案**。委托 `isContextOverflow` 而非仅 `getOverflowPatterns()` 是关键——
 * 前者会先跑 pi-ai 的 NON_OVERFLOW 排除（如 `/^Throttling error:/i`、`/rate limit/i`），否则 pi-ai 的兜底
 * pattern `/too many tokens/i` 会把 Bedrock 限流文案误判成 overflow → 触发徒劳的 compaction/restart。
 *
 * 只走「errorMessage 文案」这一路：不传 `contextWindow`，故 pi-ai 的 silent-overflow（usage 路）不参与
 * ——那条内核另由 `stopReason==="length"` 直判。
 */

import {
  isContextOverflow as piAiIsContextOverflow,
  type AssistantMessage,
} from "@earendil-works/pi-ai";

/**
 * 内核特有补充：pi-ai 的列表**不含** DashScope/Qwen 的 overflow 文案。
 * 用完整短语 `range of input length` 而非裸 `input length`：后者会误伤参数校验类错误
 * （"invalid input length for field X"），把本该 fail-fast 的配置错误判成 overflow → 触发徒劳的 restart。
 * （这条文案本身极具体，不会与 throttling/rate-limit 共现，故独立 OR、不必再过 NON_OVERFLOW 排除。）
 */
const KERNEL_EXTRA_PATTERNS: ReadonlyArray<RegExp> = [
  /range of input length/i, // DashScope/Qwen: "Range of input length should be [1, N]"
];

const ZERO_USAGE: AssistantMessage["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * 把一段 errorMessage 包成 pi-ai `isContextOverflow` 能吃的最小 error 消息（只 Case 1 文案路用到）。
 * 依赖一个上游契约：`isContextOverflow` 的 errorMessage 路只读 `stopReason`/`errorMessage`，silent-overflow
 * 路靠 `contextWindow`（本函数不传、故不触发，零 usage 不被读）。若未来 pi-ai 在文案路新增读 usage/provider
 * 等字段，这里的最小消息需同步补全。
 */
function asErrorMessage(errorMessage: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "",
    provider: "",
    model: "",
    usage: ZERO_USAGE,
    stopReason: "error",
    errorMessage,
    timestamp: 0,
  };
}

/**
 * 默认 context-overflow 判定：委托 pi-ai 的 `isContextOverflow`（含 OVERFLOW 匹配 + NON_OVERFLOW 排除），
 * 再 OR 上内核对 Qwen 的补充。空串 / 非 overflow 错误返回 false。
 */
export function defaultIsContextOverflow(errorMessage: string): boolean {
  if (errorMessage.length === 0) return false;
  return (
    piAiIsContextOverflow(asErrorMessage(errorMessage)) ||
    KERNEL_EXTRA_PATTERNS.some((re) => re.test(errorMessage))
  );
}
