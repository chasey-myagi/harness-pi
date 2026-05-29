import type { Api, Model, Usage } from "@harness-pi/core";

export interface DashScopeEnv {
  DASHSCOPE_API_KEY?: string | undefined;
  QWEN_API_KEY?: string | undefined;
}

export interface DashScopeResolvedModelRuntime {
  model: Model<Api>;
  llmOptions: Record<string, unknown>;
}

export interface DashScopePricingTier {
  maxInputTokens?: number;
  inputCnyPerMillion: number;
  outputCnyPerMillion: number;
  thinkingOutputCnyPerMillion?: number;
}

export interface DashScopePricingCny {
  source: string;
  tiers: readonly DashScopePricingTier[];
}

export interface DashScopeModelMetadata {
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: Model<Api>["input"];
  pricingCny?: DashScopePricingCny;
}

export interface DashScopeCostEstimate {
  amount: number;
  currency: "CNY";
  source: string;
}

const DASHSCOPE_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const PRICING_SOURCE =
  "DashScope China mainland token pricing (help.aliyun.com, 2026-05-29)";

const QWEN_PLUS_PRICING: DashScopePricingCny = {
  source: PRICING_SOURCE,
  tiers: [
    {
      maxInputTokens: 128_000,
      inputCnyPerMillion: 0.8,
      outputCnyPerMillion: 2,
      thinkingOutputCnyPerMillion: 8,
    },
    {
      maxInputTokens: 256_000,
      inputCnyPerMillion: 2.4,
      outputCnyPerMillion: 20,
      thinkingOutputCnyPerMillion: 24,
    },
    {
      maxInputTokens: 1_000_000,
      inputCnyPerMillion: 4.8,
      outputCnyPerMillion: 48,
      thinkingOutputCnyPerMillion: 64,
    },
  ],
};

const QWEN_TURBO_PRICING: DashScopePricingCny = {
  source: PRICING_SOURCE,
  tiers: [
    {
      inputCnyPerMillion: 0.3,
      outputCnyPerMillion: 0.6,
      thinkingOutputCnyPerMillion: 3,
    },
  ],
};

const QWEN36_PLUS_PRICING: DashScopePricingCny = {
  source: PRICING_SOURCE,
  tiers: [
    {
      maxInputTokens: 256_000,
      inputCnyPerMillion: 2,
      outputCnyPerMillion: 12,
      thinkingOutputCnyPerMillion: 12,
    },
    {
      maxInputTokens: 1_000_000,
      inputCnyPerMillion: 8,
      outputCnyPerMillion: 48,
      thinkingOutputCnyPerMillion: 48,
    },
  ],
};

const QWEN36_FLASH_PRICING: DashScopePricingCny = {
  source: PRICING_SOURCE,
  tiers: [
    {
      maxInputTokens: 256_000,
      inputCnyPerMillion: 1.2,
      outputCnyPerMillion: 7.2,
      thinkingOutputCnyPerMillion: 7.2,
    },
    {
      maxInputTokens: 1_000_000,
      inputCnyPerMillion: 4.8,
      outputCnyPerMillion: 28.8,
      thinkingOutputCnyPerMillion: 28.8,
    },
  ],
};

const QWEN35_PLUS_PRICING: DashScopePricingCny = {
  source: PRICING_SOURCE,
  tiers: [
    {
      maxInputTokens: 128_000,
      inputCnyPerMillion: 0.8,
      outputCnyPerMillion: 4.8,
      thinkingOutputCnyPerMillion: 4.8,
    },
    {
      maxInputTokens: 256_000,
      inputCnyPerMillion: 2,
      outputCnyPerMillion: 12,
      thinkingOutputCnyPerMillion: 12,
    },
    {
      maxInputTokens: 1_000_000,
      inputCnyPerMillion: 4,
      outputCnyPerMillion: 24,
      thinkingOutputCnyPerMillion: 24,
    },
  ],
};

const QWEN35_FLASH_PRICING: DashScopePricingCny = {
  source: PRICING_SOURCE,
  tiers: [
    {
      maxInputTokens: 128_000,
      inputCnyPerMillion: 0.2,
      outputCnyPerMillion: 2,
      thinkingOutputCnyPerMillion: 2,
    },
    {
      maxInputTokens: 256_000,
      inputCnyPerMillion: 0.8,
      outputCnyPerMillion: 8,
      thinkingOutputCnyPerMillion: 8,
    },
    {
      maxInputTokens: 1_000_000,
      inputCnyPerMillion: 1.2,
      outputCnyPerMillion: 12,
      thinkingOutputCnyPerMillion: 12,
    },
  ],
};

const UNKNOWN_DASHSCOPE_METADATA: DashScopeModelMetadata = {
  contextWindow: 128_000,
  maxTokens: 8192,
  reasoning: false,
  input: ["text"],
};

const DASH_SCOPE_MODELS: Record<string, DashScopeModelMetadata> = {
  "qwen-plus": qwenMetadata(1_000_000, 32_768, QWEN_PLUS_PRICING),
  "qwen-plus-latest": qwenMetadata(1_000_000, 32_768, QWEN_PLUS_PRICING),
  "qwen-plus-2025-12-01": qwenMetadata(1_000_000, 32_768, QWEN_PLUS_PRICING),
  "qwen-plus-2025-09-11": qwenMetadata(1_000_000, 32_768, QWEN_PLUS_PRICING),
  "qwen-plus-2025-07-28": qwenMetadata(1_000_000, 32_768, QWEN_PLUS_PRICING),

  "qwen-turbo": qwenMetadata(1_000_000, 16_384, QWEN_TURBO_PRICING),
  "qwen-turbo-latest": qwenMetadata(1_000_000, 16_384, QWEN_TURBO_PRICING),
  "qwen-turbo-2025-07-15": qwenMetadata(1_000_000, 16_384, QWEN_TURBO_PRICING),
  "qwen-turbo-2025-04-28": qwenMetadata(1_000_000, 16_384, QWEN_TURBO_PRICING),

  "qwen3.6-plus": qwenMetadata(1_000_000, 65_536, QWEN36_PLUS_PRICING),
  "qwen3.6-plus-2026-04-02": qwenMetadata(
    1_000_000,
    65_536,
    QWEN36_PLUS_PRICING,
  ),
  "qwen3.6-flash": qwenMetadata(1_000_000, 65_536, QWEN36_FLASH_PRICING),
  "qwen3.6-flash-2026-04-16": qwenMetadata(
    1_000_000,
    65_536,
    QWEN36_FLASH_PRICING,
  ),

  "qwen3.5-plus": qwenMetadata(1_000_000, 65_536, QWEN35_PLUS_PRICING),
  "qwen3.5-plus-2026-02-15": qwenMetadata(
    1_000_000,
    65_536,
    QWEN35_PLUS_PRICING,
  ),
  "qwen3.5-flash": qwenMetadata(1_000_000, 65_536, QWEN35_FLASH_PRICING),
  "qwen3.5-flash-2026-02-23": qwenMetadata(
    1_000_000,
    65_536,
    QWEN35_FLASH_PRICING,
  ),
};

export function isDashScopeProviderAlias(provider: string): boolean {
  return provider === "dashscope" || provider === "qwen";
}

export function resolveDashScopeModel(
  modelId: string,
  env: DashScopeEnv,
): DashScopeResolvedModelRuntime {
  const apiKey = env.DASHSCOPE_API_KEY ?? env.QWEN_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing DashScope credentials. Set DASHSCOPE_API_KEY or QWEN_API_KEY.",
    );
  }

  const metadata = getDashScopeModelMetadata(modelId);
  return {
    model: {
      id: modelId,
      name: `DashScope ${modelId}`,
      api: "openai-completions",
      provider: "dashscope",
      baseUrl: DASHSCOPE_BASE_URL,
      reasoning: metadata.reasoning,
      input: metadata.input,
      // pi-ai Model.cost is USD per million tokens. DashScope docs publish CNY;
      // CNY estimation is kept in this adapter so the shared USD report stays honest.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: metadata.contextWindow,
      maxTokens: metadata.maxTokens,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsUsageInStreaming: true,
        maxTokensField: "max_tokens",
        thinkingFormat: "qwen",
        supportsStrictMode: false,
      },
    } satisfies Model<"openai-completions">,
    llmOptions: { apiKey },
  };
}

export function getDashScopeModelMetadata(
  modelId: string,
): DashScopeModelMetadata {
  return DASH_SCOPE_MODELS[modelId] ?? UNKNOWN_DASHSCOPE_METADATA;
}

export function estimateDashScopeCostCny(
  modelId: string,
  usage: Usage | undefined,
  opts: { thinking: boolean } = { thinking: false },
): DashScopeCostEstimate | undefined {
  const pricing = getDashScopeModelMetadata(modelId).pricingCny;
  if (!pricing || !usage) return undefined;

  const inputTokens = usage.input + usage.cacheRead;
  const outputTokens = usage.output;
  const tier = selectPricingTier(pricing, inputTokens);
  const outputRate =
    opts.thinking && tier.thinkingOutputCnyPerMillion !== undefined
      ? tier.thinkingOutputCnyPerMillion
      : tier.outputCnyPerMillion;
  const amount =
    (inputTokens / 1_000_000) * tier.inputCnyPerMillion +
    (outputTokens / 1_000_000) * outputRate;

  return {
    amount,
    currency: "CNY",
    source: pricing.source,
  };
}

function selectPricingTier(
  pricing: DashScopePricingCny,
  inputTokens: number,
): DashScopePricingTier {
  const tier = pricing.tiers.find(
    (candidate) =>
      candidate.maxInputTokens === undefined ||
      inputTokens <= candidate.maxInputTokens,
  );
  if (tier) return tier;
  const fallback = pricing.tiers[pricing.tiers.length - 1];
  if (!fallback) throw new Error("DashScope pricing has no tiers.");
  return fallback;
}

function qwenMetadata(
  contextWindow: number,
  maxTokens: number,
  pricingCny: DashScopePricingCny,
): DashScopeModelMetadata {
  return {
    contextWindow,
    maxTokens,
    reasoning: true,
    input: ["text"],
    pricingCny,
  };
}
