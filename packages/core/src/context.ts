/**
 * HookContextImpl —— HookContext 接口的具体实现。
 *
 * 整个 session 共享一个 instance。kernel 通过 _setTurnIdx / _setSignal 在 turn 切换
 * 或 run/continue 重入时更新运行时字段。appendMessage / abort 操作回调到 session。
 */

import type { Message } from "@mariozechner/pi-ai";
import type { HookContext } from "./hook.js";

export interface HookContextDeps {
  sessionId: string;
  initialSignal: AbortSignal;
  /** kernel 提供的 messages 引用（同一个数组）。 */
  messages: ReadonlyArray<Message>;
  onAppendMessage: (msg: Message) => void;
  /** abort 回调到 kernel；kernel 决定如何 propagate（典型：abort internal AbortController）。 */
  onAbort: (reason: string) => void;
  /** emit 回调（可选；默认 noop）。 */
  onEmit?: (event: { type: string; [k: string]: unknown }) => void;
}

export class HookContextImpl implements HookContext {
  readonly sessionId: string;
  readonly state = new Map<string, unknown>();

  private _turnIdx = 0;
  private _signal: AbortSignal;
  private readonly deps: HookContextDeps;

  constructor(deps: HookContextDeps) {
    this.deps = deps;
    this.sessionId = deps.sessionId;
    this._signal = deps.initialSignal;
  }

  get turnIdx(): number {
    return this._turnIdx;
  }

  get signal(): AbortSignal {
    return this._signal;
  }

  get messages(): ReadonlyArray<Message> {
    return this.deps.messages;
  }

  appendMessage(msg: Message): void {
    this.deps.onAppendMessage(msg);
  }

  abort(reason: string): void {
    this.deps.onAbort(reason);
  }

  emit(event: { type: string; [k: string]: unknown }): void {
    this.deps.onEmit?.(event);
  }

  /** kernel-internal: 推进 turnIdx。 */
  _setTurnIdx(idx: number): void {
    this._turnIdx = idx;
  }

  /** kernel-internal: 在 run() 重新绑定 signal（同 session 多次 run / continue）。 */
  _setSignal(signal: AbortSignal): void {
    this._signal = signal;
  }
}
