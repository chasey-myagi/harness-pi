# @harness-pi/plugins

> Standard library of plugins, controllers, and metrics sinks for harness-pi sessions.

This package is the batteries-included plugin layer for [harness-pi](https://github.com/chasey-myagi/harness-pi), a production harness for pi-ai-based agents. It ships ready-to-use hooks (permission gating, history compaction, cost/token accounting, watchdogs), higher-level controllers for orchestrating multiple sessions, and pluggable metrics sinks — all built against the `Hook` and `AgentSession` primitives in `@harness-pi/core`. You compose these into an `AgentSession`'s `hooks` array; the kernel runs them at the appropriate lifecycle points.

## Install

```bash
pnpm add @harness-pi/plugins
```

Requires `@harness-pi/core` (installed as a dependency).

## Quick start

```ts
import { AgentSession } from "@harness-pi/core";
import { costTracker, permissionGate } from "@harness-pi/plugins";

const session = new AgentSession({
  model,                 // a pi-ai Model<Api>
  tools,                 // your HarnessTool[]
  systemPrompt: "You are a helpful agent.",
  hooks: [
    // Rule-based tool gate: first matching rule wins; unmatched tools are denied.
    permissionGate({
      rules: [
        { match: /^(read|grep|list)/, decision: "allow" },
        { match: "bash", decision: "ask", reason: "shell access needs approval" },
      ],
      fallback: "deny",
      // "ask" decisions are resolved here (may be async, e.g. prompt a human / RPC).
      onAsk: async (call) => approveInUi(call),
    }),
    // Accumulates tokens / cost / duration per model into ctx.state.
    costTracker({
      mode: "lifetime",
      onSessionFinalized: (_ctx, stats) => {
        console.log(`cost: $${stats.costUSD.toFixed(4)} (${stats.llmCallCount} calls)`);
      },
    }),
  ],
});

const summary = await session.run("Find and summarize the TODOs in this repo.");
```

## What's inside

Plugins (the package root export):

- **permissionGate** — declarative `match → allow/ask/deny` rule engine over the tool chokepoint; fail-closed by default, `ask` resolved via an `onAsk` callback.
- **compactSummarize** — LLM-generated summary of early messages when history overflows (view-transform; does not destroy raw history).
- **trimHistory** — drops middle-of-history tool results, keeping the most recent N messages.
- **costTracker** — accumulates input/output/cached tokens, USD cost, and per-model breakdown into `ctx.state`; read via `getCostStats(ctx)`.
- **tokenBudget** — enforces a token ceiling per run or session.
- **repeatedCallGuard** — detects and reacts to repeated identical tool calls within a window.
- **watchdog** — per-turn timeout guard.
- **toolStats** — records per-tool call counts, durations, and spans; read via `getToolStats(ctx)`, plus `estimateParallelSavings`.
- **sessionLog** — appends lifecycle events to an NDJSON log on disk.
- **systemReminder** — injects system-reminder messages at chosen lifecycle events.
- **emptyRunGuard** — aborts after too many consecutive empty turns.
- **toolOutputBuffer** — ring-buffer of recent tool outputs; read via `getToolOutputBuffer`.
- **leaseDecision** — gates tool use against lease/ownership predicates (pairs with `LeaseQueue`).
- **batchCounter** — counts tool-call batches per turn.

Controllers (`@harness-pi/plugins/controllers`):

- **parallel() / pipeline()** — fan-out and staged orchestration of work items across sessions.
- **WorkPool** — runs a fixed set of work items across static partitions.
- **LeaseQueue** — dynamic pull-based work distribution via leases.
- **forkSession / forkSessionAll** — branch a session into one or more isolated forks.
- **LifecycleRestart** — restart-on-lifecycle supervision for long-running sessions.
- **compactOnOverflow / CompactRestartFresh** — restart a session fresh from a compacted summary on context overflow.
- **subAgentTool / routedSubAgentTool** — wrap a child session as a callable tool; the routed variant picks among multiple `AgentSpec`s by `agent_type`.
- **GapExplorer** — explore and report coverage gaps in a result set.

Metrics:

- **metrics** — plugin that emits `MetricEvent`s to a pluggable `MetricsSink`; `emitMetric` / `getMetricsSink` for direct access.
- **MemorySink** (`@harness-pi/plugins/metrics/sinks/memory`) — in-memory sink for tests and inspection.
- **NdjsonFileSink** (`@harness-pi/plugins/metrics/sinks/ndjson-file`) — append metrics as NDJSON to a file; `BatchingSink` and `WorkItemAggregator` for batching and rollups.

## License

MIT
