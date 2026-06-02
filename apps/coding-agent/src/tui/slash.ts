/**
 * 斜杠命令解析（纯逻辑，P4）。提交框里以 `/` 开头的输入先经此路由，不走普通 run/steer 流程。
 * 刻意保持极小，只认 P4 需要的 /compact 和 /help；P5 命令面板会在此基础上扩展。
 */

export type SlashCommand =
  | { kind: "compact" }
  | { kind: "help" }
  | { kind: "multi"; rest: string }
  | { kind: "exit" }
  | { kind: "unknown"; name: string };

/** 解析一条斜杠命令；非斜杠输入（不以 `/` 开头）返回 null —— 交回普通 submit 流程。 */
export function parseSlashCommand(text: string): SlashCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const name = (trimmed.slice(1).split(/\s+/)[0] ?? "").toLowerCase();
  switch (name) {
    case "compact":
      return { kind: "compact" };
    case "help":
      return { kind: "help" };
    case "multi":
      // 余下的整串（指令 + @文件）交给 parseMultiCommand 进一步解析。
      return { kind: "multi", rest: trimmed.slice(1 + name.length).trim() };
    case "exit":
    case "quit":
      return { kind: "exit" };
    default:
      return { kind: "unknown", name };
  }
}

/**
 * 命令元数据（单一事实源）：既喂给 pi-tui Editor 的 autocomplete provider 做 `/` 实时补全，
 * 又拼出 /help 文本。形状是 pi-tui `SlashCommand` 的结构子集（{name, description}），可直接传入。
 */
export const SLASH_COMMANDS: ReadonlyArray<{
  name: string;
  description: string;
  argumentHint?: string;
}> = [
  { name: "compact", description: "turn on compaction for this session (summarize earlier messages; history kept)" },
  {
    name: "multi",
    description: "analyze several @files in parallel — read-only sub-agents, cannot edit",
    argumentHint: "<question/analysis> @file @file …",
  },
  { name: "help", description: "show available commands" },
  { name: "exit", description: "quit the TUI (or press Ctrl-C)" },
];

/** /help 的命令清单文本（从 SLASH_COMMANDS 派生，避免两处漂移）。 */
export const SLASH_HELP = SLASH_COMMANDS.map(
  (c) => `/${c.name.padEnd(8)} — ${c.description}`,
).join("\n");
