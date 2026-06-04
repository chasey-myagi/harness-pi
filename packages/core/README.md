# @harness-pi/core

> Agent kernel — a pi-ai LLM loop with a first-class, four-phase hook system.

`@harness-pi/core` is the kernel of an LLM agent: it drives the pi-ai completion loop, executes tools, and dispatches a structured hook system across four phases (event, decision, transform, around). Everything above it — persistence backends, permission gates, compaction, metrics — is built as plugins on top of these primitives. It is part of [harness-pi](https://github.com/chasey-myagi/harness-pi), a production harness for pi-ai-based agents.

## Install

```bash
pnpm add @harness-pi/core
```

Peer: `@earendil-works/pi-ai` (model runtime, a dependency).

## Quick start

```ts
import {
  AgentSession,
  Type,
  type HarnessTool,
  type SessionEvent,
} from "@harness-pi/core";
import { createFakeModel } from "@harness-pi/core/testing";

// A HarnessTool is a pi-ai Tool plus an execute() function.
const echo: HarnessTool = {
  name: "echo",
  description: "Echo a message back to the caller.",
  parameters: Type.Object({ msg: Type.String() }),
  isConcurrencySafe: (input) => true,
  async execute(args) {
    return { content: [{ type: "text", text: String(args.msg) }] };
  },
};

// createFakeModel scripts assistant responses so the loop runs without a provider.
// In production, pass a real pi-ai Model<Api> instead.
const model = createFakeModel([
  { content: [{ type: "toolCall", id: "1", name: "echo", arguments: { msg: "hi" } }] },
  { content: [{ type: "text", text: "done" }] },
]);

const session = new AgentSession({
  model,
  tools: [echo],
  systemPrompt: "You are a helpful agent.",
});

// Fine-grained LiveEvents: in-flight token/thinking/toolcall deltas.
session.on("text_delta", (e) => process.stdout.write(e.delta));

// runStreaming yields coarse SessionEvents; finalSummary resolves to a RunSummary.
const stream = session.runStreaming("say hi");
for await (const event of stream) {
  const ev: SessionEvent = event;
  if (ev.type === "tool-end") {
    console.log(`tool ${ev.call.name} -> ${ev.result.isError ? "error" : "ok"}`);
  }
}

const summary = await stream.finalSummary;
console.log(summary.reason, summary.turns, summary.usage.totalTokens);
```

## What's inside

- **AgentSession** — the execution loop: `runStreaming(prompt)`, steering, abort, and resume; emits coarse `SessionEvent`s plus fine `LiveEvent`s via `session.on`.
- **Hook system** — event hooks (`onSessionStart`/`End`, `onTurnStart`/`End`, `onLlmEnd`, `onPostToolUse`, `onContextOverflow`, `onSteer`, `onError`), decision hooks (`onPreToolUse`, `onUserPromptSubmit`) with fail-open/fail-closed semantics, transform pipes (`transformSystemPromptBeforeLlm`, `transformMessagesBeforeLlm`), and around wrappers (`wrapTurn`, `wrapToolExec`).
- **HarnessTool** — a pi-ai `Tool` plus `execute()` and optional `isConcurrencySafe`; the kernel batches concurrency-safe tools and runs unsafe ones sequentially.
- **SessionStore protocol + MemorySessionStore** — append-only persistence with lineage and fork-from-prefix; `RunSummary` is the terminal result.
- **HookContext** — `sessionId`, `turnIdx`, `signal`, a typed state map, messages, a config view, a logger, and `appendMessage()`/`abort()`/`emit()`.
- **Context-overflow detection** — `stopReason === "length"` or a custom `isContextOverflow` predicate fires `onContextOverflow`.
- **Testing utilities** at `./testing` — `createFakeModel()` and `createTestContext()`.

## License

MIT
