import { describe, it, expect } from "vitest";
import { createUserMessage } from "@harness-pi/core";
import { createTestContext } from "@harness-pi/core/testing";
import type { Message } from "@earendil-works/pi-ai";
import {
  defaultSummarize,
  renderSummaryPrompt,
  DEFAULT_SUMMARY_TEMPLATE,
} from "../summary-template.js";

const NINE_SECTIONS = [
  "Primary Request and Intent",
  "Key Concepts",
  "Files and Resources",
  "Errors and Fixes",
  "Problem Solving",
  "All User Messages",
  "Pending Tasks",
  "Current Work",
  "Next Step",
];

describe("defaultSummarize / summary template", () => {
  it("renders all 9 sections into the prompt", async () => {
    let seen = "";
    const summarize = defaultSummarize({
      complete: async (p) => {
        seen = p;
        return "SUMMARY";
      },
    });
    const { ctx } = createTestContext();
    const out = await summarize([createUserMessage("hello")], ctx);

    expect(out).toBe("SUMMARY");
    for (const [i, label] of NINE_SECTIONS.entries()) {
      expect(seen).toContain(`${i + 1}. ${label}`);
    }
  });

  it("embeds early message content into the transcript", async () => {
    let seen = "";
    const summarize = defaultSummarize({
      complete: async (p) => {
        seen = p;
        return "S";
      },
    });
    const assistant: Message = {
      role: "assistant",
      content: [{ type: "text", text: "ASSISTANT_SAID_THIS" }],
      api: "x" as never,
      provider: "p",
      model: "m",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: 0,
    };
    const { ctx } = createTestContext();
    await summarize([createUserMessage("USER_ASKED_THIS"), assistant], ctx);

    expect(seen).toContain("USER_ASKED_THIS");
    expect(seen).toContain("ASSISTANT_SAID_THIS");
    expect(seen).toContain("user: USER_ASKED_THIS");
    expect(seen).toContain("assistant: ASSISTANT_SAID_THIS");
  });

  it("includes tool call args and tool result names in the transcript", async () => {
    let seen = "";
    const summarize = defaultSummarize({ complete: async (p) => ((seen = p), "S") });
    const assistant: Message = {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/etc/hosts" } }],
      api: "x" as never,
      provider: "p",
      model: "m",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: 0,
    };
    const toolResult: Message = {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read",
      content: [{ type: "text", text: "FILE_BODY" }],
      isError: false,
      timestamp: 0,
    };
    const { ctx } = createTestContext();
    await summarize([assistant, toolResult], ctx);

    expect(seen).toContain("read");
    expect(seen).toContain("/etc/hosts");
    expect(seen).toContain("toolResult(read): FILE_BODY");
  });

  it("a custom template overrides the default and still receives the transcript", async () => {
    let seen = "";
    const summarize = defaultSummarize({
      complete: async (p) => ((seen = p), "S"),
      template: "ONLY_THIS {transcript} END",
    });
    const { ctx } = createTestContext();
    await summarize([createUserMessage("payload")], ctx);

    expect(seen).toContain("ONLY_THIS");
    expect(seen).toContain("payload");
    expect(seen).not.toContain("Primary Request and Intent"); // 默认 9 段未出现
    expect(seen).toBe("ONLY_THIS user: payload END");
  });

  it("renderSummaryPrompt defaults to the 9-section template", () => {
    const out = renderSummaryPrompt([createUserMessage("x")]);
    expect(out).toBe(DEFAULT_SUMMARY_TEMPLATE.replace("{transcript}", "user: x"));
  });

  it("renderMessage covers string content and image blocks (#98)", () => {
    // 两条未覆盖分支：① content 为裸 string（非 block 数组）；② block 数组里的 image block → "[image]"。
    const stringMsg = { role: "user", content: "PLAIN_STRING" } as unknown as Message;
    const imageMsg = {
      role: "user",
      content: [{ type: "image", source: { kind: "base64", data: "x", mimeType: "image/png" } }],
    } as unknown as Message;
    const out = renderSummaryPrompt([stringMsg, imageMsg], "{transcript}");
    expect(out).toContain("user: PLAIN_STRING");
    expect(out).toContain("user: [image]");
  });
});
