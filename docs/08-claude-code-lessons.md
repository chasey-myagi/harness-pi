# 08 · Claude Code Lessons

> 系统扫描 Claude Code 源码后，按本项目各模块整理"借鉴 / 拒绝 / 推迟"的具体建议。每条带源码引用 + 提议的 API 改动。

## 0. 扫描方法

读了 `/Users/chasey/Dev/cc/external/claude-code/src/` 下：

- `Tool.ts` (792 行) — Tool 接口
- `query.ts` (1729 行) — 主 loop
- `QueryEngine.ts` (1295 行) — query 入口封装
- `query/config.ts` / `query/stopHooks.ts` / `query/tokenBudget.ts` — query 子模块
- `utils/forkedAgent.ts` (689 行) — sub-agent fork 模式
- `utils/sessionStart.ts` / `utils/sideQuestion.ts` — session 生命周期 + side question
- `utils/processUserInput/processUserInput.ts` — user prompt 处理
- `types/hooks.ts` (290 行) — hook 类型（[03-hook-system](03-hook-system.md) 已用过）
- `tasks/types.ts` + `tasks/*Task/` — Task 子系统
- `cost-tracker.ts` (323 行) — cost 追踪
- `utils/permissions/*` — 权限系统
- `entrypoints/sdk/coreTypes.ts` — `HOOK_EVENTS` 数组（[03-hook-system](03-hook-system.md) 已引用）

跨 13 个文件 / 约 6000 行核心代码，按模块归类后写下结论。

## 1. 决策总览

按"borrow / skip / defer"对每个 finding 分类：

| 标记 | 含义 |
|---|---|
| ✅ **borrow** | v0 / v0.x 就加进设计 |
| ⏸️ **defer** | v0.x 之后考虑；先记下来 |
| ❌ **skip** | 明确决定不要（理由必须说清） |

| # | Finding | 来源 | 决策 | 影响哪份 doc |
|---|---|---|---|---|
| 1.1 | Config / State 分离 | `query.ts` + `query/config.ts` | ✅ borrow | [02-kernel](02-kernel.md) |
| 1.2 | Query 用 async generator yield events | `query.ts:219 export async function* query` | ✅ borrow | [02-kernel](02-kernel.md) |
| 1.3 | `maxOutputTokensRecoveryCount` 自动恢复 context overflow | `query.ts State` | ❌ skip | (不写) |
| 1.4 | `autoCompactTracking` 内置 compaction | `query.ts State` | ❌ skip | (不写) |
| 2.1 | `isConcurrencySafe(input)` + 同 turn 并行执行多 tool | `Tool.ts:402` | ✅ borrow | [02-kernel](02-kernel.md) + [types.ts](../packages/core/src/types.ts) |
| 2.2 | `interruptBehavior(): 'cancel' \| 'block'` | `Tool.ts:416` | ⏸️ defer | (steering 不在 v0) |
| 2.3 | `isReadOnly` / `isDestructive` / `isOpenWorld` | `Tool.ts:404-434` | ⏸️ defer | (permission 不在 v0) |
| 2.4 | `inputsEquivalent(a, b)` 重复 tool call 去重 | `Tool.ts:401` | ⏸️ defer | (cache 优化，v0.x) |
| 2.5 | `aliases: string[]` tool 改名向后兼容 | `Tool.ts:371` | ✅ borrow | [types.ts](../packages/core/src/types.ts) |
| 2.6 | `ToolResult.newMessages` tool 可以返回额外 message | `Tool.ts:322` | ✅ borrow | [02-kernel](02-kernel.md) + [04-context-injection](04-context-injection.md) |
| 2.7 | `ToolResult.contextModifier` tool 修改 loop context | `Tool.ts:330` | ❌ skip | (太通用，破坏 plugin 边界) |
| 2.8 | `searchHint` + `shouldDefer` lazy tool 加载 | `Tool.ts:378, 442` | ⏸️ defer | (context 优化，需要时做) |
| 3.1 | Token budget tracker（连续 turn token 监控 + 继续提示） | `query/tokenBudget.ts` | ✅ borrow | [05-plugins](05-plugins.md) 新增 plugin |
| 3.2 | Cost tracker | `cost-tracker.ts` | ✅ borrow | [05-plugins](05-plugins.md) 新增 plugin |
| 3.3 | Stop hook with continuation（onSessionEnd 返 continue=true → 再跑一轮） | `query/stopHooks.ts` | ✅ borrow | [03-hook-system](03-hook-system.md) + [06-controllers](06-controllers.md) |
| 3.4 | `structuredOutputEnforcement` 结构化输出校验 | `QueryEngine.ts` import | ⏸️ defer | (RAG/特定 agent 才需要) |
| 4.1 | `forkedAgent` + `CacheSafeParams` 共享父 prompt cache | `utils/forkedAgent.ts` | ✅ borrow | [06-controllers](06-controllers.md) sideQuestion 实现细节 |
| 4.2 | Task 子系统多种类（Local / Remote / InProcess / Workflow） | `tasks/types.ts` | ⏸️ defer | (Controller 形态多样性，v0 三种够) |
| 4.3 | `executeTaskCompletedHooks` / `executeTeammateIdleHooks` | `query/stopHooks.ts` imports | ⏸️ defer | (Controller 自己 emit event 即可，不在 kernel) |
| 5.1 | `saveCacheSafeParams` 模块级 mutable side channel | `forkedAgent.ts:73` | ❌ skip | (作者自己注释承认是 hack) |
| 5.2 | `appendSystemMessage` UI-only 消息（normalizeMessagesForAPI 边界过滤） | `Tool.ts:207` | ✅ borrow | [03-hook-system](03-hook-system.md) `systemMessage` 字段已经接近这个 |
| 5.3 | 多 `createXxxMessage` helper（user / system / interrupt / attachment） | `utils/messages.ts` | ✅ borrow | [02-kernel](02-kernel.md) 暴露 `createAttachmentMessage` |
| 6.1 | Permission 系统（rule / classifier / denialTracking / autoMode） | `utils/permissions/*` | ❌ skip | (太重；plugin `leaseDecision` 模式已足够) |
| 6.2 | MCP 集成 | `services/mcp/*` | ❌ skip | (Mario 不做，我们也不做) |
| 6.3 | Statsig / feature gates | `query/config.ts` | ❌ skip | (业务侧自己控制) |

下面按模块详述每条。

---

## 2. Kernel ([02-kernel.md](02-kernel.md))

### 2.1 ✅ Config / State 分离

**Claude Code**：`query.ts` 把 `params`（immutable，入口传进）和 `state`（mutable，loop 间更新）显式分开，配合 `query/config.ts` 的 `QueryConfig`：

```ts
// query/config.ts:25
export type QueryConfig = {
  sessionId: SessionId
  gates: { streamingToolExecution: boolean; emitToolUseSummaries: boolean; ... }
}

// query.ts:204
type State = {
  messages: Message[]
  toolUseContext: ToolUseContext
  autoCompactTracking: ...
  turnCount: number
  transition: Continue | undefined
  // ...
}
```

注释解释：

> Separating these from the per-iteration State struct and the mutable ToolUseContext makes future step() extraction tractable — a pure reducer can take (state, event, config) where config is plain data.

**对我们的启示**：把 `AgentSession` 内部状态显式拆成 `SessionConfig`（immutable: model, tools, hooks, maxTurns）+ `SessionState`（mutable: messages, turnIdx, abortRequested）。好处：

- 未来想抽 pure reducer 测试不会被自己绊住
- ctx 暴露给 hook 的字段更明确（hook 不需要看 config，只看 state）
- 序列化只导 state，config 由 caller 重新提供

**API 改动**（[02-kernel.md](02-kernel.md) 现版本是 `class AgentSession` 内字段混在一起；提议分离）：

```ts
interface SessionConfig {
  readonly model: Model<any>;
  readonly tools: ReadonlyArray<HarnessTool>;
  readonly systemPrompt: string;
  readonly hooks: ReadonlyArray<Hook>;
  readonly maxTurns: number;
  readonly sessionId: string;
}

interface SessionState {
  messages: Message[];
  turnIdx: number;
  abortRequested: { reason: string } | null;
  pendingAttachments: Attachment[];
}

class AgentSession {
  readonly config: SessionConfig;
  private state: SessionState;
  // ...
}
```

`HookContext` 只暴露 state 的 readonly view + 几个 mutator，不暴露 config（hook 不应该改 config）。

### 2.2 ✅ Query 用 async generator yield events

**Claude Code**：

```ts
// query.ts:219
export async function* query(
  params: QueryParams,
): AsyncGenerator<
  | StreamEvent
  | RequestStartEvent
  | Message
  | TombstoneMessage
  | ToolUseSummaryMessage,
  Terminal
> { ... }
```

消费者可以 `for await (const event of query(...))` 流式拿 event，做 UI 渲染 / 中途 abort / 取消订阅。比 `Promise<RunSummary>` 灵活。

**对我们的启示**：v0 我们设计是 `run(): Promise<RunSummary>`。**升级成 async generator 兼容**：

```ts
class AgentSession {
  // 同时提供两种入口：
  
  // 1. 流式（generator）：高级用法，能流式消费 event
  async *runStream(prompt: string, opts?): AsyncGenerator<SessionEvent, RunSummary> { ... }
  
  // 2. 简单（promise）：默认用法，等同 `await runStream().return()`
  async run(prompt: string, opts?): Promise<RunSummary> {
    let summary: RunSummary;
    for await (const _ of this.runStream(prompt, opts)) {
      /* 默认消费 ignore */
    }
    return summary!;
  }
}
```

`SessionEvent` 是 kernel 内部产出的事件流（turn_start / turn_end / llm_chunk / tool_start / ...），跟 hook event 同源但 hook event 是钩子调用，generator event 是给消费者看的。

[02-kernel.md](02-kernel.md) §1 加这两个签名。

### 2.3 ❌ `maxOutputTokensRecoveryCount` 自动恢复 context overflow

**Claude Code**：`State.maxOutputTokensRecoveryCount` + `maxOutputTokensOverride` 在 loop 中跟踪 context overflow 错误，自动减小 max_tokens 重试。

**为什么 skip**：
- 这是 Anthropic API 特定的错误恢复
- bidding-agent 实际场景：context overflow 时直接 abort + 让 watchdog 重启 fresh session 比"在原 session 里魔法缩小 token"更直接
- 想要的人写个 around plugin 包 `wrapLlmCall` 自己做

### 2.4 ❌ `autoCompactTracking` 内置 compaction

**Claude Code**：`State.autoCompactTracking` + `hasAttemptedReactiveCompact` —— 内置 compaction 策略。

**为什么 skip**：
- compaction 策略是 application-specific（要不要保留 thinking、user message、tool result）
- 我们已经决定 compaction 走 `transformMessagesBeforeLlm` plugin
- 内置一个会卡死所有非典型用法

---

## 3. HarnessTool / Tool 接口（[types.ts](../packages/core/src/types.ts)）

### 3.1 ✅ `isConcurrencySafe(input)` + 同 turn 并行执行多 tool

**Claude Code**：

```ts
// Tool.ts:402
isConcurrencySafe(input: z.infer<Input>): boolean

// Tool.ts:759 默认实现：
isConcurrencySafe: (_input?: unknown) => false,
```

多个 tool 在同一 assistant message 里被一起调用时（LLM 一次生成多 toolCall），如果**全部** concurrency-safe，可以 `Promise.all` 并行执行；否则顺序。

**真实工具的选择**：
- `TaskGetTool`（读 task 状态）→ safe
- `WebFetchTool` → safe
- `WebSearchTool` → safe
- `AskUserQuestionTool` → 自己声明 safe（虽然有副作用，但跟其他工具不冲突）

不 safe 的（默认）：
- 写文件 / 改文件 / bash 命令——可能有顺序依赖

**对我们的启示**：极有价值。bidding-agent 单 turn 多 `submit_evidence` / `judge_question` 并行能省一截时间。

**API 改动**（[types.ts](../packages/core/src/types.ts)）：

```ts
export interface HarnessTool extends Tool {
  execute(args, ctx, signal): Promise<ToolExecResult>;
  label?: string;
  
  // 新增：默认 false（保守）
  isConcurrencySafe?(input: Record<string, unknown>): boolean;
}
```

[02-kernel.md §2 loop 算法](02-kernel.md#2-loop-算法完整伪代码) 改动：

```
for call in toolCalls:
  ...

// 改为：
const safeBatch: ToolCall[] = [];
const sequential: ToolCall[] = [];
for (const call of toolCalls) {
  const tool = this.tools.find(t => t.name === call.name);
  if (tool?.isConcurrencySafe?.(call.arguments)) safeBatch.push(call);
  else sequential.push(call);
}
// safeBatch 并行执行
await Promise.all(safeBatch.map(call => executeOne(call)));
// sequential 顺序
for (const call of sequential) await executeOne(call);
```

注意 hook 派发：每个 tool 的 PreToolUse / PostToolUse 还是各自串行；只是 `tool.execute()` 本身并行。

### 3.2 ⏸️ `interruptBehavior(): 'cancel' | 'block'` defer

**Claude Code**：`Tool.ts:416`

```ts
interruptBehavior?(): 'cancel' | 'block'
```

当用户在 tool 跑的时候发了 steering message：
- `'cancel'` → 立即停 tool 丢结果
- `'block'`（默认）→ 跑完再处理 steering

**为什么 defer**：v0 没有 steering 概念（那是 pi-coding-agent 的终端 UX）。后端 agent 想做 steering 自己加 plugin + 走 `wrapToolExec` 实现。

### 3.3 ⏸️ `isReadOnly` / `isDestructive` / `isOpenWorld` defer

**Claude Code**：

```ts
// Tool.ts:404
isReadOnly(input: z.infer<Input>): boolean
isDestructive?(input: z.infer<Input>): boolean
isOpenWorld?(input: z.infer<Input>): boolean
```

给 permission system / 沙箱模式 / 用户警告用。

**为什么 defer**：
- 我们没有内置 permission 系统（plugin 用 `decision: deny` 做就够）
- 业务侧自己分类（"这个 tool 在我们 agent 里算敏感"）灵活度更高
- v0.x 看用户反馈再决定

### 3.4 ⏸️ `inputsEquivalent(a, b)` 重复 call 去重 defer

**Claude Code**：

```ts
// Tool.ts:401
inputsEquivalent?(a: z.infer<Input>, b: z.infer<Input>): boolean
```

判断两次 tool call 是不是"实质相同"——比如 `Read` 同一个文件第二次直接 reuse 第一次的结果。

**为什么 defer**：这是 cache 优化，跟 plugin 层的 tool-output-buffer 有部分重叠。v0.x 看真实需要再加。

### 3.5 ✅ `aliases: string[]` tool 改名向后兼容

**Claude Code**：

```ts
// Tool.ts:371
aliases?: string[]

// Tool.ts:348
export function toolMatchesName(
  tool: { name: string; aliases?: string[] },
  name: string,
): boolean {
  return tool.name === name || (tool.aliases?.includes(name) ?? false)
}
```

LLM 学了旧名字怎么办？给新版工具加 aliases，旧 toolCall 还能路由到新工具。

**对我们的启示**：低成本高价值。bidding-agent 已经改过几次工具名（submit_evidence v1 → v2 paramaters），这种向后兼容能省迁移痛苦。

**API 改动**（[types.ts](../packages/core/src/types.ts)）：

```ts
export interface HarnessTool extends Tool {
  // 新增：
  aliases?: string[];
}

// kernel 内部用 findToolByName(tools, callName) helper
```

### 3.6 ✅ `ToolResult.newMessages` tool 可以返回额外 message

**Claude Code**：

```ts
// Tool.ts:321
export type ToolResult<T> = {
  data: T
  newMessages?: (UserMessage | AssistantMessage | AttachmentMessage | SystemMessage)[]
  contextModifier?: (context: ToolUseContext) => ToolUseContext
  mcpMeta?: { ... }
}
```

Tool 不止返回自己的输出，还能往 conversation 里加额外 message（如附件 / 用户提示 / 状态说明）。

**对我们的启示**：bidding-agent 的 `judge_question` 完成后想加一句"批次 8 题完成，将刷新上下文"——目前是塞在 tool result 文本里。**改成 ToolResult.newMessages 更干净**。

**API 改动**：

```ts
export interface ToolExecResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
  
  // 新增：tool 想往 messages 里追加的额外消息
  newMessages?: Message[];
}
```

[02-kernel.md §loop 算法](02-kernel.md#2-loop-算法完整伪代码) 4d 后加一步：

```
if rawResult.newMessages:
  for msg in rawResult.newMessages:
    this.messages.push(msg)
```

[04-context-injection.md](04-context-injection.md) 加一节"通过 tool 返回值注入"。

### 3.7 ❌ `ToolResult.contextModifier` tool 修改 loop context

**Claude Code**：

```ts
contextModifier?: (context: ToolUseContext) => ToolUseContext
```

一个 tool 调用后能改 loop 的 `ToolUseContext`（比如调整 `mainLoopModel`、改 `mcpClients`）。

**为什么 skip**：
- 破坏 plugin 边界——任何 tool 都能改 session 行为，难追溯
- 同样的效果用 hook（`onPostToolUse → updatedToolOutput`）+ plugin 状态做更明确
- 注释里说"contextModifier is only honored for tools that aren't concurrency safe"——edge case 不少

### 3.8 ⏸️ `searchHint` + `shouldDefer` lazy tool 加载 defer

**Claude Code**：

```ts
// Tool.ts:378
searchHint?: string  // "3–10 words, no trailing period"

// Tool.ts:442
shouldDefer?: boolean  // 不在初始 prompt 里包含，等 ToolSearch 找出来再加载
```

`ToolSearchTool` 让 LLM 通过 keyword 搜出 tool 然后才注入 schema——避免初始 prompt 太大。

**对我们的启示**：v0 的 agent 工具数量都不多，这套机制太重。v0.x 等到有用户 50+ tool 才考虑。

---

## 4. Plugins ([05-plugins.md](05-plugins.md))

### 4.1 ✅ Token budget tracker plugin

**Claude Code**：`query/tokenBudget.ts` 跟踪 per-turn token 消耗，按 budget 决定要不要 `continue`（往 LLM 注 nudge "你还有 X% 预算，继续"）vs `stop`：

```ts
// query/tokenBudget.ts:65
const isDiminishing =
  tracker.continuationCount >= 3 &&
  deltaSinceLastCheck < DIMINISHING_THRESHOLD &&
  tracker.lastDeltaTokens < DIMINISHING_THRESHOLD
```

判 diminishing returns 三条件：连续超 3 turn + delta < 500 + 上次也 < 500。

**对我们的启示**：标准 plugin。

**新 plugin**（加进 [05-plugins.md](05-plugins.md) §5.10）：

```ts
import type { Hook, HookContext } from "@harness-pi/core";

export interface TokenBudgetOptions {
  /** 这个 session 的 token budget。null = 不限。 */
  budget: number | null;
  /** Budget 到达 X% 时停。默认 0.9。 */
  completionThreshold?: number;
  /** Diminishing returns 阈值。默认 500。 */
  diminishingThreshold?: number;
  /** 触发 nudge 的回调（注 reminder / abort / 记 metric）。 */
  onNudge?: (ctx: HookContext, status: NudgeStatus) => void;
  onStop?: (ctx: HookContext, reason: string) => void;
}

const KEY = "token-budget.tracker";

export function tokenBudget(opts: TokenBudgetOptions): Hook {
  return {
    name: "token-budget",

    onTurnEnd(input, ctx) {
      const tracker = (ctx.state.get(KEY) as Tracker) ?? newTracker();
      const turnTokens = tracker.lastGlobalTurnTokens + (input.assistantMessage.usage?.output ?? 0);
      // ...诊断 / 决策（详见 Claude Code query/tokenBudget.ts:51）
      ctx.state.set(KEY, updated);
    },
  };
}
```

### 4.2 ✅ Cost tracker plugin

**Claude Code**：`cost-tracker.ts` 累计 token / cost USD / API duration / 行数变化。

**对我们的启示**：v0 标准 plugin。不要复制他们的全局 state 模式（getTotalCostUSD 等顶层 getter），用 plugin + sink：

```ts
import type { Hook, HookContext } from "@harness-pi/core";

export interface CostTrackerOptions {
  /** 模型成本表。可选；不传则只统计 token 不算 cost。 */
  costModel?: (modelId: string, usage: Usage) => number;
  /** 累计读取入口（业务代码用）。 */
}

const KEY = "cost-tracker.state";

export function costTracker(opts: CostTrackerOptions = {}): Hook {
  return {
    name: "cost-tracker",

    onSessionStart(_input, ctx) {
      ctx.state.set(KEY, { input: 0, output: 0, cached: 0, costUSD: 0, byModel: new Map() });
    },

    onLlmEnd(input, ctx) {
      const state = ctx.state.get(KEY) as CostState;
      state.input += input.msg.usage.input;
      state.output += input.msg.usage.output;
      // ...
    },
  };
}

export function getCostStats(ctx: HookContext): CostState | undefined {
  return ctx.state.get(KEY) as CostState | undefined;
}
```

### 4.3 ✅ Stop hook continuation pattern（onSessionEnd 返 continue=true → 再跑一轮）

**Claude Code**：`query/stopHooks.ts` 和 `utils/hooks.ts` 的 `executeStopHooks`——session 自然结束时跑 hook，hook 能注 follow-up message + 让 loop 再跑一轮：

```ts
// query.ts State 里 stopHookActive: boolean | undefined
// query/stopHooks.ts 处理 follow-up 注入
```

**对我们的启示**：我们的 [03-hook-system §4 HookResult](03-hook-system.md#4-hookresult-返回-envelope) 已经有 `continue?: boolean` 字段，但**没明确写"onSessionEnd 返 continue=true 触发自动续跑"的语义**。补这条：

在 [03-hook-system.md](03-hook-system.md) §4 加：

```md
**特例**：`onSessionEnd` 返回 `{ continue: true, additionalContext: "..." }` 触发 kernel 再跑一轮：
- session 状态从 "ended" 回到 "running"
- additionalContext 作为下一轮的 user message 注入
- 多 hook 返 continue=true → 多次续跑（用 maxContinuations 兜底防死循环）

用法：
- 用户审批 / 外部事件 → "继续处理"
- 自动续跑 prompt：根据 token budget 没到达
- 多步 workflow 阶段切换

注意：跟 controller 的 lifecycleRestart 不同——后者是 abort 后创建新 session；这个是同 session 继续。
```

[06-controllers.md](06-controllers.md) 也加一节说明 controller 跟 stop hook 的边界。

### 4.4 ⏸️ `structuredOutputEnforcement` defer

**Claude Code**：`QueryEngine.ts` import `registerStructuredOutputEnforcement`——给 LLM 强制结构化输出（JSON schema 校验）。

**为什么 defer**：业务 specific。要做的人自己写个 `transformMessagesBeforeLlm` plugin。

---

## 5. Controllers ([06-controllers.md](06-controllers.md))

### 5.1 ✅ `forkedAgent` + `CacheSafeParams` 共享父 prompt cache

**Claude Code**：`utils/forkedAgent.ts:57`

```ts
export type CacheSafeParams = {
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  toolUseContext: ToolUseContext
  forkContextMessages: Message[]
}
```

子 agent 用**父 agent 的 systemPrompt + cache-prefix messages** → API prompt cache hit → 大幅省 token。

`maxOutputTokens` 改动会 bust cache（thinking config 是 cache key 一部分），文档明确警告。

**对我们的启示**：[06-controllers §6.1 sideQuestion](06-controllers.md#61-sidequestionclaude-code-btw-模式) 现在是占位说明。**这一节展开成完整设计**，包含 cache-safe params 协议：

```ts
// packages/plugins/src/controllers/side-question.ts

export interface SideQuestionOptions {
  parentSession: AgentSession;
  question: string;
  tools?: HarnessTool[];          // 默认 []
  maxTurns?: number;              // 默认 1
  thinkingConfig?: ThinkingConfig; // !!! 必须跟父 session 一致，否则破坏 cache
  skipCacheWrite?: boolean;       // 默认 true（一次性 fork，不写新 cache）
}

export async function sideQuestion(opts: SideQuestionOptions): Promise<SideQuestionResult> {
  // 1. 取父 session 的 cache-safe 部分
  const parentMessages = [...opts.parentSession.messages];
  const parentSystemPrompt = opts.parentSession.config.systemPrompt;
  const parentModel = opts.parentSession.config.model;
  
  // 2. wrap 问题为 system-reminder
  const wrappedQuestion = `<system-reminder>This is a side question...</system-reminder>\n\n${opts.question}`;
  
  // 3. 创建 fork session
  const forkSession = new AgentSession({
    model: parentModel,
    systemPrompt: parentSystemPrompt,
    tools: opts.tools ?? [],
    initialMessages: parentMessages,
    maxTurns: opts.maxTurns ?? 1,
  });
  
  // 4. 跑
  const summary = await forkSession.run(wrappedQuestion);
  
  // 5. 抽 response（参考 Claude Code extractSideQuestionResponse）
  return {
    response: extractFinalText(forkSession.messages),
    usage: forkSession.snapshot().totalUsage,
  };
}
```

把 Claude Code `sideQuestion.ts` 的 `runSideQuestion` 当 reference，全文 156 行就照搬。

### 5.2 ⏸️ Task 子系统多种类 defer

**Claude Code**：`tasks/` 下有 LocalShell / LocalAgent / Remote / InProcess / Workflow / Monitor / Dream 多种 Task。每种是一个状态机 + UI。

**对我们的启示**：v0 三个 controller（lifecycleRestart / workPool / leaseQueue）够覆盖 bidding-agent 的需求。后续如果出现新模式（如 webhook-triggered agent、cron 触发 agent），按 Claude Code 的形式建一个新 controller。

不需要把所有 Task 类型预先定义在 v0。

### 5.3 ⏸️ `executeTaskCompletedHooks` / `executeTeammateIdleHooks` defer

**Claude Code**：`HOOK_EVENTS` 含 `TaskCreated` / `TaskCompleted` / `TeammateIdle`——Task 生命周期 hook。

**对我们的启示**：Controller 自己 emit `controller.taskCompleted` event 通过 metrics sink 即可，不在 kernel hook 里。降低 kernel 复杂度。

如果未来 v0.x Controller 想接 plugin（比如"task 完成 → 触发 lifecycle hook"），单独设计一套 Controller hook，不混进 kernel hook。

---

## 6. Adapters ([07-adapters.md](07-adapters.md))

### 6.1 ❌ Cost tracker 全局 state 模式

**Claude Code**：`cost-tracker.ts` 用 `bootstrap/state.js` 的全局 mutable（getTotalInputTokens / getTotalCostUSD 等顶层 getter）。

**为什么 skip**：
- 全局 state 跨 session 串味
- 测试隔离困难
- 我们走 plugin + ctx.state + sink 模式（[5.2](#42--cost-tracker-plugin)）

### 6.2 ✅ `BatchingSink` 的 unify pattern

我们 [07-adapters §3 通用 batching 模式](07-adapters.md#3-通用-batching-模式) 已经设计了。Claude Code 没有同等抽象（他们多个 logging path 各写各的），**我们这个抽象比他们干净**。保持。

---

## 7. Context Injection ([04-context-injection.md](04-context-injection.md))

### 7.1 ✅ `appendSystemMessage` UI-only 消息 + boundary 过滤

**Claude Code**：`Tool.ts:207`

```ts
appendSystemMessage?: (
  msg: Exclude<SystemMessage, SystemLocalCommandMessage>,
) => void
```

`SystemMessage` 推到 UI 的 REPL message list，但在 `normalizeMessagesForAPI` 边界**被 type 强制过滤掉**——LLM 永远看不到。

**对我们的启示**：我们的 `HookResult.systemMessage` 现在是"给用户 console 看的"，但**没明确说在哪里被过滤**。补：

在 [02-kernel §3 消息管理](02-kernel.md#3-消息管理) 加：

```md
### `systemMessage` 的过滤边界

Hook 返回的 `systemMessage` 字段：
- ✅ 通过 `onSessionEvent` 回调 emit 给消费者（log 到 console / 显示在 UI）
- ❌ **永远不进 `session.messages`，永远不发给 LLM**

实现：kernel 把 systemMessage push 到一个独立的 `consoleSink`，不进消息 pipeline。
```

### 7.2 ✅ 多 `createXxxMessage` helper

**Claude Code**：`utils/messages.ts` 有 `createUserMessage` / `createSystemMessage` / `createUserInterruptionMessage` / `createAttachmentMessage` 等。

**对我们的启示**：kernel 暴露：

```ts
// packages/core/src/messages.ts
export function createUserMessage(content: string | Content[]): Message;
export function createAttachmentMessage(opts: {
  type: "hook_additional_context" | "tool_result_overflow" | ...;
  content: string;
  hookName?: string;
  hookEvent?: string;
}): Message;
```

让 plugin 不用各自实现这些。

[02-kernel.md](02-kernel.md) 加一节"helper 导出"。

---

## 8. 明确不借鉴的（理由必须说清）

### 8.1 ❌ Permission 系统（`utils/permissions/*`）

Claude Code 有完整的 permission 体系：
- `PermissionRule` schema
- `PermissionUpdate` 增量更新规则
- `bashClassifier` 分类 bash 命令
- `dangerousPatterns` 危险命令检测
- `autoModeState` 自动模式
- `denialTracking` 拒绝计数（达到阈值改 fallback 策略）

**为什么 skip**：
- 这是 coding agent 特定的"防止 LLM 删生产数据"系统
- 后端 agent 的"权限"更多是业务概念（这个 user 能不能调这个 tool），用 plugin 写一个 `permissionPlugin` 就够
- 我们的 `decision: deny` 模式已覆盖最核心需求

### 8.2 ❌ MCP 集成

Mario 在 pi-mono 明确说不做 MCP（[pi-coding-agent README §Philosophy](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent#philosophy)）。我们也不做。用户要装 plugin 自己接。

### 8.3 ❌ Feature gates / Statsig

Claude Code 在 `query/config.ts:18` 大量用 `checkStatsigFeatureGate_*` 控制功能开关。

**为什么 skip**：业务侧自己控制，core 不该绑特定 feature flag 系统。

### 8.4 ❌ `saveCacheSafeParams` 模块级 mutable

`forkedAgent.ts:73-79` 用模块级 mutable 当 side channel。注释自承：

> This side channel avoids changing the Promise<HookResultMessage[]> return type that main.tsx and print.ts both already await on... rippling a structural return-type change through that handoff would touch five callsites for what is a print-mode-only value.

**为什么 skip**：Claude Code 自己也觉得这是 hack。我们 ctx.state 模式更干净。

---

## 9. 落地清单（已完成 / 已驳回）

> 这份清单原本是 12 条 lesson 的实施 plan。Review 后做了 ✅ 留 / ❌ 删 / ⚠️ 降级保留 三种决定。下面是最终结果。

### ✅ 已落进设计（v0 加进 docs / types.ts）

- [x] [types.ts](../packages/core/src/types.ts)：HarnessTool 加 `isConcurrencySafe` + `aliases` + `ToolExecResult.newMessages`
- [x] [types.ts](../packages/core/src/types.ts)：暴露 `createUserMessage` + `createAttachmentMessage` helper
- [x] [02-kernel.md §2.3](02-kernel.md#23-同-turn-多-tool-并行执行基于-isconcurrencysafe)：loop 算法加并行 tool exec（按 isConcurrencySafe 分组 + safe 批 Promise.all + 按原顺序回填 messages）
- [x] [02-kernel.md §2.4](02-kernel.md#24-aliases-工具改名向后兼容)：`aliases` 工具改名向后兼容
- [x] [02-kernel.md §2 loop 4h](02-kernel.md#2-loop-算法完整伪代码)：ToolResult.newMessages 处理（toolResult 之后 push）
- [x] [02-kernel.md §3.2a](02-kernel.md#32a-systemmessage-边界过滤)：`systemMessage` 边界过滤（永不进 messages，只 emit 给 console）
- [x] [02-kernel.md §10a](02-kernel.md#10a-helper-exports)：helper 导出（createUserMessage / createAttachmentMessage）
- [x] [03-hook-system.md §4.1](03-hook-system.md#41-特例onsessionend-返-continue-true-触发同-session-续跑)：`onSessionEnd` 返 `continue: true` 触发**同 session** 续跑的协议（含 maxContinuations 兜底 + 跟 controller 重启的对比）
- [x] [04-context-injection.md §6](04-context-injection.md#6-通过-tool-返回值注入-newmessages)：通过 tool 返回值注入（含跟 additionalContext 的对照决策）
- [x] [04-context-injection.md §8](04-context-injection.md#8-序列化语义)：序列化语义表更新（含 newMessages / systemMessage）
- [x] [05-plugins.md §5.10](05-plugins.md#510-cost-tracker)：新增 `costTracker` plugin（不抄 Claude Code 全局 state 模式）
- [x] [05-plugins.md §5.11](05-plugins.md#511-token-budget)：新增 `tokenBudget` plugin（含 diminishing returns + nudge 注入；标 advanced）
- [x] [06-controllers.md §6.1](06-controllers.md#61-sidequestionclaude-code-btw-模式)：`sideQuestion` 从占位升级为完整设计（含 CacheSafeParams 协议、wrappedQuestion 模板、5 条 Claude Code 血泪经验）

### ❌ 驳回（不做，理由写在这里以备未来回头看）

| 原 lesson | 驳回理由 |
|---|---|
| Config / State 分离 | 700 LOC kernel 不需要这层抽象；"pure reducer for tests" 是过度工程的典型；kernel 长到 1500+ LOC 再回来看 |
| `runStream(): AsyncGenerator` 双 API 入口 | 用户要流式事件可以用 hook（`onTurnEnd` 等）拿到；多一个 API 路径意味着双倍维护；后端 agent 实际场景 90% 是 `await run()` |

### ⚠️ 降级保留（v0 加 API 但文档标"高级用法"）

| 原 lesson | 处理 |
|---|---|
| `ToolResult.newMessages` | 加字段 + 文档明确"大多数情况优先用 hook `additionalContext`"，避免给同一目的双 API 入口 |
| `sideQuestion` controller | 只写设计 doc，**不实现**；目的是确保 v0 `AgentSession` 接缝（`getCacheSafeParams()`）不被关死 |

### Phase 1+ 推迟（v0.x 看真实需求再决定）

- HarnessTool 加 `interruptBehavior` / `isReadOnly` / `isDestructive` / `inputsEquivalent` / `searchHint`
- Controller 多 Task 类型（LocalShell / Remote / Workflow 等）
- 自定义 hook event（TaskCompleted / TeammateIdle 等 Controller 层 event）
- 自动结构化输出校验（structuredOutputEnforcement）
- sideQuestion 真正实现

### ❌ 永不做（明确决定）

- Permission rule system（用户用 `decision: deny` plugin 自己做）
- MCP（Mario 不做，我们也不做）
- Statsig / feature flag 系统（业务自己控制）
- 全局 mutable cost tracker（用 ctx.state + sink 替代）
- 自动 context overflow recovery（让 watchdog restart 处理）
- 自动 compaction（用户用 `transformMessagesBeforeLlm` plugin）
- 自动 prompt cache 管理（pi-ai 自己处理）
- `saveCacheSafeParams` 模块级 mutable side channel（Claude Code 自己注释承认是 hack）

---

## 10. 总评

Claude Code 是**经过百万用户验证的成熟系统**，但它的**面向场景跟我们不一样**：

- Claude Code 是终端 coding agent，UI 重，"用户感受"驱动设计
- 我们是后端 agent harness，运行时驱动，能不写 UI 就不写

借鉴的边界：

| Claude Code 强项 | 我们要 | 我们不要 |
|---|---|---|
| Hook 系统 | ✅ 全套借鉴（return envelope, additionalContext, timeout） | 27 个 event 名照搬（我们按形态分） |
| Tool 接口 | ✅ isConcurrencySafe / aliases / newMessages | searchHint / shouldDefer / interruptBehavior / permission 标记 |
| Token / Cost 追踪 | ✅ 借鉴算法做成 plugin | 全局 state 模式 |
| Side question / fork | ✅ CacheSafeParams 协议 | 整个 Task 子系统 |
| Permission | ❌ | (业务方自己用 plugin 做) |
| MCP | ❌ | |
| Compaction | ❌ | (用户用 plugin 做) |
| Statsig | ❌ | |

**核心心得**：Claude Code 的设计**克制 + 类型驱动**——他们的 `HookResult` envelope、`isConcurrencySafe` 默认 false 等"安全侧"决策值得学。但很多复杂度是 IDE/Terminal 场景特有的，**用同等粒度做后端 agent 会过度工程**。

抽象成一条原则：**借**他们的协议设计和数据形状，**不借**他们的 UI / IDE / permission / MCP 这些重量级子系统。

---

## 11. 当前状态

**全部 13 条已审核完成**：9 条 ✅ 落进 docs / types.ts，2 条 ❌ 驳回（Config/State 分离、runStream），2 条 ⚠️ 降级保留（newMessages 标 advanced、sideQuestion 仅设计不实现）。

下一步是 Phase 0 的最后一步：**按 [03-hook-system v2 接口](03-hook-system.md#2-hook-接口定义) 重写 [hook.ts](../packages/core/src/hook.ts)**——目前 hook.ts 是 v1，跟最新 doc 已有出入。

重写后 Phase 0 完成，进 Phase 1 跑通 kernel。
