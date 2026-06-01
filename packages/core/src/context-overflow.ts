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
 */

/**
 * 主流 provider 的 context-overflow 错误文案片段（小写匹配）。每条都标注来源，方便增删时对账。
 * 故意保守：只收「明确指向上下文/输入长度超限」的措辞，不收 "too long" 这类会误伤的泛词。
 */
const OVERFLOW_PATTERNS: ReadonlyArray<string> = [
  "context_length_exceeded", // OpenAI 错误码
  "maximum context length", // OpenAI: "This model's maximum context length is N tokens"
  "context window", // 通用："exceeds the context window"
  "prompt is too long", // Anthropic: "prompt is too long: N tokens > M maximum"
  "range of input length", // DashScope/Qwen: "Range of input length should be [1, N]"
  // ↑ 用完整短语而非裸 "input length"：后者会误伤参数校验类错误（"invalid input length for field X"），
  //   把本该 fail-fast 的配置错误判成 overflow → 触发徒劳的 restart-fresh。
  "reduce the length", // OpenAI 提示语："Please reduce the length of the messages"
  "too many tokens", // 通用
];

/**
 * 默认 context-overflow 判定：错误文案（小写）命中任一已知 provider 片段即视为越界。
 * 空串 / 非 overflow 错误返回 false。
 */
export function defaultIsContextOverflow(errorMessage: string): boolean {
  if (errorMessage.length === 0) return false;
  const lower = errorMessage.toLowerCase();
  return OVERFLOW_PATTERNS.some((p) => lower.includes(p));
}
