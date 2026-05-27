/**
 * Phase 1 foundation tests —— state typing / log sink / config view / KERNEL_INTERNALS 封装。
 *
 * 这些 test 锁住 hook 接口的 v2 表面，未来如果有 PR 破坏其中任一点都会 fail。
 */

import { describe, it, expect, vi } from "vitest";
import {
  AgentSession,
  type Hook,
  type HookContext,
  type LogLevel,
  type HarnessTool,
  Type,
} from "../index.js";
import { createFakeModel } from "../testing.js";

/* ──────────────── Phase 1.1 state typing ──────────────── */

// 在 test 文件里 augment，证明 plugin 端可以注册 key 并自动推断
declare module "../hook.js" {
  interface HookStateRegistry {
    "phase1-test.counter": number;
    "phase1-test.label": string;
  }
}

describe("Phase 1: TypedStateMap", () => {
  it("registered keys are typed; get returns T | undefined without `as`", async () => {
    let observed: number | undefined;
    let observedLabel: string | undefined;

    const probe: Hook = {
      name: "probe",
      onSessionStart(_input, ctx) {
        // typed set
        ctx.state.set("phase1-test.counter", 42);
        ctx.state.set("phase1-test.label", "hello");
      },
      onTurnEnd(_input, ctx) {
        // typed get — no `as` needed; 推断为 number | undefined / string | undefined
        observed = ctx.state.get("phase1-test.counter");
        observedLabel = ctx.state.get("phase1-test.label");
      },
    };

    const fake = createFakeModel([
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      hooks: [probe],
    });
    await session.run("go");

    expect(observed).toBe(42);
    expect(observedLabel).toBe("hello");
    fake.teardown();
  });

  it("unregistered string keys fall back to unknown", async () => {
    const probe: Hook = {
      name: "probe",
      onSessionStart(_input, ctx) {
        ctx.state.set("not-registered-key", { foo: 1 });
        const v = ctx.state.get("not-registered-key");
        // v 的类型是 unknown — 用户得自己 narrow / cast
        expect(v).toEqual({ foo: 1 });
      },
    };
    const fake = createFakeModel([
      { content: [{ type: "text", text: "ok" }] },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      hooks: [probe],
    });
    await session.run("go");
    fake.teardown();
  });

  it("state has/delete/clear/size work as expected", async () => {
    const observations: Array<string | number | boolean> = [];
    const probe: Hook = {
      name: "probe",
      onSessionStart(_input, ctx) {
        ctx.state.set("phase1-test.counter", 1);
        observations.push(ctx.state.has("phase1-test.counter"));
        observations.push(ctx.state.size);
        ctx.state.delete("phase1-test.counter");
        observations.push(ctx.state.has("phase1-test.counter"));
        ctx.state.set("phase1-test.counter", 5);
        ctx.state.set("phase1-test.label", "x");
        observations.push(ctx.state.size);
        ctx.state.clear();
        observations.push(ctx.state.size);
      },
    };
    const fake = createFakeModel([
      { content: [{ type: "text", text: "ok" }] },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      hooks: [probe],
    });
    await session.run("go");
    expect(observations).toEqual([true, 1, false, 2, 0]);
    fake.teardown();
  });
});

/* ──────────────── Phase 1.2 ctx.log structured sink ──────────────── */

describe("Phase 1: ctx.log", () => {
  it("calls custom logSink with sessionId + turnIdx auto-attached", async () => {
    const captured: Array<{
      level: LogLevel;
      msg: string;
      fields: Record<string, unknown>;
    }> = [];

    const probe: Hook = {
      name: "probe",
      onTurnStart(_input, ctx) {
        ctx.log.info("turn started", { hook: "probe", extra: 1 });
        ctx.log.warn("warning", { hook: "probe" });
      },
    };
    const fake = createFakeModel([
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      hooks: [probe],
      logSink: (level, msg, fields) => {
        captured.push({ level, msg, fields });
      },
    });
    await session.run("go");

    expect(captured.length).toBe(2);
    expect(captured[0]?.level).toBe("info");
    expect(captured[0]?.msg).toBe("turn started");
    expect(captured[0]?.fields["sessionId"]).toBe(session.id);
    expect(captured[0]?.fields["turnIdx"]).toBe(0);
    expect(captured[0]?.fields["hook"]).toBe("probe");
    expect(captured[0]?.fields["extra"]).toBe(1);
    expect(captured[1]?.level).toBe("warn");
    fake.teardown();
  });

  it("default log sink falls back to console (smoke test)", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const probe: Hook = {
      name: "probe",
      onTurnStart(_input, ctx) {
        ctx.log.info("smoke");
      },
    };
    const fake = createFakeModel([
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      hooks: [probe],
    });
    await session.run("go");

    expect(spy).toHaveBeenCalled();
    const line = spy.mock.calls[0]?.[0] as string;
    expect(line).toContain("harness-pi");
    expect(line).toContain(session.id);
    expect(line).toContain("smoke");
    spy.mockRestore();
    fake.teardown();
  });
});

/* ──────────────── Phase 1.3 ctx.config view ──────────────── */

describe("Phase 1: ctx.config", () => {
  it("exposes sessionId / model / toolNames / maxTurns / maxContinuations", async () => {
    let captured: HookContext["config"] | null = null;

    const echo: HarnessTool = {
      name: "echo",
      description: "echo",
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text", text: "hi" }] };
      },
    };
    const probe: Hook = {
      name: "probe",
      onSessionStart(_input, ctx) {
        captured = ctx.config;
      },
    };
    const fake = createFakeModel([
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [echo],
      hooks: [probe],
      maxTurns: 12,
      maxContinuations: 3,
    });
    await session.run("go");

    expect(captured).not.toBeNull();
    expect(captured!.sessionId).toBe(session.id);
    expect(captured!.maxTurns).toBe(12);
    expect(captured!.maxContinuations).toBe(3);
    expect(Array.from(captured!.toolNames)).toEqual(["echo"]);
    expect(captured!.model.id).toMatch(/^fake-model-/);
    fake.teardown();
  });

  it("config.toolNames is frozen — plugin 不能改 kernel 的 config 视图", async () => {
    const probe: Hook = {
      name: "probe",
      onSessionStart(_input, ctx) {
        expect(() => {
          (ctx.config.toolNames as unknown as string[]).push("hack");
        }).toThrow();
      },
    };
    const fake = createFakeModel([
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      hooks: [probe],
    });
    await session.run("go");
    fake.teardown();
  });
});

/* ──────────────── Phase 1.4 KERNEL_INTERNALS encapsulation ──────────────── */

describe("Phase 1: KERNEL_INTERNALS encapsulation (post Gate-1 fix)", () => {
  it("`@harness-pi/core` index 不导出 internal 标识符（getKernelInternals / KERNEL_INTERNALS_BAG）", async () => {
    const mod = await import("../index.js");
    const keys = Object.keys(mod);
    expect(keys).not.toContain("getKernelInternals");
    expect(keys).not.toContain("KERNEL_INTERNALS_BAG");
    expect(keys).not.toContain("KERNEL_INTERNALS");
  });

  it("ctx 实例上没有任何 own symbol property — Object.getOwnPropertySymbols 反射不到 internals", async () => {
    let leakedSymbols: symbol[] = [];
    const probe: Hook = {
      name: "probe",
      onTurnStart(_input, ctx) {
        leakedSymbols = Object.getOwnPropertySymbols(ctx);
      },
    };
    const fake = createFakeModel([
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      hooks: [probe],
    });
    await session.run("go");
    expect(leakedSymbols.length).toBe(0);
    fake.teardown();
  });

  it("ctx 上没有任何 internal-looking own property 名（穷举 enumerable keys）", async () => {
    let leakedKeys: string[] = [];
    const probe: Hook = {
      name: "probe",
      onTurnStart(_input, ctx) {
        leakedKeys = Object.getOwnPropertyNames(ctx).filter(
          (k) => /internal|kernel|mutator|setTurnIdx|setSignal/i.test(k),
        );
      },
    };
    const fake = createFakeModel([
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      hooks: [probe],
    });
    await session.run("go");
    expect(leakedKeys).toEqual([]);
    fake.teardown();
  });
});

/* ──────────────── Gate-1 follow-up: deep-freeze + log safety + session-log dead ──────────────── */

describe("Phase 1 (post Gate-1): ctx.config deep-frozen", () => {
  it("ctx.config 本身 frozen — 不能改 maxTurns / sessionId", async () => {
    let mutationThrew = false;
    let valueAfter: number | null = null;
    const probe: Hook = {
      name: "probe",
      onSessionStart(_input, ctx) {
        try {
          (ctx.config as { maxTurns: number }).maxTurns = 999;
        } catch {
          mutationThrew = true;
        }
        valueAfter = ctx.config.maxTurns;
      },
    };
    const fake = createFakeModel([
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      hooks: [probe],
      maxTurns: 50,
    });
    await session.run("go");
    // strict mode 下 freeze object 的赋值会 throw；sloppy 模式下静默失败但不生效
    expect(mutationThrew || valueAfter === 50).toBe(true);
    expect(valueAfter).toBe(50);
    fake.teardown();
  });

  it("ctx.config.model frozen — 不能改 model.id", async () => {
    let modelIdAfter: string | null = null;
    const probe: Hook = {
      name: "probe",
      onSessionStart(_input, ctx) {
        try {
          (ctx.config.model as { id: string }).id = "hacked";
        } catch {
          /* expected to throw in strict mode */
        }
        modelIdAfter = ctx.config.model.id;
      },
    };
    const fake = createFakeModel([
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      hooks: [probe],
    });
    await session.run("go");
    expect(modelIdAfter).not.toBe("hacked");
    expect(modelIdAfter).toMatch(/^fake-model-/);
    fake.teardown();
  });

  it("ctx.config.toolNames frozen — 已在前一组测过，这里再 cover Array.prototype mutator", async () => {
    let pushThrew = false;
    let lenAfter = -1;
    const probe: Hook = {
      name: "probe",
      onSessionStart(_input, ctx) {
        try {
          (ctx.config.toolNames as unknown as string[]).push("hack");
        } catch {
          pushThrew = true;
        }
        lenAfter = ctx.config.toolNames.length;
      },
    };
    const fake = createFakeModel([
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      hooks: [probe],
    });
    await session.run("go");
    expect(pushThrew).toBe(true);
    expect(lenAfter).toBe(0);
    fake.teardown();
  });
});

describe("Phase 1 (post Gate-1): ctx.log safety", () => {
  it("plugin 传 sessionId/turnIdx 不能覆盖 kernel 注入的真实值", async () => {
    const captured: Array<{
      level: LogLevel;
      msg: string;
      fields: Record<string, unknown>;
    }> = [];
    const probe: Hook = {
      name: "probe",
      onTurnStart(_input, ctx) {
        ctx.log.info("hi", {
          sessionId: "spoofed-session",
          turnIdx: 999,
          hook: "probe",
        });
      },
    };
    const fake = createFakeModel([
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      hooks: [probe],
      logSink: (level, msg, fields) => {
        captured.push({ level, msg, fields });
      },
    });
    await session.run("go");
    expect(captured[0]?.fields["sessionId"]).toBe(session.id);
    expect(captured[0]?.fields["turnIdx"]).toBe(0);
    expect(captured[0]?.fields["hook"]).toBe("probe");
    fake.teardown();
  });

  it("默认 sink 对循环引用 fields 不 crash", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const probe: Hook = {
      name: "probe",
      onTurnStart(_input, ctx) {
        const circ: Record<string, unknown> = {};
        circ["self"] = circ;
        // 不应 throw —— defaultLogSink 内部 try/catch 兜底
        expect(() => ctx.log.info("circ", circ)).not.toThrow();
      },
    };
    const fake = createFakeModel([
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      hooks: [probe],
    });
    await session.run("go");
    spy.mockRestore();
    fake.teardown();
  });
});
