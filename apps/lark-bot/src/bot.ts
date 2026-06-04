/**
 * bot 主循环（supervisor）：
 * - 带退避地常驻 `event consume`（子进程退出就重启 = lifecycle-restart）
 * - 按 event_id 去重（飞书会重投）
 * - 按 chat 串行处理（同 chat 不并发，跨 chat 可并行）
 * - 每个 chat 缓存一条 AgentSession（多轮记忆），LRU 控内存
 * - agent 最终文本 → im +messages-reply 回到原对话
 */

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentSession, Api, Model } from "@harness-pi/core";
import { NdjsonFileSink } from "@harness-pi/plugins";
import { createBotSession, resolveModel, type Observability } from "./agent.js";
import { createLarkTools } from "./tools.js";
import { consumeEvents, replyMessage, type LarkMessageEvent } from "./lark.js";
import { MemoryStore } from "./memory.js";
import type { BotConfig } from "./config.js";

/** 从 assistant 消息里抽纯文本（用于当作飞书回复）。 */
function extractText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter(
        (b): b is { type: "text"; text: string } =>
          !!b &&
          typeof b === "object" &&
          (b as { type?: unknown }).type === "text" &&
          typeof (b as { text?: unknown }).text === "string",
      )
      .map((b) => b.text)
      .join("\n")
      .trim();
  }
  return "";
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export class LarkBot {
  private readonly cfg: BotConfig;
  private readonly model: Model<Api>;
  private readonly tools: ReturnType<typeof createLarkTools>;
  /** 自生长记忆（全局共享，跨所有 chat / 会话）。 */
  private readonly memory: MemoryStore;
  /** 观测/评测落点（cfg.telemetry 关时为 undefined）。 */
  private readonly obs: Observability | undefined;

  private readonly sessions = new Map<string, AgentSession>();
  private readonly chatLru: string[] = [];
  /** 每个 chat 一条 promise 链，保证同 chat 串行。 */
  private readonly chains = new Map<string, Promise<void>>();

  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];

  constructor(cfg: BotConfig) {
    this.cfg = cfg;
    // 可能 throw（缺 key / 未知 model）——交给 index.ts 的顶层捕获，fail fast。
    this.model = resolveModel(cfg.modelSpec);
    this.memory = new MemoryStore(resolve(cfg.memoryFile));
    this.tools = createLarkTools(cfg, this.memory);

    if (cfg.telemetry) {
      const dataDir = resolve(cfg.dataDir);
      const logDir = join(dataDir, "sessions");
      mkdirSync(logDir, { recursive: true });
      this.obs = {
        logDir,
        metricsSink: new NdjsonFileSink({ path: join(dataDir, "metrics.ndjson"), batchSize: 1 }),
      };
    } else {
      this.obs = undefined;
    }
  }

  private log(msg: string): void {
    console.error(`[lark-bot ${new Date().toISOString()}] ${msg}`);
  }

  async start(signal: AbortSignal): Promise<void> {
    this.log(
      `starting — model=${this.cfg.modelSpec} event=${this.cfg.eventKey} identity=${this.cfg.identity} toolIdentity=${this.cfg.toolIdentity} groups=${this.cfg.respondInGroups} owner=${this.cfg.ownerOpenId ?? "(any)"}`,
    );
    if (this.obs) this.log(`telemetry → ${this.obs.logDir} (sessions) + metrics.ndjson`);
    const mem = this.memory.load();
    this.log(`memory ← ${this.memory.path} (${mem.length} chars sedimented)`);
    let backoff = 1000;
    while (!signal.aborted) {
      try {
        await consumeEvents(
          this.cfg,
          {
            onEvent: (ev) => this.enqueue(ev),
            onLog: (m) => this.log(m),
          },
          signal,
        );
        if (signal.aborted) break;
        this.log("event consume exited; restarting…");
        backoff = 1000; // 干净退出，退避归零
      } catch (err) {
        this.log(`event consume failed: ${(err as Error).message}; retrying in ${backoff}ms`);
      }
      if (signal.aborted) break;
      await delay(backoff, signal);
      backoff = Math.min(backoff * 2, 30_000);
    }
    this.log("stopped");
  }

  private enqueue(ev: LarkMessageEvent): void {
    const dedupId = ev.event_id ?? ev.message_id ?? ev.id;
    if (dedupId) {
      if (this.seen.has(dedupId)) return;
      this.remember(dedupId);
    }
    const chatId = ev.chat_id ?? "(unknown)";
    const prev = this.chains.get(chatId) ?? Promise.resolve();
    const next = prev
      .then(() => this.handle(ev))
      .catch((err) => this.log(`handle error: ${(err as Error).message}`));
    this.chains.set(chatId, next);
  }

  private async handle(ev: LarkMessageEvent): Promise<void> {
    // 锁定主人：toolIdentity=user 时 bot 会以主人身份操作其私有数据，必须确认发件人就是主人，
    // 否则任何人 DM 都能借 bot 之手读/动主人的东西。ownerOpenId 留空 = 不限制（仅自用可空）。
    if (this.cfg.ownerOpenId && ev.sender_id && ev.sender_id !== this.cfg.ownerOpenId) {
      this.log(`ignored message from non-owner ${ev.sender_id}`);
      return;
    }
    if (!this.cfg.respondInGroups && ev.chat_type === "group") return;

    const messageId = ev.message_id ?? ev.id;
    const chatId = ev.chat_id;
    const content = (ev.content ?? "").trim();
    if (!messageId || !chatId || content.length === 0) return;

    const mt = ev.message_type ?? "text";
    if (mt !== "text" && mt !== "post") {
      await replyMessage(this.cfg, messageId, `暂时只支持文本消息（收到 ${mt}）。`, {
        ...(ev.event_id ? { idempotencyKey: ev.event_id } : {}),
      });
      return;
    }

    this.log(`← [${chatId}] ${mt} ${content.length}ch: ${content.slice(0, 80)}`);

    const session = this.getSession(chatId);
    let reply: string;
    let turns = 0;
    try {
      const summary = await session.run(content);
      turns = summary.turns;
      reply = extractText(summary.lastMessage) || "（已处理）";
    } catch (err) {
      this.log(`agent run error for ${chatId}: ${(err as Error).message}`);
      reply = `处理出错了：${(err as Error).message}`;
    }

    const res = await replyMessage(this.cfg, messageId, reply, {
      ...(ev.event_id ? { idempotencyKey: ev.event_id } : {}),
    });
    this.log(
      `→ [${chatId}] replied ${reply.length}ch turns=${turns} ${res.ok ? "ok" : `FAIL: ${res.stderr || res.stdout}`}`,
    );
  }

  private getSession(chatId: string): AgentSession {
    const existing = this.sessions.get(chatId);
    if (existing) {
      this.touchLru(chatId);
      return existing;
    }
    const session = createBotSession(this.cfg, this.model, [...this.tools], this.memory, this.obs);
    this.sessions.set(chatId, session);
    this.chatLru.push(chatId);
    this.evictSessions(chatId);
    return session;
  }

  private touchLru(chatId: string): void {
    const i = this.chatLru.indexOf(chatId);
    if (i >= 0) this.chatLru.splice(i, 1);
    this.chatLru.push(chatId);
  }

  private evictSessions(keep: string): void {
    while (this.chatLru.length > this.cfg.maxSessions) {
      const victim = this.chatLru.shift();
      if (!victim || victim === keep) continue;
      this.sessions.delete(victim);
      this.chains.delete(victim);
    }
  }

  private remember(id: string): void {
    this.seen.add(id);
    this.seenOrder.push(id);
    while (this.seenOrder.length > this.cfg.dedupCapacity) {
      const old = this.seenOrder.shift();
      if (old) this.seen.delete(old);
    }
  }
}
