# @harness-pi/tools

> First-party coding tools (read, bash, edit, write, grep, find, ls) as HarnessTool factories.

This package provides the built-in coding tools used to give an agent access to a workspace: reading and writing files, running shell commands, and searching the filesystem. Each tool is exposed as a factory bound to a working directory, returning a `HarnessTool` you hand to an agent. It is part of [harness-pi](https://github.com/chasey-myagi/harness-pi), a production harness for pi-ai-based agents.

## Install

```bash
pnpm add @harness-pi/tools
```

Requires `@harness-pi/core` (the agent kernel that consumes these tools).

## Quick start

```ts
import { AgentSession } from "@harness-pi/core";
import { createCodingTools, createReadOnlyTools } from "@harness-pi/tools";

// All factories are bound to a workspace cwd. They resolve every path
// argument relative to it and refuse to escape it by default.
const cwd = process.cwd();

// Full read/write coding toolset: read, bash, edit, write.
const tools = createCodingTools(cwd);

// Or a sandboxed, read-only set: read, grep, find, ls.
// const tools = createReadOnlyTools(cwd);

// `model` is your pi-ai Model<Api>; see @harness-pi/core for how to obtain one.
const session = new AgentSession({ model, tools });

const result = await session.run("Summarize the files in this directory.");
```

Both `createCodingTools(cwd)` and `createReadOnlyTools(cwd)` return a `HarnessTool[]`, which is exactly the shape `AgentSession`'s `tools` option expects.

## What's inside

Tools (each a factory bound to a `cwd`, returning a `HarnessTool`):

- **read** (`createReadTool`) — Read a text file or image; long output is truncated with continuation hints.
- **bash** (`createBashTool`) — Run a shell command; returns stdout/stderr, supports a timeout and a sanitized env.
- **edit** (`createEditTool`) — Replace a unique text range in an existing file.
- **write** (`createWriteTool`) — Write a complete file, creating parent directories as needed.
- **grep** (`createGrepTool`) — Search file contents by regex or literal, honoring `.gitignore`.
- **find** (`createFindTool`) — Find files by glob pattern, returning workspace-relative paths.
- **ls** (`createLsTool`) — List directory contents, alphabetized with a `/` suffix for directories.

Presets (each returns a ready-to-use collection):

- **createAllTools** — All seven tools as a `Record<ToolName, HarnessTool>`.
- **createCodingTools** — `HarnessTool[]` of read, bash, edit, write.
- **createReadOnlyTools** — `HarnessTool[]` of read, grep, find, ls.

Concurrency and safety:

- **Concurrency** — Read-only tools (read, grep, find, ls) report `isConcurrencySafe` and may run in parallel; bash is not concurrency-safe.
- **Cancellation** — All tools honor the `AbortSignal` passed by the kernel.
- **bash control** — Supports a per-call timeout (seconds; default 120s), a configurable working directory, and a sanitized environment that strips secret-like variables.

## License

MIT
