/**
 * LLM seam：在 pi-ai 公共面**之上**收口两个人体工学缺口，让消费者(engram / bidding-agent /
 * coding-agent)无需直接 import `@earendil-works/pi-ai`、也无需手写 Model 字面量或裸 `Record` options。
 *
 * 这层**不改 pi-ai 一行**(架构不变量 L1 仍成立)——只是在内核侧把「自定义 Model 构造」与「provider
 * options 类型」集中到一个咽喉点。pi-ai 将来 churn `Model` 类型时只动本文件 + index re-export。
 *
 * 解决两个 issue：
 *   #38 `makeOpenAICompatibleModel()`：自定义 OpenAI-compatible model 不再需要手写字面量 + `as Model` cast +
 *       无意义的 `cost:{0,0,0,0}` 占位。
 *   #39 `LlmOptions`：把 `AgentSessionOptions.llmOptions` 从 `Record<string,unknown>` 收紧成 typed shape，
 *       `{apikey}` 这类 typo 在编译期失败；真·provider 私有键走具名 `providerExtras` 逃生口。
 */

import type {
  Model,
  StreamOptions,
  ProviderStreamOptions,
  OpenAICompletionsCompat,
} from "@earendil-works/pi-ai";

// ─────────────────────────────────────────────────────────────────────────────
// #39 — typed llmOptions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 透传给 pi-ai `stream()`/`complete()` 的跨-provider 选项，typed 版。
 *
 * 锚定 pi-ai 已导出的 `StreamOptions`(apiKey / temperature / maxTokens / headers / timeoutMs /
 * maxRetries / metadata / …)，这是**所有 provider 共有**的基底。两处偏离：
 *
 * - **去掉 `signal`**：它是 kernel 保留字段(session 用自己的 AbortSignal)，传了也会被覆盖。
 *   Omit 让「传 signal」直接变编译错误，把保留语义写进类型而不是注释。
 * - **加具名 `providerExtras`**：pi-ai 的 provider 专属选项(如 openai-completions 的 `reasoningEffort`、
 *   anthropic 的 thinking 配置)不在公共 `StreamOptions` 里。它们走这个**显式逃生口**，而不是把整个对象
 *   放松成 `Record<string,unknown>`——后者会顺带丢掉 `{apikey}` 的 typo 检查(#39 的核心诉求)。
 *
 * 注意 `baseUrl` **不在这里**——它是 Model 的字段(见 {@link makeOpenAICompatibleModel})，不是 per-call option。
 */
export type LlmOptions = Omit<StreamOptions, "signal"> & {
  /**
   * Provider 专属、不在公共 `StreamOptions` 里的选项(如 openai-completions 的 `reasoningEffort`)。
   * 原样 spread 到顶层透传。
   *
   * **优先级**:`resolveLlmOptions` 把 providerExtras 在 typed 字段**之后** spread(`{...rest, ...providerExtras}`),
   * 故同名键以 providerExtras 为准——这是有意的逃生口语义(能覆盖任何 typed 字段)。`signal` 例外:始终被
   * kernel 的 AbortSignal 覆盖。别把已 typed 的键(如 `apiKey`)塞进 providerExtras——那会绕过 #39 的 typo 检查。
   */
  providerExtras?: Record<string, unknown>;
};

/**
 * 把 {@link LlmOptions} 摊平成 pi-ai `stream()`/`complete()` 实际吃的 `ProviderStreamOptions`：
 * 把 `providerExtras` spread 回顶层。**不**注入 signal —— 调用方(kernel / compaction)各自负责。
 *
 * kernel(session.ts)与 coding-agent 的 compaction 都直连 pi-ai，复用同一份摊平逻辑避免漂移。
 */
export function resolveLlmOptions(
  opts: LlmOptions | undefined,
): ProviderStreamOptions {
  if (!opts) return {};
  const { providerExtras, ...rest } = opts;
  return { ...rest, ...providerExtras };
}

// ─────────────────────────────────────────────────────────────────────────────
// #38 — custom OpenAI-compatible Model 工厂
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 构造一个 OpenAI-compatible(`api: "openai-completions"`)自定义 Model 的输入。
 * 覆盖 DashScope/Qwen、Moonshot、本地 vLLM、任意 OpenAI 兼容端点。
 */
export interface OpenAICompatibleModelSpec {
  /** Provider 侧的 model id，如 `"qwen-plus"`。 */
  id: string;
  /** OpenAI 兼容端点 baseUrl，如 `"https://dashscope.aliyuncs.com/compatible-mode/v1"`。 */
  baseUrl: string;
  /** Provider 名(影响 cost 归类 / 展示)。默认取 `baseUrl` 的 hostname。 */
  provider?: string;
  /** 展示名。默认 `${provider} ${id}`。 */
  name?: string;
  /** 模型是否支持 reasoning/thinking。默认 `false`。 */
  reasoning?: boolean;
  /** 输入模态。默认 `["text"]`。 */
  input?: ("text" | "image")[];
  /** 上下文窗口 token 数。 */
  contextWindow: number;
  /** 单次输出 token 上限。 */
  maxTokens: number;
  /**
   * 价格(USD per million tokens)。默认 `{0,0,0,0}`——自定义 model 通常拿不到官方 USD 价，
   * 零默认让调用点不必再写无意义占位。若 cost-budget 要精确,显式传。
   */
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /**
   * OpenAI-compatible 兼容性覆盖。**不传则整个省略**，交给 pi-ai 按 baseUrl 自动探测——
   * 别硬塞默认值，否则对非目标端点(如把 qwen 的 `thinkingFormat` 套到别的 provider)反而是错的。
   */
  compat?: OpenAICompletionsCompat;
}

/** 默认 provider 名：取 baseUrl 的 hostname。baseUrl 非法 URL 会 throw(fail-loud，早于跑模型)。 */
function providerFromBaseUrl(baseUrl: string): string {
  return new URL(baseUrl).hostname;
}

/**
 * 造一个 OpenAI-compatible 自定义 Model —— **零 `as Model` cast、无 `cost:{0,0,0,0}` 占位**。
 *
 * cast 能消除的关键：返回类型标注成**具体 api 字面量** `Model<"openai-completions">`，pi-ai 的条件字段
 * `compat?: TApi extends "openai-completions" ? OpenAICompletionsCompat : …`(types.d.ts)对窄字面量正确解析为
 * `OpenAICompletionsCompat`(而非宽联合 `Model<Api>` 下塌成的 `never`)。返回值可隐式 widen 到 `Model<Api>` 供下游用。
 *
 * @example
 * const model = makeOpenAICompatibleModel({
 *   id: "qwen-plus",
 *   baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
 *   provider: "dashscope",
 *   contextWindow: 131072,
 *   maxTokens: 8192,
 * });
 * new AgentSession({ model, tools, llmOptions: { apiKey } });
 */
export function makeOpenAICompatibleModel(
  spec: OpenAICompatibleModelSpec,
): Model<"openai-completions"> {
  const provider = spec.provider ?? providerFromBaseUrl(spec.baseUrl);
  return {
    id: spec.id,
    name: spec.name ?? `${provider} ${spec.id}`,
    api: "openai-completions",
    provider,
    baseUrl: spec.baseUrl,
    reasoning: spec.reasoning ?? false,
    input: spec.input ?? ["text"],
    cost: spec.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: spec.contextWindow,
    maxTokens: spec.maxTokens,
    // compat 未给则省略 → pi-ai 按 baseUrl 自动探测(exactOptionalPropertyTypes 下不能写 compat:undefined)。
    ...(spec.compat ? { compat: spec.compat } : {}),
  };
}
