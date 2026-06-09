/**
 * skills —— 渐进式技能加载测试（issue #68 / O2）。
 *
 * 经 testing.ts fake-model 的 getCalls()——它捕获每次 Context.systemPrompt / Context.tools，
 * 据此断言 catalog 进 system prompt（仅 name+description）、invoke 注入 body、非法 name throw、
 * 工具激活复用 O1 激活集、opt-in 与 0.2.x 字节级一致、构造期 fail-loud。
 */

import { describe, it, expect } from "vitest";
import {
  AgentSession,
  Type,
  type HarnessTool,
} from "@harness-pi/core";
import { createFakeModel } from "@harness-pi/core/testing";
import { skills } from "../skills.js";
import { deferredTools } from "../deferred-tools.js";

function trivialTool(name: string): HarnessTool {
  return {
    name,
    description: `${name} tool`,
    parameters: Type.Object({}),
    isConcurrencySafe: () => true,
    async execute() {
      return { content: [{ type: "text", text: `${name} ran` }] };
    },
  };
}

function namesOf(
  tools: ReadonlyArray<{ name: string }> | undefined,
): string[] {
  return (tools ?? []).map((t) => t.name);
}

const SPECS = [
  {
    name: "review-pr",
    description: "Use when asked to review a pull request.",
    body: "REVIEW BODY: read the diff, check correctness, summarize findings.",
  },
  {
    name: "deep-research",
    description: "Use for multi-source fact-checked research.",
    body: "RESEARCH BODY: fan out searches, verify claims, cite sources.",
  },
];

describe("skills: catalog in system prompt (a)", () => {
  it("appends each skill's name + description, never the body", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ]);
    const { hook, tool } = skills(SPECS);
    const session = new AgentSession({
      model: fake,
      systemPrompt: "You are an agent.",
      tools: [tool],
      hooks: [hook],
    });
    await session.run("go");

    const sys = fake.getCalls()[0]!.systemPrompt;
    expect(sys).toContain("## Available skills");
    for (const s of SPECS) {
      // 精确钉住 name↔description 配对(独立 toContain 会漏「名字配错描述」)。
      expect(sys).toContain(`- ${s.name}: ${s.description}`);
      // body 绝不进 catalog。
      expect(sys).not.toContain(s.body);
    }
    // 原有 system prompt 保留。
    expect(sys).toContain("You are an agent.");
    fake.teardown();
  });
});

describe("skills: invoke injects body (b)", () => {
  it("skill({name}) returns the spec body as toolResult content", async () => {
    const { hook, tool } = skills(SPECS);
    const fake = createFakeModel([
      {
        content: [
          { type: "toolCall", name: "skill", arguments: { name: "review-pr" } },
        ],
      },
      { content: [{ type: "text", text: "done" }], stopReason: "stop" },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [tool],
      hooks: [hook],
    });
    await session.run("go");

    const tr = session.messages.find((m) => m.role === "toolResult") as
      | { content: { text?: string }[]; isError?: boolean }
      | undefined;
    expect(tr).toBeDefined();
    expect(tr!.isError).not.toBe(true);
    const text = tr!.content.map((b) => b.text ?? "").join("");
    expect(text).toContain("REVIEW BODY");
    fake.teardown();
  });
});

describe("skills: unknown name (c)", () => {
  it("throws -> kernel wraps as isError toolResult mentioning 'unknown skill'", async () => {
    const { hook, tool } = skills(SPECS);
    const fake = createFakeModel([
      {
        content: [
          { type: "toolCall", name: "skill", arguments: { name: "nope" } },
        ],
      },
      { content: [{ type: "text", text: "done" }], stopReason: "stop" },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [tool],
      hooks: [hook],
    });
    await session.run("go");

    const tr = session.messages.find((m) => m.role === "toolResult") as
      | { content: { text?: string }[]; isError?: boolean }
      | undefined;
    expect(tr).toBeDefined();
    expect(tr!.isError).toBe(true);
    const text = tr!.content.map((b) => b.text ?? "").join("");
    expect(text).toContain("unknown skill");
    fake.teardown();
  });
});

describe("skills: tool activation reuses O1 activation set (d)", () => {
  it("invoking a skill with tools activates them in the deferred listing next turn", async () => {
    const { hook, tool } = skills([
      {
        name: "fetcher",
        description: "Use to fetch web pages.",
        body: "FETCH BODY",
        tools: ["WebFetch"],
      },
    ]);
    const fake = createFakeModel([
      // turn-1：调 skill 激活 WebFetch（不收尾，继续循环）。
      {
        content: [
          { type: "toolCall", name: "skill", arguments: { name: "fetcher" } },
        ],
      },
      // turn-2：收尾。
      { content: [{ type: "text", text: "done" }], stopReason: "stop" },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [trivialTool("WebFetch"), tool],
      hooks: [
        deferredTools({ deferred: ["WebFetch"], alwaysListed: [tool.name] }),
        hook,
      ],
    });
    await session.run("go");

    const turn1 = namesOf(fake.getCalls()[0]!.tools);
    const turn2 = namesOf(fake.getCalls()[1]!.tools);
    // turn-1：WebFetch 仍 deferred、不可见。
    expect(turn1).not.toContain("WebFetch");
    // turn-2：skill 激活后下一 turn 出现在 listing（证明复用 O1 激活集）。
    expect(turn2).toContain("WebFetch");

    // toolResult 文案标注激活的工具。
    const tr = session.messages.find((m) => m.role === "toolResult") as
      | { content: { text?: string }[] }
      | undefined;
    const text = tr!.content.map((b) => b.text ?? "").join("");
    expect(text).toContain("FETCH BODY");
    expect(text).toContain("activated tools: WebFetch");
    fake.teardown();
  });
});

describe("skills: activation is a union, not overwrite (d2)", () => {
  it("invoking a skill keeps previously-activated deferred tools visible", async () => {
    const { hook, tool } = skills([
      { name: "fetcher", description: "fetch web", body: "FETCH", tools: ["WebFetch"] },
    ]);
    const fake = createFakeModel([
      {
        content: [
          { type: "toolCall", name: "skill", arguments: { name: "fetcher" } },
        ],
      },
      { content: [{ type: "text", text: "done" }], stopReason: "stop" },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [trivialTool("WebFetch"), trivialTool("Grep"), tool],
      hooks: [
        // Grep 是 deferred 且**预激活**(alwaysListed)→ 一开始就可见;skill 再激活 WebFetch。
        // 若 skill 用 overwrite(new Set(spec.tools))而非 union,会丢掉预激活的 Grep。
        deferredTools({
          deferred: ["WebFetch", "Grep"],
          alwaysListed: ["Grep", tool.name],
        }),
        hook,
      ],
    });
    await session.run("go");

    const turn2 = namesOf(fake.getCalls()[1]!.tools);
    // union:WebFetch 新激活 + Grep 预激活仍在(overwrite 会丢 Grep)。
    expect(turn2).toEqual(expect.arrayContaining(["WebFetch", "Grep"]));
    fake.teardown();
  });
});

describe("skills: skill tool is a barrier", () => {
  it("declares isConcurrencySafe === false (writes shared ctx.state activation set)", () => {
    const { tool } = skills(SPECS);
    expect(tool.isConcurrencySafe!({})).toBe(false);
  });
});

describe("skills: custom toolName", () => {
  it("honors opts.toolName in both tool.name and the catalog invoke hint", async () => {
    const { hook, tool } = skills(SPECS, { toolName: "loadSkill" });
    expect(tool.name).toBe("loadSkill");
    const fake = createFakeModel([
      { content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ]);
    const session = new AgentSession({ model: fake, tools: [tool], hooks: [hook] });
    await session.run("go");
    expect(fake.getCalls()[0]!.systemPrompt).toContain("`loadSkill`");
    fake.teardown();
  });
});

describe("skills: opt-in byte-equal (e)", () => {
  it("without the skills hook, system prompt has no 'Available skills'", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ]);
    const session = new AgentSession({
      model: fake,
      systemPrompt: "You are an agent.",
      tools: [],
      hooks: [],
    });
    await session.run("go");

    expect(fake.getCalls()[0]!.systemPrompt).toBe("You are an agent.");
    expect(fake.getCalls()[0]!.systemPrompt).not.toContain("Available skills");
    fake.teardown();
  });
});

describe("skills: construction-time fail-loud (f)", () => {
  it("empty specs throws", () => {
    expect(() => skills([])).toThrow();
  });

  it("duplicate skill name throws", () => {
    expect(() =>
      skills([
        { name: "dup", description: "a", body: "A" },
        { name: "dup", description: "b", body: "B" },
      ]),
    ).toThrow(/duplicate skill name/);
  });
});
