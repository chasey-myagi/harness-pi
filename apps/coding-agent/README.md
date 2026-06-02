# @harness-pi/coding-agent

A dogfood coding agent built on **@harness-pi/core** (the pi-ai agent kernel) with a
**pi-tui** terminal UI. It exercises the full harness-pi feature set end to end:
streaming, a tool-approval gate, mid-run steering, crash-recovery resume, context
compaction, and parallel sub-agent fan-out.

## Prerequisites

```bash
pnpm install
pnpm build        # builds all workspace packages; required — deps resolve to dist/
```

Node >= 20. The agent runs `bash`/`edit`/`write` on your **host shell** — it is not a
sandbox. Run it only in workspaces you intend to modify (or use `--read-only`).

## Model + API key

Pick a model with `--model provider:id` (or set `HARNESS_PI_MODEL`). DashScope/Qwen and
all standard pi-ai providers are supported.

```bash
# DashScope (Qwen) — reads DASHSCOPE_API_KEY or QWEN_API_KEY from the environment
export DASHSCOPE_API_KEY=$(security find-generic-password -a "$USER" -s DASHSCOPE_API_KEY -w)
```

Aliases: `dashscope:qwen-plus`, `qwen:qwen-plus`.

## One-shot (headless)

Run a single task and print the answer + a run report (cost, tokens, tool stats):

```bash
node dist/cli.js --cwd . --model qwen:qwen-plus --read-only "Read calc.py — any bugs?"
```

## Interactive TUI

```bash
node dist/cli.js --tui --model qwen:qwen-plus
# or: pnpm --filter @harness-pi/coding-agent start -- --tui --model qwen:qwen-plus
```

In the TUI:

- **Stream** — the assistant's answer types out live; thinking shows above the answer.
- **Tool approval** — `bash`/`edit`/`write` pop an Allow-once / Deny prompt. Read tools
  (`read`/`grep`/`find`/`ls`) run without asking. `--yolo` skips all prompts.
- **Steering** — type while a run is in flight to inject a message into the next turn.
- **Esc** — cancel the in-flight run (or a `/multi` batch). **Ctrl-C** (or **Ctrl-D** on an
  empty input, or **/exit**) quits.
- **Status bar** — model · session tokens · context-usage gauge · cost · tool stats.

### Slash commands (type `/` for autocomplete)

| Command | What it does |
|---|---|
| `/compact` | Turn on compaction for this session — summarize earlier messages for the model (full history is kept). Stays on for the session. |
| `/multi <question> @file @file …` | Analyze several files **in parallel** with read-only sub-agents (cannot edit), then aggregate the findings. |
| `/help` | List commands. |
| `/exit` | Quit the TUI. |

Type `@` to autocomplete file paths under the workspace. File completion uses
[`fd`](https://github.com/sharkdp/fd) when installed (faster, respects `.gitignore`) and
falls back to a directory walk otherwise.

`--compact` enables automatic compaction from launch (otherwise `/compact` is manual).

## Crash recovery

TUI sessions persist to `.harness-pi/sessions/<id>.jsonl` every turn. On exit you'll see:

```
Session persisted (process-crash recoverable). Resume with: --resume <id>
```

Resume into the TUI with the prior history restored:

```bash
node dist/cli.js --resume <id> --model qwen:qwen-plus
```

(Persistence uses `appendFileSync` without `fsync` — recoverable from a process crash, not
guaranteed against power loss.)

## All flags

Run `node dist/cli.js --help`. Key ones: `--cwd`, `--model`, `--read-only`, `--tui`,
`--resume <id>`, `--yolo`, `--compact`, `--disable <a,b>`, `--log-dir`, `--metrics-file`.
