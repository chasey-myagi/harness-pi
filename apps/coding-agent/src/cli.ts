#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { pathToFileURL } from "node:url";
import {
  createCodingAgent,
  resolveModelRuntime,
  resolveModelSpec,
  runAgentPrompt,
} from "./agent.js";
import { renderRunReport, renderSessionEvent } from "./output.js";
import { toolNames, type ToolName } from "@harness-pi/tools";
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
  help: boolean;
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
  const agent = createCodingAgent(createOptions);

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
