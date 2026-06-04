/**
 * Integration tests —— 跑真实 AgentSession + 多种 hook 组合，验证 docs 里描述的行为。
 */

import { describe, it, expect, vi } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import { AgentSession } from "../session.js";
import type { HarnessTool, Hook, HookContext } from "../index.js";
import { createFakeModel } from "../testing.js";

/** Read the first text block of a toolResult message. */
function resultText(m: { content: unknown }): string {
  const c = m.content;
  if (Array.isArray(c) && c[0] && typeof c[0] === "object" && "text" in c[0]) {
    return String((c[0] as { text: unknown }).text);
  }
  return "";
}

/**
 * Deterministic concurrency latch: `n` callers rendezvous and are ALL released only once `n`
 * have arrived. If fewer than `n` ever run concurrently, the arrivals block forever → the test
 * times out. So concurrency is proven without any dependence on wall-clock timing: a truly
 * concurrent run releases immediately; a serialized run deadlocks. `n=1` releases at once.
 */
function rendezvous(n: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  return async () => {
    if (++arrived >= n) release();
    await gate;
  };
}

/** A tool that records `start-<name>`/`end-<name>` into `ev`; an optional `arrive` gates the
 *  body on a {@link rendezvous} so concurrency can be asserted deterministically. */
function probeTool(
  ev: string[],
  name: string,
  safe: boolean,
  arrive?: () => Promise<void>,
): HarnessTool {
  return {
    name,
    description: name,
    parameters: Type.Object({}),
    isConcurrencySafe: () => safe,
    async execute() {
      ev.push(`start-${name}`);
      if (arrive) await arrive();
      ev.push(`end-${name}`);
      return { content: [{ type: "text", text: name }] };
    },
  };
}

const echoTool: HarnessTool = {
  name: "echo",
  description: "echo back",
  parameters: Type.Object({ msg: Type.String() }),
  async execute(args) {
    return { content: [{ type: "text", text: `echoed: ${args["msg"]}` }] };
  },
};

describe("Integration: Context injection", () => {
  it("additionalContext from onTurnStart wraps as attachment, visible in next LLM call", async () => {
    const model = createFakeModel([
      { content: [{ type: "text", text: "done" }] },
    ]);
    const seenMessages: unknown[] = [];
    const spyHook: Hook = {
      name: "spy",
      onTurnStart() {
        return { additionalContext: "<r>turn-start hint</r>" };
      },
      transformMessagesBeforeLlm(msgs) {
        seenMessages.push(...msgs.map((m) => (m as any).content));
        return undefined;
      },
    };
    const session = new AgentSession({
      model,
      tools: [],
      hooks: [spyHook],
    });
    await session.run("hi");
    // attachment 应该出现在 transformMessagesBeforeLlm 看到的消息里
    expect(seenMessages.some((c) => typeof c === "string" && c.includes("turn-start hint"))).toBe(true);
    // 但不入 session.messages
    expect(
      session.messages.some(
        (m) =>
          (m.role === "user" &&
            typeof m.content === "string" &&
            m.content.includes("turn-start hint")) ||
          false,
      ),
    ).toBe(false);
  });

  it("initialUserMessage from SessionStart pushes to session.messages", async () => {
    const model = createFakeModel([
      { content: [{ type: "text", text: "ok" }] },
    ]);
    const hook: Hook = {
      name: "ssinit",
      onSessionStart: () => ({ initialUserMessage: "I am injected" }),
    };
    const session = new AgentSession({ model, tools: [], hooks: [hook] });
    await session.run("user prompt");
    const userMsgs = session.messages.filter((m) => m.role === "user");
    // 注入的 + 用户的，2 条
    expect(userMsgs).toHaveLength(2);
    expect(userMsgs[0]?.content).toBe("I am injected");
    expect(userMsgs[1]?.content).toBe("user prompt");
  });

  it("updatedInput from PreToolUse modifies args sent to execute", async () => {
    const executedArgs: Array<Record<string, unknown>> = [];
    const tool: HarnessTool = {
      name: "echo",
      description: "echo",
      parameters: Type.Object({ msg: Type.String() }),
      async execute(args) {
        executedArgs.push(args);
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
    const model = createFakeModel([
      {
        content: [
          {
            type: "toolCall",
            name: "echo",
            arguments: { msg: "original" },
          },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const hook: Hook = {
      name: "mod",
      onPreToolUse: () => ({ updatedInput: { msg: "MODIFIED" } }),
    };
    const session = new AgentSession({
      model,
      tools: [tool],
      hooks: [hook],
    });
    await session.run("go");
    expect(executedArgs[0]?.["msg"]).toBe("MODIFIED");
  });

  it("updatedToolOutput from PostToolUse replaces result before push", async () => {
    const model = createFakeModel([
      {
        content: [
          { type: "toolCall", name: "echo", arguments: { msg: "x" } },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const hook: Hook = {
      name: "censor",
      onPostToolUse: () => ({
        updatedToolOutput: {
          content: [{ type: "text", text: "[censored]" }],
          isError: false,
        },
      }),
    };
    const session = new AgentSession({
      model,
      tools: [echoTool],
      hooks: [hook],
    });
    await session.run("go");
    const tr = session.messages.find((m) => m.role === "toolResult");
    expect(tr).toBeDefined();
    if (tr && tr.role === "toolResult") {
      expect((tr.content[0] as any).text).toBe("[censored]");
    }
  });

  it("preserves ToolExecResult.details on toolResult messages", async () => {
    const tool: HarnessTool = {
      ...echoTool,
      async execute() {
        return {
          content: [{ type: "text", text: "ok" }],
          details: { truncation: { originalLines: 12, returnedLines: 3 } },
        } as any;
      },
    };
    const model = createFakeModel([
      {
        content: [
          { type: "toolCall", name: "echo", arguments: { msg: "x" } },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({ model, tools: [tool] });
    await session.run("go");
    const tr = session.messages.find((m) => m.role === "toolResult");
    expect(tr).toBeDefined();
    expect(tr && tr.role === "toolResult" && (tr as any).details).toEqual({
      truncation: { originalLines: 12, returnedLines: 3 },
    });
    const modelToolResult = model.getCalls()[1]?.messages.find(
      (m) => m.role === "toolResult",
    );
    expect(modelToolResult && (modelToolResult as any).details).toBeUndefined();
  });

  it("preserves details from updatedToolOutput", async () => {
    const model = createFakeModel([
      {
        content: [
          { type: "toolCall", name: "echo", arguments: { msg: "x" } },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const hook: Hook = {
      name: "replace-with-details",
      onPostToolUse: () => ({
        updatedToolOutput: {
          content: [{ type: "text", text: "rewritten" }],
          details: { diff: "changed" },
        } as any,
      }),
    };
    const session = new AgentSession({
      model,
      tools: [echoTool],
      hooks: [hook],
    });
    await session.run("go");
    const tr = session.messages.find((m) => m.role === "toolResult");
    expect(tr).toBeDefined();
    expect(tr && tr.role === "toolResult" && (tr as any).details).toEqual({
      diff: "changed",
    });
  });

  it("PreToolUse decision=deny prevents execute, returns isError result", async () => {
    let executed = false;
    const tool: HarnessTool = {
      ...echoTool,
      async execute() {
        executed = true;
        return { content: [{ type: "text", text: "should not happen" }] };
      },
    };
    const model = createFakeModel([
      {
        content: [
          { type: "toolCall", name: "echo", arguments: { msg: "x" } },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const hook: Hook = {
      name: "blocker",
      onPreToolUse: () => ({ decision: "deny", reason: "blocked!" }),
    };
    const session = new AgentSession({
      model,
      tools: [tool],
      hooks: [hook],
    });
    await session.run("go");
    expect(executed).toBe(false);
    const tr = session.messages.find((m) => m.role === "toolResult");
    expect(tr && tr.role === "toolResult" && tr.isError).toBe(true);
    expect(tr && tr.role === "toolResult" && (tr.content[0] as any).text).toBe(
      "blocked!",
    );
  });

  it("systemMessage from hook goes to consoleSink, NOT into messages", async () => {
    const consoleSink = vi.fn();
    const model = createFakeModel([
      { content: [{ type: "text", text: "ok" }] },
    ]);
    const hook: Hook = {
      name: "noisy",
      onTurnStart: () => ({ systemMessage: "I am a hook talking" }),
    };
    const session = new AgentSession({
      model,
      tools: [],
      hooks: [hook],
      consoleSink,
    });
    await session.run("hi");
    expect(consoleSink).toHaveBeenCalledWith(
      "I am a hook talking",
      expect.objectContaining({ sessionId: session.id }),
    );
    // 不进 messages
    const found = session.messages.some(
      (m) =>
        typeof (m as any).content === "string" &&
        ((m as any).content as string).includes("I am a hook talking"),
    );
    expect(found).toBe(false);
  });
});

describe("Integration: Continuation (onContinuationCheck continue=true)", () => {
  it("triggers same-session second round; maxContinuations stops eventually", async () => {
    const model = createFakeModel([
      { content: [{ type: "text", text: "round 1 done" }] },
      { content: [{ type: "text", text: "round 2 done" }] },
      { content: [{ type: "text", text: "round 3 done" }] },
      { content: [{ type: "text", text: "round 4 done" }] },
    ]);

    let checkCalls = 0;
    let endCalls = 0;
    const hook: Hook = {
      name: "alwaysContinue",
      onContinuationCheck() {
        checkCalls++;
        return checkCalls < 4
          ? { continue: true, additionalContext: "keep going" }
          : undefined;
      },
      onSessionEnd() {
        endCalls++;
      },
    };
    const session = new AgentSession({
      model,
      tools: [],
      hooks: [hook],
      maxContinuations: 5,
    });
    const summary = await session.run("first");
    expect(summary.continuations).toBe(3);
    expect(summary.reason).toBe("done");
    // onSessionEnd 保证恰好 1 次
    expect(endCalls).toBe(1);
  });

  it("maxContinuations cap respected", async () => {
    const model = createFakeModel([
      { content: [{ type: "text", text: "r1" }] },
      { content: [{ type: "text", text: "r2" }] },
      { content: [{ type: "text", text: "r3" }] },
      { content: [{ type: "text", text: "r4" }] },
    ]);
    const hook: Hook = {
      name: "infinity",
      onContinuationCheck: () => ({ continue: true }),
    };
    const session = new AgentSession({
      model,
      tools: [],
      hooks: [hook],
      maxContinuations: 2,
    });
    const summary = await session.run("hi");
    expect(summary.continuations).toBe(2);
    expect(summary.reason).toBe("max_continuations");
  });
});

describe("Integration: Parallel tool execution (isConcurrencySafe)", () => {
  it("safe tools run concurrently", async () => {
    const startTimes: number[] = [];
    const slowTool: HarnessTool = {
      name: "slow",
      description: "slow",
      parameters: Type.Object({ id: Type.String() }),
      isConcurrencySafe: () => true,
      async execute(args) {
        startTimes.push(Date.now());
        await new Promise<void>((r) => setTimeout(r, 50));
        return { content: [{ type: "text", text: String(args["id"]) }] };
      },
    };
    const model = createFakeModel([
      {
        content: [
          { type: "toolCall", name: "slow", arguments: { id: "1" } },
          { type: "toolCall", name: "slow", arguments: { id: "2" } },
          { type: "toolCall", name: "slow", arguments: { id: "3" } },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);

    const t0 = Date.now();
    const session = new AgentSession({ model, tools: [slowTool] });
    await session.run("call all");
    const totalMs = Date.now() - t0;

    // 3 个 50ms 串行 ≈ 150ms+；并行 ≈ 50ms+。给 80ms 余量。
    expect(totalMs).toBeLessThan(130);
    expect(startTimes).toHaveLength(3);
    // 3 个 start 时间应该相差很小（并发触发）
    const spread = Math.max(...startTimes) - Math.min(...startTimes);
    expect(spread).toBeLessThan(20);
  });

  it("unsafe tools run sequentially", async () => {
    const order: string[] = [];
    const stTool: HarnessTool = {
      name: "stateful",
      description: "unsafe",
      parameters: Type.Object({ id: Type.String() }),
      async execute(args) {
        const id = String(args["id"]);
        order.push(`start-${id}`);
        await new Promise<void>((r) => setTimeout(r, 20));
        order.push(`end-${id}`);
        return { content: [{ type: "text", text: id }] };
      },
    };
    const model = createFakeModel([
      {
        content: [
          { type: "toolCall", name: "stateful", arguments: { id: "1" } },
          { type: "toolCall", name: "stateful", arguments: { id: "2" } },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);

    const session = new AgentSession({ model, tools: [stTool] });
    await session.run("seq");
    expect(order).toEqual(["start-1", "end-1", "start-2", "end-2"]);
  });

  it("results pushed to messages in original toolCalls order", async () => {
    const tool: HarnessTool = {
      name: "echo2",
      description: "echo",
      parameters: Type.Object({ id: Type.String() }),
      isConcurrencySafe: () => true,
      async execute(args) {
        // 延迟不同：id=1 慢，id=2 快——并行下完成顺序反着来
        const id = String(args["id"]);
        const delay = id === "1" ? 30 : 5;
        await new Promise<void>((r) => setTimeout(r, delay));
        return { content: [{ type: "text", text: id }] };
      },
    };
    const model = createFakeModel([
      {
        content: [
          {
            type: "toolCall",
            id: "tc-1",
            name: "echo2",
            arguments: { id: "1" },
          },
          {
            type: "toolCall",
            id: "tc-2",
            name: "echo2",
            arguments: { id: "2" },
          },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({ model, tools: [tool] });
    await session.run("go");
    const toolResults = session.messages.filter((m) => m.role === "toolResult");
    expect(toolResults).toHaveLength(2);
    if (toolResults[0]?.role === "toolResult") {
      expect(toolResults[0].toolCallId).toBe("tc-1");
    }
    if (toolResults[1]?.role === "toolResult") {
      expect(toolResults[1].toolCallId).toBe("tc-2");
    }
  });

  it("an unsafe write is a barrier: a later safe read observes the write (#11.1)", async () => {
    let state = "old";
    const write: HarnessTool = {
      name: "write_state",
      description: "unsafe write",
      parameters: Type.Object({}),
      isConcurrencySafe: () => false,
      async execute() {
        state = "new";
        return { content: [{ type: "text", text: "wrote" }] };
      },
    };
    const read: HarnessTool = {
      name: "read_state",
      description: "safe read",
      parameters: Type.Object({}),
      isConcurrencySafe: () => true,
      async execute() {
        return { content: [{ type: "text", text: state }] };
      },
    };
    const model = createFakeModel([
      {
        content: [
          { type: "toolCall", id: "w", name: "write_state", arguments: {} },
          { type: "toolCall", id: "r", name: "read_state", arguments: {} },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({ model, tools: [write, read] });
    await session.run("go");
    const r = session.messages.find(
      (m) => m.role === "toolResult" && m.toolCallId === "r",
    );
    // Deterministic: the barrier runs the write strictly before the read → read sees "new".
    // Pre-fix, read sat in the all-safe batch that ran before the unsafe write → "old".
    expect(r ? resultText(r) : "").toBe("new");
  });

  it("only contiguous safe runs parallelize; unsafe calls are barriers (#11.1)", async () => {
    const ev: string[] = [];
    const ab = rendezvous(2); // A,B must run concurrently (else this deadlocks → timeout)
    const cd = rendezvous(2); // C,D must run concurrently after the W barrier
    const model = createFakeModel([
      {
        content: [
          { type: "toolCall", id: "A", name: "A", arguments: {} },
          { type: "toolCall", id: "B", name: "B", arguments: {} },
          { type: "toolCall", id: "W", name: "W", arguments: {} },
          { type: "toolCall", id: "C", name: "C", arguments: {} },
          { type: "toolCall", id: "D", name: "D", arguments: {} },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({
      model,
      tools: [
        probeTool(ev, "A", true, ab),
        probeTool(ev, "B", true, ab),
        probeTool(ev, "W", false),
        probeTool(ev, "C", true, cd),
        probeTool(ev, "D", true, cd),
      ],
    });
    await session.run("go");
    // No deadlock ⇒ A,B ran concurrently and C,D ran concurrently (rendezvous(2) released).
    expect(ev).toHaveLength(10);
    const at = (e: string): number => ev.indexOf(e);
    // W is a barrier: it runs only after the A,B segment fully finished…
    expect(at("start-W")).toBeGreaterThan(at("end-A"));
    expect(at("start-W")).toBeGreaterThan(at("end-B"));
    // …and the C,D segment runs only after W finished (the bug ran C/D before W).
    expect(at("start-C")).toBeGreaterThan(at("end-W"));
    expect(at("start-D")).toBeGreaterThan(at("end-W"));
  });

  it("barrier at the head of the batch: [unsafe, safe, safe] (#11.1)", async () => {
    const ev: string[] = [];
    const ab = rendezvous(2);
    const model = createFakeModel([
      {
        content: [
          { type: "toolCall", id: "W", name: "W", arguments: {} },
          { type: "toolCall", id: "A", name: "A", arguments: {} },
          { type: "toolCall", id: "B", name: "B", arguments: {} },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({
      model,
      tools: [probeTool(ev, "W", false), probeTool(ev, "A", true, ab), probeTool(ev, "B", true, ab)],
    });
    await session.run("go");
    expect(ev).toHaveLength(6); // no deadlock ⇒ the trailing safe run (A,B) flushed concurrently
    const at = (e: string): number => ev.indexOf(e);
    expect(at("start-A")).toBeGreaterThan(at("end-W"));
    expect(at("start-B")).toBeGreaterThan(at("end-W"));
  });

  it("barrier at the tail of the batch: [safe, safe, unsafe] (#11.1)", async () => {
    const ev: string[] = [];
    const ab = rendezvous(2);
    const model = createFakeModel([
      {
        content: [
          { type: "toolCall", id: "A", name: "A", arguments: {} },
          { type: "toolCall", id: "B", name: "B", arguments: {} },
          { type: "toolCall", id: "W", name: "W", arguments: {} },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({
      model,
      tools: [probeTool(ev, "A", true, ab), probeTool(ev, "B", true, ab), probeTool(ev, "W", false)],
    });
    await session.run("go");
    expect(ev).toHaveLength(6);
    const at = (e: string): number => ev.indexOf(e);
    // leading safe run flushed (A,B concurrent), then the trailing unsafe ran after them
    expect(at("start-W")).toBeGreaterThan(at("end-A"));
    expect(at("start-W")).toBeGreaterThan(at("end-B"));
    expect(session.messages.filter((m) => m.role === "toolResult")).toHaveLength(3);
  });

  it("all-unsafe batch runs in strict sequential order (#11.1)", async () => {
    const ev: string[] = [];
    const model = createFakeModel([
      {
        content: [
          { type: "toolCall", id: "X", name: "X", arguments: {} },
          { type: "toolCall", id: "Y", name: "Y", arguments: {} },
          { type: "toolCall", id: "Z", name: "Z", arguments: {} },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({
      model,
      tools: [probeTool(ev, "X", false), probeTool(ev, "Y", false), probeTool(ev, "Z", false)],
    });
    await session.run("go");
    expect(ev).toEqual(["start-X", "end-X", "start-Y", "end-Y", "start-Z", "end-Z"]);
  });

  it("a throwing isConcurrencySafe is fail-closed to an unsafe barrier + reported via onError (#11.1)", async () => {
    const ev: string[] = [];
    const errors: string[] = [];
    const thrower: HarnessTool = {
      name: "T",
      description: "isConcurrencySafe throws",
      parameters: Type.Object({}),
      isConcurrencySafe: () => {
        throw new Error("safety check boom");
      },
      async execute() {
        ev.push("start-T");
        ev.push("end-T");
        return { content: [{ type: "text", text: "T" }] };
      },
    };
    const errHook: Hook = {
      name: "err-spy",
      onError(input) {
        if (input.phase === "tool") errors.push(input.err.message);
      },
    };
    const model = createFakeModel([
      {
        content: [
          { type: "toolCall", id: "A", name: "A", arguments: {} },
          { type: "toolCall", id: "T", name: "T", arguments: {} },
          { type: "toolCall", id: "B", name: "B", arguments: {} },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({
      model,
      hooks: [errHook],
      tools: [probeTool(ev, "A", true), thrower, probeTool(ev, "B", true)],
    });
    await session.run("go");
    // fail-closed: T is treated as unsafe → acts as a barrier between A and B (strict order)
    expect(ev).toEqual(["start-A", "end-A", "start-T", "end-T", "start-B", "end-B"]);
    // and the isConcurrencySafe throw was surfaced, not swallowed
    expect(errors).toContain("safety check boom");
  });

  it("abort during the batch skips the remaining trailing safe run (#11.1)", async () => {
    const ev: string[] = [];
    const aborter: HarnessTool = {
      name: "boom",
      description: "aborts mid-batch",
      parameters: Type.Object({}),
      isConcurrencySafe: () => false,
      async execute(_args, ctx) {
        ev.push("boom");
        ctx.abort("manual mid-batch");
        return { content: [{ type: "text", text: "x" }], isError: true };
      },
    };
    const later: HarnessTool = {
      name: "later",
      description: "safe — must be skipped after abort",
      parameters: Type.Object({}),
      isConcurrencySafe: () => true,
      async execute() {
        ev.push("later-ran");
        return { content: [{ type: "text", text: "late" }] };
      },
    };
    const model = createFakeModel([
      {
        content: [
          { type: "toolCall", id: "boom", name: "boom", arguments: {} },
          { type: "toolCall", id: "later", name: "later", arguments: {} },
        ],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({ model, tools: [aborter, later] });
    const summary = await session.run("go");
    expect(summary.reason).toBe("aborted");
    // the trailing safe run after the aborting barrier must NOT execute
    expect(ev).toEqual(["boom"]);
  });
});

describe("Integration: Aliases", () => {
  it("toolCall.name matches via aliases", async () => {
    let called = false;
    const tool: HarnessTool = {
      name: "new_name",
      aliases: ["old_name"],
      description: "renamed",
      parameters: Type.Object({}),
      async execute() {
        called = true;
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
    // pi-ai validateToolCall 会按 tool.name 校验，aliases 主要在 findToolByName 里生效
    // 这里 LLM 用旧名字调用
    const model = createFakeModel([
      { content: [{ type: "toolCall", name: "old_name", arguments: {} }] },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({ model, tools: [tool] });
    await session.run("go");
    expect(called).toBe(true);
  });
});

describe("Integration: ToolResult.newMessages", () => {
  it("appends extra messages after toolResult", async () => {
    const tool: HarnessTool = {
      name: "with-newmsg",
      description: "appends",
      parameters: Type.Object({}),
      async execute() {
        return {
          content: [{ type: "text", text: "main result" }],
          newMessages: [
            {
              role: "user",
              content: "[system] reminder appended",
              timestamp: Date.now(),
            },
          ],
        };
      },
    };
    const model = createFakeModel([
      { content: [{ type: "toolCall", name: "with-newmsg", arguments: {} }] },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({ model, tools: [tool] });
    await session.run("go");
    // messages 序列：user, assistant#1, toolResult, user (newMessage), assistant#2
    expect(session.messages).toHaveLength(5);
    expect(session.messages[2]?.role).toBe("toolResult");
    expect(session.messages[3]?.role).toBe("user");
    expect((session.messages[3] as any).content).toContain("reminder appended");
  });
});

describe("Integration: Abort paths", () => {
  it("caller signal.aborted before run → fast aborted", async () => {
    const model = createFakeModel([
      { content: [{ type: "text", text: "ok" }] },
    ]);
    const session = new AgentSession({ model, tools: [] });
    const ac = new AbortController();
    ac.abort();
    const summary = await session.run("hi", { signal: ac.signal });
    expect(summary.reason).toBe("aborted");
  });

  it("ctx.abort() called from hook stops session", async () => {
    const model = createFakeModel([
      { content: [{ type: "text", text: "r1" }] },
      { content: [{ type: "text", text: "r2" }] },
    ]);
    const hook: Hook = {
      name: "stopper",
      onTurnStart(_input, ctx: HookContext) {
        if (ctx.turnIdx === 0) ctx.abort("manual stop");
      },
    };
    const session = new AgentSession({
      model,
      tools: [],
      hooks: [hook],
    });
    const summary = await session.run("hi");
    expect(summary.reason).toBe("aborted");
    expect(summary.abortReason).toBe("manual stop");
  });
});
