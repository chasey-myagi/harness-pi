#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createCodingAgent,
  resumeCodingAgent,
  resolveModelRuntime,
  resolveModelSpec,
  runAgentPrompt,
  type CodingAgent,
} from "./agent.js";
import { renderRunReport, renderSessionEvent } from "./output.js";
import {
  detectDefaultModel,
  envVarForProvider,
  formatModelList,
  formatProviderList,
  loadDotEnv,
} from "./config.js";
import { harnessPiGitignoreWarning } from "./workspace-safety.js";
import { toolNames, type ToolName } from "@harness-pi/tools";
import { JsonlSessionStore } from "@harness-pi/adapters";
import { ProcessTerminal } from "@mariozechner/pi-tui";
import { createTuiApp } from "./tui/app.js";

interface CliArgs {
  cwd: string;
  model?: string | undefined;
  readOnly: boolean;
  disabledTools: ToolName[];
  logDir?: string | undefined;
  noLog?: boolean | undefined;
  logArgs?: "redacted" | "full" | "none" | undefined;
  metricsFile?: string | undefined;
  task?: string | undefined;
  tui: boolean;
  repl: boolean;
  yolo: boolean;
  compact: boolean;
  resume?: string | undefined;
  envFile?: string | undefined;
  listProviders: boolean;
  listModels?: string | undefined;
  version: boolean;
  help: boolean;
}

/** TUI 会话落盘文件路径:.harness-pi/sessions/<id>.jsonl（相对 cwd）。 */
function sessionFilePath(cwd: string, sessionId: string): string {
  return join(resolve(cwd), ".harness-pi", "sessions", `${sessionId}.jsonl`);
}

/** 该会话的 persistence 子对象（store + id 捆一起，对齐 createCodingAgent.persistence）。 */
function persistenceFor(
  cwd: string,
  sessionId: string,
): { store: JsonlSessionStore; sessionId: string } {
  return { store: new JsonlSessionStore(sessionFilePath(cwd, sessionId)), sessionId };
}

/** 取 assistant 消息纯文本（content 可能是 string 或 block 数组）。 */
function assistantText(msg: { content: unknown } | undefined): string {
  if (!msg) return "";
  const content = msg.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) =>
      b && typeof b === "object" && "text" in b && typeof (b as { text: unknown }).text === "string"
        ? (b as { text: string }).text
        : "",
    )
    .join("");
}

/**
 * `/multi` 用的只读 bounded 子代理执行器：每个子任务造一个全新的 readOnly + 限轮 agent 跑完即弃。
 * 只读 = 只 read/grep/find/ls，并行安全、不触发审批弹窗。父 signal 透传，可被 Esc 取消整批。
 */
export function makeReadOnlySubAgentSpawner(
  cwd: string,
  model: ReturnType<typeof resolveModelRuntime>["model"],
  llmOptions: Record<string, unknown> | undefined,
): (task: string, signal: AbortSignal) => Promise<{ ok: boolean; text: string }> {
  return async (task, signal) => {
    const subOpts: Parameters<typeof createCodingAgent>[0] = {
      cwd,
      model,
      readOnly: true,
      maxTurns: 8,
    };
    if (llmOptions !== undefined) subOpts.llmOptions = llmOptions;
    const sub = createCodingAgent(subOpts);
    // 只挂监听：orchestrateMulti 在启动前就用 signal.aborted 短路了，故 spawn 永远不会收到"已 abort"的
    // signal；在飞中途 abort 时这个监听触发 sub.session.abort()，取消正在跑的子代理。
    const onAbort = (): void => sub.session.abort("multi parent aborted");
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const report = await runAgentPrompt(sub, task);
      const last = report.summary.lastMessage;
      // 成功 = run 干净收尾 **且** 最后一条 assistant 是 stopReason:"stop"。光看 reason 不够：provider 把
      // 错误/超窗当流事件报回时，内核仍以 reason:"done" 收尾（session.ts:1190），但 lastMessage.stopReason
      // 是 "error"/"length"——那种不算成功，否则限流的子代理会被标成 ✓。
      const ok = report.summary.reason === "done" && last?.stopReason === "stop";
      return { ok, text: assistantText(last) || "(no output)" };
    } catch (err) {
      return { ok: false, text: err instanceof Error ? err.message : String(err) };
    } finally {
      signal.removeEventListener("abort", onAbort);
      await sub.close();
    }
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);

  // .env: explicit --env-file first, then ./.env in the launch dir. Never overrides real env vars.
  if (args.envFile !== undefined) loadDotEnv(args.envFile);
  loadDotEnv(join(process.cwd(), ".env"));

  if (args.help) {
    printHelp();
    return;
  }
  if (args.version) {
    console.log(readVersion());
    return;
  }
  if (args.listProviders) {
    console.log(formatProviderList());
    return;
  }
  if (args.listModels !== undefined) {
    console.log(formatModelList(args.listModels));
    return;
  }

  // Mode default: no task and not explicitly TUI → prefer the TUI on a real terminal (the headline
  // experience); --repl forces the plain readline REPL; piped/no-TTY with no task can't drive an
  // interactive prompt, so show help instead of silently hanging on a readline that never returns.
  if (!args.task && !args.tui && !args.repl) {
    if (process.stdin.isTTY) {
      args.tui = true;
    } else {
      printHelp();
      return;
    }
  }

  const spec = resolveModelSpecOrDetect(args.model);
  let runtime: ReturnType<typeof resolveModelRuntime>;
  try {
    runtime = resolveModelRuntime(spec);
  } catch (err) {
    throw augmentKeyError(err, spec);
  }
  const createOptions: Parameters<typeof createCodingAgent>[0] = {
    cwd: args.cwd,
    model: runtime.model,
    readOnly: args.readOnly,
    disabledTools: args.disabledTools,
  };
  if (runtime.llmOptions !== undefined) {
    createOptions.llmOptions = runtime.llmOptions;
  }
  if (args.logDir !== undefined) createOptions.logDir = args.logDir;
  if (args.noLog === true) createOptions.log = false;
  if (args.logArgs !== undefined) createOptions.logArgs = args.logArgs;
  if (args.metricsFile !== undefined) {
    createOptions.metricsFile = args.metricsFile;
  }
  // TUI 模式默认开 tool 审批门（bash/write/edit 需确认）；--yolo 关闭。one-shot/readline 无弹窗、不挂门。
  if (args.tui && !args.yolo) {
    createOptions.permission = {};
  }
  // TUI 模式挂上 compaction hook：默认 {}（阈值=哨兵,不自动触发,但 /compact 可手动启用）；
  // --compact 则设一个自动阈值（长对话超阈自动把早期消息压成摘要）。one-shot/readline 不挂。
  if (args.tui) {
    createOptions.compaction = args.compact
      ? { maxMessages: 60, keepRecent: 8 }
      : {};
  }

  // TUI 会话默认落盘到 .harness-pi/sessions/<id>.jsonl（崩溃后可 --resume 续跑）。
  // resume：从给定 id 回放历史重建 session；新 TUI：随机 id 起新会话。one-shot/readline 不落盘。
  let agent: CodingAgent;
  let sessionId: string | undefined;
  if (args.resume !== undefined) {
    sessionId = args.resume;
    // 提前挡 typo:resume 一个从没落过盘的 id 会静默开一个空会话（store 文件不存在→历史为空），
    // 用户还会在退出时看到误导的"Session saved"。不存在就直接报错。
    if (!existsSync(sessionFilePath(args.cwd, sessionId))) {
      throw new Error(
        `No saved session "${sessionId}" at ${sessionFilePath(args.cwd, sessionId)}`,
      );
    }
    agent = await resumeCodingAgent({
      ...createOptions,
      persistence: persistenceFor(args.cwd, sessionId),
    });
  } else {
    if (args.tui) {
      sessionId = randomUUID();
      createOptions.persistence = persistenceFor(args.cwd, sessionId);
    }
    agent = createCodingAgent(createOptions);
  }

  // #22 守卫：启动期就把 .harness-pi 未被 gitignore 的风险打到 stderr（早于任何落盘，且 TUI 路径
  // 不渲染 run report 也能看到）。one-shot 的 run report 也会再列一次（agent.warnings），刻意冗余。
  const gitignoreWarning = harnessPiGitignoreWarning(args.cwd);
  if (gitignoreWarning) process.stderr.write(`⚠️  ${gitignoreWarning}\n`);

  try {
    if (!args.readOnly) {
      console.warn(
        "Warning: bash runs on the host shell. This app is not a sandbox.",
      );
    }

    if (args.task) {
      const report = await runAgentPrompt(agent, args.task, {
        onEvent: printEvent,
      });
      // 先打模型的正文答案——否则 one-shot 只剩事件行 + 统计报告，用户看不到任何回答。
      printAnswer(report);
      console.log(renderRunReport(report));
      return;
    }

    if (args.tui) {
      const app = createTuiApp({
        agent,
        terminal: new ProcessTerminal(),
        cwd: agent.cwd,
        // resume 时把重建的历史渲进 TUI（新建会话 snapshot 为空、不渲）。
        initialMessages: agent.session.snapshot().messages,
        spawnReadOnlySubAgent: makeReadOnlySubAgentSpawner(
          args.cwd,
          runtime.model,
          runtime.llmOptions,
        ),
      });
      await app.run(); // 直到用户 Ctrl-C 退出
      // 退出后告知 resume 句柄。落盘每 turn 用 appendFileSync（无 fsync）——进程崩溃可恢复，
      // 但断电/内核 panic 下最后一次写可能丢，故措辞为"process-crash recoverable"而非"saved"。
      if (sessionId) {
        console.log(
          `Session persisted (process-crash recoverable). Resume with: --resume ${sessionId}`,
        );
      }
      return;
    }

    await runInteractive(agent);
  } finally {
    await agent.close();
  }
}

export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    cwd: process.cwd(),
    readOnly: false,
    disabledTools: [],
    tui: false,
    repl: false,
    yolo: false,
    compact: false,
    listProviders: false,
    version: false,
    help: false,
  };
  const task: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // `--` is ignored (not a flag-stopper): supports the `pnpm start -- --flags` dev workflow,
    // where pnpm injects a leading `--` before the user's flags, which must still be parsed.
    if (arg === "--") {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (arg === "--version" || arg === "-V") {
      out.version = true;
      continue;
    }
    if (arg === "--list-providers") {
      out.listProviders = true;
      continue;
    }
    if (arg === "--list-models") {
      out.listModels = requireValue(argv, ++i, "--list-models");
      continue;
    }
    if (arg === "--env-file") {
      out.envFile = requireValue(argv, ++i, "--env-file");
      continue;
    }
    if (arg === "--repl") {
      out.repl = true;
      continue;
    }
    if (arg === "--cwd") {
      out.cwd = requireValue(argv, ++i, "--cwd");
      continue;
    }
    if (arg === "--model") {
      out.model = requireValue(argv, ++i, "--model");
      continue;
    }
    if (arg === "--read-only") {
      out.readOnly = true;
      continue;
    }
    if (arg === "--tui") {
      out.tui = true;
      continue;
    }
    if (arg === "--yolo") {
      out.yolo = true;
      continue;
    }
    if (arg === "--compact") {
      out.compact = true;
      out.tui = true; // compaction 是 TUI 特性。
      continue;
    }
    if (arg === "--resume") {
      out.resume = requireValue(argv, ++i, "--resume");
      out.tui = true; // resume 是 TUI 崩溃续跑特性,隐含进 TUI。
      continue;
    }
    if (arg === "--disable") {
      out.disabledTools = parseDisabledTools(requireValue(argv, ++i, "--disable"));
      continue;
    }
    if (arg === "--log-dir") {
      out.logDir = requireValue(argv, ++i, "--log-dir");
      continue;
    }
    if (arg === "--no-log") {
      out.noLog = true;
      continue;
    }
    if (arg === "--log-args") {
      out.logArgs = parseLogArgs(requireValue(argv, ++i, "--log-args"));
      continue;
    }
    if (arg === "--metrics-file") {
      out.metricsFile = requireValue(argv, ++i, "--metrics-file");
      continue;
    }
    if (arg?.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (arg !== undefined) task.push(arg);
  }

  if (task.length > 0) out.task = task.join(" ");
  return out;
}

export function parseDisabledTools(value: string): ToolName[] {
  const allowed = new Set<string>(toolNames);
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      if (!allowed.has(part)) {
        throw new Error(
          `Unknown tool "${part}". Known tools: ${toolNames.join(", ")}`,
        );
      }
      return part as ToolName;
    });
}

export function parseLogArgs(value: string): "redacted" | "full" | "none" {
  if (value !== "redacted" && value !== "full" && value !== "none") {
    throw new Error(
      `Invalid --log-args "${value}". Expected one of: redacted, full, none.`,
    );
  }
  return value;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

async function runInteractive(
  agent: ReturnType<typeof createCodingAgent>,
): Promise<void> {
  const rl = createInterface({ input, output });
  try {
    while (true) {
      const prompt = (await rl.question("hpi> ")).trim();
      if (!prompt) continue;
      if (prompt === "exit" || prompt === "quit") break;
      const report = await runAgentPrompt(agent, prompt, {
        onEvent: printEvent,
      });
      printAnswer(report);
      console.log(renderRunReport(report));
    }
  } finally {
    rl.close();
  }
}

/** 打印模型的正文答案（headless 模式下 renderSessionEvent 不渲 llm-end 文本，否则用户看不到回答）。 */
function printAnswer(report: Awaited<ReturnType<typeof runAgentPrompt>>): void {
  const answer = assistantText(report.summary.lastMessage).trim();
  if (answer.length > 0) console.log(`\n${answer}\n`);
}

function printEvent(event: Parameters<typeof renderSessionEvent>[0]): void {
  const line = renderSessionEvent(event);
  if (line) console.log(line);
}

const NO_MODEL_MESSAGE = [
  "No model specified and no provider API key detected.",
  "  • Pass one:     hpi --model anthropic:claude-sonnet-4-0   (or qwen:qwen-plus)",
  "  • Or set a key:  export ANTHROPIC_API_KEY=...   then just run  hpi",
  "  • See options:   hpi --list-providers",
].join("\n");

/** Resolve the model spec from --model/HARNESS_PI_MODEL; if neither is set, auto-detect one from
 *  a present provider API key. Throws an actionable message when nothing can be resolved. */
function resolveModelSpecOrDetect(cliModel: string | undefined): string {
  try {
    return resolveModelSpec(cliModel);
  } catch (err) {
    // Only the "missing model" case should fall back to auto-detection; rethrow anything else.
    if (err instanceof Error && !/Missing model/.test(err.message)) throw err;
    const detected = detectDefaultModel();
    if (!detected) throw new Error(NO_MODEL_MESSAGE);
    console.warn(
      `No --model given; using ${detected.spec} (${detected.envVar} detected). Override with --model or HARNESS_PI_MODEL.`,
    );
    return detected.spec;
  }
}

/** Turn pi-ai's generic "Missing API credentials" into an actionable message naming the exact
 *  env var to set. Other errors pass through unchanged. Preserves the original via `cause`. */
function augmentKeyError(err: unknown, spec: string): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  if (!/Missing API credentials for provider/.test(e.message)) return e;
  const idx = spec.indexOf(":");
  const provider = idx === -1 ? spec : spec.slice(0, idx);
  const envVar = envVarForProvider(provider);
  const how = envVar
    ? `Set ${envVar} (e.g. export ${envVar}=sk-...).`
    : "Set the provider's API key environment variable.";
  return new Error(
    `Missing API key for provider "${provider}". ${how} Run \`hpi --list-providers\` to see options.`,
    { cause: e },
  );
}

/** Read this package's version from package.json next to dist/ (works in dist and via tsx). */
function readVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function printHelp(): void {
  console.log(`hpi — @harness-pi/coding-agent

A usable coding agent on the harness-pi kernel: streaming TUI, tool approval,
crash-resume, context compaction, and parallel read-only sub-agents.

Usage:
  hpi                           Launch the interactive TUI (default on a terminal).
  hpi "fix the failing test"    One-shot: run a single task headless, print the answer.
  hpi --model <provider:id>     Pick a model explicitly.

Setup — pick a provider and set its API key, then just run hpi:
  export ANTHROPIC_API_KEY=...        # Anthropic Claude
  export OPENAI_API_KEY=...           # OpenAI
  export DASHSCOPE_API_KEY=...        # Alibaba Qwen (use --model qwen:qwen-plus)
  hpi --list-providers                # all providers + which key you have set
  hpi --list-models anthropic         # model ids for a provider
With a key set, hpi auto-picks a default model; override with --model or HARNESS_PI_MODEL.

Options:
  --model <provider:id>    pi-ai model, e.g. anthropic:claude-sonnet-4-0, qwen:qwen-plus.
                            Or set HARNESS_PI_MODEL. Auto-detected from your API keys if omitted.
  --tui                    Force the interactive TUI (chat UI, streaming, approval, /commands).
  --repl                   Plain readline REPL instead of the TUI.
  --cwd <path>             Workspace directory. Defaults to the current directory.
  --read-only              Restrict tools to read/grep/find/ls (no edits, no bash).
  --resume <id>            Resume a saved TUI session (.harness-pi/sessions/<id>.jsonl).
  --yolo                   (TUI) skip tool-approval prompts — allow bash/write/edit unattended.
  --compact                (TUI) auto-summarize early messages when the conversation grows long.
  --disable <a,b>          Disable named first-party tools (read,bash,edit,write,grep,find,ls).
  --env-file <path>        Load env vars from a .env file (./.env is auto-loaded too).
  --log-dir <path>         Session log directory. Defaults to .harness-pi/logs.
  --no-log                 Disable the session log entirely.
  --log-args <mode>        Tool-arg logging: redacted (default) | full | none.
  --metrics-file <path>    Write run metrics as NDJSON.
  --list-providers         List supported providers and their API-key env vars.
  --list-models <provider> List model ids for a provider.
  --version                Print the version.
  --help                   Show this help.
`);
}

/**
 * True when this module is the process entry point. Compares the *real* paths of both sides so
 * the npm `bin` symlink (node_modules/.bin/hpi → dist/cli.js) is recognized — a plain
 * `import.meta.url === pathToFileURL(argv[1])` check fails through a symlink (Node resolves the
 * module URL to the real file while argv[1] stays the symlink), which would make `hpi` a no-op.
 */
export function isMainModule(metaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
