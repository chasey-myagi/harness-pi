import { describe, it, expect } from "vitest";
import { createUserMessage } from "@harness-pi/core";
import type { Message, Tool } from "@earendil-works/pi-ai";
import {
  estimateTokensByChars,
  estimateRequestTokens,
  defaultTokenCounter,
  PER_MESSAGE_OVERHEAD,
} from "../auto-compaction.js";

const m = (t: string): Message => createUserMessage(t);

/** 造一个 pi-ai Tool（name + description + parameters）。 */
function tool(name: string, description: string, parameters: unknown): Tool {
  return { name, description, parameters } as Tool;
}

describe("estimateRequestTokens (X1, issue #55)", () => {
  it("counts more than messages-only when tools are present (锁 D0 7x 低估方向)", () => {
    const messages = [m("hi")];
    const tools = [
      tool("read", "Read a file from disk", {
        type: "object",
        properties: { path: { type: "string", description: "absolute path" } },
        required: ["path"],
      }),
      tool("bash", "Run a shell command in the host shell", {
        type: "object",
        properties: { command: { type: "string", description: "the command" } },
        required: ["command"],
      }),
    ];
    const messagesOnly = estimateTokensByChars(messages);
    const withTools = estimateRequestTokens({ messages, tools });
    // 含 tool schema 的请求级估算 ≫ 仅数消息文本。
    expect(withTools).toBeGreaterThan(messagesOnly);
    // 而且差距显著（tools 的序列化体积远大于一条 "hi"）——不是只多一两个 token。
    expect(withTools).toBeGreaterThan(messagesOnly * 5);
  });

  it("tools contribute additively: adding a tool strictly increases the estimate", () => {
    const messages = [m("question")];
    const t1 = tool("read", "read a file", { type: "object", properties: {} });
    const t2 = tool(
      "grep",
      "search files by pattern with a long description here",
      { type: "object", properties: { pattern: { type: "string" } } },
    );
    const one = estimateRequestTokens({ messages, tools: [t1] });
    const two = estimateRequestTokens({ messages, tools: [t1, t2] });
    expect(two).toBeGreaterThan(one);
  });

  it("systemPrompt contributes: a long system prompt raises the estimate", () => {
    const messages = [m("q")];
    const none = estimateRequestTokens({ messages });
    const withSys = estimateRequestTokens({
      messages,
      systemPrompt: "You are a careful coding agent. ".repeat(50),
    });
    expect(withSys).toBeGreaterThan(none);
  });

  it("tools and systemPrompt contributions are separable (each adds on its own)", () => {
    const messages = [m("q")];
    const t = tool("read", "read a file from disk", { type: "object", properties: {} });
    const sys = "system prompt body ".repeat(20);

    const base = estimateRequestTokens({ messages });
    const plusTool = estimateRequestTokens({ messages, tools: [t] });
    const plusSys = estimateRequestTokens({ messages, systemPrompt: sys });
    const plusBoth = estimateRequestTokens({ messages, tools: [t], systemPrompt: sys });

    expect(plusTool).toBeGreaterThan(base);
    expect(plusSys).toBeGreaterThan(base);
    // 两者一起 = 各自增量之和（在 base 之上叠加），且严格大于任一单项。
    expect(plusBoth).toBe(plusTool + plusSys - base);
    expect(plusBoth).toBeGreaterThan(plusTool);
    expect(plusBoth).toBeGreaterThan(plusSys);
  });

  it("adds a per-message format overhead (count grows with message count even for empty text)", () => {
    const one = estimateRequestTokens({ messages: [m("")] });
    const three = estimateRequestTokens({ messages: [m(""), m(""), m("")] });
    // 空文本仍各计每消息格式开销，故条数多 = 估值高。
    expect(three).toBeGreaterThan(one);
    expect(three - one).toBe(8); // 2 条额外 × 4 tok/消息
  });

  it("reuses CJK / image rules from estimateTokensByChars", () => {
    // CJK：每码点 ≈ 1 token，仍生效。
    const cjk = "你好世界".repeat(10); // 40 码点
    const cjkEst = estimateRequestTokens({ messages: [m(cjk)] });
    // ≈ 40 (CJK) + 每消息开销。
    expect(cjkEst).toBe(40 + PER_MESSAGE_OVERHEAD);

    // 图片：扁平 1000，不随 data 长度膨胀。
    const imgMsg: Message = {
      role: "user",
      content: [{ type: "image", data: "A".repeat(50_000), mimeType: "image/png" }],
      timestamp: 0,
    };
    const imgEst = estimateRequestTokens({ messages: [imgMsg] });
    expect(imgEst).toBe(1000 + PER_MESSAGE_OVERHEAD); // 1000 (image) + 每消息开销
  });

  it("equals messages-only + per-message overhead when tools/systemPrompt are omitted", () => {
    const messages = [m("hello world"), m("second message")];
    expect(estimateRequestTokens({ messages })).toBe(
      estimateTokensByChars(messages) + messages.length * PER_MESSAGE_OVERHEAD,
    );
  });
});

describe("estimateTokensByChars (regression — must stay unchanged by X1)", () => {
  it("counts message text only, no tools/system/format overhead", () => {
    // "hello" = 5 ASCII → ceil(5/4) = 2。绝不因 X1 多算每消息开销或 tool 体积。
    expect(estimateTokensByChars([m("hello")])).toBe(2);
  });

  it("empty message is still 0 (no per-message overhead added)", () => {
    expect(estimateTokensByChars([m("")])).toBe(0);
  });

  it("counts the tool parameters schema (the largest D0 blind spot), not just name+description", () => {
    // 两个 tool 仅 parameters 不同:大 schema 必须让估值严格更高。
    // 防回归:若只数 name+description 漏了 JSON.stringify(parameters),本测试会失败。
    const messages = [m("hi")];
    const small = [tool("t", "d", { type: "object", properties: {} })];
    const bigSchema = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 30 }, (_, i) => [
          `field_${i}`,
          { type: "string", description: "a reasonably long field description ".repeat(3) },
        ]),
      ),
    };
    const big = [tool("t", "d", bigSchema)];
    expect(estimateRequestTokens({ messages, tools: big })).toBeGreaterThan(
      estimateRequestTokens({ messages, tools: small }),
    );
  });
});

describe("defaultTokenCounter", () => {
  it("estimate delegates to estimateRequestTokens", () => {
    const input = {
      messages: [m("hi")],
      tools: [tool("read", "read a file", { type: "object", properties: {} })],
      systemPrompt: "be careful",
    };
    expect(defaultTokenCounter.estimate(input)).toBe(estimateRequestTokens(input));
  });

  it("does not implement count (count? is a future opt-in seam)", () => {
    expect(defaultTokenCounter.count).toBeUndefined();
  });
});
