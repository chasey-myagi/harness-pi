# @harness-pi/coding-agent

A genuinely usable coding agent on **[@harness-pi/core](https://www.npmjs.com/package/@harness-pi/core)** (the pi-ai agent kernel) with a **pi-tui** terminal UI. It exercises the full harness-pi feature set end to end: token streaming, a tool-approval gate, mid-run steering, crash-recovery resume, context compaction, and parallel read-only sub-agent fan-out.

Ships the `hpi` command.

## Install

```bash
npx @harness-pi/coding-agent --help      # run without installing
# or install the `hpi` command globally:
npm i -g @harness-pi/coding-agent
```

Requires **Node ≥ 20** (`node --version`).

## Quick start

```bash
export ANTHROPIC_API_KEY=sk-...   # or any provider below
hpi                                # launches the interactive TUI
```

With a key set, `hpi` auto-detects a sensible default model. To run one task headless:

```bash
hpi --model anthropic:claude-sonnet-4-0 "read calc.py and point out bugs"
```

> ⚠️ The agent runs `bash`/`edit`/`write` on your **host shell** — it is **not a sandbox**. Run it only in a workspace you intend to modify, or use `--read-only`.

## Model & API keys

Pick any pi-ai provider with `--model provider:id` (or set `HARNESS_PI_MODEL`). Set the provider's API-key environment variable and `hpi` picks it up:

| Provider | `--model` example | Env var |
|---|---|---|
| Anthropic | `anthropic:claude-sonnet-4-0` | `ANTHROPIC_API_KEY` |
| OpenAI | `openai:gpt-4.1` | `OPENAI_API_KEY` |
| Google | `google:gemini-flash-latest` | `GEMINI_API_KEY` |
| xAI | `xai:grok-3-latest` | `XAI_API_KEY` |
| Groq | `groq:llama-3.3-70b-versatile` | `GROQ_API_KEY` |
| DeepSeek | `deepseek:deepseek-v4-flash` | `DEEPSEEK_API_KEY` |
| Moonshot (Kimi) | `moonshotai:kimi-k2-0905-preview` | `MOONSHOT_API_KEY` |
| Alibaba Qwen | `qwen:qwen-plus` | `DASHSCOPE_API_KEY` (or `QWEN_API_KEY`) |

…and ~24 more via `hpi --list-providers` (set that provider's own API-key env var).

```bash
hpi --list-providers          # every provider + which key you currently have set
hpi --list-models anthropic   # model ids for a provider
```

If you omit `--model` and `HARNESS_PI_MODEL`, `hpi` auto-detects a model from whichever API key you have set (override anytime with `--model`).

**`.env` support** — `hpi` auto-loads a `.env` file from the current directory (and `--env-file <path>`). Real environment variables always win over `.env`.

```bash
# .env
ANTHROPIC_API_KEY=sk-...
HARNESS_PI_MODEL=anthropic:claude-sonnet-4-0
```

## Interactive TUI (the default)

Running `hpi` in a terminal launches the TUI (`--tui` to force it; `--repl` for a plain readline prompt instead).

- **Stream** — the assistant's answer types out live; thinking shows above the answer.
- **Tool approval** — `bash`/`edit`/`write` show an Allow-once / Deny prompt. Read tools (`read`/`grep`/`find`/`ls`) run without asking. `--yolo` skips all prompts.
- **Steering** — type while a run is in flight to inject a message into the next turn.
- **Esc** — cancel the in-flight run (or a `/multi` / `/goal` loop). **Ctrl-C** (or **Ctrl-D** on empty input, or **/exit**) quits.
- **Status bar** — model · session tokens · context-usage gauge · cost · tool stats.

Works in any modern terminal (iTerm2, WezTerm, Kitty, Ghostty, VS Code, Windows Terminal) — no special setup.

### Slash commands (type `/` for autocomplete)

| Command | What it does |
|---|---|
| `/compact` | Turn on compaction for this session — summarize earlier messages for the model (full history is kept). |
| `/goal <goal> [--max-turns N] [--budget N] [--success <criteria>]` | Run a **goal + verifier + budget loop**: the agent acts until it self-reports `GOAL_STATUS: REACHED`, or until `--max-turns` / `--budget` (tokens) is exhausted. Rounds and budget remaining are shown per turn. Esc interrupts. |
| `/multi <question> @file @file …` | Analyze several files **in parallel** with read-only sub-agents (cannot edit), then aggregate the findings. |
| `/help` | List commands. |
| `/exit` | Quit the TUI. |

Type `@` to autocomplete file paths under the workspace. File completion uses [`fd`](https://github.com/sharkdp/fd) when installed (faster, respects `.gitignore`) and falls back to a directory walk otherwise. Optional:

```bash
brew install fd          # macOS
sudo apt install fd-find # Debian/Ubuntu (binary is `fdfind`)
choco install fd         # Windows
```

## One-shot (headless)

Give a task as a positional argument to run once and print the answer + a run report (cost, tokens, tool stats):

```bash
hpi --read-only "summarize the architecture of src/"
hpi --model qwen:qwen-plus "fix the failing test in calc.test.ts"
```

## Crash recovery & resume

TUI sessions persist to `.harness-pi/sessions/<id>.jsonl` every turn. On exit you'll see:

```
Session persisted (process-crash recoverable). Resume with: --resume <id>
```

Resume into the TUI with the prior conversation restored:

```bash
hpi --resume <id>
```

(Persistence uses `appendFileSync` without `fsync` — recoverable from a process crash, not guaranteed against power loss. Clear with `rm -rf .harness-pi/`.)

## Flags

| Flag | Description |
|---|---|
| `--model <provider:id>` | pi-ai model. Or `HARNESS_PI_MODEL`. Auto-detected from your API keys if omitted. |
| `--tui` / `--repl` | Force the TUI / use a plain readline REPL. |
| `--cwd <path>` | Workspace directory. Defaults to the current directory. |
| `--read-only` | Restrict tools to `read`/`grep`/`find`/`ls` (no edits, no bash). |
| `--resume <id>` | Resume a saved TUI session. |
| `--yolo` | (TUI) skip tool-approval prompts. |
| `--compact` | (TUI) auto-summarize early messages when the conversation grows long. |
| `--disable <a,b>` | Disable named first-party tools. |
| `--env-file <path>` | Load env vars from a `.env` file (`./.env` is auto-loaded too). |
| `--log-dir <path>` | Session log directory. Defaults to `.harness-pi/logs`. |
| `--metrics-file <path>` | Write run metrics as NDJSON. |
| `--list-providers` / `--list-models <p>` | Discover providers and model ids. |
| `--version` / `--help` | Print version / help. |

## Develop (from source)

This package lives in the [harness-pi](https://github.com/chasey-myagi/harness-pi) monorepo.

```bash
pnpm install && pnpm build        # build all workspace packages
pnpm --filter @harness-pi/coding-agent start -- --tui --model qwen:qwen-plus
pnpm --filter @harness-pi/coding-agent test
```

> macOS tip: pull a key from Keychain at launch — `export DASHSCOPE_API_KEY=$(security find-generic-password -a "$USER" -s DASHSCOPE_API_KEY -w)`.

## License

MIT
