# @harness-pi/adapters

> Concrete I/O behind the kernel protocols — JSONL/Postgres SessionStore, EventPump, WebSocket sink.

`@harness-pi/adapters` provides the concrete persistence and transport implementations that sit behind the protocols defined in `@harness-pi/core`. The kernel declares `SessionStore` and an event bus but ships no I/O of its own; this package supplies the file/Postgres stores you hand to a session, plus the pump and sink that carry live and recorded events to a WebSocket (or any other channel). It is part of [harness-pi](https://github.com/chasey-myagi/harness-pi), a production harness for pi-ai-based agents.

## Install

```bash
pnpm add @harness-pi/adapters
```

Requires `@harness-pi/core`. `PostgresSessionStore` expects a node-postgres client injected (run `pnpm add pg` in your app); this package bundles no `pg`.

## Quick start

```ts
import { AgentSession } from "@harness-pi/core";
import { JsonlSessionStore, PostgresSessionStore } from "@harness-pi/adapters";
import { Pool } from "pg";

// --- JSONL store: append-only file, crash-tolerant replay on construct ---
const jsonlStore = new JsonlSessionStore("./.sessions/agent.jsonl");

const session = new AgentSession({
  model,           // a pi-ai Model<Api>
  tools: [],       // your HarnessTool[]
  store: jsonlStore,
});

await session.run("List the files in the current directory.");

// Later (or in another process): rebuild from disk and keep going.
const resumed = await AgentSession.resume(jsonlStore, session.id, {
  model,
  tools: [],
});
await resumed.continue();

// --- Postgres store: inject a node-postgres Pool (satisfies PgClient) ---
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const pgStore = new PostgresSessionStore(pool);
await pgStore.migrate(); // idempotent DDL; run once before first use

const pgSession = new AgentSession({ model, tools: [], store: pgStore });
await pgSession.run("Summarize the open issues.");
```

## What's inside

- **`JsonlSessionStore`** — append-only JSONL file store with crash-tolerant replay and lineage indexing.
- **`PostgresSessionStore`** — Postgres-backed store; you inject a minimal `PgClient` (node-postgres `Pool`/`Client` satisfy it) — zero runtime `pg` dependency in this package.
- **`EventPump`** — packages live deltas + recorded `SessionEvent`s into sequenced `TransportEnvelope`s for any sink.
- **`WebSocketSink`** — `EventPump` → WebSocket, with `readyState` awareness, injectable serialization, and graceful drops.

## License

MIT
