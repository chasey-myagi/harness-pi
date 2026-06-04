# 03 · Hook System

> Hook 接口、四种形态、执行模型（并行 vs 顺序）、统一返回 envelope、per-hook timeout、性能契约、dispatcher 实现。

## 0. 目录

1. [总览](#1-总览)
2. [Hook 接口定义](#2-hook-接口定义)
3. [执行模型：按 hook 形态分](#3-执行模型按-hook-形态分)
4. [HookResult 返回 envelope](#4-hookresult-返回-envelope)
5. [合并规则](#5-合并规则)
6. [Per-hook timeout](#6-per-hook-timeout)
7. [Sync vs Async](#7-sync-vs-async)
8. [注册顺序 = 执行顺序](#8-注册顺序--执行顺序契约)
9. [性能契约](#9-性能契约)
10. [Dispatcher 实现](#10-dispatcher-实现)
11. [借鉴自 Claude Code](#11-借鉴自-claude-code)
12. [反例与禁忌](#12-反例与禁忌)

## 1. 总览

Hook 系统是 harness-pi 跟 [pi-agent-core](https://github.com/badlogic/pi-mono/tree/main/packages/agent-core) 的**核心区别**。

- pi-agent-core 给的是 **observer pattern**：`session.subscribe(event => ...)`，只能看
- harness-pi 给的是 **interceptor pattern**：hook 可以 `deny / modify args / inject context / abort`

这一不同决定了 harness-pi 的设计成本（自己重写 loop ~400-600 LOC）和价值（lease 拦截、动态 system prompt、staleness reminder 等 production 必备能力）。

## 2. Hook 接口定义

```ts
import type { Message, AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import type { HookContext, HookResult, ToolExecResult, HarnessTool } from "@harness-pi/core";

export interface Hook {
  /** 用于调试 / metrics / log 归因。 */
  name: string;

  /** Per-hook timeout（ms）。默认按 hook 类型走（见 §6）。 */
  timeout?: number;

  /** 内部 hook 不计入用户面 metrics（沿用 Claude Code 命名）。 */
  internal?: boolean;

  // ──────────────────── Event 形态：并行 ────────────────────
  // 返回 HookResult 时仅 additionalContext / systemMessage 等"输出型"字段生效；
  // continue / decision / updatedInput 等"决策型"字段被忽略（编译期可以再收紧）。
  onSessionStart?(input: SessionStartInput, ctx: HookContext): HookResult | void | Promise<HookResult | void>;
  onSessionEnd?(input: SessionEndInput, ctx: HookContext): HookResult | void | Promise<HookResult | void>;
  onTurnStart?(input: TurnStartInput, ctx: HookContext): HookResult | void | Promise<HookResult | void>;
  onTurnEnd?(input: TurnEndInput, ctx: HookContext): HookResult | void | Promise<HookResult | void>;
  onLlmEnd?(input: LlmEndInput, ctx: HookContext): HookResult | void | Promise<HookResult | void>;
  onPostToolUse?(input: PostToolUseInput, ctx: HookContext): HookResult | void | Promise<HookResult | void>;
  onError?(input: ErrorInput, ctx: HookContext): void | Promise<void>;

  // ─────────── Decision 形态：顺序 short-circuit ───────────
  onPreToolUse?(input: PreToolUseInput, ctx: HookContext): HookResult | void | Promise<HookResult | void>;
  onUserPromptSubmit?(input: UserPromptSubmitInput, ctx: HookContext): HookResult | void | Promise<HookResult | void>;

  // ─────────── Transform 形态：pipe（顺序） ───────────
  transformSystemPromptBeforeLlm?(systemPrompt: string, ctx: HookContext): string | void | Promise<string | void>;

  // ─────────── Around 形态：嵌套 ───────────
  wrapTurn?(ctx: HookContext, next: () => Promise<void>): Promise<void>;
  wrapToolExec?(call: ToolCall, ctx: HookContext, next: () => Promise<ToolExecResult>): Promise<ToolExecResult>;
}

// Input 类型——每种 event 有 typed payload
export interface SessionStartInput { source: "run" | "continue"; initialPrompt?: string; }
export interface SessionEndInput   { turns: number; reason: "done" | "max_turns" | "aborted" | "error"; }
export interface TurnStartInput    { turnIdx: number; }
export interface TurnEndInput      { turnIdx: number; assistantMessage: AssistantMessage; toolResults: ToolExecResult[]; }
export interface LlmEndInput       { msg: AssistantMessage; durationMs: number; }
export interface PreToolUseInput   { call: ToolCall; tool: HarnessTool; }
export interface PostToolUseInput  { call: ToolCall; result: ToolExecResult; durationMs: number; }
export interface UserPromptSubmitInput { userMessage: Message; }
export interface ErrorInput        { phase: "llm" | "tool" | "hook"; err: Error; call?: ToolCall; hookName?: string; }
```

## 3. 执行模型：按 hook 形态分

| 形态 | 方法前缀 | 执行策略 | 顺序敏感？ | 为什么 |
|---|---|---|---|---|
| **Event** | `on*` | **并行** `Promise.all` | ❌ | hook 之间无数据依赖，浪费时间 |
| **Decision** | `onPreToolUse` / `onUserPromptSubmit` | **顺序 short-circuit** | ✅ | 第一个返回非 undefined 拿决策权，后续不必跑 |
| **Transform (pipe)** | `transform*` | **顺序 await** | ✅ | 前一个输出 = 后一个输入 |
| **Around** | `wrap*` | **嵌套**（天然顺序） | ✅ | 洋葱模型，定义如此 |

### 3.1 Event：并行

```ts
async fireEvent(method, input, ctx): Promise<HookResult[]> {
  const results = await Promise.all(
    this.hooks
      .filter(h => h[method])
      .map(h => this.invokeWithTimeout(h, method, input, ctx))
  );
  return results.filter(r => r != null);
}
```

**收益**：5 个 event hook 同时挂，开销 ≈ max(各 hook) 而不是 sum(各 hook)。
**约束**：event hook 不允许通过返回值影响流程（continue / decision 等字段被忽略）。

### 3.2 Decision：顺序 short-circuit

```ts
async fireDecision(method, input, ctx): Promise<HookResult | null> {
  for (const h of this.hooks) {
    if (!h[method]) continue;
    const r = await this.invokeWithTimeout(h, method, input, ctx);
    if (r?.decision || r?.updatedInput) return r;  // 拿到决策就停
  }
  return null;
}
```

**收益**：常见路径（allow）一旦最严格的 hook 通过，后续 hook 不必跑。
**约束**：早注册的优先级高——把最严的 hook（lease）放最前。

### 3.3 Transform (pipe)：顺序

```ts
async firePipe(method, value, ctx): Promise<typeof value> {
  let v = value;
  for (const h of this.hooks) {
    if (!h[method]) continue;
    const r = await this.invokeWithTimeout(h, method, v, ctx);
    if (r != null) v = r;  // void 表示不改
  }
  return v;
}
```

**仅 `transformSystemPromptBeforeLlm` 是 pipe**——因为 system prompt 是个 string，前一个改完后一个继续改。

`additionalContext` 走的是 aggregate 模型（并行 + 拼数组），不是 pipe。详见 [04-context-injection §2](04-context-injection.md#2-additionalcontext-的聚合模型).

### 3.4 Around：嵌套

```ts
buildAroundChain(method, ctxArg, inner) {
  return this.hooks
    .filter(h => h[method])
    .reduceRight(
      (next, h) => () => h[method]!(ctxArg, next),
      inner,
    );
}

// 用：
await this.buildAroundChain("wrapTurn", ctx, async () => {
  // turn 主体
})();
```

**嵌套深度** = 注册的 wrap hook 数。早注册的在外层。

### 3.5 执行模型选型决策表

为什么这么分？因为不同 hook 的**性质**不同：

| Hook 性质 | 数据依赖 | 顺序意义 | 适合形态 |
|---|---|---|---|
| 记 metric | 无 | 无 | Event 并行 |
| 写 log | 无 | 无（log 本身有时间戳） | Event 并行 |
| 改 messages 让 LLM 看到 transient context | 有（前一个改完后一个看到） | 有 | Transform pipe 或 aggregate |
| 决定要不要拦 tool call | 短路语义 | 有（严的先判） | Decision 短路 |
| 包整个 turn 加超时 | 嵌套语义 | 有（外层先起 timer） | Around |

## 4. HookResult 返回 envelope

借鉴 Claude Code，所有 hook 用同一个返回 shape（不同方法只用其中一部分字段）：

```ts
export interface HookResult {
  // ── Control flow ──
  /** false → 结束 session。默认 true。 */
  continue?: boolean;
  /** continue=false 时给用户/log 的解释。 */
  stopReason?: string;

  // ── Decision（PreToolUse / UserPromptSubmit）──
  decision?: "allow" | "deny";
  reason?: string;
  /** 改 tool args（PreToolUse 用）。 */
  updatedInput?: Record<string, unknown>;
  /** 改 tool result（PostToolUse 用）。 */
  updatedToolOutput?: ToolExecResult;

  // ── Context injection ──
  /** Transient：包成 attachment 拼到下次 LLM call。 */
  additionalContext?: string;
  /** Persistent：仅 SessionStart 用，作为初始 user message 入 session.messages。 */
  initialUserMessage?: string;

  // ── UX ──
  /** 给用户 console 看的，不进 LLM context。 */
  systemMessage?: string;
}
```

每个 hook 方法**只看到 envelope 里跟它相关的字段**：

| 方法 | 有效字段 |
|---|---|
| `onPreToolUse` | `decision`, `reason`, `updatedInput`, `additionalContext`, `stopReason`, `continue` |
| `onPostToolUse` | `updatedToolOutput`, `additionalContext`, `systemMessage` |
| `onUserPromptSubmit` | `decision`, `additionalContext`, `continue`, `stopReason` |
| `onSessionStart` | `initialUserMessage`, `additionalContext`, `systemMessage` |
| `onSessionEnd` | `continue`, `additionalContext`, `systemMessage` ⚠️ 见 §4.1 |
| `onTurnEnd` | `continue`, `stopReason`, `systemMessage` |
| 其他 Event | `additionalContext`, `systemMessage` |

无效字段被 dispatcher 忽略（不报错，但 dev mode 可以 warn）。

### 4.1 特例：`onSessionEnd` 返 `continue: true` 触发**同 session 续跑**

借鉴 Claude Code `query/stopHooks.ts` 的 stop hook continuation 模式。

**默认行为**：session 跑到 `reason="done"` 后，kernel 触发 `onSessionEnd` 给所有 hook，然后返回 `RunSummary` 给 caller。结束。

**带 continuation**：如果**任一** `onSessionEnd` hook 返回 `{ continue: true, additionalContext: "..." }`，kernel **不**结束 session，而是：

1. 把 `additionalContext` 包成 attachment message 拼进 messages（仅这次 LLM call 看到）
2. session 状态从 "ended" 回到 "running"
3. 自动跑下一个 turn（不需要 caller 干预）
4. 直到下一次 `onSessionEnd` 没有 hook 要求 continue 才真正结束

**用例**：
- 自动续跑：token budget plugin 检测到"预算还剩 30%，请继续深入"
- 用户审批回流：外部事件触发"继续处理"
- 多阶段 workflow：阶段 1 完成 → hook 自动切到阶段 2

**死循环防护**：`SessionConfig.maxContinuations` 默认 5。超过即视为 bug，强行结束并 `reason="max_continuations"`。caller 看 `RunSummary.continuations` 字段感知发生过几次。

**对比 controller 重启**：
- `onSessionEnd → continue: true`：**同 session、同 messages、同 ctx.state**，无缝继续
- `lifecycleRestart` controller：**新 session、新 messages（从 snapshot 继承）、新 ctx.state**，watchdog abort 时用

两者解决不同问题，不冲突。

## 5. 合并规则

多个 hook 返回 result 时，怎么合？

| 字段 | 合并策略 | 理由 |
|---|---|---|
| `continue: false` | **任一 false → false** | 谁说停就停（fail-safe） |
| `stopReason` | **第一个非空的赢** | 第一个发现问题的 hook 解释权大 |
| `decision: "deny"` | **第一个 deny 赢**（short-circuit） | 严策略优先（注册顺序排序） |
| `decision: "allow"` | 无显式 allow 合并——只要没 deny 就 allow | 默认 allow |
| `updatedInput` | **最后一个 writer 赢**（chain 覆盖） | 类似 Redux reducer 链；早改后改都可以 |
| `updatedToolOutput` | 同上 | 同上 |
| `additionalContext` | **数组拼接**，按注册顺序 | 多 plugin 各自加自己的 reminder |
| `initialUserMessage` | **第一个非空的赢**（SessionStart 单次事件） | 只 session 开始一次，多 hook 抢的话第一个赢 |
| `systemMessage` | **数组拼接**，按注册顺序 | 用户能看到所有 hook 的提示 |

### 5.1 一个完整合并例子

```ts
// 3 个 hook 都实现了 onPostToolUse：

// hook A（metrics）：
{ /* 无返回值 */ }

// hook B（tool-output-buffer）：
{ additionalContext: undefined }   // 不注入

// hook C（result sanitizer）：
{
  updatedToolOutput: sanitize(result),
  additionalContext: "<reminder>tool output was sanitized</reminder>",
  systemMessage: "Sanitized tool output for safety",
}

// 并行执行后合并：
{
  updatedToolOutput: <sanitized>,      // C 唯一改 result
  additionalContext: "<reminder>...</reminder>",  // 仅 C 给了
  systemMessage: "Sanitized tool output for safety",
}
```

### 5.2 输出共存约定（plugin 作者必读）

**多个 plugin 可以同时挂同一个 hook 方法，输出会按注册顺序聚合**。这意味着：

- 你的 `additionalContext` 不是独家——别的 plugin 可能也在同一 turn 注 reminder
- 你的 `systemMessage` 不是独家——别的 plugin 也会写 console
- 你的 `decision: "deny"` **可能不是第一个**——但 Decision 路径短路语义保证第一个决断的赢
- 你的 `updatedInput` / `updatedToolOutput` 走 **last-writer-wins**——别的 plugin 后注册会覆盖你

具体到几种典型 event：

| Hook 形态 | 你写 `additionalContext: "X"` 时的行为 |
|---|---|
| `onContinuationCheck`（event 并行） | 跟其他 hook 的 additionalContext 拼成 `string[]`，kernel 逐个 push 成独立 attachment message |
| `onTurnStart` / `onTurnEnd` / `onSessionStart` / `onPostToolUse`（event 并行） | 同上 —— LLM 同 turn 看到 N 段独立 `<system-reminder>` |
| `onPreToolUse`（decision 短路） | dispatcher 把所有 hook 的累积值 `join("\n")` 成**一条** additionalContext 跟着决策返回 |

实操建议：

1. **写 reminder 时假设别人也在写**：用清晰的 tag（`<system-reminder>`, `<perf-warning>`）让 LLM 能区分来源
2. **不要假设你的 attachment 紧邻 user prompt**：可能前后被夹其他 plugin 的内容
3. **别把 additionalContext 当 plugin 间通信渠道**：协作走 `ctx.state.set/get`（约定带 plugin 前缀的 key）

详见 [05-plugins.md §3 ctx.state 约定](05-plugins.md#3-ctxstate-约定).

## 6. Per-hook timeout

每个 hook 自己声明 timeout，kernel 用 `Promise.race([hookFn(), timeoutPromise])` 兜底。

```ts
export interface Hook {
  name: string;
  timeout?: number;  // ms
  ...
}
```

默认值按形态：

| 形态 | 默认 timeout | 超时行为 |
|---|---|---|
| Event | 100ms | 记 `outcome="cancelled"`，结果视为空 |
| Transform (pipe) | 500ms | 返回原值（透明 fallback） |
| Decision | 200ms | 视为 undefined（不发表意见） |
| Around | **不强制**（plugin 自带 timer） | 抛错 → 当 tool error 处理 |

实现：

```ts
async invokeWithTimeout(h, method, ...args) {
  const t = h.timeout ?? DEFAULT_TIMEOUT[methodCategory(method)];
  const inner = new AbortController();
  const innerSignal = inner.signal;

  try {
    return await Promise.race([
      Promise.resolve(h[method](...args, innerSignal /* 看实现要不要传 */)),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          inner.abort();
          reject(new HookTimeoutError(h.name, method, t));
        }, t);
      }),
    ]);
  } catch (err) {
    if (!h.internal) {
      // 记 metric 让用户感知
      // 错误吞掉，fail-open
    }
    return undefined;
  }
}
```

## 7. Sync vs Async

```ts
onToolEnd?(input, ctx): HookResult | void | Promise<HookResult | void>;
```

返回类型是 `T | Promise<T>`。kernel 不区分，统一 `await`。

**`await` 一个非 promise 的开销**：V8 大约 1μs（一次 microtask 调度）。10 个 hook 也就 10μs，可忽略。

收益：

- plugin 作者写 sync 也行、async 也行
- 测试简单（不用 await 半天）
- TS 类型上一致

## 8. 注册顺序 = 执行顺序契约

**这是 API 契约，写进 0.x 不变。**

对顺序敏感的 hook 形态：

| 形态 | 顺序意义 |
|---|---|
| Around | 早注册的在**外层**（先起 timer，后停 timer） |
| Decision | 早注册的**优先决策**（严策略放前） |
| Transform pipe | 早注册的**先改**（后改的看到前改的结果） |
| Event | **顺序无意义**（并行执行；但实际调用是按 array 顺序 .map） |

### 8.1 推荐注册顺序

```ts
new AgentSession({
  hooks: [
    // 1. Around 最外层：能 abort 一切
    watchdog({ turnTimeoutMs: 600_000 }),

    // 2. Decision 严格的先
    leaseDecision({ ... }),
    permissionGate({ ... }),

    // 3. Event（顺序无关）
    metrics({ sink }),
    sessionLog({ dir }),
    toolOutputBuffer({ track: [...] }),
    emptyRunGuard({ maxEmptyTurns: 3 }),
    batchCounter({ triggerTool: "judge_question", batchSize: 8, onFull: ... }),

    // 4. Transform pipe
    trimHistory({ keepRecent: 16 }),     // 先 trim
    systemReminder({ trigger: ... }),    // 再注入（看到的是 trim 后的 messages）
  ],
});
```

## 9. 性能契约

**总原则**：plugin 不在 hot path 做阻塞 I/O。需要持久化走 Sink + 批 flush。

### 9.1 plugin 作者必读 6 条

1. **不在 hook 函数体里做阻塞 I/O**。需要持久化走 Sink + 批量 flush。参考 [`metrics` plugin](05-plugins.md#9-metrics) 的 push-to-buffer + 1s 批 flush 模式。
2. **每个 hook 应在 <10ms 内完成**。超过即视为 bug。
3. **kernel 给每个 hook 100-500ms timeout 兜底**，超时被 cancel，不影响主流程；但**不要靠 timeout 当流程控制**。
4. **plugin 之间通过 `ctx.state` 协作**，约定带前缀的 key 名（如 `"watchdog.lastActivityTs"`）。
5. **不假设其他 plugin 的存在**。你的 plugin 可能跟任意子集一起部署。
6. **抛错不要怕**：kernel 自动 catch + 记 metric + fail-open 继续。但**别故意抛错当控制流**——用 `decision: "deny"`。

### 9.2 性能 budget 实算

bidding-agent 完整 plugin 栈跑一次 tool call 的开销估算：

| 步骤 | 时间 | 备注 |
|---|---|---|
| `wrapToolExec(watchdog)` 起 timer | ~5μs | setTimeout |
| 3 个 `onPreToolUse` 并行（lease / args-inject / permission） | ~10μs | Map lookup + 小对象创建 |
| **实际 tool 执行**（kb_search） | **5-500ms** | 真正的成本在这里 |
| 5 个 `onPostToolUse` 并行（metrics / log / buffer / empty-run / batch-counter） | ~30μs | 5 个 push 操作 |
| 1 个 `transformToolResultAfterExec`（如果是 pipe 模式；当前设计走 Event） | ~5μs | 字符串拼接 |
| `wrapToolExec(watchdog)` 解 timer | ~2μs | clearTimeout |
| **Hook overhead 总计** | **~52μs** | < 0.1ms |

10 个 plugin 同时挂，hook overhead **不到 100μs**。tool 本身随便都是几十毫秒起。**hook 系统不会成为瓶颈**。

### 9.3 反例分析

| 反面案例 | 后果 | 兜底 |
|---|---|---|
| plugin 里 `await fetch(remote)` 200ms | 当前 event 加 200ms 等待 | timeout 100ms 后被 cancel |
| plugin 里 `JSON.stringify(hugeObject)` 50ms | 阻塞 event loop 50ms（不光这 session，整个 Node process） | 无（同步操作 timeout 也救不了；靠 code review） |
| plugin 抛错没 catch | kernel 自动 catch，记 metric，session 继续 | dispatcher 自带 try/catch |
| plugin promise 永不 resolve | timeout 兜底 100ms 后被 cancel | per-hook timeout |
| plugin 死循环 | 阻塞 event loop（同步死循环 timeout 救不了） | 无（靠 code review） |

教训：**plugin 是受信代码**（不是用户输入），但要靠纪律保持 hot path 干净。

## 10. Dispatcher 实现

完整伪代码（~80 行）：

```ts
import type { Hook, HookContext, HookResult } from "./hook.js";

type EventMethod = "onSessionStart" | "onSessionEnd" | "onTurnStart" | "onTurnEnd" | "onLlmEnd" | "onPostToolUse" | "onError";
type DecisionMethod = "onPreToolUse" | "onUserPromptSubmit";
type PipeMethod = "transformSystemPromptBeforeLlm";
type AroundMethod = "wrapTurn" | "wrapToolExec";

const DEFAULT_TIMEOUTS: Record<string, number> = {
  event: 100,
  decision: 200,
  pipe: 500,
  // around 不强制
};

export class HookDispatcher {
  constructor(private hooks: Hook[]) {}

  /** Event：并行，合并结果按 §5 规则。 */
  async fireEvent(method: EventMethod, input: any, ctx: HookContext): Promise<MergedHookResult> {
    const matched = this.hooks.filter(h => typeof h[method] === "function");
    const results = await Promise.all(
      matched.map(h => this.invoke(h, method, [input, ctx], "event")),
    );
    return mergeResults(results, matched.map(h => h.name));
  }

  /** Decision：顺序，第一个非 undefined 短路。 */
  async fireDecision(method: DecisionMethod, input: any, ctx: HookContext): Promise<HookResult | null> {
    for (const h of this.hooks) {
      if (typeof h[method] !== "function") continue;
      const r = await this.invoke(h, method, [input, ctx], "decision");
      if (r && (r.decision || r.updatedInput || r.continue === false)) return r;
    }
    return null;
  }

  /** Transform pipe：顺序，前一个的输出是后一个的输入。 */
  async firePipe(method: PipeMethod, value: any, ctx: HookContext): Promise<any> {
    let v = value;
    for (const h of this.hooks) {
      if (typeof h[method] !== "function") continue;
      const r = await this.invoke(h, method, [v, ctx], "pipe");
      if (r != null) v = r;
    }
    return v;
  }

  /** Around：reduceRight 构造嵌套链。 */
  buildAroundChain<T>(method: AroundMethod, ctxArg: any, inner: () => Promise<T>): () => Promise<T> {
    return this.hooks
      .filter(h => typeof h[method] === "function")
      .reduceRight(
        (next, h) => () => (h[method] as any)(ctxArg, next),
        inner,
      );
  }

  private async invoke(h: Hook, method: string, args: any[], category: "event" | "decision" | "pipe"): Promise<any> {
    const t = h.timeout ?? DEFAULT_TIMEOUTS[category];
    const timer = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new HookTimeoutError(h.name, method, t)), t),
    );
    try {
      return await Promise.race([Promise.resolve((h as any)[method](...args)), timer]);
    } catch (err) {
      if (!h.internal) {
        // 记 metric：hook.failed { name, method, err }
      }
      return undefined;  // fail-open
    }
  }
}

class HookTimeoutError extends Error {
  constructor(public hookName: string, public method: string, public timeoutMs: number) {
    super(`Hook "${hookName}" method "${method}" timed out after ${timeoutMs}ms`);
  }
}

function mergeResults(results: (HookResult | undefined)[], names: string[]): MergedHookResult {
  const out: MergedHookResult = {};
  const additionalContexts: string[] = [];
  const systemMessages: string[] = [];
  for (const r of results) {
    if (!r) continue;
    if (r.continue === false) {
      out.continue = false;
      if (!out.stopReason && r.stopReason) out.stopReason = r.stopReason;
    }
    if (r.updatedToolOutput) out.updatedToolOutput = r.updatedToolOutput;
    if (r.additionalContext) additionalContexts.push(r.additionalContext);
    if (r.systemMessage) systemMessages.push(r.systemMessage);
    if (r.initialUserMessage && !out.initialUserMessage) out.initialUserMessage = r.initialUserMessage;
  }
  out.additionalContexts = additionalContexts;
  out.systemMessages = systemMessages;
  return out;
}

export interface MergedHookResult {
  continue?: boolean;
  stopReason?: string;
  updatedToolOutput?: ToolExecResult;
  additionalContexts?: string[];
  systemMessages?: string[];
  initialUserMessage?: string;
}
```

## 11. 借鉴自 Claude Code

主要学习：

| 设计点 | Claude Code 怎么做 | 我们怎么用 |
|---|---|---|
| 27 个事件枚举 | `HOOK_EVENTS` 数组 + `hookSpecificOutput` discriminated union | 我们用方法名分（DX 好），返回 envelope 用统一 shape |
| 统一返回 envelope | `syncHookResponseSchema`（continue/decision/additionalContext/...） | 直接 borrow，剪掉 MCP-specific 字段 |
| `additionalContext: string` | 包成 `createAttachmentMessage({ type: 'hook_additional_context', hookName, hookEvent })` | 我们也包成 attachment 而非裸 splice |
| `outcome: 'success' \| 'blocking' \| ...` | 每次 hook 执行的 outcome 报告 | 我们记 `hook.failed` / `hook.cancelled` metric |
| `HookCallback.timeout` | per-hook 超时 | 直接 borrow |
| `internal: boolean` | 内部 hook 不上报 metric | 直接 borrow |
| `async: true` envelope option | fire-and-forget | **暂不做**，v0 不需要 |
| `HookCallbackMatcher.matcher` | 按 tool name 模糊匹配 | **暂不做**，plugin body if 判断够用 |
| `AggregatedHookResult` | 显式定义合并语义 | 直接 borrow（见 §5） |

## 12. 反例与禁忌

### 12.1 ❌ 用 hook 抛错当控制流

```ts
// ❌ 别这样：
onPreToolUse(call, ctx) {
  if (lockedOut(call)) throw new Error("locked");  // kernel 会 catch + fail-open，你想要的"拦截"没生效
}

// ✅ 用 decision：
onPreToolUse(call, ctx) {
  if (lockedOut(call)) return { decision: "deny", reason: "locked" };
}
```

### 12.2 ❌ 在 hook 里 await I/O

```ts
// ❌ 别这样（200ms 卡死整个 turn 的 hook 链）：
onToolEnd(input, ctx) {
  await fetch("https://logserver/log", { method: "POST", body: ... });
}

// ✅ push 到 sink 队列，sink 自己批 flush：
onToolEnd(input, ctx) {
  this.sink.enqueue({ ... });  // 同步 push，纳秒级
}
```

### 12.3 ❌ Plugin 之间直接 import

```ts
// ❌ 别这样：
import { getMetricsSink } from "../metrics/index.js";

onToolEnd(input, ctx) {
  getMetricsSink().record(...);  // 紧耦合，没装 metrics plugin 就崩
}

// ✅ 通过 ctx.state 总线：
onToolEnd(input, ctx) {
  const sink = ctx.state.get("metrics.sink") as MetricsSink | undefined;
  sink?.record(...);  // 没装就跳过
}
```

### 12.4 ❌ 修改 ctx.messages

```ts
// ❌ 别这样（ctx.messages 是 ReadonlyArray，但 TS 不能阻止用户 cast）：
(ctx.messages as Message[]).push(myMsg);

// ✅ 走 hook 接口：
return { additionalContext: "..." };  // transient
// 或：
ctx.appendMessage(myMsg);  // persistent
```

### 12.5 ❌ 用 hook 实现 around 行为

```ts
// ❌ 别用 onPreToolUse + onPostToolUse 模拟 around：
onPreToolUse(input, ctx) {
  ctx.state.set("timer", setTimeout(() => ..., 10000));
}
onPostToolUse(input, ctx) {
  clearTimeout(ctx.state.get("timer"));  // 容易漏 cleanup（tool 抛错的话）
}

// ✅ 用 wrapToolExec：
wrapToolExec(call, ctx, next) {
  const timer = setTimeout(() => ..., 10000);
  try { return await next(); } finally { clearTimeout(timer); }
}
```

## 13. 下一步

- [04-context-injection](04-context-injection.md) —— Context 注入的四种机制详解
- [05-plugins](05-plugins.md) —— 12 个标准 plugin 如何用 hook 接口实现
- [02-kernel](02-kernel.md) —— kernel 的 loop 怎么调用 dispatcher
