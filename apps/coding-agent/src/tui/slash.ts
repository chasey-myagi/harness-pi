/**
 * 斜杠命令解析（纯逻辑，P4）。提交框里以 `/` 开头的输入先经此路由，不走普通 run/steer 流程。
 * 刻意保持极小，只认 P4 需要的 /compact 和 /help；P5 命令面板会在此基础上扩展。
 */

export type SlashCommand =
  | { kind: "compact" }
  | { kind: "help" }
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
    default:
      return { kind: "unknown", name };
  }
}

/** /help 的命令清单文本。 */
export const SLASH_HELP = [
  "/compact  — turn on compaction for this session (summarize earlier messages; history kept)",
  "/help     — show this help",
].join("\n");
