import { describe, expect, it } from "vitest";
import {
  makeOpenAICompatibleModel,
  resolveLlmOptions,
  type Model,
  type Api,
} from "../index.js";

describe("makeOpenAICompatibleModel (#38)", () => {
  it("builds a valid openai-completions Model with sane defaults — no cast, no cost placeholder", () => {
    const model = makeOpenAICompatibleModel({
      id: "qwen-plus",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      provider: "dashscope",
      contextWindow: 131072,
      maxTokens: 8192,
    });

    expect(model.api).toBe("openai-completions");
    expect(model.id).toBe("qwen-plus");
    expect(model.provider).toBe("dashscope");
    expect(model.name).toBe("dashscope qwen-plus");
    expect(model.reasoning).toBe(false);
    expect(model.input).toEqual(["text"]);
    expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    // compat 未传 → 省略，交给 pi-ai 按 baseUrl 自动探测。
    expect(model.compat).toBeUndefined();

    // 关键:返回值隐式 widen 到 Model<Api> 无需 cast(编译能过即证明 #38 的 cast 已消除)。
    const widened: Model<Api> = model;
    expect(widened.api).toBe("openai-completions");
  });

  it("defaults provider to the baseUrl hostname when omitted", () => {
    const model = makeOpenAICompatibleModel({
      id: "local-model",
      baseUrl: "http://localhost:8000/v1",
      contextWindow: 8192,
      maxTokens: 2048,
    });
    expect(model.provider).toBe("localhost");
    expect(model.name).toBe("localhost local-model");
  });

  it("passes explicit cost and compat through when given", () => {
    const model = makeOpenAICompatibleModel({
      id: "qwen-plus",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      provider: "dashscope",
      reasoning: true,
      contextWindow: 131072,
      maxTokens: 8192,
      cost: { input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0 },
      compat: { thinkingFormat: "qwen", maxTokensField: "max_tokens" },
    });
    expect(model.reasoning).toBe(true);
    expect(model.cost.input).toBe(1);
    expect(model.compat?.thinkingFormat).toBe("qwen");
    expect(model.compat?.maxTokensField).toBe("max_tokens");
  });

  it("throws fail-loud on a malformed baseUrl when provider is derived", () => {
    expect(() =>
      makeOpenAICompatibleModel({
        id: "x",
        baseUrl: "not-a-url",
        contextWindow: 1,
        maxTokens: 1,
      }),
    ).toThrow();
  });
});

describe("resolveLlmOptions (#39)", () => {
  it("returns empty object for undefined", () => {
    expect(resolveLlmOptions(undefined)).toEqual({});
  });

  it("flattens providerExtras back to the top level for pi-ai", () => {
    const resolved = resolveLlmOptions({
      apiKey: "sk-test",
      temperature: 0.2,
      providerExtras: { reasoningEffort: "high" },
    });
    expect(resolved.apiKey).toBe("sk-test");
    expect(resolved.temperature).toBe(0.2);
    expect((resolved as Record<string, unknown>).reasoningEffort).toBe("high");
    // providerExtras 本身不应作为一个键泄漏到 pi-ai 选项里。
    expect((resolved as Record<string, unknown>).providerExtras).toBeUndefined();
  });
});
