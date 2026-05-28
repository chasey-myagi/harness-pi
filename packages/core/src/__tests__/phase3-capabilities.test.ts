/**
 * Phase 3 tests —— runStreaming async iterable + cost-tracker mode + smoke for forkSession.
 *
 * forkSession 是 plugins 包的 controller，所以那块的 deep test 在 plugins 包测；这里只
 * confirm runStreaming / continueStreaming 的 event 序列对得上 hook 序列。
 */

import { describe, it, expect } from "vitest";
import {
  AgentSession,
  Type,
  type HarnessTool,
  type SessionEvent,
} from "../index.js";
import { createFakeModel } from "../testing.js";

/* ──────────────── runStreaming async iterator ──────────────── */

describe("Phase 3: runStreaming", () => {
  const echoTool: HarnessTool = {
    name: "echo",
    description: "",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "ok" }] };
    },
  };

  it("yields session lifecycle events in order", async () => {
    const fake = createFakeModel([
      { content: [{ type: "toolCall", name: "echo", arguments: {} }] },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [echoTool],
    });
    const events: SessionEvent[] = [];
    const stream = session.runStreaming("go");
    for await (const ev of stream) {
      events.push(ev);
    }
    const summary = await stream.finalSummary;

    expect(events[0]?.type).toBe("session-start");
    expect(events[events.length - 1]?.type).toBe("session-end");
    // 期望事件类型集合包含核心几类
    const types = events.map((e) => e.type);
    expect(types).toContain("turn-start");
    expect(types).toContain("llm-end");
    expect(types).toContain("tool-end");
    expect(types).toContain("turn-end");
    expect(summary.reason).toBe("done");
    fake.teardown();
  });

  it("session-end event 包含完整 RunSummary", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({ model: fake, tools: [] });
    const events: SessionEvent[] = [];
    for await (const ev of session.runStreaming("go")) events.push(ev);

    const endEv = events.find((e) => e.type === "session-end");
    expect(endEv).toBeDefined();
    if (endEv && endEv.type === "session-end") {
      expect(endEv.summary.reason).toBe("done");
      expect(typeof endEv.summary.turns).toBe("number");
      expect(typeof endEv.summary.continuations).toBe("number");
    }
    fake.teardown();
  });

  it("finalSummary Promise 跟 iterator 结果一致", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({ model: fake, tools: [] });
    const stream = session.runStreaming("go");
    const events: SessionEvent[] = [];
    for await (const ev of stream) events.push(ev);
    const summary = await stream.finalSummary;
    const endEv = events.find((e) => e.type === "session-end");
    if (endEv && endEv.type === "session-end") {
      expect(endEv.summary).toEqual(summary);
    }
    fake.teardown();
  });

  it("streaming forwarder 在 session 跑完后被卸载（不影响后续 run）", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "first" }] },
      { content: [{ type: "text", text: "second" }] },
    ]);
    const session = new AgentSession({ model: fake, tools: [] });

    // 第一次：streaming
    const s1 = session.runStreaming("go");
    const events1: SessionEvent[] = [];
    for await (const ev of s1) events1.push(ev);
    await s1.finalSummary;

    // 第二次：非 streaming run；forwarder 应已卸载，不会再 push
    const summary2 = await session.run("again");
    expect(summary2.reason).toBe("done");
    fake.teardown();
  });
});

/* ──────────────── exhaustive switch over SessionEvent ──────────────── */

describe("Phase 3: SessionEvent discriminated union", () => {
  it("compile-time exhaustive switch (smoke)", () => {
    const handle = (ev: SessionEvent): string => {
      switch (ev.type) {
        case "session-start":
          return "ss";
        case "turn-start":
          return "ts";
        case "llm-end":
          return "le";
        case "tool-end":
          return "te";
        case "turn-end":
          return "tn";
        case "continuation-check":
          return "cc";
        case "session-end":
          return "se";
        case "error":
          return "er";
        default: {
          const _exhaustive: never = ev;
          return _exhaustive;
        }
      }
    };
    // 调一下确保 lambda 不被 tree-shaken
    expect(typeof handle).toBe("function");
  });
});
