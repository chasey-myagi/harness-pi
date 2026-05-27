/**
 * HookContextImpl —— HookContext 接口的具体实现。
 *
 * 整个 session 共享一个 instance。Kernel 通过 [KERNEL_INTERNALS] symbol-keyed bag 在
 * turn 切换 / run/continue 重入时更新运行时字段；symbol 不从 `index.ts` 导出，所以
 * plugin 拿到 ctx 也调不到 internal mutator。
 *
 * 设计要点：
 *   - state 物理上是 Map<string, unknown>；外部以 TypedStateMap 视图暴露
 *     （key 注册过的自动类型推断，未注册退回 unknown）。
 *   - log 是 HookLogger 接口；session 构造时可注入自定义 sink，默认走 console。
 *   - config 是 SessionConfigView 只读视图，由 session 构造时一次性 build；turn 内不变。
 */

import type { Message } from "@mariozechner/pi-ai";
import type {
  HookContext,
  HookLogger,
  LogLevel,
  SessionConfigView,
  TypedStateMap,
} from "./hook.js";

/**
 * Kernel-internal mutator bag。Plugin 拿不到这个 symbol，所以也调不到下面的方法。
 * 只在 `@harness-pi/core` 内部 import 这个 symbol。
 */
export const KERNEL_INTERNALS = Symbol("@harness-pi/core::kernel-internals");

export interface HookContextInternal {
  setTurnIdx(idx: number): void;
  setSignal(signal: AbortSignal): void;
}

export interface HookContextDeps {
  sessionId: string;
  initialSignal: AbortSignal;
  /** kernel 提供的 messages 引用（同一个数组）。 */
  messages: ReadonlyArray<Message>;
  /** kernel 提供的 config 视图（构造期一次性 build；turn 内不变）。 */
  config: SessionConfigView;
  /** structured log sink；undefined 用默认 console sink。 */
  logSink?: (
    level: LogLevel,
    msg: string,
    fields: Record<string, unknown>,
  ) => void;
  onAppendMessage: (msg: Message) => void;
  /** abort 回调到 kernel；kernel 决定如何 propagate（典型：abort internal AbortController）。 */
  onAbort: (reason: string) => void;
  /** emit 回调（可选；默认 noop）。 */
  onEmit?: (event: { type: string; [k: string]: unknown }) => void;
}

/**
 * 默认 log sink：`console.<level>` 加结构化前缀，行尾 JSON 化 fields。
 * 不做 sampling / level 过滤 —— 那是 sink 替换者的事。
 */
function defaultLogSink(
  level: LogLevel,
  msg: string,
  fields: Record<string, unknown>,
): void {
  const fieldsStr = Object.keys(fields).length === 0 ? "" : ` ${JSON.stringify(fields)}`;
  const line = `[harness-pi ${fields["sessionId"] ?? "?"} turn=${fields["turnIdx"] ?? "?"}] ${msg}${fieldsStr}`;
  // eslint-disable-next-line no-console
  const fn =
    level === "error" ? console.error :
    level === "warn" ? console.warn :
    level === "debug" ? console.debug :
    console.log;
  fn(line);
}

export class HookContextImpl implements HookContext {
  readonly sessionId: string;
  readonly config: SessionConfigView;
  readonly state: TypedStateMap;
  readonly log: HookLogger;

  private _turnIdx = 0;
  private _signal: AbortSignal;
  private readonly deps: HookContextDeps;
  private readonly _stateMap = new Map<string, unknown>();

  constructor(deps: HookContextDeps) {
    this.deps = deps;
    this.sessionId = deps.sessionId;
    this._signal = deps.initialSignal;
    this.config = deps.config;

    // TypedStateMap 是 Map 的薄壳：物理仍是 Map<string, unknown>，
    // 重载签名在类型层给已注册 key 推断；运行时跟原来一致。
    const m = this._stateMap;
    this.state = {
      get: (key: string) => m.get(key),
      set: (key: string, value: unknown) => {
        m.set(key, value);
      },
      has: (key: string) => m.has(key),
      delete: (key: string) => m.delete(key),
      clear: () => {
        m.clear();
      },
      get size() {
        return m.size;
      },
    } as TypedStateMap;

    const sink = deps.logSink ?? defaultLogSink;
    const buildFields = (extra?: Record<string, unknown>): Record<string, unknown> => ({
      sessionId: this.sessionId,
      turnIdx: this._turnIdx,
      ...(extra ?? {}),
    });
    this.log = {
      debug: (msg, fields) => sink("debug", msg, buildFields(fields)),
      info: (msg, fields) => sink("info", msg, buildFields(fields)),
      warn: (msg, fields) => sink("warn", msg, buildFields(fields)),
      error: (msg, fields) => sink("error", msg, buildFields(fields)),
    };
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

  /**
   * Symbol-keyed internal API。Plugin 拿不到 KERNEL_INTERNALS 这个 symbol（它没从
   * `index.ts` 导出），所以也调不到里面的方法。`session.ts` 通过 `ctx[KERNEL_INTERNALS]`
   * 访问。
   */
  [KERNEL_INTERNALS]: HookContextInternal = {
    setTurnIdx: (idx: number): void => {
      this._turnIdx = idx;
    },
    setSignal: (signal: AbortSignal): void => {
      this._signal = signal;
    },
  };
}
