# 05 · Plugins

> Plugin 解剖、命名/状态约定、11 个标准库 plugin 的完整设计。

## 0. 目录

1. [Plugin 是什么](#1-plugin-是什么)
2. [Plugin 工厂模式](#2-plugin-工厂模式)
3. [`ctx.state` 约定](#3-ctxstate-约定)
4. [文件组织](#4-文件组织)
5. 标准库 12 个 plugin（每个独立小节）
   - [5.1 watchdog](#51-watchdog)
   - [5.2 trim-history](#52-trim-history)
   - [5.3 empty-run-guard](#53-empty-run-guard)
   - [5.4 tool-output-buffer](#54-tool-output-buffer)
   - [5.5 session-log](#55-session-log)
   - [5.6 system-reminder](#56-system-reminder)
   - [5.7 batch-counter](#57-batch-counter)
   - [5.8 lease-decision](#58-lease-decision)
   - [5.9 metrics](#59-metrics)
   - [5.10 cost-tracker](#510-cost-tracker)
   - [5.11 token-budget](#511-token-budget) **advanced**
   - [5.12 repeated-call-guard](#512-repeated-call-guard) **v0.0.2 新增**
6. [测试规约](#6-测试规约)

## 1. Plugin 是什么

**Plugin = 一个返回 `Hook` 对象的工厂函数。**

```ts
import type { Hook } from "@harness-pi/core";

export function myPlugin(opts: MyPluginOptions): Hook {
  // plugin 私有状态（plugin 实例级别，跨 session 共享 = 不推荐）
  // 通常 plugin 是无状态的，状态走 ctx.state
  return {
    name: "my-plugin",
    timeout: 200,
    onToolEnd(input, ctx) {
      // ...
    },
  };
}
```

特征：

- **无状态优先**：plugin 函数本身尽量纯（一次 new session 一次工厂调用即可重用）
- **配置通过 opts**：所有可调参数走构造时传入
- **状态走 `ctx.state`**：session 级状态在 `ctx.state.set(key, value)`
- **小而单一**：plugin 应优先保持一个清晰职责；如果状态、hook 分支或测试夹具开始互相拖累，就拆成更小的 plugin 或 helper
- **零跨 plugin 依赖**：不 import 另一个 plugin

## 2. Plugin 工厂模式

```ts
// 工厂签名：opts → Hook
export function pluginName(opts?: PluginOptions): Hook { ... }

// 使用：
const session = new AgentSession({
  hooks: [
    pluginName({ ... }),
    anotherPlugin({ ... }),
  ],
});
```

**为什么不用 class**：
- 函数式更轻
- 配置一次，闭包捕获即可
- 没有继承需求

**为什么不用 decorator**：
- TS 装饰器还在 stage-3 + 配置麻烦
- 我们的 plugin 是数据（hook 对象），不是行为修饰

## 3. `ctx.state` 约定

`ctx.state: Map<string, unknown>` 是 plugin 之间的共享黑板。**约定 key 名带 plugin 前缀防撞名**：

```ts
// ✅ 好：
ctx.state.set("watchdog.lastActivityTs", Date.now());
ctx.state.set("empty-run.consecutive", 3);
ctx.state.set("batch-counter.count", 5);
ctx.state.set("tool-output-buffer.entries", buf);
ctx.state.set("metrics.sink", sinkInstance);

// ❌ 坏：撞名风险高
ctx.state.set("count", 5);
ctx.state.set("buffer", buf);
ctx.state.set("sink", sink);
```

**类型不安全**：`ctx.state` 是 `Map<string, unknown>`，读出来需要 cast。建议每个 plugin 在自己的代码里包一层 typed helper：

> **输出共存约定**：多个 plugin 可以同时挂同一个 hook 方法，输出（`additionalContext` / `systemMessage` / etc.）会按注册顺序聚合。你的 reminder 可能跟别人的 reminder **共存**——同 turn LLM 看到 N 段 `<system-reminder>`。写 plugin 时假设别人也在写：用清晰的 tag 区分来源，不要把 `additionalContext` 当 plugin 间通信渠道（用 `ctx.state` 协作）。完整合并规则见 [03-hook-system §5.2 输出共存约定](03-hook-system.md#52-输出共存约定plugin-作者必读)。


```ts
// watchdog.ts 内部
const K_LAST_ACTIVITY = "watchdog.lastActivityTs";
function getLastActivity(ctx: HookContext): number | undefined {
  return ctx.state.get(K_LAST_ACTIVITY) as number | undefined;
}
function setLastActivity(ctx: HookContext, ts: number): void {
  ctx.state.set(K_LAST_ACTIVITY, ts);
}
```

**生命周期**：`ctx.state` 跟 session 等长，session 结束 GC。不要塞超大对象（PDF 渲染图、模型权重等），用 LRU 或 TTL。

## 4. 文件组织

```
packages/plugins/src/
├── index.ts                  ← 每个 plugin 一个 named export
│
├── watchdog.ts               ← 单文件 plugin
├── trim-history.ts
├── empty-run-guard.ts
├── tool-output-buffer.ts
├── session-log.ts
├── system-reminder.ts
├── batch-counter.ts
├── lease-decision.ts
│
├── metrics/                  ← 多文件 plugin 用子目录
│   ├── index.ts
│   ├── types.ts
│   ├── recorder.ts
│   └── sinks/
│       ├── memory.ts
│       ├── ndjson-file.ts
│       └── postgres.ts
│
└── controllers/              ← 不是 plugin，独立目录
    ├── lifecycle-restart.ts
    ├── work-pool.ts
    └── lease-queue.ts
```

每个 plugin 文件结构：

```ts
// 1. JSDoc 顶部块：what / why / when to use
/**
 * Watchdog —— 单 turn 超时强终止。
 *
 * 用例：production agent，某些 LLM 或 tool 偶尔卡死。
 * bidding-agent 实测 Qwen reasoning 长尾 5-6 min；
 * 推荐 turnTimeoutMs >= 10 min。
 */

// 2. 类型声明
export interface WatchdogOptions { ... }

// 3. ctx.state key 常量
const K_LAST_ACTIVITY = "watchdog.lastActivityTs";

// 4. plugin 工厂
export function watchdog(opts: WatchdogOptions): Hook { ... }

// 5. （可选）测试 helper export，名字带 underscore 前缀
export function _resetForTests(): void { ... }
```

---

## 5. 标准库 12 个 plugin

### 5.1 watchdog

#### 目的

单 turn 超时强终止，防 LLM/tool 卡死。

#### Hook 形态

Around (`wrapTurn`)

#### 完整设计

```ts
import type { Hook, HookContext } from "@harness-pi/core";

export interface WatchdogOptions {
  /** 单 turn 最大耗时（ms）。超时 abort 当前 session。 */
  turnTimeoutMs: number;
  /** 超时回调（记 metric / 通知外部）。 */
  onTimeout?: (ctx: HookContext, turnIdx: number) => void;
}

export function watchdog(opts: WatchdogOptions): Hook {
  return {
    name: "watchdog",

    async wrapTurn(ctx, next) {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        opts.onTimeout?.(ctx, ctx.turnIdx);
        ctx.abort(`watchdog: turn ${ctx.turnIdx} timed out after ${opts.turnTimeoutMs}ms`);
      }, opts.turnTimeoutMs);

      try {
        await next();
      } finally {
        clearTimeout(timer);
        if (timedOut) {
          // optional: 记 metric
        }
      }
    },
  };
}
```

#### 配置选项

- `turnTimeoutMs`（必）：推荐生产 5-10 min
- `onTimeout`：超时回调；典型用 `(ctx, turn) => recordMetric({ kind: 'watchdog.timeout', turnIdx: turn })`

#### 与其他 plugin 交互

- **跟 lifecycle-restart controller 配合**：watchdog abort session → controller 检测到 abort → 启动新 session（带 carryover）
- **跟 metrics plugin 配合**：`onTimeout` 回调里 push 个 `watchdog.timeout` event

#### 失败模式

- **`ctx.abort()` 调用之后当前 turn 仍要走完才退**——watchdog 不能硬中断已经在跑的 tool。要硬中断在 `onTimeout` 里 abort 外部 AbortController。
- **嵌套 watchdog**：多个 watchdog plugin 同时挂，最严的（最短 timeout）先触发；外层 cleanup 仍会跑。

#### 测试要点

- 正常 turn 不触发 timer
- turn 超时 → `next()` 抛错时 `clearTimeout` 仍要跑（finally 兜底）
- `onTimeout` 被调用且参数正确
- `ctx.abort` 调用后 session 在下次 turn 边界退出

---

### 5.2 trim-history

#### 目的

把历史 tool result 替换成短占位符，控制 LLM 输入 token。来自 bidding-agent v3.3 实测：turn 11+ input/turn 从 86K → 35K (-59%)。

#### Hook 形态

Around (`wrapTurn`)——因为要在 LLM call 前改 messages view 但 turn 内其他 hook 不应该看到改后的。

或者更简单：自定义一个 `transformMessagesBeforeLlm` 入口（kernel 暴露给 transform pipe）。

**选哪种？** 选**前者**（在 `wrapTurn` 里通过 `applyToContextView` 改 LLM 看到的 messages）。理由：kernel 不需要额外暴露 `transformMessagesBeforeLlm`——这是 trim-history 独有的需求，做成 pipe API 暴露太通用。

但等等——bidding-agent 现在用的是 `registerApiProvider` 全局注入，那个不依赖 hook。要不要保留？**保留作为 fallback**，但 v0 推荐用 hook 版本。

#### 完整设计（hook 版本，wrapTurn 路径）

实现要点：在 `wrapTurn` 里临时替换 `ctx` 引用的 messages 不可行（messages 是 session 状态）。需要 kernel 暴露一个钩子让我们在 LLM call 前 transform。

**结论**：trim-history 是少数需要 kernel 给它特殊钩子的 plugin。kernel 暴露 `transformMessagesBeforeLlm` pipe（仅 trim 类用）。

```ts
import type { Hook, HookContext } from "@harness-pi/core";
import type { Message } from "@earendil-works/pi-ai";

export interface TrimHistoryOptions {
  /** 最近 N 条 toolResult 保留原样。 */
  keepRecent: number;
}

export function trimHistory(opts: TrimHistoryOptions): Hook {
  return {
    name: "trim-history",
    timeout: 50,  // 纯计算，应该极快

    transformMessagesBeforeLlm(messages: Message[], _ctx) {
      const toolResultIdxs: number[] = [];
      for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === "toolResult") toolResultIdxs.push(i);
      }
      if (toolResultIdxs.length <= opts.keepRecent) return;  // 不改

      const cutoff = toolResultIdxs[toolResultIdxs.length - opts.keepRecent - 1];

      return messages.map((m, i) => {
        if (i > cutoff || m.role !== "toolResult") return m;
        return {
          ...m,
          content: [{
            type: "text" as const,
            text: `[trimmed tool result: ${m.toolName} — older context, do not re-call unless needed]`,
          }],
        };
      });
    },
  };
}
```

需要在 hook.ts 加一个方法：

```ts
interface Hook {
  // ...
  /** Transform pipe: messages 数组进，messages 数组出。仅 trim 类需要。 */
  transformMessagesBeforeLlm?(messages: Message[], ctx: HookContext): Message[] | void | Promise<Message[] | void>;
}
```

#### 配置选项

- `keepRecent`（默认 16）：bidding-agent 实测覆盖 2-4 turn 工具调用密度

#### 与其他 plugin 交互

- **互不影响**：trim 输出的 messages 不进 `session.messages`，纯 view 修改

#### 失败模式

- **image 内容被替换成 placeholder**：read_source 的 PDF 图渲染丢了。但 judgment 已经走 DB 持久化，不依赖 messages 历史。这是 bidding-agent 实测可接受的代价。
- **trim 完 tool call/result 配对乱了**：实现要 careful，只改 toolResult.content，不改 toolCallId / toolName / 整体顺序。

#### 测试要点

- 不足 keepRecent 条 → 返回 undefined（不改）
- 超过 keepRecent → 老的 toolResult 被替换，toolCallId / toolName 保留
- assistant / user message 永不变
- 保留最近 keepRecent 条原封不动

---

### 5.3 empty-run-guard

#### 目的

LLM 连续 N turn 没调用任何 tool → 视为卡死 / 困惑，主动 abort。防 token 空转。

#### Hook 形态

Event (`onTurnEnd`) + `ctx.abort()`

#### 完整设计

```ts
import type { Hook } from "@harness-pi/core";

export interface EmptyRunGuardOptions {
  /** 连续 N turn 无 tool call 则 abort。 */
  maxEmptyTurns: number;
}

const KEY = "empty-run.consecutive";

export function emptyRunGuard(opts: EmptyRunGuardOptions): Hook {
  return {
    name: "empty-run-guard",
    timeout: 50,

    onTurnEnd(input, ctx) {
      const prev = (ctx.state.get(KEY) as number) ?? 0;
      const now = input.toolResults.length === 0 ? prev + 1 : 0;
      ctx.state.set(KEY, now);

      if (now >= opts.maxEmptyTurns) {
        ctx.abort(`${now} consecutive empty turns (no tool calls) — LLM may be confused or unreachable`);
      }
    },
  };
}
```

#### 配置选项

- `maxEmptyTurns`（默认 3）：bidding-agent 验证过的值

#### 与其他 plugin 交互

- **跟 metrics plugin 配合**：abort 后 metrics 的 `onSessionEnd` 看到 `reason="aborted"` + `stopReason="..."` 自动记
- **跟 watchdog 互补**：watchdog 防"单 turn 卡死"，empty-run 防"很多 turn 但没用"

#### 失败模式

- **误杀**：LLM 真的只是在用文字回答用户而不调用 tool（如 ask_user 模式）会被误杀。如果 `ask_user` 是 tool 那 OK；如果是 LLM 直接说话则需要 plugin 配置允许"有 text content 不算空"。
- **解决方案**：opts 加 `considerEmpty: (input) => boolean`，默认 `input.toolResults.length === 0`，用户可重写。

#### 测试要点

- 单次空 turn 不触发
- 连续 N 次空触发 abort
- 中间有一次非空 → 计数归零
- abort 后 session.reason === "aborted"

---

### 5.4 tool-output-buffer

#### 目的

按白名单工具的输出落进一个 session 级 ring buffer（TTL + 容量），供别的 plugin / 业务代码读。来自 bidding-agent EvidenceBuffer。

#### Hook 形态

Event (`onSessionStart` 建 buffer + `onToolEnd` push)

#### 完整设计

```ts
import type { Hook, HookContext } from "@harness-pi/core";

export interface ToolOutputBufferOptions {
  /** 白名单工具名。 */
  track: string[];
  /** 容量上限。 */
  maxEntries: number;
  /** 字节上限（所有 entries 加起来）。 */
  maxBytes: number;
  /** TTL（ms）。 */
  ttlMs: number;
}

export interface BufferEntry {
  toolName: string;
  args: Record<string, unknown>;
  output: string;
  ts: number;
}

const KEY = "tool-output-buffer.ring";

export function toolOutputBuffer(opts: ToolOutputBufferOptions): Hook {
  return {
    name: "tool-output-buffer",
    timeout: 50,

    onSessionStart(_input, ctx) {
      ctx.state.set(KEY, new RingBuffer(opts));
    },

    onToolEnd(input, ctx) {
      if (!opts.track.includes(input.call.name)) return;
      const buf = ctx.state.get(KEY) as RingBuffer;
      if (!buf) return;
      const text = input.result.content
        .filter(c => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
      buf.push({ toolName: input.call.name, args: input.call.arguments, output: text, ts: Date.now() });
    },

    onSessionEnd(_input, ctx) {
      const buf = ctx.state.get(KEY) as RingBuffer | undefined;
      buf?.clear();
      ctx.state.delete(KEY);
    },
  };
}

class RingBuffer {
  private entries: BufferEntry[] = [];
  private totalBytes = 0;
  constructor(private opts: ToolOutputBufferOptions) {}

  push(e: BufferEntry) {
    this.entries.push(e);
    this.totalBytes += e.output.length;
    this.evict();
  }

  private evict() {
    const now = Date.now();
    while (this.entries.length > 0 && now - this.entries[0].ts > this.opts.ttlMs) {
      this.totalBytes -= this.entries.shift()!.output.length;
    }
    while (this.entries.length > this.opts.maxEntries || this.totalBytes > this.opts.maxBytes) {
      if (!this.entries.length) break;
      this.totalBytes -= this.entries.shift()!.output.length;
    }
  }

  clear() { this.entries = []; this.totalBytes = 0; }

  /** 公共 API（其他 plugin / 业务读取） */
  snapshot(): ReadonlyArray<BufferEntry> { return [...this.entries]; }
  find(predicate: (e: BufferEntry) => boolean): BufferEntry | undefined {
    return this.entries.find(predicate);
  }
}

/** 读 buffer 的 helper（外部代码用）。 */
export function getToolOutputBuffer(ctx: HookContext): RingBuffer | undefined {
  return ctx.state.get(KEY) as RingBuffer | undefined;
}
```

#### 配置选项

- `track`（必）：默认推荐 `["Read", "Grep", "kb_search"]`（domain 自定义）
- `maxEntries` 默认 200
- `maxBytes` 默认 20MB
- `ttlMs` 默认 15min

#### 与其他 plugin 交互

- **业务代码 / 其他 plugin 通过 `getToolOutputBuffer(ctx)` 读**——这是 plugin **唯一**对外暴露 API 的合规方式
- bidding-agent 的"submit_evidence 校验 excerpt"逻辑写成业务代码消费 buffer，不写成 plugin

#### 失败模式

- **`onSessionStart` 没跑就 push**：guard `if (!buf) return`
- **跨 session 状态泄漏**：plugin 是无状态的（buffer 在 `ctx.state`），ctx 跟 session 等长

#### 测试要点

- 跟踪工具 push 进，非跟踪工具不 push
- TTL 过期被 evict
- 超容量被 evict
- session end 后 clear

---

### 5.5 session-log

#### 目的

每个 session 写一份 NDJSON log 到磁盘，复盘 / 调试用。来自 bidding-agent session-logger。

#### Hook 形态

Event (所有 `on*` event 都记一条)

#### 完整设计

```ts
import type { Hook, HookContext } from "@harness-pi/core";
import { createWriteStream, type WriteStream } from "fs";
import { join } from "path";

export interface SessionLogOptions {
  /** 输出目录。文件名 `<sessionId>.ndjson`。 */
  dir: string;
  /** 哪些 event 记。默认全部。 */
  events?: Array<"sessionStart" | "sessionEnd" | "turnStart" | "turnEnd" | "llmEnd" | "preToolUse" | "postToolUse" | "error">;
}

const KEY_STREAM = "session-log.stream";

export function sessionLog(opts: SessionLogOptions): Hook {
  const includes = (e: string) => !opts.events || opts.events.includes(e as any);

  function write(ctx: HookContext, event: string, payload: unknown) {
    const stream = ctx.state.get(KEY_STREAM) as WriteStream | undefined;
    if (!stream) return;
    stream.write(JSON.stringify({ ts: Date.now(), turnIdx: ctx.turnIdx, event, ...payload as object }) + "\n");
  }

  return {
    name: "session-log",
    internal: true,    // 不上报 hook metric

    onSessionStart(input, ctx) {
      const path = join(opts.dir, `${ctx.sessionId}.ndjson`);
      const stream = createWriteStream(path, { flags: "a" });
      ctx.state.set(KEY_STREAM, stream);
      if (includes("sessionStart")) write(ctx, "sessionStart", input);
    },

    onSessionEnd(input, ctx) {
      if (includes("sessionEnd")) write(ctx, "sessionEnd", input);
      const stream = ctx.state.get(KEY_STREAM) as WriteStream | undefined;
      stream?.end();
      ctx.state.delete(KEY_STREAM);
    },

    onTurnStart(input, ctx)    { if (includes("turnStart")) write(ctx, "turnStart", input); },
    onTurnEnd(input, ctx)      { if (includes("turnEnd")) write(ctx, "turnEnd", { toolResultsCount: input.toolResults.length }); },
    onLlmEnd(input, ctx)       { if (includes("llmEnd")) write(ctx, "llmEnd", { durationMs: input.durationMs, usage: input.msg.usage, stopReason: input.msg.stopReason }); },
    onPreToolUse(input, ctx)   { if (includes("preToolUse")) write(ctx, "preToolUse", { tool: input.call.name, args: input.call.arguments }); },
    onPostToolUse(input, ctx)  { if (includes("postToolUse")) write(ctx, "postToolUse", { tool: input.call.name, durationMs: input.durationMs, isError: input.result.isError }); },
    onError(input, ctx)        { if (includes("error")) write(ctx, "error", { phase: input.phase, err: input.err.message, hookName: input.hookName }); },
  };
}
```

#### 配置选项

- `dir`（必）：默认推荐 `process.cwd() + "/logs"`
- `events`：选哪些事件落盘，默认全部

#### 与其他 plugin 交互

- 完全独立。可以挂任意子集 plugin

#### 失败模式

- **写盘失败**：`stream.write` 异步错误如果不监听 `'error'` 会让 process crash。生产建议监听并 log 一次后忽略。
- **大 session 文件**：100 turn × 多 event = MB 级。考虑加日志轮转（按日期分目录）。

#### 测试要点

- 文件创建 / 内容格式（每行有效 JSON）
- `events: ["turnEnd"]` 只写 turnEnd
- session end 后 stream 关闭

---

### 5.6 system-reminder

#### 目的

按条件向 LLM 注入 `<system-reminder>` transient 提示。来自 Claude Code 的 reminder 模式。

#### Hook 形态

Event (any of `onTurnStart` / `onPostToolUse` / etc) returning `additionalContext`

#### 完整设计

```ts
import type { Hook, HookContext } from "@harness-pi/core";

export interface SystemReminderOptions {
  /** 在哪个事件触发检查。 */
  on: "turnStart" | "turnEnd" | "postToolUse";
  /** 返回 reminder 文本或 null（null=不注入）。 */
  trigger: (ctx: HookContext, input: any) => string | null;
  /** 是否包 `<system-reminder>` 标签，默认 true。 */
  wrap?: boolean;
}

export function systemReminder(opts: SystemReminderOptions): Hook {
  const wrap = opts.wrap ?? true;
  const inject = (ctx: HookContext, input: any) => {
    const text = opts.trigger(ctx, input);
    if (!text) return;
    const body = wrap ? `<system-reminder>${text}</system-reminder>` : text;
    return { additionalContext: body };
  };

  const hook: Hook = { name: `system-reminder(${opts.on})` };
  if (opts.on === "turnStart") hook.onTurnStart = (input, ctx) => inject(ctx, input);
  if (opts.on === "turnEnd") hook.onTurnEnd = (input, ctx) => inject(ctx, input);
  if (opts.on === "postToolUse") hook.onPostToolUse = (input, ctx) => inject(ctx, input);
  return hook;
}
```

#### 配置选项

- `on`（必）：触发时机
- `trigger`（必）：纯函数，决定要不要 inject 以及 inject 什么
- `wrap`：默认 true，包 `<system-reminder>` tag

#### 与其他 plugin 交互

- **跟 batch-counter 联动**：`trigger` 检查 `ctx.state.get("batch-counter.count")` 决定是否提醒"已处理 N 题请收尾"
- **跟 tool-output-buffer 联动**：`trigger` 看 buffer 内容判断 "外部文件变了"

#### 失败模式

- **trigger 抛错**：dispatcher 兜底 fail-open，不影响 session
- **总返回非 null**：每 turn 都注入 → token 浪费。`trigger` 应该真正检查条件后才返回

#### 测试要点

- `trigger` 返回 null → 无 additionalContext
- `trigger` 返回 string → 收到 wrap 后的 reminder
- wrap=false 时直接用原文

---

### 5.7 batch-counter

#### 目的

每 N 次目标 tool 触发回调，让外部决定接下来怎么办（abort / 注入 reminder / 等）。来自 bidding-agent batchCounter。

#### Hook 形态

Event (`onPostToolUse`)

#### 完整设计

```ts
import type { Hook, HookContext } from "@harness-pi/core";

export interface BatchCounterOptions {
  /** 计哪个工具的调用。 */
  triggerTool: string;
  /** 每 N 次触发 onFull。 */
  batchSize: number;
  /** 达到 batchSize 时的回调。回调里可调 ctx.abort()、记 metric、或塞 reminder。 */
  onFull: (ctx: HookContext, count: number) => void;
}

const KEY = "batch-counter.count";

export function batchCounter(opts: BatchCounterOptions): Hook {
  return {
    name: `batch-counter(${opts.triggerTool}/${opts.batchSize})`,
    timeout: 50,

    onPostToolUse(input, ctx) {
      if (input.call.name !== opts.triggerTool) return;
      if (input.result.isError) return;  // 失败的不计

      const n = ((ctx.state.get(KEY) as number) ?? 0) + 1;
      ctx.state.set(KEY, n);

      if (n >= opts.batchSize) {
        ctx.state.set(KEY, 0);  // 重置
        opts.onFull(ctx, n);
      }
    },
  };
}
```

#### 配置选项

- `triggerTool`（必）：bidding-agent 用 `judge_question`
- `batchSize` 默认 8
- `onFull` 推荐写法：

```ts
batchCounter({
  triggerTool: "judge_question",
  batchSize: 8,
  onFull: (ctx, n) => {
    // 选 1：直接 abort，让 controller 重启
    ctx.abort(`Processed ${n} questions, refreshing context`);
    // 选 2：塞 reminder，让 LLM 自己收尾
    // (这条要配合 system-reminder plugin 实现，因为这里没法直接 inject)
  },
});
```

#### 与其他 plugin 交互

- **跟 system-reminder 配合**：onFull 里 set 一个 flag，system-reminder 的 trigger 读到 flag → inject "请收尾" reminder
- **跟 lifecycle-restart controller 配合**：abort 后 controller 重启新 session 继续

#### 失败模式

- **onFull 抛错**：dispatcher fail-open，count 已经重置，下一波重新计

#### 测试要点

- 非目标工具不计数
- 失败工具不计数
- 达到 batchSize 触发 onFull 且 count 归零
- session 内的 ctx.state 跨 turn 持续

---

### 5.8 lease-decision

#### 目的

bidding-agent 的"lease 冲突拦截"。多 worker 并行时，每个 worker 持有一个 lease（如 questionId），LLM 试图调用 tool 但 args 里的 id 跟当前 lease 不一致 → 拦下。

#### Hook 形态

Decision (`onPreToolUse`)

#### 完整设计

```ts
import type { Hook, HookContext, ToolCall } from "@harness-pi/core";

export interface LeaseDecisionOptions {
  /** 返回当前 lease 持有的 id；null = 没 lease，跳过检查。 */
  currentLease: (ctx: HookContext) => string | null;
  /** Tool args 里哪个字段是 lease id（默认 "questionId"）。 */
  argField?: string;
  /** 哪些工具受 lease 约束。默认全部（args 含 argField 的）。 */
  guardedTools?: string[];
  /** 冲突回调（记 metric / 通知外部）。 */
  onConflict?: (call: ToolCall, actualLease: string, requestedLease: string) => void;
  /** 拦截后给 LLM 的提示前缀。 */
  reasonPrefix?: string;
}

export function leaseDecision(opts: LeaseDecisionOptions): Hook {
  const argField = opts.argField ?? "questionId";
  const reasonPrefix = opts.reasonPrefix ?? "Lease mismatch:";

  return {
    name: "lease-decision",
    timeout: 50,

    onPreToolUse(input, ctx) {
      if (opts.guardedTools && !opts.guardedTools.includes(input.call.name)) return;

      const requested = (input.call.arguments as any)?.[argField];
      if (typeof requested !== "string") return;  // 没传 lease id 不管

      const actual = opts.currentLease(ctx);
      if (!actual || actual === requested) return;  // 没 lease 或匹配

      opts.onConflict?.(input.call, actual, requested);
      return {
        decision: "deny",
        reason: `${reasonPrefix} tool ${input.call.name} used ${argField}="${requested}", current lease is "${actual}". Process the leased item first.`,
        additionalContext: `<system-reminder>The previous tool call was rejected because it referenced ${argField}="${requested}" but you are currently leased to "${actual}". Switch to "${actual}".</system-reminder>`,
      };
    },
  };
}
```

#### 配置选项

- `currentLease`（必）：业务代码提供 lease 读取
- `argField` 默认 `"questionId"`
- `guardedTools`：留 undefined 表示所有 tool 都检查
- `onConflict`：记 metric / 上报

#### 与其他 plugin 交互

- **跟 metrics 配合**：`onConflict` 里 push 个 `lease.conflict` event
- **跟 lease-queue controller 配合**：controller 持有 lease pool，plugin 通过 `currentLease` callback 读

#### 失败模式

- **`currentLease` 抛错**：dispatcher fail-open → 视为没 lease → 不拦截。如果想 fail-safe（宁可拦错），plugin 内自己 try/catch + return deny。

#### 测试要点

- args 无 lease id → 不拦
- lease id 匹配 → 不拦
- lease id 不匹配 → deny + reason + additionalContext
- `guardedTools` 过滤生效

---

### 5.9 metrics

#### 目的

异步批写 metric 事件到 sink，供 dashboard / 分析。基于 bidding-agent metrics 系统的简化版。

#### Hook 形态

Event (`onLlmEnd` / `onToolEnd` / `onSessionStart` / `onSessionEnd` / `onError`)

#### 完整设计

文件 `packages/plugins/src/metrics/index.ts`：

```ts
import type { Hook, HookContext } from "@harness-pi/core";
import type { MetricsSink, MetricEvent, MetricKind } from "./types.js";

export interface MetricsOptions {
  sink: MetricsSink;
  /** 哪些 kind 记。默认全部。 */
  kinds?: MetricKind[];
}

const KEY_SINK = "metrics.sink";

export function metrics(opts: MetricsOptions): Hook {
  const includes = (k: MetricKind) => !opts.kinds || opts.kinds.includes(k);
  const emit = (sink: MetricsSink, event: MetricEvent) => {
    sink.enqueue(event);  // sink 自己批 flush
  };

  return {
    name: "metrics",
    internal: true,

    onSessionStart(_input, ctx) {
      ctx.state.set(KEY_SINK, opts.sink);
      if (includes("session.started")) {
        emit(opts.sink, { kind: "session.started", sessionId: ctx.sessionId, ts: Date.now() });
      }
    },

    onSessionEnd(input, ctx) {
      if (includes("session.ended")) {
        emit(opts.sink, { kind: "session.ended", sessionId: ctx.sessionId, ts: Date.now(), turns: input.turns, reason: input.reason });
      }
    },

    onLlmEnd(input, ctx) {
      if (includes("llm.called")) {
        emit(opts.sink, {
          kind: "llm.called",
          sessionId: ctx.sessionId,
          turnIdx: ctx.turnIdx,
          ts: Date.now(),
          durationMs: input.durationMs,
          stopReason: input.msg.stopReason,
          usage: input.msg.usage,
        });
      }
    },

    onPostToolUse(input, ctx) {
      if (includes("tool.called")) {
        emit(opts.sink, {
          kind: "tool.called",
          sessionId: ctx.sessionId,
          turnIdx: ctx.turnIdx,
          ts: Date.now(),
          toolName: input.call.name,
          durationMs: input.durationMs,
          isError: input.result.isError ?? false,
        });
      }
    },

    onError(input, ctx) {
      if (includes("error.observed")) {
        emit(opts.sink, {
          kind: "error.observed",
          sessionId: ctx.sessionId,
          turnIdx: ctx.turnIdx,
          ts: Date.now(),
          phase: input.phase,
          message: input.err.message,
          hookName: input.hookName,
        });
      }
    },
  };
}

/** 业务代码可以拿到 sink 自己 emit 自定义 kind。 */
export function getMetricsSink(ctx: HookContext): MetricsSink | undefined {
  return ctx.state.get(KEY_SINK) as MetricsSink | undefined;
}
```

`types.ts`：

```ts
export type MetricKind =
  | "session.started"
  | "session.ended"
  | "llm.called"
  | "tool.called"
  | "error.observed";

// 用户用 declaration merging 扩展自己的 kind
export interface UserMetricKinds {}
export type ExtendedMetricKind = MetricKind | keyof UserMetricKinds;

export interface MetricEvent {
  kind: ExtendedMetricKind;
  sessionId?: string;
  turnIdx?: number;
  ts: number;
  [k: string]: unknown;  // payload 字段不约束
}

export interface MetricsSink {
  enqueue(event: MetricEvent): void;
  flush?(): Promise<void>;  // 测试 / 关 session 时用
  stats?(): { enqueued: number; flushed: number; failed: number };
}
```

Sink 实现见 [07-adapters](07-adapters.md)。

#### 配置选项

- `sink`（必）：要装哪个 sink（memory / ndjson / postgres）
- `kinds`：白名单 kind 过滤

#### 与其他 plugin 交互

- 业务代码用 `getMetricsSink(ctx)` 拿 sink 自己 emit 业务 kind（如 bidding-agent 的 `evidence.submitted`）

#### 失败模式

- **sink 挂了**：sink 自己负责重试 / 丢弃 / 报警；plugin 不处理
- **sink 队列满**：sink 按 backpressure 策略丢老的（默认）

#### 测试要点

- 每个 kind 都能 emit
- `kinds` 过滤生效
- `getMetricsSink` 拿得到
- session end 后 sink 还能被业务读（不立刻 flush 强 close）

---

### 5.10 cost-tracker

#### 目的

累计 token / cost USD / API duration 到 session 级 + 全局级。借鉴 Claude Code `cost-tracker.ts` 的算法，但**不复制其全局 mutable state 模式**——我们走 `ctx.state` + 可选 sink。

#### Hook 形态

Event (`onSessionStart` 建 state + `onLlmEnd` 累计 + `onSessionEnd` 上报)

#### 完整设计

```ts
import type { Hook, HookContext } from "@harness-pi/core";

export interface CostTrackerOptions {
  /** 模型成本计算（per provider/model）。null 则只统计 token 不算 USD。 */
  costModel?: (modelId: string, usage: { input: number; output: number; cached?: number }) => number;
  /** session 结束时回调（落 sink / metrics / DB）。 */
  onSessionFinalized?: (ctx: HookContext, stats: CostStats) => void;
}

export interface CostStats {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUSD: number;
  durationMs: number;
  llmCallCount: number;
  byModel: Map<string, { input: number; output: number; cached: number; costUSD: number; calls: number }>;
}

const KEY = "cost-tracker.stats";
const KEY_START = "cost-tracker.startTs";

export function costTracker(opts: CostTrackerOptions = {}): Hook {
  return {
    name: "cost-tracker",
    internal: true,
    timeout: 50,

    onSessionStart(_input, ctx) {
      ctx.state.set(KEY_START, Date.now());
      ctx.state.set(KEY, {
        inputTokens: 0, outputTokens: 0, cachedTokens: 0,
        costUSD: 0, durationMs: 0, llmCallCount: 0,
        byModel: new Map(),
      } satisfies CostStats);
    },

    onLlmEnd(input, ctx) {
      const stats = ctx.state.get(KEY) as CostStats;
      const usage = input.msg.usage;
      if (!usage) return;

      const modelId = (input.msg as any).model ?? "unknown";
      const inputTok = usage.input ?? 0;
      const outputTok = usage.output ?? 0;
      const cachedTok = (usage as any).inputCached ?? 0;
      const cost = opts.costModel?.(modelId, { input: inputTok, output: outputTok, cached: cachedTok }) ?? 0;

      stats.inputTokens += inputTok;
      stats.outputTokens += outputTok;
      stats.cachedTokens += cachedTok;
      stats.costUSD += cost;
      stats.llmCallCount += 1;

      const m = stats.byModel.get(modelId) ?? { input: 0, output: 0, cached: 0, costUSD: 0, calls: 0 };
      m.input += inputTok; m.output += outputTok; m.cached += cachedTok;
      m.costUSD += cost; m.calls += 1;
      stats.byModel.set(modelId, m);
    },

    onSessionEnd(_input, ctx) {
      const stats = ctx.state.get(KEY) as CostStats;
      const startTs = ctx.state.get(KEY_START) as number;
      stats.durationMs = Date.now() - startTs;
      opts.onSessionFinalized?.(ctx, stats);
    },
  };
}

/** 业务代码 / 其他 plugin 读 cost 数据。 */
export function getCostStats(ctx: HookContext): CostStats | undefined {
  return ctx.state.get(KEY) as CostStats | undefined;
}
```

#### 配置选项

- `costModel`：缺省则只统计 token 不算 USD。典型实现查 `pi-ai` 内置 cost table 或自定义 schema。
- `onSessionFinalized`：典型组合 `metrics` plugin 推一个 `session.cost` event 或写 DB。

#### 与其他 plugin 交互

- **跟 metrics 配合**：`onSessionFinalized` 里 `getMetricsSink(ctx)?.enqueue({ kind: "session.cost", ...stats })`
- **跟 tokenBudget 配合**：tokenBudget 读 `getCostStats(ctx)` 判断预算

#### 失败模式

- **`usage` 字段缺失**：guard `if (!usage) return;`，session 不挂
- **costModel 抛错**：用户错，dispatcher catch + 记 metric，本次 LLM 不算 cost 继续

#### 测试要点

- 多模型混跑后 byModel 计数正确
- 没有 costModel 时 costUSD 保持 0
- session end 时 onSessionFinalized 被调用一次

---

### 5.11 token-budget

#### 目的

跟踪 per-session（或 per-turn）累计 token 消耗，按预算阈值决定"继续"或"停止"。借鉴 Claude Code [`query/tokenBudget.ts`](https://github.com/badlogic/pi-mono) 的算法（completion threshold + diminishing returns 检测）。

**标 advanced**：大多数 agent 用 `maxTurns` 限流就够；token-budget 适合长跑 agent（research / 数据处理）需要细粒度预算控制。

#### Hook 形态

Event (`onSessionStart` 建 tracker + `onTurnEnd` 检查 + 可触发 `continue: true` 注 nudge 或 abort)

#### 完整设计

```ts
import type { Hook, HookContext, HookResult } from "@harness-pi/core";

export interface TokenBudgetOptions {
  /** session 总 token 预算。null = 不限。 */
  budget: number | null;
  /** 当前 turn 累计 token >= budget × 这个比例时停止。默认 0.9。 */
  completionThreshold?: number;
  /** Diminishing returns 阈值。连续 N turn delta < 这个值视为收敛。默认 500。 */
  diminishingThreshold?: number;
  /** 连续多少 turn 才开始判 diminishing。默认 3。 */
  diminishingMinContinuations?: number;
  /** 触发 nudge 时返回的 additionalContext 模板。 */
  nudgeMessage?: (pct: number, turnTokens: number, budget: number) => string;
}

interface BudgetTracker {
  continuationCount: number;
  lastDeltaTokens: number;
  lastTotalTokens: number;
  startedAt: number;
}

const KEY = "token-budget.tracker";

export function tokenBudget(opts: TokenBudgetOptions): Hook {
  const completionThreshold = opts.completionThreshold ?? 0.9;
  const diminishingThreshold = opts.diminishingThreshold ?? 500;
  const diminishingMinContinuations = opts.diminishingMinContinuations ?? 3;
  const nudgeMsg = opts.nudgeMessage ?? defaultNudgeMessage;

  return {
    name: "token-budget",
    timeout: 50,

    onSessionStart(_input, ctx) {
      ctx.state.set(KEY, {
        continuationCount: 0,
        lastDeltaTokens: 0,
        lastTotalTokens: 0,
        startedAt: Date.now(),
      } satisfies BudgetTracker);
    },

    onTurnEnd(input, ctx): HookResult | void {
      if (opts.budget == null || opts.budget <= 0) return;

      const tracker = ctx.state.get(KEY) as BudgetTracker;
      // 从 cost-tracker 拉总 token 数（或自己累计 input.assistantMessage.usage）
      const totalTokens = readCumulativeTokens(ctx);
      const pct = Math.round((totalTokens / opts.budget) * 100);
      const delta = totalTokens - tracker.lastTotalTokens;

      const isDiminishing =
        tracker.continuationCount >= diminishingMinContinuations &&
        delta < diminishingThreshold &&
        tracker.lastDeltaTokens < diminishingThreshold;

      // 已经超预算 → 立即停
      if (totalTokens >= opts.budget) {
        return { continue: false, stopReason: `token budget exhausted: ${totalTokens}/${opts.budget}` };
      }

      // diminishing returns → 停
      if (isDiminishing) {
        return { continue: false, stopReason: `diminishing returns: last 3 turns added <${diminishingThreshold} tokens each` };
      }

      // 未到完成阈值 → continue 并注 nudge
      if (totalTokens < opts.budget * completionThreshold) {
        tracker.continuationCount++;
        tracker.lastDeltaTokens = delta;
        tracker.lastTotalTokens = totalTokens;
        // 注意：onTurnEnd 默认 stopReason 字段会被忽略；这里用 additionalContext 注入提示
        return {
          additionalContext: `<system-reminder>${nudgeMsg(pct, totalTokens, opts.budget)}</system-reminder>`,
        };
      }

      // 已到完成阈值 → 不强停，让 LLM 自己决定（自然结束就 ok）
      return;
    },
  };
}

function defaultNudgeMessage(pct: number, turnTokens: number, budget: number): string {
  return `You've used ${turnTokens.toLocaleString()} / ${budget.toLocaleString()} tokens (${pct}%). Continue if more useful work remains; otherwise summarize and stop.`;
}

function readCumulativeTokens(ctx: HookContext): number {
  // 优先从 cost-tracker 读；fallback 自己累计
  const stats = ctx.state.get("cost-tracker.stats") as { inputTokens: number; outputTokens: number } | undefined;
  if (stats) return stats.inputTokens + stats.outputTokens;
  return (ctx.state.get("token-budget.fallback") as number) ?? 0;
}
```

#### 配置选项

- `budget`：核心参数。`null` = 不限。典型值：100K - 1M 看任务类型
- `completionThreshold` 默认 0.9
- `diminishingThreshold` 默认 500
- `nudgeMessage`：自定义 reminder 文案

#### 与其他 plugin 交互

- **依赖 cost-tracker**（推荐）：从 `ctx.state.get("cost-tracker.stats")` 读累计 token。若未挂 cost-tracker，回退用本 plugin 自己累计（功能略弱）
- **跟 onSessionEnd continuation 配合**：如果 token-budget 在 onTurnEnd 返 `continue: false`，session 结束；如果未触发 stop，nudge 注入让 LLM 自己决定要不要再来一轮（LLM 的下一轮 `stopReason !== "toolUse"` 时自然结束）
- **跟 batch-counter 互斥**：两者都管 "什么时候停"，同时挂会双重停。一般选一个

#### 失败模式

- **diminishing 误判**：LLM 真的在"沉思"几个 turn 才能产出结果，被误杀。`diminishingMinContinuations` 默认 3 比较保守
- **没有 cost-tracker**：fallback 累计精度差（不算 cached token / 跨 turn 边界丢失）

#### 测试要点

- budget 未到 → 不触发任何停
- 累计超 budget → continue: false 返回
- diminishing 检测：连续 3 turn delta 都 < 500 → continue: false
- nudge 在 50%/70% 等中段 turn 注入
- 跟 cost-tracker 联动：先挂 cost-tracker 再挂 token-budget，读得到累计

---

### 5.12 repeated-call-guard

#### 目的

检测 LLM 反复用同 args 调同一 tool（"原地打转" semantic 信号）。token-budget 的 diminishing returns 是 token-delta 信号，跟语义无关；本 plugin 补上语义维度——窗口内同 `(tool, args)` 重复达阈值就触发回调。

典型用例：
- bidding-agent 反复 grep 同一关键词
- research agent 反复搜索同一 query
- 任何"agent 卡在某个想法上"的场景

#### Hook 形态

Event (`onPostToolUse` 滑动窗口记录 + 触发回调)

#### 完整设计

详见 [`packages/plugins/src/repeated-call-guard.ts`](../packages/plugins/src/repeated-call-guard.ts)。

签名：
```ts
export function repeatedCallGuard(opts: {
  threshold: number;           // ≥ threshold 次同 (tool, args) 触发
  windowSize?: number;          // 默认 20
  onRepeat: (ctx, pattern) => void;  // 典型：ctx.abort / 注 reminder / 记 metric
  watchTools?: string[];        // 白名单，undefined = 全部
  argsEqual?: (a, b) => boolean;  // 默认 JSON.stringify 比较
  resetOnTrigger?: boolean;     // 默认 true，避免连续触发
}): Hook;
```

#### 配置选项 / 失败模式

- `threshold` 推荐 3-5（太小误报，太大错过 stuck pattern）
- `windowSize` 推荐 10-30（覆盖 2-3 turn 的 tool 密度）
- `argsEqual` 默认 JSON.stringify 对 key order 敏感——绝大多数 LLM tool call 同语义会同 order；真有需求传 callback 自定义
- `error` 结果不计数（避免反复 retry 失败 tool 触发误报）

#### 跟其他 plugin 配合

- **跟 token-budget 互补**：token-budget 是定量（token 量），repeated-call-guard 是定性（pattern 重复）
- **跟 metrics 配合**：`onRepeat` 里 `getMetricsSink(ctx)?.enqueue({ kind: "stuck.detected", ... })` 上报
- **跟 system-reminder 配合**：`onRepeat` 里 `ctx.state.set("stuck.flag", true)`，system-reminder trigger 读 flag 注 "尝试不同的角度" 提醒

---

## 6. 测试规约

每个 plugin 至少包含：

```
packages/plugins/__tests__/<plugin-name>.test.ts
```

最少测试覆盖：

1. **happy path**：典型 use case 跑通
2. **配置缺省值**：opts 缺省字段走默认值
3. **配置极端值**：0 / null / 空数组等
4. **状态隔离**：两个 session 各自的 plugin state 互不影响
5. **失败 fail-open**：plugin 内部抛错不破坏 session
6. **timeout 兜底**：超时 hook 被 cancel 不挂 session
7. **跟典型组合 plugin 不冲突**：跑一遍 watchdog + metrics + log 同挂

测试用 `vitest`，跟 bidding-agent 一致。

---

## 7. 下一步

- 想看 sink 怎么写 → [07-adapters](07-adapters.md)
- 想看 controller 怎么 compose 多个 plugin → [06-controllers](06-controllers.md)
- 想看 plugin 在 kernel 主循环里被怎么调度 → [02-kernel §2 Loop 算法](02-kernel.md#2-loop-算法完整伪代码)
