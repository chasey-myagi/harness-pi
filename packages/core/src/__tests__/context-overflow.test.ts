import { describe, it, expect } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import { AgentSession } from "../session.js";
import { createFakeModel } from "../testing.js";
import { defaultIsContextOverflow } from "../context-overflow.js";
import type { Hook, ContextOverflowInput } from "../hook.js";
import type { HarnessTool } from "../types.js";

/** 收集 onContextOverflow 事件的小 hook 工厂。 */
function watcher(sink: ContextOverflowInput[]): Hook {
  return {
    name: "overflow-watch",
    onContextOverflow: (input) => {
      sink.push(input);
    },
  };
}

describe("onContextOverflow event", () => {
  it("fires when a turn ends with stopReason 'length'", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "truncated" }], stopReason: "length" },
    ]);
    const seen: ContextOverflowInput[] = [];
    const session = new AgentSession({
      model: fake,
      tools: [],
      hooks: [watcher(seen)],
    });
    await session.run("hi");

    expect(seen).toHaveLength(1);
    expect(seen[0]!.stopReason).toBe("length");
    expect(seen[0]!.turnIdx).toBe(0);
    // user prompt + truncated assistant 都已在 messages 里（assistant 先 push 再 fire）。
    expect(seen[0]!.messageCount).toBe(2);
    expect(seen[0]!.errorMessage).toBeUndefined();
    fake.teardown();
  });

  it("does NOT fire on a normal stopReason 'stop'", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ]);
    const seen: ContextOverflowInput[] = [];
    const session = new AgentSession({
      model: fake,
      tools: [],
      hooks: [watcher(seen)],
    });
    await session.run("hi");

    expect(seen).toHaveLength(0);
    fake.teardown();
  });

  it("fires on stopReason 'error' when errorMessage matches an overflow pattern", async () => {
    // pi-ai 把 provider 的 context-overflow API error 转成 error 流事件 → result() resolve 出
    // stopReason==="error" + errorMessage。fake 的 throwError 正是模拟这条路径（非 sync throw）。
    const fake = createFakeModel([
      {
        content: [],
        throwError: new Error(
          "This model's maximum context length is 8192 tokens, however you requested 9001",
        ),
      },
    ]);
    const seen: ContextOverflowInput[] = [];
    const session = new AgentSession({
      model: fake,
      tools: [],
      hooks: [watcher(seen)],
    });
    await session.run("hi");

    expect(seen).toHaveLength(1);
    expect(seen[0]!.stopReason).toBe("error");
    expect(seen[0]!.errorMessage).toContain("maximum context length");
    expect(seen[0]!.messageCount).toBe(2);
    fake.teardown();
  });

  it("does NOT fire on a non-overflow error (e.g. auth failure)", async () => {
    const fake = createFakeModel([
      { content: [], throwError: new Error("401 Unauthorized: invalid api key") },
    ]);
    const seen: ContextOverflowInput[] = [];
    const session = new AgentSession({
      model: fake,
      tools: [],
      hooks: [watcher(seen)],
    });
    await session.run("hi");

    expect(seen).toHaveLength(0);
    fake.teardown();
  });

  it("does NOT fire on an error stopReason with an empty errorMessage", async () => {
    // 钉住内核里 `assistant.errorMessage ?? ""` 的兜空 + defaultIsContextOverflow("")===false。
    const fake = createFakeModel([{ content: [], throwError: new Error("") }]);
    const seen: ContextOverflowInput[] = [];
    const session = new AgentSession({
      model: fake,
      tools: [],
      hooks: [watcher(seen)],
    });
    await session.run("hi");

    expect(seen).toHaveLength(0);
    fake.teardown();
  });

  it("fires with the right turnIdx/messageCount when overflow follows a tool-use turn", async () => {
    // 真实场景：overflow 来自多轮累积的 trace，而非首轮。turn0 用工具、turn1 截断。
    const echo: HarnessTool = {
      name: "echo",
      description: "echo",
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text", text: "r" }] };
      },
    };
    const fake = createFakeModel([
      { content: [{ type: "toolCall", name: "echo", arguments: {} }] }, // turn 0
      { content: [{ type: "text", text: "truncated" }], stopReason: "length" }, // turn 1
    ]);
    const seen: ContextOverflowInput[] = [];
    const session = new AgentSession({
      model: fake,
      tools: [echo],
      hooks: [watcher(seen)],
    });
    await session.run("hi");

    expect(seen).toHaveLength(1);
    expect(seen[0]!.turnIdx).toBe(1);
    // messages: user, assistant(toolCall), toolResult, assistant(length) = 4。
    expect(seen[0]!.messageCount).toBe(4);
    fake.teardown();
  });

  it("honors a custom isContextOverflow predicate (kernel doesn't hard-pick what counts)", async () => {
    // 默认启发式不认识 "QUOTA_CTX_FULL"，自定义谓词认。
    const fake = createFakeModel([
      { content: [], throwError: new Error("QUOTA_CTX_FULL") },
    ]);
    const seen: ContextOverflowInput[] = [];
    const session = new AgentSession({
      model: fake,
      tools: [],
      hooks: [watcher(seen)],
      isContextOverflow: (m) => m.includes("QUOTA_CTX_FULL"),
    });
    await session.run("hi");

    expect(defaultIsContextOverflow("QUOTA_CTX_FULL")).toBe(false); // 默认不会 fire
    expect(seen).toHaveLength(1); // 自定义谓词使其 fire
    expect(seen[0]!.stopReason).toBe("error");
    fake.teardown();
  });

  it("a strategy aborting in onContextOverflow ends the run as 'aborted' (restart-fresh hook point)", async () => {
    // 这是 compactRestartFresh 依赖的内核契约：策略在 onContextOverflow 里 ctx.abort →
    // run 以 reason "aborted" + abortReason 收尾，lifecycle-restart 才能据此重启 fresh。
    const fake = createFakeModel([
      { content: [{ type: "text", text: "truncated" }], stopReason: "length" },
    ]);
    const hook: Hook = {
      name: "compact-restart",
      onContextOverflow: (_input, ctx) => {
        ctx.abort("compaction:overflow");
      },
    };
    const session = new AgentSession({ model: fake, tools: [], hooks: [hook] });
    const summary = await session.run("hi");

    expect(summary.reason).toBe("aborted");
    expect(summary.abortReason).toBe("compaction:overflow");
    fake.teardown();
  });
});

describe("defaultIsContextOverflow", () => {
  it("matches known provider overflow phrasings", () => {
    expect(
      defaultIsContextOverflow("This model's maximum context length is 8192 tokens"),
    ).toBe(true); // OpenAI
    expect(
      defaultIsContextOverflow("prompt is too long: 250000 tokens > 200000 maximum"),
    ).toBe(true); // Anthropic
    expect(
      defaultIsContextOverflow("InvalidParameter: Range of input length should be [1, 30000]"),
    ).toBe(true); // DashScope/Qwen
    expect(defaultIsContextOverflow("error code: context_length_exceeded")).toBe(true);
    expect(defaultIsContextOverflow("EXCEEDS THE CONTEXT WINDOW")).toBe(true); // 大小写无关
  });

  it("inherits pi-ai's maintained overflow patterns (not a hand-maintained subset)", () => {
    // 以下文案在 pi-ai 0.73.1 的 OVERFLOW_PATTERNS 里、但**不在**内核旧的手维护列表里——
    // 命中即证明 defaultIsContextOverflow 现在复用 pi-ai 的 getOverflowPatterns()，升级 pi-ai 自动跟进。
    expect(
      defaultIsContextOverflow(
        "This model's maximum prompt length is 131072 but the request contains 537812 tokens",
      ),
    ).toBe(true); // xAI (Grok)
    expect(
      defaultIsContextOverflow("the request exceeds the available context size, try increasing it"),
    ).toBe(true); // llama.cpp
    expect(defaultIsContextOverflow("Input is too long for requested model.")).toBe(true); // Amazon Bedrock
  });

  it("keeps the kernel's Qwen addition that pi-ai's list lacks", () => {
    // pi-ai 的列表不含 DashScope/Qwen 文案，内核作为补充保留——这条单独钉死，防 follow-up 误删。
    expect(
      defaultIsContextOverflow("InvalidParameter: Range of input length should be [1, 30000]"),
    ).toBe(true);
  });

  it("rejects empty and unrelated errors", () => {
    expect(defaultIsContextOverflow("")).toBe(false);
    expect(defaultIsContextOverflow("401 Unauthorized")).toBe(false);
    expect(defaultIsContextOverflow("rate limit exceeded")).toBe(false);
    expect(defaultIsContextOverflow("connection reset by peer")).toBe(false);
  });

  it("does NOT misclassify throttling that happens to mention 'too many tokens' (NON_OVERFLOW exclusion)", () => {
    // pi-ai 的兜底 pattern /too many tokens/i 会命中 Bedrock 限流文案；委托 pi-ai 的 isContextOverflow
    // 会先跑 NON_OVERFLOW 排除（/^Throttling error:/i 即 pi-ai formatBedrockError 产出、也是内核实际收到
    // 的 errorMessage 格式），把它判回 false——否则会把「退避重试」的限流误升级成「丢历史 restart」。
    // 两条都**含** "too many tokens"（命中 pi-ai 兜底 OVERFLOW pattern），靠 NON_OVERFLOW 前缀排除判回 false
    // ——这才真正钉死排除分支（若只 getOverflowPatterns() 不排除，两条都会误判 true）。
    expect(
      defaultIsContextOverflow("Throttling error: too many tokens, please wait before trying again"),
    ).toBe(false);
    expect(defaultIsContextOverflow("Service unavailable: too many tokens this minute")).toBe(false);
  });

  it("does NOT false-positive on parameter-validation errors mentioning input length", () => {
    // "input length" 这条已收紧成完整短语 "range of input length"（DashScope 真实文案），
    // 不再误伤裸的参数校验错误。
    expect(defaultIsContextOverflow("invalid input length for field 'name'")).toBe(false);
    expect(defaultIsContextOverflow("input length must be positive")).toBe(false);
  });
});
