import { describe, it, expect } from "vitest";
import { AgentSession } from "../session.js";
import { assertCriticalDecisionHooks } from "../dispatcher.js";
import { createFakeModel } from "../testing.js";
import type { Hook } from "../hook.js";

describe("fail-closed classification (critical decision hooks)", () => {
  it("refuses to construct a session with a critical decision hook that omits failClosed", () => {
    const fake = createFakeModel([]);
    const bad: Hook = {
      name: "gate",
      critical: true,
      onPreToolUse: () => ({ decision: "allow" }),
      // failClosed 故意不写
    };
    expect(
      () => new AgentSession({ model: fake, tools: [], hooks: [bad] }),
    ).toThrow(/must declare failClosed explicitly/);
    fake.teardown();
  });

  it("accepts a critical decision hook that declares failClosed:true", () => {
    const fake = createFakeModel([]);
    const hook: Hook = {
      name: "gate",
      critical: true,
      failClosed: true,
      onPreToolUse: () => ({ decision: "allow" }),
    };
    expect(
      () => new AgentSession({ model: fake, tools: [], hooks: [hook] }),
    ).not.toThrow();
    fake.teardown();
  });

  it("accepts a critical decision hook that explicitly opts into failClosed:false", () => {
    // 关键：critical 不强制 failClosed=true，只强制「表态」。显式选 fail-open 是允许的。
    const fake = createFakeModel([]);
    const hook: Hook = {
      name: "gate",
      critical: true,
      failClosed: false,
      onUserPromptSubmit: () => ({ decision: "allow" }),
    };
    expect(
      () => new AgentSession({ model: fake, tools: [], hooks: [hook] }),
    ).not.toThrow();
    fake.teardown();
  });

  it("rejects critical:true on a non-decision hook (category misuse)", () => {
    const fake = createFakeModel([]);
    const bad: Hook = {
      name: "observer",
      critical: true,
      failClosed: true,
      onTurnStart: () => {}, // 不是 decision 方法
    };
    expect(
      () => new AgentSession({ model: fake, tools: [], hooks: [bad] }),
    ).toThrow(/implements no decision method/);
    fake.teardown();
  });

  it("leaves non-critical decision hooks alone (default fail-open, unchanged behavior)", () => {
    const fake = createFakeModel([]);
    const hook: Hook = {
      name: "soft-policy",
      onPreToolUse: () => ({ decision: "allow" }),
      // 非 critical、不写 failClosed —— 完全合法（软策略默认 fail-open）。
    };
    expect(
      () => new AgentSession({ model: fake, tools: [], hooks: [hook] }),
    ).not.toThrow();
    fake.teardown();
  });

  it("enforces the same rule on use() (runtime registration)", () => {
    const fake = createFakeModel([]);
    const session = new AgentSession({ model: fake, tools: [] });
    const bad: Hook = {
      name: "late-gate",
      critical: true,
      onPreToolUse: () => ({ decision: "deny" }),
    };
    expect(() => session.use(bad)).toThrow(/must declare failClosed explicitly/);
    fake.teardown();
  });

  it("assertCriticalDecisionHooks is callable directly and passes a well-formed list", () => {
    expect(() =>
      assertCriticalDecisionHooks([
        { name: "ok", critical: true, failClosed: true, onPreToolUse: () => ({ decision: "allow" }) },
        { name: "plain", onTurnStart: () => {} }, // 非 critical：不校验
      ]),
    ).not.toThrow();
  });

  it("enforces the rule for onUserPromptSubmit-only critical hooks (both decision methods covered)", () => {
    // 之前的拒绝路径都走 onPreToolUse；这条钉住 onUserPromptSubmit 作为唯一 decision 方法的分支。
    const fake = createFakeModel([]);
    const bad: Hook = {
      name: "prompt-gate",
      critical: true,
      onUserPromptSubmit: () => ({ decision: "deny" }),
      // failClosed 故意不写
    };
    expect(
      () => new AgentSession({ model: fake, tools: [], hooks: [bad] }),
    ).toThrow(/must declare failClosed explicitly/);
    fake.teardown();
  });

  it("assertCriticalDecisionHooks throws directly (decoupled from session construction)", () => {
    expect(() =>
      assertCriticalDecisionHooks([
        { name: "bad", critical: true, onPreToolUse: () => ({ decision: "deny" }) },
      ]),
    ).toThrow(/must declare failClosed explicitly/);
    expect(() =>
      assertCriticalDecisionHooks([
        { name: "miscat", critical: true, failClosed: true, onTurnEnd: () => {} },
      ]),
    ).toThrow(/implements no decision method/);
  });

  it("treats explicit critical:false the same as non-critical (no failClosed requirement)", () => {
    const fake = createFakeModel([]);
    const hook: Hook = {
      name: "explicit-non-critical",
      critical: false,
      onPreToolUse: () => ({ decision: "allow" }),
      // critical:false → 不强制 failClosed
    };
    expect(
      () => new AgentSession({ model: fake, tools: [], hooks: [hook] }),
    ).not.toThrow();
    fake.teardown();
  });
});
