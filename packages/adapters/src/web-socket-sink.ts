/**
 * WebSocketSink —— 把 EventPump 的 `TransportSink` 接到一个 WebSocket（docs/09 §4.6，#13 的收尾）。
 *
 * EventPump 是 sink 注入式、domain-free 的；它的文档示例就是 `ws.send(JSON.stringify(env))`。这个适配器
 * 把那一行升级成一个能用的 sink，多做两件「一行版」做不到的事：
 *   1. **serialize 可注入**：默认 `JSON.stringify`；注入它把 envelope 映射成前端/自定义线协议。
 *   2. **readyState 感知**：socket 不在 OPEN 时**不 send**（浏览器 WebSocket 在 CLOSING/CLOSED 上 send 会抛
 *      `InvalidStateError`），改为干净丢弃 + 可选 `onDrop` 报一声——断线后不会每条都炸。
 *
 * **零 ws 依赖**：只结构化要求 `{ readyState: number; send(data: string): void }`，浏览器原生 `WebSocket`
 * 与 node `ws` 包的 `WebSocket` 都天生满足（readyState 取值是标准的 0/1/2/3）。**domain-free**：envelope→
 * 前端协议的映射由调用方经 `serialize` 注入，本适配器不掺任何业务。
 *
 * **失败分层**：socket 没开 = 预期内的事，这里静默丢（+onDrop）。`serialize` 抛错 / OPEN 状态下 `send` 仍
 * 抛错 = 意外，**原样向上抛**，交给 EventPump 的 `onError` 隔离（pump 绝不让 sink 抛错杀掉 agent loop 或
 * 调用方的 for-await）。两层各管各的，不重复兜底。注意：`onDrop` / `serialize` 这两个调用方回调**自身**若
 * 抛错也会一并上抛、被当作 onError 路径——请让它们保持轻量、别在里面抛。
 */

import type { TransportEnvelope, TransportSink } from "./event-pump.js";

/** 浏览器 `WebSocket` 与 node `ws` 包都满足的最小结构。`readyState`：0 CONNECTING/1 OPEN/2 CLOSING/3 CLOSED。 */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
}

export interface WebSocketSinkOptions {
  /** envelope → 线字符串。默认 `JSON.stringify`；注入它来映射成前端/自定义协议。 */
  serialize?: (envelope: TransportEnvelope) => string;
  /** socket 非 OPEN 时丢弃了一条 envelope 的回调（观测丢失用）。不给则静默丢。 */
  onDrop?: (envelope: TransportEnvelope) => void;
}

/** WebSocket.OPEN。 */
const WS_OPEN = 1;

export class WebSocketSink implements TransportSink {
  constructor(
    private readonly socket: WebSocketLike,
    private readonly opts: WebSocketSinkOptions = {},
  ) {}

  send(envelope: TransportEnvelope): void {
    // readyState 每次现读：socket 可能在两条 envelope 之间断开。
    if (this.socket.readyState !== WS_OPEN) {
      this.opts.onDrop?.(envelope);
      return;
    }
    const serialize = this.opts.serialize ?? defaultSerialize;
    // serialize / send 抛错（循环引用、OPEN 状态下 socket 仍报错）原样上抛 → EventPump.onError 隔离。
    this.socket.send(serialize(envelope));
  }
}

function defaultSerialize(envelope: TransportEnvelope): string {
  return JSON.stringify(envelope);
}
