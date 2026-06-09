/**
 * deferredTools + toolSearch 集成测试（issue #66 / O1）。
 *
 * 经 testing.ts fake-model 的 getCalls()——它捕获每次 Context.tools（即 LLM 看到的 listing），
 * 据此断言 listing 子集化、激活下一 turn 生效、opt-in 字节级一致、execution 解耦、估算联动、fail-open。
 */

import { describe, it, expect } from "vitest";
import {
  AgentSession,
  Type,
  type HarnessTool,
  type Hook,
} from "@harness-pi/core";
import { createFakeModel } from "@harness-pi/core/testing";
import { deferredTools } from "../deferred-tools.js";
import { toolSearch } from "../tool-search.js";
import { autoCompaction } from "../auto-compaction.js";
import { permissionGate } from "../permission-gate.js";

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

describe("deferredTools: listing subset (a)", () => {
  it("hides deferred tools, keeps non-deferred + alwaysListed", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ]);
    const search = toolSearch();
    const session = new AgentSession({
      model: fake,
      tools: [trivialTool("read"), trivialTool("WebFetch"), search],
      hooks: [
        deferredTools({
          deferred: ["WebFetch"],
          alwaysListed: ["read", search.name],
        }),
      ],
    });
    await session.run("go");

    const listing = namesOf(fake.getCalls()[0]!.tools);
    expect(listing).toContain("read");
    expect(listing).toContain("toolSearch");
    expect(listing).not.toContain("WebFetch");
    fake.teardown();
  });
});

describe("deferredTools: activation takes effect next turn (b)", () => {
  it("toolSearch({select}) in turn-1 makes the tool visible in turn-2", async () => {
    const search = toolSearch();
    const fake = createFakeModel([
      // turn-1：模型调 toolSearch 激活 WebFetch（不收尾，继续循环）。
      {
        content: [
          { type: "toolCall", name: "toolSearch", arguments: { select: ["WebFetch"] } },
        ],
      },
      // turn-2：收尾。
      { content: [{ type: "text", text: "done" }], stopReason: "stop" },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [trivialTool("read"), trivialTool("WebFetch"), search],
      hooks: [
        deferredTools({
          deferred: ["WebFetch"],
          alwaysListed: ["read", search.name],
        }),
      ],
    });
    await session.run("go");

    const turn1 = namesOf(fake.getCalls()[0]!.tools);
    const turn2 = namesOf(fake.getCalls()[1]!.tools);
    expect(turn1).not.toContain("WebFetch");
    expect(turn2).toContain("WebFetch");
    // 激活是**累加**进 listing，不是替换 —— 原本可见的工具仍在。
    expect(turn2).toEqual(expect.arrayContaining(["read", "toolSearch", "WebFetch"]));
    fake.teardown();
  });

  it("keyword fuzzy-match activates matching tools next turn", async () => {
    const search = toolSearch();
    const fake = createFakeModel([
      // keyword "fetch" 命中 WebFetch 的 name+description（"WebFetch tool"）。
      {
        content: [
          { type: "toolCall", name: "toolSearch", arguments: { keyword: "fetch" } },
        ],
      },
      { content: [{ type: "text", text: "done" }], stopReason: "stop" },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [trivialTool("read"), trivialTool("WebFetch"), search],
      hooks: [
        deferredTools({ deferred: ["WebFetch"], alwaysListed: ["read", search.name] }),
      ],
    });
    await session.run("go");

    expect(namesOf(fake.getCalls()[0]!.tools)).not.toContain("WebFetch");
    expect(namesOf(fake.getCalls()[1]!.tools)).toContain("WebFetch");
    fake.teardown();
  });

  it("no match (incl. phantom select name) activates nothing and says so", async () => {
    const search = toolSearch();
    const fake = createFakeModel([
      {
        content: [
          { type: "toolCall", name: "toolSearch", arguments: { select: ["nonexistent"] } },
        ],
      },
      { content: [{ type: "text", text: "done" }], stopReason: "stop" },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [trivialTool("read"), trivialTool("WebFetch"), search],
      hooks: [
        deferredTools({ deferred: ["WebFetch"], alwaysListed: ["read", search.name] }),
      ],
    });
    await session.run("go");

    const tr = session.messages.find((m) => m.role === "toolResult") as
      | { content: { text?: string }[] }
      | undefined;
    expect(tr!.content.map((b) => b.text ?? "").join("")).toContain("No tools matched");
    // 不存在的名字（模型瞎编）不激活任何工具：下一 turn WebFetch 仍隐藏。
    expect(namesOf(fake.getCalls()[1]!.tools)).not.toContain("WebFetch");
    fake.teardown();
  });
});

describe("deferredTools: predicate-form deferred (function)", () => {
  it("supports deferred as a (name) => boolean predicate", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ]);
    const search = toolSearch();
    const session = new AgentSession({
      model: fake,
      tools: [
        trivialTool("read"),
        trivialTool("WebFetch"),
        trivialTool("WebSearch"),
        search,
      ],
      hooks: [
        deferredTools({
          deferred: (n) => n.startsWith("Web"),
          alwaysListed: ["read", search.name],
        }),
      ],
    });
    await session.run("go");

    const listing = namesOf(fake.getCalls()[0]!.tools);
    expect(listing).toEqual(expect.arrayContaining(["read", "toolSearch"]));
    expect(listing).not.toContain("WebFetch");
    expect(listing).not.toContain("WebSearch");
    fake.teardown();
  });
});

describe("deferredTools: opt-in byte-equal (c)", () => {
  it("without deferredTools, every call sees the full tool set", async () => {
    const fake = createFakeModel([
      {
        content: [{ type: "toolCall", name: "read", arguments: {} }],
      },
      { content: [{ type: "text", text: "done" }], stopReason: "stop" },
    ]);
    const tools = [trivialTool("read"), trivialTool("WebFetch"), toolSearch()];
    const fullNames = namesOf(tools).sort();
    const session = new AgentSession({ model: fake, tools, hooks: [] });
    await session.run("go");

    for (const call of fake.getCalls()) {
      expect(namesOf(call.tools).sort()).toEqual(fullNames);
    }
    fake.teardown();
  });
});

describe("deferredTools: execution decoupled from listing (d)", () => {
  it("a deferred-but-not-activated tool still executes (findToolByName uses full set)", async () => {
    const fake = createFakeModel([
      // 模型直接调 WebFetch —— 它当前不在 listing 里，但仍在 session.tools 全集。
      { content: [{ type: "toolCall", name: "WebFetch", arguments: {} }] },
      { content: [{ type: "text", text: "done" }], stopReason: "stop" },
    ]);
    const search = toolSearch();
    const session = new AgentSession({
      model: fake,
      tools: [trivialTool("read"), trivialTool("WebFetch"), search],
      hooks: [
        deferredTools({ deferred: ["WebFetch"], alwaysListed: [search.name] }),
      ],
    });
    await session.run("go");

    // listing 子集化：WebFetch 不可见。
    expect(namesOf(fake.getCalls()[0]!.tools)).not.toContain("WebFetch");
    // 但执行照样发生：toolResult 拿到 WebFetch 的输出。
    const tr = session.messages.find((m) => m.role === "toolResult") as
      | { content: { text?: string }[]; isError?: boolean }
      | undefined;
    expect(tr).toBeDefined();
    expect(tr!.isError).not.toBe(true);
    expect(tr!.content[0]!.text).toBe("WebFetch ran");
    fake.teardown();
  });

  it("permission gate still blocks an activated/visible-or-not deferred tool (listing-independent闸)", async () => {
    const fake = createFakeModel([
      { content: [{ type: "toolCall", name: "WebFetch", arguments: {} }] },
      { content: [{ type: "text", text: "done" }], stopReason: "stop" },
    ]);
    const search = toolSearch();
    const session = new AgentSession({
      model: fake,
      tools: [trivialTool("WebFetch"), search],
      hooks: [
        deferredTools({ deferred: ["WebFetch"], alwaysListed: [search.name] }),
        permissionGate({
          rules: [{ match: "WebFetch", decision: "deny", reason: "WebFetch is off" }],
          fallback: "allow",
        }),
      ],
    });
    await session.run("go");

    const tr = session.messages.find((m) => m.role === "toolResult") as
      | { content: { text?: string }[]; isError?: boolean }
      | undefined;
    expect(tr).toBeDefined();
    expect(tr!.isError).toBe(true);
    const text = tr!.content.map((b) => b.text ?? "").join("");
    expect(text).toContain("WebFetch is off");
    fake.teardown();
  });
});

describe("toolSearch: barrier (e)", () => {
  it("declares isConcurrencySafe === false", () => {
    const search = toolSearch();
    expect(search.isConcurrencySafe!({})).toBe(false);
  });
});

describe("deferredTools + autoCompaction: estimation linkage (f)", () => {
  it("autoCompaction reads the activated subset, not the full set", async () => {
    // 全集 3 个工具，deferred 掉一个大工具（bigTool），激活集只剩 read + toolSearch。
    // 通过自定义 tokenCounter 把「随发 tools 的条目数」暴露出来断言。
    const seenToolCounts: number[] = [];
    const seenToolNames: string[][] = [];
    const bigTool = trivialTool("WebFetch");
    const search = toolSearch();
    // 跑 2 个 turn：turn-0 的 estimate 在本 turn 的 deferredTools 写 activeListing **之前**跑
    //（内核固定 messages-pipe 先于 tools-pipe），读到 undefined → 退回全集 3；turn-1 的 estimate
    // 读到 turn-0 写入的激活子集 → 2。这是一 turn 滞后，对「宁高勿低」的阈值无害。
    const fake = createFakeModel([
      { content: [{ type: "toolCall", name: "read", arguments: {} }] },
      { content: [{ type: "text", text: "done" }], stopReason: "stop" },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [trivialTool("read"), bigTool, search],
      hooks: [
        // deferredTools 排在 autoCompaction 之前（注册顺序）。
        deferredTools({
          deferred: ["WebFetch"],
          alwaysListed: ["read", search.name],
        }),
        autoCompaction({
          maxContextTokens: 1_000_000, // 阈值极高，不真压缩；只为触发 estimate 调用。
          triggerRatio: 0.9,
          keepRecent: 1,
          tokenCounter: {
            estimate: ({ tools }) => {
              seenToolCounts.push((tools ?? []).length);
              seenToolNames.push(namesOf(tools));
              return 0;
            },
          },
          summarize: () => "RECAP",
        }),
      ],
    });
    await session.run("go");

    // 全集是 3（read / WebFetch / toolSearch）；激活子集排除 WebFetch → 2。
    expect(seenToolCounts.length).toBeGreaterThanOrEqual(2);
    // turn-0：activeListing 尚未写入 → 退回全集 3。
    expect(seenToolCounts[0]).toBe(3);
    // turn-1：读到上一 turn 写入的激活子集 → 2（证明 estimate 确实改读 activeListing 而非永远全集）。
    expect(seenToolCounts[1]).toBe(2);
    // 且被丢的恰是 deferred 的 WebFetch（不只是数量对，drop 对了工具）。
    expect(seenToolNames[1]).toEqual(expect.arrayContaining(["read", "toolSearch"]));
    expect(seenToolNames[1]).not.toContain("WebFetch");
    fake.teardown();
  });
});

describe("deferredTools: fail-open (g)", () => {
  it("transformToolsBeforeLlm throwing degrades that turn to the full listing", async () => {
    const throwing: Hook = {
      name: "deferred-thrower",
      transformToolsBeforeLlm: () => {
        throw new Error("boom");
      },
    };
    const fake = createFakeModel([
      { content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ]);
    const tools = [trivialTool("read"), trivialTool("WebFetch"), toolSearch()];
    const fullNames = namesOf(tools).sort();
    const session = new AgentSession({ model: fake, tools, hooks: [throwing] });
    const summary = await session.run("go");

    // 抛错被内核 fail-open 吞掉 → 该 turn 退化全集 listing，session 不崩。
    expect(summary.reason).toBe("done");
    expect(namesOf(fake.getCalls()[0]!.tools).sort()).toEqual(fullNames);
    fake.teardown();
  });
});
