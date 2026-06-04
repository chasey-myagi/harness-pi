/**
 * HookContextImpl —— HookContext 接口的具体实现。
 *
 * 整个 session 共享一个 instance。Kernel 通过 module-private WeakMap 持有
 * 每个 ctx 实例对应的 mutator bag——plugin 拿不到 WeakMap 引用，
 * 也不能通过 `Object.getOwnPropertySymbols(ctx)` 反射出来（早期 symbol 方案
 * 的逃逸路径，已废弃；详见 Gate 1 review M1）。
 *
 * 设计要点：
 *   - state 物理上是 Map<string, unknown>；外部以 TypedStateMap 视图暴露
 *     （key 注册过的自动类型推断，未注册退回 unknown）。
 *   - log 是 HookLogger 接口；session 构造时可注入自定义 sink，默认走 console。
 *   - config 是 SessionConfigView 只读视图，由 session 构造时一次性 deep-freeze；turn 内不变。
 */

import type { Message } from "@earendil-works/pi-ai";
import type {
  HookContext,
  HookLogger,
  LogLevel,
  SessionConfigView,
  StateValueFor,
  TypedStateMap,
} from "./hook.js";

export interface HookContextInternal {
  setTurnIdx(idx: number): void;
  setSignal(signal: AbortSignal): void;
}

/**
 * Kernel ↔ HookContextImpl 之间的 internal mutator 通道。Module-private WeakMap：
 *   - 外部从 `index.ts` 拿不到（不导出）
 *   - 不在 ctx 实例上留任何 own property / symbol → `Object.getOwnPropertySymbols` 反射不到
 *   - WeakMap 弱引用，ctx 被 GC 时自动清理
 *
 * 只允许 session.ts / 内部测试通过 `getKernelInternals(ctx)` 拿。
 */
const KERNEL_INTERNALS_BAG = new WeakMap<HookContextImpl, HookContextInternal>();

/**
 * 只能在 `@harness-pi/core` 内部用。Plugin 拿不到这个函数（不从 index 导出）。
 * Session 用 `getKernelInternals(ctx).setTurnIdx(idx)` 推进 turn。
 */
export function getKernelInternals(
  ctx: HookContextImpl,
): HookContextInternal {
  const bag = KERNEL_INTERNALS_BAG.get(ctx);
  if (!bag) throw new Error("HookContext internals missing — constructor invariant violated");
  return bag;
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
 *
 * 防御性 stringify：plugin 传循环引用时不让整个 turn crash。
 */
function safeStringifyFields(fields: Record<string, unknown>): string {
  if (Object.keys(fields).length === 0) return "";
  try {
    return ` ${JSON.stringify(fields)}`;
  } catch {
    // 退化为逐 key 字符串化，避免循环引用 / BigInt / Function 等 throw
    const parts: string[] = [];
    for (const [k, v] of Object.entries(fields)) {
      try {
        parts.push(`${k}=${JSON.stringify(v)}`);
      } catch {
        parts.push(`${k}=[unserializable]`);
      }
    }
    return ` { ${parts.join(", ")} }`;
  }
}

function defaultLogSink(
  level: LogLevel,
  msg: string,
  fields: Record<string, unknown>,
): void {
  const fieldsStr = safeStringifyFields(fields);
  const line = `[harness-pi ${fields["sessionId"] ?? "?"} turn=${fields["turnIdx"] ?? "?"}] ${msg}${fieldsStr}`;
  // eslint-disable-next-line no-console
  const fn =
    level === "error" ? console.error :
    level === "warn" ? console.warn :
    level === "debug" ? console.debug :
    console.log;
  fn(line);
}

/**
 * TypedStateMap 的薄壳实现。物理仍是 Map<string, unknown>，conditional type 让 caller
 * 在已注册 key 上拿到正确推断。命名 class 而不是 object literal，stack trace 友好。
 */
class StateMapImpl implements TypedStateMap {
  private readonly _m = new Map<string, unknown>();

  get<K extends string>(key: K): StateValueFor<K> | undefined {
    return this._m.get(key) as StateValueFor<K> | undefined;
  }
  set<K extends string>(key: K, value: StateValueFor<K>): void {
    this._m.set(key, value);
  }
  has<K extends string>(key: K): boolean {
    return this._m.has(key);
  }
  delete<K extends string>(key: K): boolean {
    return this._m.delete(key);
  }
  clear(): void {
    this._m.clear();
  }
  get size(): number {
    return this._m.size;
  }
}

export class HookContextImpl implements HookContext {
  readonly sessionId: string;
  readonly config: SessionConfigView;
  readonly state: TypedStateMap = new StateMapImpl();
  readonly log: HookLogger;

  private _turnIdx = 0;
  private _signal: AbortSignal;
  private readonly deps: HookContextDeps;

  constructor(deps: HookContextDeps) {
    this.deps = deps;
    this.sessionId = deps.sessionId;
    this._signal = deps.initialSignal;
    this.config = deps.config;

    const sink = deps.logSink ?? defaultLogSink;
    // 关键顺序：user `extra` 在前，kernel 注入的 sessionId/turnIdx 在后覆盖 user
    // —— 防 plugin 伪造 sessionId/turnIdx 污染下游 log 聚合。
    const buildFields = (extra?: Record<string, unknown>): Record<string, unknown> => ({
      ...(extra ?? {}),
      sessionId: this.sessionId,
      turnIdx: this._turnIdx,
    });
    this.log = Object.freeze({
      debug: (msg: string, fields?: Record<string, unknown>) =>
        sink("debug", msg, buildFields(fields)),
      info: (msg: string, fields?: Record<string, unknown>) =>
        sink("info", msg, buildFields(fields)),
      warn: (msg: string, fields?: Record<string, unknown>) =>
        sink("warn", msg, buildFields(fields)),
      error: (msg: string, fields?: Record<string, unknown>) =>
        sink("error", msg, buildFields(fields)),
    });

    // 把 internal mutator 装进 module-private WeakMap，不挂任何 own property 到 ctx 上。
    KERNEL_INTERNALS_BAG.set(this, {
      setTurnIdx: (idx: number) => {
        this._turnIdx = idx;
      },
      setSignal: (signal: AbortSignal) => {
        this._signal = signal;
      },
    });
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
}
