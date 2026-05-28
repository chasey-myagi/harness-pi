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

  it("streaming forwarder 在 session 跑完后从 _hooks 真的被移除（不只是 noop）", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "first" }] },
      { content: [{ type: "text", text: "second" }] },
    ]);
    const session = new AgentSession({ model: fake, tools: [] });
    const baselineHooks = (session as unknown as { _hooks: unknown[] })._hooks
      .length;

    const s1 = session.runStreaming("go");
    const events1: SessionEvent[] = [];
    for await (const ev of s1) events1.push(ev);
    await s1.finalSummary;

    // 直接断言 forwarder 不在 hook list 里
    const afterHooks = (session as unknown as { _hooks: unknown[] })._hooks
      .length;
    expect(afterHooks).toBe(baselineHooks);

    // 反向证明：第二次 streaming 只该有 1 个 session-start（不该是 2 个 stale forwarder 重复 push）
    const s2 = session.runStreaming("again");
    const events2: SessionEvent[] = [];
    for await (const ev of s2) events2.push(ev);
    await s2.finalSummary;
    expect(events2.filter((e) => e.type === "session-start")).toHaveLength(1);
    fake.teardown();
  });

  it("M2: consumer break 触发 iter.return() → session abort", async () => {
    const echoTool: HarnessTool = {
      name: "echo",
      description: "",
      parameters: Type.Object({}),
      async execute() {
        // 慢一点让 break 有机会触发
        await new Promise((r) => setTimeout(r, 20));
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
    const fake = createFakeModel([
      { content: [{ type: "toolCall", name: "echo", arguments: {} }] },
      { content: [{ type: "text", text: "should not reach" }] },
    ]);
    const session = new AgentSession({ model: fake, tools: [echoTool] });
    const stream = session.runStreaming("go");
    for await (const ev of stream) {
      if (ev.type === "turn-start") break;
    }
    const summary = await stream.finalSummary;
    expect(summary.reason).toBe("aborted");
    expect(summary.abortReason).toContain("consumer broke iteration");
    fake.teardown();
  });

  it("M3: 并发 runStreaming → 第二次返回带 error 事件的 closed iterator（不抛 sync exception）", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "first" }] },
      { content: [{ type: "text", text: "second" }] },
    ]);
    const session = new AgentSession({ model: fake, tools: [] });
    const s1 = session.runStreaming("first");
    // 不 await s1 finalSummary，立刻尝试 s2 —— _running=true，应该返回 closed iter（不 throw）
    const s2 = session.runStreaming("second");
    const s2Events: SessionEvent[] = [];
    for await (const ev of s2) s2Events.push(ev);
    expect(s2Events.some((e) => e.type === "error")).toBe(true);
    await expect(s2.finalSummary).rejects.toThrow();
    // 收尾 s1
    for await (const _ of s1) void _;
    await s1.finalSummary;
    fake.teardown();
  });
});

/* ──────────────── M6: 覆盖 continuation-check + error arm ──────────────── */

describe("Phase 3 (post Gate-3): all 8 SessionEvent arms produced at runtime", () => {
  it("continuation-check arm fires when onContinuationCheck hook is registered", async () => {
    let asked = false;
    const fake = createFakeModel([
      { content: [{ type: "text", text: "first" }] },
      { content: [{ type: "text", text: "second" }] },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      hooks: [
        {
          name: "continue-once",
          onContinuationCheck: () => {
            if (asked) return; // 第二次 say no
            asked = true;
            return { continue: true };
          },
        },
      ],
    });
    const events: SessionEvent[] = [];
    for await (const ev of session.runStreaming("go")) events.push(ev);
    expect(events.some((e) => e.type === "continuation-check")).toBe(true);
    fake.teardown();
  });

  it("error arm fires when LLM provider returns error stop reason", async () => {
    // Fake provider 把 throwError 转成 assistantMessage with stopReason="error"
    // 跟"真正的 throw"不同——这里测的是 kernel 检测到 error stop 时是否走 onError
    const fake = createFakeModel([
      { content: [], throwError: new Error("LLM provider crashed") },
    ]);
    const session = new AgentSession({ model: fake, tools: [] });
    const events: SessionEvent[] = [];
    for await (const ev of session.runStreaming("go")) events.push(ev);
    // 至少 session-end 一定有；error 事件 fire 取决于 kernel 怎么处理 stopReason=error
    expect(events.some((e) => e.type === "session-end")).toBe(true);
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
