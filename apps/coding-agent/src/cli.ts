#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
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
  metricsFile?: string | undefined;
  task?: string | undefined;
  tui: boolean;
  yolo: boolean;
  compact: boolean;
  resume?: string | undefined;
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

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return;
  }

  const runtime = resolveModelRuntime(resolveModelSpec(args.model));
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
      console.log(renderRunReport(report));
      return;
    }

    if (args.tui) {
      const app = createTuiApp({ agent, terminal: new ProcessTerminal() });
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
    yolo: false,
    compact: false,
    help: false,
  };
  const task: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      out.help = true;
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
      const prompt = (await rl.question("harness-pi> ")).trim();
      if (!prompt) continue;
      if (prompt === "exit" || prompt === "quit") break;
      const report = await runAgentPrompt(agent, prompt, {
        onEvent: printEvent,
      });
      console.log(renderRunReport(report));
    }
  } finally {
    rl.close();
  }
}

function printEvent(event: Parameters<typeof renderSessionEvent>[0]): void {
  const line = renderSessionEvent(event);
  if (line) console.log(line);
}

function printHelp(): void {
  console.log(`@harness-pi/coding-agent

Usage:
  pnpm --filter @harness-pi/coding-agent start -- --cwd . --model provider:model "task"
  pnpm --filter @harness-pi/coding-agent start -- --cwd . --model provider:model

Options:
  --cwd <path>             Workspace directory. Defaults to process cwd.
  --model <provider:id>    pi-ai model. Can also be HARNESS_PI_MODEL.
                            DashScope aliases: dashscope:qwen-plus, qwen:qwen-plus.
  --read-only              Use read/grep/find/ls only.
  --tui                    Launch the pi-tui interactive TUI (chat UI, streaming).
                            Persists to .harness-pi/sessions/<id>.jsonl for crash recovery.
  --resume <id>            Resume a saved session by id. Launches the TUI unless a
                            one-shot task is also given (then it continues that session headless).
  --yolo                   (TUI) skip tool approval prompts — allow bash/write/edit without asking.
  --compact                (TUI) auto-summarize early messages once the conversation grows long.
                            Without it, /compact in the TUI triggers summarization manually.
  --disable <a,b>          Disable named first-party tools.
  --log-dir <path>         Session log dir. Defaults to .harness-pi/logs.
  --metrics-file <path>    Write metrics NDJSON.
  --help                   Show this help.
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
