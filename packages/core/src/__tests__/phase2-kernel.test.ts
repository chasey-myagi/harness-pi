/**
 * Phase 2 tests —— dispatcher 泛型化 / DecisionOutcome / verifyHookDependencies /
 * isConcurrencySafe 错误上报 / _runOneTurn 拆分后的可观察行为。
 */

import { describe, it, expect } from "vitest";
import {
  AgentSession,
  HookDispatcher,
  verifyHookDependencies,
  Type,
  type DecisionOutcome,
  type HarnessTool,
  type Hook,
  type HookDependencyWarning,
  type HookFailureInfo,
} from "../index.js";
import { createFakeModel, createTestContext } from "../testing.js";

/* ──────────────── verifyHookDependencies ──────────────── */

describe("Phase 2: verifyHookDependencies", () => {
  const noopHook = (name: string, extras: Partial<Hook> = {}): Hook => ({
    name,
    ...extras,
  });

  it("missing-required: warn when required hook not registered", () => {
    const warnings = verifyHookDependencies([
      noopHook("a", { requires: ["nonexistent"] }),
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.kind).toBe("missing-required");
    expect(warnings[0]?.hook).toBe("a");
    expect(warnings[0]?.related).toBe("nonexistent");
  });

  it("required-after-self: warn when dep registered after self", () => {
    const warnings = verifyHookDependencies([
      noopHook("a", { requires: ["b"] }),
      noopHook("b"),
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.kind).toBe("required-after-self");
  });

  it("no warning when dep registered before self", () => {
    const warnings = verifyHookDependencies([
      noopHook("b"),
      noopHook("a", { requires: ["b"] }),
    ]);
    expect(warnings).toEqual([]);
  });

  it("conflict: warn when both registered", () => {
    const warnings = verifyHookDependencies([
      noopHook("a", { conflictsWith: ["b"] }),
      noopHook("b"),
    ]);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings.find((w) => w.kind === "conflict")).toBeDefined();
  });

  it("duplicate-name: warn when same name registered twice", () => {
    const warnings = verifyHookDependencies([noopHook("a"), noopHook("a")]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.kind).toBe("duplicate-name");
  });

  it("session 构造期把 warning emit 到 consoleSink", async () => {
    const messages: Array<{ msg: string; turnIdx: number }> = [];
    const fake = createFakeModel([
      { content: [{ type: "text", text: "done" }] },
    ]);
    new AgentSession({
      model: fake,
      tools: [],
      hooks: [
        { name: "a", requires: ["b"] }, // b 不存在
      ],
      consoleSink: (msg, c) => messages.push({ msg, turnIdx: c.turnIdx }),
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.msg).toContain("hook-deps:missing-required");
    expect(messages[0]?.turnIdx).toBe(-1); // 构造期约定
    fake.teardown();
  });

  it("use() 后重新校验依赖（之前 missing 现在补齐）", () => {
    const consoleMessages: string[] = [];
    const fake = createFakeModel([
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      hooks: [{ name: "a", requires: ["b"] }],
      consoleSink: (msg) => consoleMessages.push(msg),
    });
    expect(consoleMessages.some((m) => m.includes("missing-required"))).toBe(
      true,
    );
    consoleMessages.length = 0;
    // use("b") 之后理论上 still missing required-after-self（b 在 a 之后）
    session.use({ name: "b" });
    expect(
      consoleMessages.some((m) => m.includes("required-after-self")),
    ).toBe(true);
    fake.teardown();
  });
});

/* ──────────────── DecisionOutcome discriminated union ──────────────── */

describe("Phase 2: fireDecisionOutcome", () => {
  it("kind=none when no hook responds", async () => {
    const dispatcher = new HookDispatcher([]);
    const { ctx } = createTestContext();
    const out: DecisionOutcome = await dispatcher.fireDecisionOutcome(
      "onPreToolUse",
      {
        call: {
          type: "toolCall",
          id: "1",
          name: "echo",
          arguments: {},
        },
        tool: {
          name: "echo",
          description: "",
          parameters: Type.Object({}),
          execute: async () => ({ content: [] }),
        },
      },
      ctx,
    );
    expect(out.kind).toBe("none");
  });

  it("kind=context-only when hooks only inject additionalContext", async () => {
    const dispatcher = new HookDispatcher([
      {
        name: "ctx-injector",
        onPreToolUse: () => ({ additionalContext: "hello" }),
      },
    ]);
    const { ctx } = createTestContext();
    const out: DecisionOutcome = await dispatcher.fireDecisionOutcome(
      "onPreToolUse",
      {
        call: {
          type: "toolCall",
          id: "1",
          name: "echo",
          arguments: {},
        },
        tool: {
          name: "echo",
          description: "",
          parameters: Type.Object({}),
          execute: async () => ({ content: [] }),
        },
      },
      ctx,
    );
    expect(out.kind).toBe("context-only");
    if (out.kind === "context-only") {
      expect(out.additionalContext).toBe("hello");
    }
  });

  it("kind=decided when hook returns decision", async () => {
    const dispatcher = new HookDispatcher([
      {
        name: "denier",
        onPreToolUse: () => ({
          decision: "deny" as const,
          reason: "nope",
          additionalContext: "side info",
        }),
      },
    ]);
    const { ctx } = createTestContext();
    const out: DecisionOutcome = await dispatcher.fireDecisionOutcome(
      "onPreToolUse",
      {
        call: {
          type: "toolCall",
          id: "1",
          name: "echo",
          arguments: {},
        },
        tool: {
          name: "echo",
          description: "",
          parameters: Type.Object({}),
          execute: async () => ({ content: [] }),
        },
      },
      ctx,
    );
    expect(out.kind).toBe("decided");
    if (out.kind === "decided") {
      expect(out.result.decision).toBe("deny");
      expect(out.result.reason).toBe("nope");
      expect(out.result.additionalContext).toBe("side info");
    }
  });
});

/* ──────────────── DecisionOutcome edge cases (Gate-2 #4) ──────────────── */

describe("Phase 2 (post Gate-2): fireDecisionOutcome edge cases", () => {
  const makeProbeArgs = () =>
    ({
      call: {
        type: "toolCall" as const,
        id: "1",
        name: "echo",
        arguments: {},
      },
      tool: {
        name: "echo",
        description: "",
        parameters: Type.Object({}),
        execute: async () => ({ content: [] }),
      },
    });

  it("kind=context-only when only systemMessage is set (no additionalContext)", async () => {
    const dispatcher = new HookDispatcher([
      {
        name: "sys-only",
        onPreToolUse: () => ({ systemMessage: "hey operator" }),
      },
    ]);
    const { ctx } = createTestContext();
    const out = await dispatcher.fireDecisionOutcome(
      "onPreToolUse",
      makeProbeArgs(),
      ctx,
    );
    expect(out.kind).toBe("context-only");
    if (out.kind === "context-only") {
      expect(out.systemMessage).toBe("hey operator");
      expect(out.additionalContext).toBeUndefined();
    }
  });

  it("kind=none when hook returns { continue: true } only", async () => {
    const dispatcher = new HookDispatcher([
      {
        name: "no-op-continue",
        onPreToolUse: () => ({ continue: true }),
      },
    ]);
    const { ctx } = createTestContext();
    const out = await dispatcher.fireDecisionOutcome(
      "onPreToolUse",
      makeProbeArgs(),
      ctx,
    );
    expect(out.kind).toBe("none");
  });

  it("exhaustive switch (compile-time): all 3 kinds covered", async () => {
    // Type-level smoke: if a new kind is added without a switch arm, this would
    // fail to typecheck via the never check in the default arm.
    const handle = (o: DecisionOutcome): string => {
      switch (o.kind) {
        case "decided":
          return "d";
        case "context-only":
          return "c";
        case "none":
          return "n";
        default: {
          const _exhaustive: never = o;
          return _exhaustive;
        }
      }
    };
    const dispatcher = new HookDispatcher([]);
    const { ctx } = createTestContext();
    const out = await dispatcher.fireDecisionOutcome(
      "onPreToolUse",
      makeProbeArgs(),
      ctx,
    );
    expect(handle(out)).toBe("n");
  });
});

/* ──────────────── Phase split: abort propagation (Gate-2 #3) ──────────────── */

describe("Phase 2 (post Gate-2): abort between phases", () => {
  it("onLlmEnd abort → 跳过 toolBatch 跟 onTurnEnd（新行为）", async () => {
    const seq: string[] = [];
    const abortFromLlm: Hook = {
      name: "abort-on-llm",
      onLlmEnd(_input, ctx) {
        seq.push("llmEnd");
        ctx.abort("abort from onLlmEnd");
      },
      onPostToolUse() {
        seq.push("postTool");
      },
      onTurnEnd() {
        seq.push("turnEnd");
      },
    };
    const echo: HarnessTool = {
      name: "echo",
      description: "",
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text", text: "x" }] };
      },
    };
    const fake = createFakeModel([
      {
        content: [{ type: "toolCall", name: "echo", arguments: {} }],
      },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [echo],
      hooks: [abortFromLlm],
    });
    const summary = await session.run("go");
    expect(summary.reason).toBe("aborted");
    // onLlmEnd 之后 ctx.abort()：phase split 让 toolBatch + turnEnd 都不跑
    expect(seq).toEqual(["llmEnd"]);
    fake.teardown();
  });
});

/* ──────────────── isConcurrencySafe 错误上报 ──────────────── */

describe("Phase 2: isConcurrencySafe error surfacing", () => {
  it("isConcurrencySafe 抛错时 fire onError 而非静默吞", async () => {
    const errors: Error[] = [];
    const failingTool: HarnessTool = {
      name: "broken",
      description: "throws in isConcurrencySafe",
      parameters: Type.Object({}),
      isConcurrencySafe: () => {
        throw new Error("intentional");
      },
      async execute() {
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
    const observer: Hook = {
      name: "observer",
      onError(input) {
        if (input.phase === "tool") errors.push(input.err);
      },
    };
    const fake = createFakeModel([
      {
        content: [
          {
            type: "toolCall",
            name: "broken",
            arguments: {},
          },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [failingTool],
      hooks: [observer],
    });
    await session.run("go");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]?.message).toBe("intentional");
    fake.teardown();
  });

  it("isConcurrencySafe 抛错的 tool 仍然顺序执行（fail-closed unsafe）", async () => {
    let executed = false;
    const failingTool: HarnessTool = {
      name: "broken",
      description: "throws in isConcurrencySafe",
      parameters: Type.Object({}),
      isConcurrencySafe: () => {
        throw new Error("intentional");
      },
      async execute() {
        executed = true;
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
    const fake = createFakeModel([
      {
        content: [
          {
            type: "toolCall",
            name: "broken",
            arguments: {},
          },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [failingTool],
    });
    await session.run("go");
    expect(executed).toBe(true);
    fake.teardown();
  });
});

/* ──────────────── _invokeSafe 泛型化（行为级 smoke）──────────────── */

describe("Phase 2: dispatcher generic invoke", () => {
  it("event hook 返回 string 不被当作 HookResult", async () => {
    // event 路径只关心 HookResult 形态；如果 hook 错误返回 string，dispatcher 应忽略而非崩
    const dispatcher = new HookDispatcher([
      // @ts-expect-error 故意返回错类型测试容忍度
      { name: "weird", onTurnStart: () => "this is not a HookResult" },
    ]);
    const { ctx } = createTestContext();
    const merged = await dispatcher.fireEvent(
      "onTurnStart",
      { turnIdx: 0 },
      ctx,
    );
    // 应当不 crash，merged 是空
    expect(merged.systemMessages).toEqual([]);
    expect(merged.additionalContexts).toEqual([]);
  });
});

/* ──────────────── _runOneTurn 拆分后 — phase 行为 ──────────────── */

describe("Phase 2: _runOneTurn phase split — observable behavior", () => {
  it("phase 顺序：onTurnStart → LLM → tools → onTurnEnd（hook 看到的事件序列）", async () => {
    const seq: string[] = [];
    const tracer: Hook = {
      name: "tracer",
      onTurnStart: () => {
        seq.push("turnStart");
      },
      onLlmEnd: () => {
        seq.push("llmEnd");
      },
      onPostToolUse: () => {
        seq.push("postTool");
      },
      onTurnEnd: () => {
        seq.push("turnEnd");
      },
    };
    const echo: HarnessTool = {
      name: "echo",
      description: "",
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text", text: "x" }] };
      },
    };
    const fake = createFakeModel([
      {
        content: [
          { type: "toolCall", name: "echo", arguments: {} },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [echo],
      hooks: [tracer],
    });
    await session.run("go");
    // 两个 turn：第一个 tool call，第二个无 tool
    expect(seq).toEqual([
      "turnStart",
      "llmEnd",
      "postTool",
      "turnEnd",
      "turnStart",
      "llmEnd",
      "turnEnd",
    ]);
    fake.teardown();
  });

  it("phase split 后 continue=false in onTurnEnd 立刻终止 session", async () => {
    const tracer: Hook = {
      name: "halter",
      onTurnEnd: () => ({ continue: false, stopReason: "I'm done" }),
    };
    const fake = createFakeModel([
      { content: [{ type: "text", text: "first" }] },
      // 不会到这里，session 已 abort
      { content: [{ type: "text", text: "second" }] },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      hooks: [tracer],
    });
    const summary = await session.run("go");
    expect(summary.reason).toBe("aborted");
    expect(summary.abortReason).toContain("I'm done");
    fake.teardown();
  });
});

/* ──────────────── failureSink 还在工作（_invokeSafe 泛型化后回归测）──────────────── */

describe("Phase 2: failureSink regression (generic _invokeSafe)", () => {
  it("hook throw 时 failureSink 收到正确 info", async () => {
    const failures: HookFailureInfo[] = [];
    const fake = createFakeModel([
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      hooks: [
        {
          name: "thrower",
          onTurnStart: () => {
            throw new Error("boom");
          },
        },
      ],
      hookFailureSink: (info) => failures.push(info),
    });
    await session.run("go");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.hookName).toBe("thrower");
    expect(failures[0]?.method).toBe("onTurnStart");
    expect(failures[0]?.errorMessage).toBe("boom");
    fake.teardown();
  });
});

// Type-level only: ensure `HookDependencyWarning` is exported and structurally complete
const _typeCheck: HookDependencyWarning = {
  kind: "missing-required",
  hook: "a",
  related: "b",
  message: "x",
};
void _typeCheck;
