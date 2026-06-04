/**
 * 暴露给 agent 的工具：
 * - lark_cli：通用闸口，按家族白名单放行任意 lark-cli 命令（默认 user 身份），破坏性命令拦截。
 * - lark_send_message：主动发消息的强类型便捷封装。
 * - remember：把学到的东西沉淀进记忆（资源位置 / 有效命令 / 主人偏好），下次自动带回 prompt。
 *
 * 注意：回复「当前对话」不靠工具——bot 主循环把 agent 最终文本当回复发回。工具只用于
 * 额外动作（探查、发到别处、沉淀记忆……）。
 */

import { Type, type HarnessTool, type ToolExecResult } from "@harness-pi/core";
import { runLarkCli } from "./lark.js";
import type { BotConfig, Identity } from "./config.js";
import type { MemoryStore } from "./memory.js";

function asText(text: string): ToolExecResult {
  return { content: [{ type: "text", text }] };
}

function cap(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…[truncated ${text.length - limit} chars]`;
}

/** 把工具传入的 identity 收敛成合法身份；非法/缺省走 fallback。 */
function pickIdentity(raw: unknown, fallback: Identity): Identity {
  const v = String(raw ?? "").trim();
  return v === "bot" || v === "user" ? v : fallback;
}

export function createLarkTools(cfg: BotConfig, memory: MemoryStore): HarnessTool[] {
  const larkCli: HarnessTool = {
    name: "lark_cli",
    label: "lark-cli",
    description: [
      "Run a lark-cli (Feishu/Lark) command and return its output. Pass the full argument list AFTER `lark-cli` as a string array.",
      `Allowed command families (first arg): ${cfg.allowedFamilies.join(", ")}.`,
      "Two identities — pick via the `identity` field:",
      "  user (default) = act as the OWNER; use to READ the owner's own data (messages, docs, calendar, mail, tasks, …).",
      "  bot            = act as the assistant; use to send/operate as the bot itself.",
      "Examples:",
      '  owner\'s agenda:          args=["calendar","+agenda"] identity="user"',
      '  search owner\'s messages: args=["im","+messages-search","--query","面试"] identity="user"',
      '  send as the assistant:   args=["im","+messages-send","--chat-id","oc_x","--text","hi"] identity="bot"',
      '  learn a command:         args=["calendar","--help"]',
      "On failure lark-cli returns JSON with error.hint — read it and retry with corrected args.",
    ].join("\n"),
    parameters: Type.Object({
      args: Type.Array(Type.String(), {
        description: 'Argument list passed to lark-cli, e.g. ["im","+messages-search","--query","面试"]',
      }),
      identity: Type.Optional(
        Type.String({ description: 'lark-cli identity: "user" (owner data, default) or "bot"' }),
      ),
    }),
    async execute(input, _ctx, signal): Promise<ToolExecResult> {
      const args = Array.isArray(input.args) ? (input.args as unknown[]).map((a) => String(a)) : [];
      const family = args[0];
      if (!family) return asText("Error: empty args — provide at least a command family.");
      if (!cfg.allowedFamilies.includes(family)) {
        return asText(
          `Error: command family "${family}" is not allowed. Allowed: ${cfg.allowedFamilies.join(", ")}.`,
        );
      }
      if (!cfg.allowDestructive) {
        const joined = args.join(" ").toLowerCase();
        const hit = cfg.destructivePatterns.find((p) => joined.includes(p));
        if (hit) {
          return asText(
            `Error: blocked a potentially destructive command (matched "${hit}"). Ask the user to run it manually.`,
          );
        }
      }
      // 身份：调用方 identity 优先，否则 cfg.toolIdentity（默认 user）。已显式带 --as 则尊重原样。
      const identity = pickIdentity(input.identity, cfg.toolIdentity);
      const finalArgs = args.includes("--as") ? args : [...args, "--as", identity];
      const res = await runLarkCli(cfg, finalArgs, { timeoutMs: cfg.toolTimeoutMs, signal });
      const body = res.ok
        ? res.stdout.trim() || "(no output)"
        : `exit=${res.code ?? "n/a"}\nSTDOUT:\n${res.stdout}\nSTDERR:\n${res.stderr}`;
      return asText(cap(body, cfg.toolOutputCap));
    },
  };

  const sendMessage: HarnessTool = {
    name: "lark_send_message",
    label: "send message",
    description:
      "Proactively send a Feishu message to a chat (oc_…) or a user (ou_…). Use only to message somewhere OTHER than the current conversation — to reply here, just write your final answer. identity defaults to bot (send as the assistant); use user to send as the owner themselves.",
    parameters: Type.Object({
      target: Type.String({ description: "Destination: chat id oc_… or user open_id ou_…" }),
      text: Type.String({ description: "Message body" }),
      markdown: Type.Optional(
        Type.Boolean({ description: "Render as markdown/post instead of plain text" }),
      ),
      identity: Type.Optional(
        Type.String({ description: 'lark-cli identity: "bot" (default, as the assistant) or "user"' }),
      ),
    }),
    async execute(input, _ctx, signal): Promise<ToolExecResult> {
      const target = String(input.target ?? "").trim();
      const body = String(input.text ?? "");
      if (!target || body.length === 0) return asText("Error: both target and text are required.");
      const isUser = target.startsWith("ou_");
      const identity = pickIdentity(input.identity, cfg.identity);
      const args = [
        "im",
        "+messages-send",
        "--as",
        identity,
        isUser ? "--user-id" : "--chat-id",
        target,
        input.markdown ? "--markdown" : "--text",
        body,
      ];
      const res = await runLarkCli(cfg, args, { timeoutMs: cfg.toolTimeoutMs, signal });
      return asText(
        res.ok ? `Sent to ${target}.` : `Failed (exit=${res.code ?? "n/a"}): ${res.stderr || res.stdout}`,
      );
    },
  };

  const remember: HarnessTool = {
    name: "remember",
    label: "remember",
    description: [
      "Persist a durable note to your long-term memory. Your memory is injected into every future conversation, so this is how you get smarter over time.",
      "Record things worth reusing: WHERE the owner's data lives (e.g. an interview Base token + table id you discovered), command recipes that worked, the owner's preferences, and corrections the owner gave you.",
      "Write one concise, self-contained fact per call (include concrete ids/tokens so future-you can act on it directly). Don't record one-off chatter.",
    ].join("\n"),
    parameters: Type.Object({
      note: Type.String({ description: "The fact to remember — concise and self-contained, with concrete ids/commands." }),
      tags: Type.Optional(
        Type.Array(Type.String(), { description: 'Optional tags, e.g. ["resource","面试"] or ["preference"]' }),
      ),
    }),
    async execute(input): Promise<ToolExecResult> {
      const note = String(input.note ?? "").trim();
      if (note.length === 0) return asText("Error: note is required.");
      const tags = Array.isArray(input.tags) ? (input.tags as unknown[]).map((t) => String(t)) : [];
      const line = memory.append(note, tags);
      return asText(`Remembered: ${line}`);
    },
  };

  return [larkCli, sendMessage, remember];
}
