import { describe, it, expect } from "vitest";
import { Type, type Context, type Message } from "@mariozechner/pi-ai";
import { AgentSession } from "../session.js";
import { MemorySessionStore } from "../session-store.js";
import { createFakeModel } from "../testing.js";
import { createUserMessage } from "../types.js";
import type { Hook, SteerInput } from "../hook.js";
import type { HarnessTool } from "../types.js";

/** 取一条 message 的纯文本（content 可能是 string 或 block 数组）。 */
function textOf(m: Message): string {
  return typeof m.content === "string"
    ? m.content
    : m.content
        .map((b) => ("text" in b && typeof b.text === "string" ? b.text : ""))
        .join("");
}

/** 某次 LLM 调用的 context 是否包含含给定子串的消息。 */
function callHas(ctx: Context, needle: string): boolean {
  return ctx.messages.some((m) => textOf(m).includes(needle));
}

describe("steering (park/drain)", () => {
  it("a message steered before run is drained into the conversation at turn start", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ]);
    const session = new AgentSession({ model: fake, tools: [] });
    session.steer(createUserMessage("steered note"));
    await session.run("hi");

    expect(callHas(fake.getCalls()[0]!, "steered note")).toBe(true);
    fake.teardown();
  });

  it("fires onSteer for the drained message with the right turnIdx", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ]);
    const seen: SteerInput[] = [];
    const hook: Hook = { name: "w", onSteer: (i) => void seen.push(i) };
    const session = new AgentSession({ model: fake, tools: [], hooks: [hook] });
    session.steer(createUserMessage("hello"));
    await session.run("hi");

    expect(seen).toHaveLength(1);
    expect(seen[0]!.turnIdx).toBe(0);
    expect(seen[0]!.message.role).toBe("user");
    expect(textOf(seen[0]!.message)).toBe("hello");
    fake.teardown();
  });

  it("does not fire onSteer when nothing is parked", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ]);
    const seen: SteerInput[] = [];
    const hook: Hook = { name: "w", onSteer: (i) => void seen.push(i) };
    const session = new AgentSession({ model: fake, tools: [], hooks: [hook] });
    await session.run("hi");

    expect(seen).toHaveLength(0);
    fake.teardown();
  });

  it("parks (does not suspend): a steer during a turn is drained at the NEXT turn, not mid-turn", async () => {
    let session!: AgentSession;
    const ping: HarnessTool = {
      name: "ping",
      description: "ping",
      parameters: Type.Object({}),
      async execute() {
        // 在进行中的 turn 0（tool 阶段）插队。
        session.steer(createUserMessage("mid-turn steer"));
        return { content: [{ type: "text", text: "pong" }] };
      },
    };
    const fake = createFakeModel([
      { content: [{ type: "toolCall", name: "ping", arguments: {} }] }, // turn 0 → 续跑
      { content: [{ type: "text", text: "done" }], stopReason: "stop" }, // turn 1
    ]);
    const seen: SteerInput[] = [];
    session = new AgentSession({
      model: fake,
      tools: [ping],
      hooks: [{ name: "w", onSteer: (i) => void seen.push(i) }],
    });
    await session.run("go");

    const calls = fake.getCalls();
    // turn 0 的 LLM 调用在 steer 之前发生：插队消息不在其中（没打断进行中的 turn）。
    expect(callHas(calls[0]!, "mid-turn steer")).toBe(false);
    // turn 1 开始的安全点 drain：插队消息进了 turn 1 的 context。
    expect(callHas(calls[1]!, "mid-turn steer")).toBe(true);
    // 在 turn 1 drain，故 onSteer 的 turnIdx 是 1（不是 0）。
    expect(seen).toHaveLength(1);
    expect(seen[0]!.turnIdx).toBe(1);
    fake.teardown();
  });

  it("drains multiple parked messages in enqueue order, one onSteer each", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ]);
    const seen: SteerInput[] = [];
    const hook: Hook = { name: "w", onSteer: (i) => void seen.push(i) };
    const session = new AgentSession({ model: fake, tools: [], hooks: [hook] });
    session.steer(createUserMessage("first"));
    session.steer(createUserMessage("second"));
    await session.run("hi");

    expect(seen.map((s) => textOf(s.message))).toEqual(["first", "second"]);
    fake.teardown();
  });

  it("a steer enqueued during drain is handled on the NEXT turn (atomic swap: no loss, no reentrancy)", async () => {
    let session!: AgentSession;
    const relay: Hook = {
      name: "relay",
      onSteer: (i) => {
        // drain "A" 时再插一条 "B"。原子 swap 保证 "B" 落进新队列、turn 1 才 drain。
        if (textOf(i.message) === "A") session.steer(createUserMessage("B"));
      },
    };
    const ping: HarnessTool = {
      name: "ping",
      description: "ping",
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text", text: "pong" }] };
      },
    };
    const fake = createFakeModel([
      { content: [{ type: "toolCall", name: "ping", arguments: {} }] }, // turn 0
      { content: [{ type: "text", text: "done" }], stopReason: "stop" }, // turn 1
    ]);
    session = new AgentSession({ model: fake, tools: [ping], hooks: [relay] });
    session.steer(createUserMessage("A"));
    await session.run("go");

    const calls = fake.getCalls();
    // turn 0：只有 A（B 在 drain A 期间入队，未在本轮 drain 循环里被消费）。
    expect(callHas(calls[0]!, "A")).toBe(true);
    expect(callHas(calls[0]!, "B")).toBe(false);
    // turn 1：B 在下一个安全点被 drain。
    expect(callHas(calls[1]!, "B")).toBe(true);
    fake.teardown();
  });

  it("rejects non-user messages (assistant/toolResult would break conversation invariants)", () => {
    const fake = createFakeModel([]);
    const session = new AgentSession({ model: fake, tools: [] });
    expect(() =>
      session.steer({ role: "assistant", content: [] } as unknown as Message),
    ).toThrow(/only user-role/);
    expect(() =>
      session.steer({ role: "toolResult" } as unknown as Message),
    ).toThrow(/only user-role/);
    // pi-ai 无独立 system role：伪造的 "system" 消息同样被拒（system 类 steering 须用 user 表达）。
    expect(() =>
      session.steer({ role: "system", content: "x" } as unknown as Message),
    ).toThrow(/only user-role/);
    fake.teardown();
  });

  it("steered messages persist to the SessionStore (not transient like attachments)", async () => {
    const store = new MemorySessionStore();
    const fake = createFakeModel([
      { content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      store,
      sessionId: "steer-persist",
    });
    session.steer(createUserMessage("durable steer"));
    await session.run("hi");

    const path = await store.getPathToLeaf("steer-persist");
    const persisted = path
      .filter((e) => e.entry.kind === "message")
      .map((e) =>
        e.entry.kind === "message" ? textOf(e.entry.message) : "",
      );
    expect(persisted).toContain("durable steer");
    fake.teardown();
  });

  it("drains parked messages at the first turn of continue() too", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "first" }], stopReason: "stop" },
    ]);
    const session = new AgentSession({ model: fake, tools: [] });
    await session.run("hi");

    fake.push({ content: [{ type: "text", text: "second" }], stopReason: "stop" });
    session.steer(createUserMessage("between turns"));
    await session.continue();

    const lastCall = fake.getCalls().at(-1)!;
    expect(callHas(lastCall, "between turns")).toBe(true);
    fake.teardown();
  });

  it("flushes onSteer's systemMessage to consoleSink and injects its additionalContext into the LLM context", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ]);
    const sysSink: string[] = [];
    const hook: Hook = {
      name: "augment",
      onSteer: () => ({ systemMessage: "sys note", additionalContext: "extra ctx" }),
    };
    const session = new AgentSession({
      model: fake,
      tools: [],
      hooks: [hook],
      consoleSink: (m) => void sysSink.push(m),
    });
    session.steer(createUserMessage("steered"));
    await session.run("hi");

    const ctx = fake.getCalls()[0]!;
    expect(callHas(ctx, "steered")).toBe(true); // 被注入的消息
    expect(callHas(ctx, "extra ctx")).toBe(true); // additionalContext → LLM context
    expect(sysSink).toContain("sys note"); // systemMessage → console sink
    expect(callHas(ctx, "sys note")).toBe(false); // systemMessage 不进 LLM context
    fake.teardown();
  });

  it("isolates a throwing onSteer hook (fail-open): drain continues, all messages land, run completes", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ]);
    const seen: string[] = [];
    const boom: Hook = {
      name: "boom",
      onSteer: () => {
        throw new Error("boom");
      },
    };
    const watch: Hook = {
      name: "watch",
      onSteer: (i) => void seen.push(textOf(i.message)),
    };
    const session = new AgentSession({ model: fake, tools: [], hooks: [boom, watch] });
    session.steer(createUserMessage("m1"));
    session.steer(createUserMessage("m2"));
    const summary = await session.run("hi");

    expect(summary.reason).toBe("done"); // 一个 onSteer 抛错不杀 run
    expect(seen).toEqual(["m1", "m2"]); // 抛错被隔离，后续消息照常处理
    const injected = session.messages.filter((m) =>
      ["m1", "m2"].includes(textOf(m)),
    );
    expect(injected).toHaveLength(2); // 两条都进了对话
    fake.teardown();
  });

  it("the steered message is already in session.messages when onSteer fires (push-before-fire contract)", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ]);
    let sawInMessages = false;
    const hook: Hook = {
      name: "w",
      onSteer: (_i, ctx) => {
        sawInMessages = ctx.messages.some((m) => textOf(m) === "probe");
      },
    };
    const session = new AgentSession({ model: fake, tools: [], hooks: [hook] });
    session.steer(createUserMessage("probe"));
    await session.run("hi");

    expect(sawInMessages).toBe(true);
    fake.teardown();
  });

  it("drains at every turn: each parked message lands in exactly the next turn's context", async () => {
    let session!: AgentSession;
    let n = 0;
    const ping: HarnessTool = {
      name: "ping",
      description: "ping",
      parameters: Type.Object({}),
      async execute() {
        n++;
        session.steer(createUserMessage(`s${n}`));
        return { content: [{ type: "text", text: "pong" }] };
      },
    };
    const fake = createFakeModel([
      { content: [{ type: "toolCall", name: "ping", arguments: {} }] }, // turn0 → steer s1
      { content: [{ type: "toolCall", name: "ping", arguments: {} }] }, // turn1 (sees s1) → steer s2
      { content: [{ type: "text", text: "done" }], stopReason: "stop" }, // turn2 (sees s1,s2)
    ]);
    session = new AgentSession({ model: fake, tools: [ping] });
    await session.run("go");

    const calls = fake.getCalls();
    expect(callHas(calls[0]!, "s1")).toBe(false); // turn0：steer 尚未发生
    expect(callHas(calls[1]!, "s1")).toBe(true); // s1 在 turn1 drain
    expect(callHas(calls[1]!, "s2")).toBe(false); // s2 在 turn1 期间入队，未在本轮注入
    expect(callHas(calls[2]!, "s1")).toBe(true); // s1 持久存在
    expect(callHas(calls[2]!, "s2")).toBe(true); // s2 在 turn2 drain
    fake.teardown();
  });

  it("parks and drains user messages with empty or non-text content (short-circuit is by queue length, not content)", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ]);
    const seen: SteerInput[] = [];
    const hook: Hook = { name: "w", onSteer: (i) => void seen.push(i) };
    const session = new AgentSession({ model: fake, tools: [], hooks: [hook] });
    session.steer(createUserMessage("")); // 空内容
    session.steer(
      createUserMessage([{ type: "image", data: "deadbeef", mimeType: "image/png" }]),
    );
    await session.run("hi");

    expect(seen).toHaveLength(2); // 空内容仍 park/drain（按队列长度判，不按内容）
    expect(seen[1]!.message.content).toEqual([
      { type: "image", data: "deadbeef", mimeType: "image/png" },
    ]); // 非文本 content 原样保留，未被内核 mutate
    fake.teardown();
  });

  it("an idle session does not drain: parked messages wait for a loop safe point", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ]);
    const seen: SteerInput[] = [];
    const hook: Hook = { name: "w", onSteer: (i) => void seen.push(i) };
    const session = new AgentSession({ model: fake, tools: [], hooks: [hook] });
    session.steer(createUserMessage("idle"));
    // 不调 run/continue。

    expect(seen).toHaveLength(0);
    expect(session.messages.some((m) => textOf(m) === "idle")).toBe(false);
    fake.teardown();
  });

  it("aborted before the first turn: parked message is neither drained nor lost (drained on the next continue)", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ]);
    const seen: SteerInput[] = [];
    const hook: Hook = { name: "w", onSteer: (i) => void seen.push(i) };
    const session = new AgentSession({ model: fake, tools: [], hooks: [hook] });
    const ac = new AbortController();
    ac.abort();
    session.steer(createUserMessage("parked"));
    const summary = await session.run("hi", { signal: ac.signal });

    expect(summary.reason).toBe("aborted");
    expect(seen).toHaveLength(0); // 首 turn 前已 abort → 未到 drain 安全点
    expect(session.messages.some((m) => textOf(m) === "parked")).toBe(false);

    // 消息没丢：下一次（未 abort 的）continue 在首 turn drain 它。
    fake.push({ content: [{ type: "text", text: "resumed" }], stopReason: "stop" });
    await session.continue();
    expect(seen.map((s) => textOf(s.message))).toContain("parked");
    fake.teardown();
  });

  it("drained messages append after the existing prefix (stable cache prefix, no reordering)", async () => {
    const fake = createFakeModel([
      { content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ]);
    const session = new AgentSession({ model: fake, tools: [] });
    session.steer(createUserMessage("note"));
    await session.run("hi");

    const msgs = fake.getCalls()[0]!.messages;
    const promptIdx = msgs.findIndex((m) => textOf(m) === "hi");
    const steeredIdx = msgs.findIndex((m) => textOf(m) === "note");
    expect(promptIdx).toBeGreaterThanOrEqual(0);
    // steered 排在 prompt **之后**：drain 在 turn 顶部、prompt 在 turn loop 之前 push，
    // 注入是「向已有前缀追加」而非「插到前面」——前缀稳定、cache 不漂移。
    expect(steeredIdx).toBeGreaterThan(promptIdx);
    fake.teardown();
  });
});
