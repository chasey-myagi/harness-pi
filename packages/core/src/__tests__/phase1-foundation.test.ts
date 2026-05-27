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

/* ──────────────── Phase 1.4 KERNEL_INTERNALS 不外泄 ──────────────── */

describe("Phase 1: KERNEL_INTERNALS encapsulation", () => {
  it("`@harness-pi/core` index 不导出 KERNEL_INTERNALS symbol", async () => {
    const mod = await import("../index.js");
    // 只导出 public API；symbol 不在
    const keys = Object.keys(mod);
    for (const k of keys) {
      expect(k.toLowerCase()).not.toContain("internal");
      expect(k.toLowerCase()).not.toContain("kernel_");
    }
    // 也不应能拿到我们的 KERNEL_INTERNALS symbol（其他 Symbol.toStringTag 类的允许存在）
    const symbols = Object.getOwnPropertySymbols(mod);
    for (const s of symbols) {
      expect(s.description ?? "").not.toContain("kernel-internals");
    }
  });

  it("plugin 拿不到 KERNEL_INTERNALS symbol，调不到 setTurnIdx", async () => {
    let leaked = false;
    const probe: Hook = {
      name: "probe",
      onTurnStart(_input, ctx) {
        // plugin 端拿到的 ctx 上有 symbol-keyed 属性，但 plugin 没有 symbol 引用
        // 无法构造一个能命中这个 key 的访问。
        // 唯一通用 escape hatch：getOwnPropertySymbols。这个 test 锁住：即使能拿到 symbol，
        // 改完也不影响 sessionId / 暴露的 turnIdx —— turnIdx 是 readonly getter 反射本地 state，
        // 但 plugin 不该走这条路。
        const syms = Object.getOwnPropertySymbols(ctx);
        // 我们知道 KERNEL_INTERNALS 是一个 symbol，但 plugin 没有 Symbol.for("...") 名字
        // （我们用 Symbol(desc) 而不是 Symbol.for，所以注册表里查不到）
        const fetched = Symbol.for("@harness-pi/core::kernel-internals");
        const matched = syms.find((s) => s === fetched);
        if (matched) leaked = true;
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
    expect(leaked).toBe(false);
    fake.teardown();
  });
});
