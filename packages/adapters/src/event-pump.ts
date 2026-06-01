/**
 * EventPump —— Event Bus → transport 适配器（docs/09 §4.6，#13）。
 *
 * 把内核两条事件轨 pump 到一个注入的 transport sink：
 *   - **live 轨**（回合进行中的 token/thinking/toolcall delta，经 `session.on(type, cb)`）；
 *   - **recorded 轨**（粗粒度生命周期 SessionEvent，经 `session.runStreaming()` 的 AsyncIterable）。
 *
 * **纯 transport、domain-free、零 ws 依赖**：每条事件包成 `TransportEnvelope`（sessionId + 可选 tag +
 * track + 单调 seq + event）交给注入的 `sink.send`。调用方把 `send` 接到 WebSocket/SSE/JSONL/任意通道
 * （如 `ws.send(JSON.stringify(env))`）。借 codex「stdout JSONL 让任意 transport 消费」的解耦思路。
 *
 * tag 是 **domain 中性**的 per-work-item 标签（bidding 填 questionId）；seq 单调、pump 实例级，给一条 WS
 * 连接里区分多 session / 排序用。
 */

import type { AgentSession, LiveEvent, SessionEvent } from "@harness-pi/core";

export interface TransportEnvelope {
  sessionId: string;
  /** per-work-item 标签（domain 中性）；不设则省略。 */
  tag?: string;
  track: "live" | "recorded";
  /**
   * pump 实例级单调序号（一个 pump 只裹一个 session，故是**单 session 内**跨两轨统一递增的序号；
   * 多 session = 多 pump = 各自独立 seq 空间，不能拿 seq 做跨 session 全局排序）。
   * 每个被 pump 看到的事件占一个 seq——若 `sink.send` 失败被隔离（见 onError），那条 envelope 仍占了
   * 它的 seq，消费端看到 **seq 跳号即知丢了一条**。注意 seq 只保证单调，**不保证跨轨因果序**（live 经
   * `_emitLive` 同步发、recorded 经 runStreaming 的 async queue 有 microtask 延迟）。
   */
  seq: number;
  event: LiveEvent | SessionEvent;
}

export interface TransportSink {
  send(envelope: TransportEnvelope): void;
}

export interface EventPumpOptions {
  sink: TransportSink;
  /** per-work-item 标签（domain 中性）。 */
  tag?: string;
  /** 转发哪些 live 事件类型；默认全部。`[]` = 显式订阅空集（转发 0 条 live）。 */
  liveTypes?: ReadonlyArray<LiveEvent["type"]>;
  /**
   * `sink.send` 抛错时的回调（WS 断开 / ws.send throw / JSON 循环引用是 transport 头号失败模式）。
   * pump 把 send 失败**隔离**——绝不让它杀 agent loop 或调用方的 for-await（两条轨语义一致）。
   * 失败的 envelope 已占 seq（消费端凭 seq 跳号检测丢失）。不给则静默丢弃。
   */
  onError?: (err: unknown, envelope: TransportEnvelope) => void;
}

const ALL_LIVE = [
  "message_start",
  "text_delta",
  "thinking_delta",
  "toolcall_delta",
  "message_end",
] as const satisfies ReadonlyArray<LiveEvent["type"]>;

// 编译期穷尽性守卫：core 若新增 LiveEvent arm 而这里漏列，下面这行会报错（提醒同步 ALL_LIVE）。
true satisfies LiveEvent["type"] extends (typeof ALL_LIVE)[number] ? true : false;

export class EventPump {
  private _seq = 0;

  constructor(
    private readonly session: AgentSession,
    private readonly opts: EventPumpOptions,
  ) {}

  private _forward(track: "live" | "recorded", event: LiveEvent | SessionEvent): void {
    const envelope: TransportEnvelope = {
      sessionId: this.session.id,
      track,
      seq: this._seq++, // 每个事件占一个 seq（失败也占 → 消费端凭跳号检测丢失）
      event,
    };
    if (this.opts.tag !== undefined) envelope.tag = this.opts.tag;
    try {
      this.opts.sink.send(envelope);
    } catch (err) {
      // transport 失败隔离：flaky sink 绝不杀 agent loop（live 轨）或调用方 for-await（recorded 轨）。
      this.opts.onError?.(err, envelope);
    }
  }

  /**
   * 订阅 live 轨，把 delta 事件转发给 sink。返回退订函数。**run/runStreaming 之前调**
   * （on 可在 run 进行中或之前注册，但要捕全须先订阅）。
   */
  attachLive(): () => void {
    const types = this.opts.liveTypes ?? ALL_LIVE;
    const unsubs = types.map((t) =>
      this.session.on(t, (e) => this._forward("live", e)),
    );
    return () => {
      for (const u of unsubs) u();
    };
  }

  /**
   * 转发一条 recorded SessionEvent（调用方在自己的 runStreaming 循环里调）。
   * 与 `pumpRecorded` **二选一**——同一个流别既 pumpRecorded 又在循环里 forwardRecorded，会 double-send。
   */
  forwardRecorded(event: SessionEvent): void {
    this._forward("recorded", event);
  }

  /**
   * 便利：消费 `runStreaming()` 的流，转发每条 recorded 事件并**原样 re-yield**（tee）——
   * 调用方仍可继续 for-await 拿到事件，pump 顺带转发。finalSummary 仍在原 stream 对象上取。
   * 与 `forwardRecorded` **二选一**（见上）。
   */
  async *pumpRecorded(
    stream: AsyncIterable<SessionEvent>,
  ): AsyncIterable<SessionEvent> {
    for await (const event of stream) {
      this.forwardRecorded(event);
      yield event;
    }
  }
}
