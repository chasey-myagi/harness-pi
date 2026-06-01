/**
 * permissionGate 规则引擎插件测试（docs/09 §4.3）。验证 pattern→allow/ask/deny、首条命中、
 * fallback deny 默认、ask 解析、domain 谓词、以及与 §3.7 fail-closed 的衔接（critical+failClosed:true，
 * 规则抛错 → deny）。
 */

import { describe, it, expect } from "vitest";
import { AgentSession, Type, type HarnessTool, type Hook } from "@harness-pi/core";
import { createFakeModel } from "@harness-pi/core/testing";
import { permissionGate } from "../permission-gate.js";

/** 跑一次「LLM 调一个工具 → 收尾」的回合，返回工具是否执行 + 那条 toolResult。 */
async function runToolCall(
  gate: Hook,
  toolName = "fs_write",
): Promise<{ ran: boolean; toolResultText: string; isError: boolean }> {
  let ran = false;
  const tool: HarnessTool = {
    name: toolName,
    description: "t",
    parameters: Type.Object({}),
    async execute() {
      ran = true;
      return { content: [{ type: "text", text: "did it" }] };
    },
  };
  const fake = createFakeModel([
    { content: [{ type: "toolCall", name: toolName, arguments: {} }] },
    { content: [{ type: "text", text: "done" }], stopReason: "stop" },
  ]);
  const session = new AgentSession({ model: fake, tools: [tool], hooks: [gate] });
  await session.run("go");
  const tr = session.messages.find((m) => m.role === "toolResult") as
    | { content: unknown; isError?: boolean }
    | undefined;
  fake.teardown();
  const content = tr?.content;
  const text = Array.isArray(content)
    ? content.map((b) => ("text" in b ? (b as { text: string }).text : "")).join("")
    : String(content ?? "");
  return { ran, toolResultText: text, isError: tr?.isError === true };
}

describe("permissionGate", () => {
  it("denies a matching deny rule (tool not executed, isError toolResult carries reason)", async () => {
    const r = await runToolCall(
      permissionGate({
        rules: [{ match: "fs_write", decision: "deny", reason: "writes are off" }],
      }),
    );
    expect(r.ran).toBe(false);
    expect(r.isError).toBe(true);
    expect(r.toolResultText).toContain("writes are off");
  });

  it("allows a matching allow rule (tool executes)", async () => {
    const r = await runToolCall(
      permissionGate({ rules: [{ match: "fs_write", decision: "allow" }] }),
    );
    expect(r.ran).toBe(true);
    expect(r.toolResultText).toBe("did it");
  });

  it("falls back to deny when no rule matches (fail-closed default)", async () => {
    const r = await runToolCall(
      permissionGate({ rules: [{ match: "other_tool", decision: "allow" }] }),
    );
    expect(r.ran).toBe(false);
    expect(r.isError).toBe(true);
  });

  it("honors a configurable allow fallback", async () => {
    const r = await runToolCall(
      permissionGate({ rules: [], fallback: "allow" }),
    );
    expect(r.ran).toBe(true);
  });

  it("ask + onAsk approving → allow", async () => {
    const r = await runToolCall(
      permissionGate({
        rules: [{ match: "fs_write", decision: "ask" }],
        onAsk: () => true,
      }),
    );
    expect(r.ran).toBe(true);
  });

  it("ask + onAsk denying → deny", async () => {
    const r = await runToolCall(
      permissionGate({
        rules: [{ match: "fs_write", decision: "ask" }],
        onAsk: async () => false,
      }),
    );
    expect(r.ran).toBe(false);
    expect(r.isError).toBe(true);
  });

  it("ask without an onAsk resolver → deny (fail-closed)", async () => {
    const r = await runToolCall(
      permissionGate({ rules: [{ match: "fs_write", decision: "ask" }] }),
    );
    expect(r.ran).toBe(false);
    expect(r.toolResultText).toContain("requires approval");
  });

  it("supports a domain predicate matcher (match receives the call + ctx)", async () => {
    // 业务谓词：args.danger===true 才拒——permissionGate 不认识 "danger"，由调用方提供判定。
    const gate = permissionGate({
      rules: [
        {
          name: "block-dangerous",
          match: (call) => (call.arguments as { danger?: boolean }).danger === true,
          decision: "deny",
          reason: "dangerous call",
        },
      ],
      fallback: "allow",
    });
    // 这个工具的 args 没有 danger → 不命中谓词 → fallback allow。
    const r = await runToolCall(gate);
    expect(r.ran).toBe(true);
  });

  it("supports a RegExp matcher on tool name", async () => {
    const deny = await runToolCall(
      permissionGate({ rules: [{ match: /^fs_/, decision: "deny" }] }),
      "fs_write",
    );
    expect(deny.ran).toBe(false);
    const allow = await runToolCall(
      permissionGate({ rules: [{ match: /^fs_/, decision: "deny" }], fallback: "allow" }),
      "net_get",
    );
    expect(allow.ran).toBe(true);
  });

  it("first matching rule wins", async () => {
    const r = await runToolCall(
      permissionGate({
        rules: [
          { match: "fs_write", decision: "allow" }, // 先命中 → 胜出
          { match: /^fs_/, decision: "deny" }, // 也能命中，但排在后面
        ],
      }),
    );
    expect(r.ran).toBe(true);
  });

  it("is a valid critical hook: constructs without tripping the §3.7 registration check", () => {
    const fake = createFakeModel([]);
    expect(
      () =>
        new AgentSession({
          model: fake,
          tools: [],
          hooks: [permissionGate({ rules: [] })],
        }),
    ).not.toThrow();
    fake.teardown();
  });

  it("a domain predicate that matches → deny with its reason (the HIT branch)", async () => {
    // 工具 args 带 danger:true → 谓词命中 → deny + 自定义 reason 透传。
    let session_ran = false;
    const tool: HarnessTool = {
      name: "fs_write",
      description: "t",
      parameters: Type.Object({ danger: Type.Optional(Type.Boolean()) }),
      async execute() {
        session_ran = true;
        return { content: [{ type: "text", text: "did it" }] };
      },
    };
    const fake = createFakeModel([
      { content: [{ type: "toolCall", name: "fs_write", arguments: { danger: true } }] },
      { content: [{ type: "text", text: "done" }], stopReason: "stop" },
    ]);
    const gate = permissionGate({
      rules: [
        {
          name: "block-dangerous",
          match: (call) => (call.arguments as { danger?: boolean }).danger === true,
          decision: "deny",
          reason: "dangerous call blocked",
        },
      ],
      fallback: "allow",
    });
    const session = new AgentSession({ model: fake, tools: [tool], hooks: [gate] });
    await session.run("go");
    const tr = session.messages.find((m) => m.role === "toolResult") as
      | { content: unknown; isError?: boolean }
      | undefined;
    const text = Array.isArray(tr?.content)
      ? tr!.content.map((b) => ("text" in b ? (b as { text: string }).text : "")).join("")
      : "";
    expect(session_ran).toBe(false);
    expect(text).toContain("dangerous call blocked");
    fake.teardown();
  });

  it("empty rules with the default fallback denies (the core fail-closed invariant)", async () => {
    const r = await runToolCall(permissionGate({ rules: [] }));
    expect(r.ran).toBe(false);
    expect(r.isError).toBe(true);
    expect(r.toolResultText).toContain("permissionGate denied");
  });

  it("fail-closed when the onAsk resolver itself throws (distinct path from a match predicate throwing)", async () => {
    const r = await runToolCall(
      permissionGate({
        rules: [{ match: "fs_write", decision: "ask" }],
        onAsk: async () => {
          throw new Error("approval service down");
        },
      }),
    );
    expect(r.ran).toBe(false);
    expect(r.isError).toBe(true);
  });

  it("fail-closed when a rule predicate throws (a broken policy hook denies, not allows)", async () => {
    const r = await runToolCall(
      permissionGate({
        rules: [
          {
            match: () => {
              throw new Error("predicate blew up");
            },
            decision: "allow",
          },
        ],
        fallback: "allow",
      }),
    );
    // 谓词抛错 → onPreToolUse reject → 内核按 failClosed:true 当 deny。绝不能因为"hook 挂了"就放行。
    expect(r.ran).toBe(false);
    expect(r.isError).toBe(true);
  });
});
