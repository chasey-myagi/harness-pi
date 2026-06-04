/**
 * lark-cli 进出封装：
 * - runLarkCli：一次性命令（execFile，参数数组，无 shell 注入面）
 * - replyMessage / sendMessage：回复 / 主动发
 * - consumeEvents：spawn `event consume`，把 stdout 的 NDJSON 逐行解析成事件
 *
 * 全部通过 lark-cli，不直接依赖飞书 SDK——契合「lark-cli 全家桶」路线，服务器上只需
 * 一个 lark-cli + 已配好的 bot 凭证。
 */

import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { BotConfig } from "./config.js";

const execFileAsync = promisify(execFile);

/** im.message.receive_v1 的事件载荷（字段对齐 `lark-cli event schema`）。全 optional——
 *  消费端按存在性判定，容忍 lark-cli 输出形态的细微差异。 */
export interface LarkMessageEvent {
  type?: string;
  event_id?: string;
  message_id?: string;
  /** message_id 的 legacy 别名。 */
  id?: string;
  chat_id?: string;
  chat_type?: string; // "p2p" | "group"
  /** 大多数类型已是渲染好的纯文本；interactive(卡片) 才是原始 JSON 串。 */
  content?: string;
  message_type?: string;
  sender_id?: string;
  create_time?: string;
  timestamp?: string;
}

export interface LarkCliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** 跑一条 lark-cli 命令。永不 throw（除非 spawn 本身失败如 ENOENT）；非零退出以 ok:false 返回，
 *  把 stdout/stderr 都带回，方便调用方（工具）让 LLM 自纠。 */
export async function runLarkCli(
  cfg: BotConfig,
  args: string[],
  opts: RunOptions = {},
): Promise<LarkCliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cfg.larkCliBin, args, {
      timeout: opts.timeoutMs ?? cfg.toolTimeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return { ok: true, stdout: stdout.toString(), stderr: stderr.toString(), code: 0 };
  } catch (err) {
    const e = err as { stdout?: string | Buffer; stderr?: string | Buffer; code?: number | string; message?: string };
    return {
      ok: false,
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? e.message ?? String(err),
      code: typeof e.code === "number" ? e.code : null,
    };
  }
}

export interface SendOptions {
  markdown?: boolean;
  idempotencyKey?: string;
}

/** 回复某条消息（线程外，回到主对话）。 */
export function replyMessage(
  cfg: BotConfig,
  messageId: string,
  text: string,
  opts: SendOptions = {},
): Promise<LarkCliResult> {
  const args = ["im", "+messages-reply", "--as", cfg.identity, "--message-id", messageId];
  args.push(opts.markdown ? "--markdown" : "--text", text);
  if (opts.idempotencyKey) args.push("--idempotency-key", opts.idempotencyKey);
  return runLarkCli(cfg, args);
}

/** 主动发消息到 chat(oc_) 或 user(ou_)。 */
export function sendMessage(
  cfg: BotConfig,
  target: { chatId?: string; userId?: string },
  text: string,
  opts: SendOptions = {},
): Promise<LarkCliResult> {
  const args = ["im", "+messages-send", "--as", cfg.identity];
  if (target.userId) args.push("--user-id", target.userId);
  else if (target.chatId) args.push("--chat-id", target.chatId);
  args.push(opts.markdown ? "--markdown" : "--text", text);
  if (opts.idempotencyKey) args.push("--idempotency-key", opts.idempotencyKey);
  return runLarkCli(cfg, args);
}

/** NDJSON 行可能是事件对象本身，也可能裹在 event/data/payload 下——逐层探测，取第一个含消息字段的。 */
function extractEvent(raw: unknown): LarkMessageEvent | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const nested = [obj.event, obj.data, obj.payload].filter(
    (c): c is Record<string, unknown> => !!c && typeof c === "object",
  );
  for (const c of [obj, ...nested]) {
    if (
      typeof c.message_id === "string" ||
      typeof c.chat_id === "string" ||
      typeof c.content === "string"
    ) {
      return c as LarkMessageEvent;
    }
  }
  return undefined;
}

export interface ConsumeHandlers {
  onEvent: (ev: LarkMessageEvent) => void;
  onLog?: (msg: string) => void;
}

/**
 * spawn `lark-cli event consume <key>` 并把 stdout 的 NDJSON 逐行喂给 onEvent。
 * Promise 在子进程退出时 resolve（正常退出/超时）——交给上层做带退避的重启（lifecycle）。
 * 子进程 spawn 失败（如 ENOENT）reject。signal abort 时 SIGTERM 子进程。
 */
export function consumeEvents(
  cfg: BotConfig,
  handlers: ConsumeHandlers,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // stdin 必须是常开的 pipe：`event consume` 把 stdin EOF 当关闭信号（专为 AI 子进程设计）。
    // 用 "ignore"(=/dev/null) 会立刻 EOF 导致一连上就退出；"pipe" 让父进程持住写端，
    // 子进程的 stdin 一直开着，长连接得以常驻。关停走 SIGTERM（onAbort）。
    const child = spawn(cfg.larkCliBin, ["event", "consume", cfg.eventKey, "--as", cfg.identity], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    // 子进程退出时父持的写端会 EPIPE；吞掉，避免 unhandled 'error'。
    child.stdin?.on("error", () => {});
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });

    if (child.stdout) {
      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (trimmed.length === 0) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          handlers.onLog?.(`[consume:non-json] ${trimmed.slice(0, 200)}`);
          return;
        }
        const ev = extractEvent(parsed);
        if (ev) handlers.onEvent(ev);
      });
    }
    if (child.stderr) {
      const erl = createInterface({ input: child.stderr });
      erl.on("line", (line) => handlers.onLog?.(`[consume:stderr] ${line}`));
    }

    child.on("error", (err) => finish(() => reject(err)));
    child.on("close", () => finish(() => resolve()));
  });
}
