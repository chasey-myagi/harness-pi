# 06 · Controllers

> Controller 定义、跟 Plugin 的本质区别、三个标准 controller、未来 controller 占位。

## 1. Controller 是什么

**Controller = 持有或编排 N 个 `AgentSession` 实例的上层模块。**

Plugin 挂在 session 里改 session 的行为；Controller 在 session 外面，**调用** kernel 而不是**包裹** kernel。

### 1.1 Plugin vs Controller 对比

| 维度 | Plugin | Controller |
|---|---|---|
| 注册方式 | `new AgentSession({ hooks: [...] })` | `const ctrl = new Controller(...); ctrl.start(...)` |
| 跟 session 关系 | 1 plugin ↔ 1 session（一份 hook 实例对应一份 session 的状态） | 1 controller ↔ N session |
| 是 hook 吗？ | ✅ | ❌ |
| 能改 LLM 看到的 messages？ | ✅ 通过 hook 入口 | ❌ 不直接接触 session 内部 |
| 能 abort session？ | ✅ 通过 `ctx.abort` | ✅ 通过 `session.abort()` |
| 能并行多 session？ | ❌ | ✅ |
| 装到哪 | `packages/plugins/src/*.ts` | `packages/plugins/src/controllers/*.ts` |

### 1.2 为什么 Controller 不是 Plugin

考虑 `work-pool`：N 个 worker 并行处理 work item 列表。

如果做成 plugin：
- 一个 plugin 实例对应一个 session
- 但 pool 要同时管 N 个 session
- plugin 没有"创建新 session"的 API

只能在 hook 之外搞。这是边界判断标准：**需要拥有/操纵多个 session 的逻辑 = Controller**。

## 2. 三个标准 Controller

| Controller | 用途 | LOC 估算 |
|---|---|---|
| `lifecycleRestart` | watchdog abort 后自动重启（含 carryover 协议） | ~100 |
| `workPool` | 给定 N 个 work item，按 group 分到 K 个并行 session | ~200 |
| `leaseQueue` | 单 item lease 模型，worker 完成一个领下一个 | ~250 |

---

## 3. `lifecycleRestart`

### 3.1 目的

Session 因 watchdog 超时 abort 后，自动重启一个新 session 继续处理，并把"完成回调"从老 session **carry over** 到新 session。来自 bidding-agent CLAUDE.md 注释里 "this was a real prod bug" 的协议。

### 3.2 协议

```
caller
  └── lifecycleRestart.run(prompt)
        │
        ├── 创建 session #1
        │     └── 注册 onComplete callback
        ├── session #1.run(prompt)
        │     ├── 某 turn watchdog abort
        │     └── RunSummary { reason: "aborted", abortReason: "watchdog: ..." }
        │
        ├── 检测到 aborted + 是 watchdog 触发 + retryCount < max
        │     └── 创建 session #2，继承 session #1 的 messages（initialMessages）
        │           └── carry over caller 的 onComplete callback
        │
        ├── session #2.continue()
        │     ├── 跑到自然结束
        │     └── RunSummary { reason: "done" }
        │
        └── 触发 caller 的 onComplete
```

**关键不变量**：caller 的 onComplete 必须**最终被调用一次**，不管中间重启几次、最后是 done 还是 max retries 用完 abort。bidding-agent 注释里说，丢掉这个回调会让 pool 卡死。

### 3.3 完整设计

```ts
import { AgentSession, type AgentSessionOptions, type RunSummary } from "@harness-pi/core";
import type { Hook } from "@harness-pi/core";

export interface LifecycleRestartOptions {
  /** 创建新 session 用的工厂。每次重启会调用一次。 */
  sessionFactory: (initialMessages?: Message[]) => AgentSession;
  /** 最大重启次数。超过即 abort。默认 3。 */
  maxRetries?: number;
  /** 重启间隔（ms）。默认 2000。 */
  retryDelayMs?: number;
  /** 哪些 abortReason 视为可重启。默认包含 "watchdog" 开头。 */
  isRetryable?: (abortReason: string) => boolean;
}

export interface LifecycleResult extends RunSummary {
  retries: number;
}

export class LifecycleRestart {
  constructor(private opts: LifecycleRestartOptions) {}

  async run(prompt: string, signal?: AbortSignal): Promise<LifecycleResult> {
    const max = this.opts.maxRetries ?? 3;
    const delay = this.opts.retryDelayMs ?? 2000;
    const isRetryable = this.opts.isRetryable ?? ((r) => r.startsWith("watchdog:"));

    let session = this.opts.sessionFactory();
    let messages = [...session.messages];
    let attempt = 0;
    let summary = await session.run(prompt, { signal });

    while (
      summary.reason === "aborted" &&
      summary.abortReason &&
      isRetryable(summary.abortReason) &&
      attempt < max &&
      !signal?.aborted
    ) {
      attempt++;
      messages = [...session.messages];
      await sleep(delay);
      session = this.opts.sessionFactory(messages);
      summary = await session.continue({ signal });
    }

    return { ...summary, retries: attempt };
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
```

### 3.4 跟 watchdog plugin 配合用法

```ts
import { AgentSession } from "@harness-pi/core";
import { watchdog, metrics } from "@harness-pi/plugins";
import { LifecycleRestart } from "@harness-pi/plugins/controllers/lifecycle-restart";

const ctrl = new LifecycleRestart({
  sessionFactory: (initialMessages) => new AgentSession({
    model,
    tools,
    systemPrompt,
    initialMessages,
    hooks: [
      watchdog({ turnTimeoutMs: 10 * 60_000 }),  // turn 超时触发 abort
      metrics({ sink }),
    ],
  }),
  maxRetries: 3,
});

const result = await ctrl.run("...");
// result.retries 告诉你重启了几次
// result.reason 是最终的退出原因
```

### 3.5 失败模式

- **maxRetries 用尽**：返回 `{ reason: "aborted", retries: max }`。caller 决定怎么办（报警 / 重新调度）。
- **caller signal abort**：立即返回当前 summary，不再重启。
- **`sessionFactory` 抛错**：bubble 到 caller。

### 3.6 测试要点

- happy path（不需要重启）
- 单次 watchdog → 1 次重启 → 成功
- 三次 watchdog → 用尽 retries → 返回 aborted
- caller signal abort 中断重启循环
- non-retryable abortReason 不触发重启
- messages 正确 carry over（每次新 session 看到之前的 conversation）

---

## 4. `workPool`

### 4.1 目的

给定 N 个 work item，每 K 个 worker 并行处理；按某种分组策略（如按 heading 切块）保持 worker 的上下文完整性。来自 bidding-agent groupByHeading + AgentPool。

### 4.2 协议

```
caller
  └── workPool.start(items, opts)
        │
        ├── partition(items) → groups[]
        │
        ├── 并发启动 K 个 worker（K ≤ groups.length）
        │     each worker = AgentSession + 处理 1 个 group
        │     ↓
        │     session.run(group.prompt) → RunSummary
        │
        └── 等待所有 worker 结束
              └── 汇总 stats
                    └── 调用 onAllComplete
```

### 4.3 完整设计

```ts
import type { AgentSession, RunSummary } from "@harness-pi/core";

export interface WorkItem { id: string; payload: unknown; }

export interface WorkPoolOptions<I extends WorkItem> {
  items: I[];
  /** 把 items 分组的策略。比如按 item.payload.heading。 */
  partition: (items: I[]) => Array<{ id: string; items: I[] }>;
  /** 给某个 group 创建 session + 跑的工厂。 */
  workerFactory: (group: { id: string; items: I[] }) => Promise<{
    session: AgentSession;
    prompt: string;
  }>;
  /** 最大并发数。默认 = partition 后的 group 数。 */
  maxConcurrency?: number;
  /** 单 group 完成时回调（用于 progress UI / metric）。 */
  onGroupComplete?: (groupId: string, summary: RunSummary) => void;
  /** 单 group 失败（factory 抛或 run 抛）回调。 */
  onGroupError?: (groupId: string, err: Error) => void;
  /** abort 时未启动的 group 被跳过的回调（与 complete/error 对称，保证每个 group 都有终态信号）。 */
  onGroupSkipped?: (groupId: string, reason: "aborted") => void;
}

export interface WorkPoolResult {
  /** 每个 group 恰一条终态：summary（完成）/ error（失败）/ skipped（abort 时未启动）。 */
  groups: Array<{ id: string; summary?: RunSummary; error?: Error; skipped?: "aborted" }>;
  totalItems: number;
  completedGroups: number;
  failedGroups: number;
  /** abort 时未启动而被给终态的 group 数。completed+failed+skipped === groups 总数。 */
  skippedGroups: number;
}

export class WorkPool<I extends WorkItem> {
  constructor(private opts: WorkPoolOptions<I>) {}

  async start(signal?: AbortSignal): Promise<WorkPoolResult> {
    // 实现要点（已发布）：
    // 1. partition → groups；queue = [...groups]；running = Set<Promise>。
    // 2. while (queue 或 running 非空)：abort 则 break；否则把 queue 填到 maxConcurrency 并发跑。
    //    每个 group：factory → session.run → push {summary} + onGroupComplete；抛错 → push {error} + onGroupError。
    // 3. **abort 必给终态**：break 后先 allSettled drain 在跑的 worker（否则 caller 拿到不一致快照），
    //    再 sweep queue 里未启动的 group → push {skipped:"aborted"} + skippedGroups++ + onGroupSkipped。
    //    每个 group 恰一条终态；守恒：completedGroups + failedGroups + skippedGroups === groups 总数。
    // ……见 packages/plugins/src/controllers/work-pool.ts。
  }
}
```

### 4.4 跟 plugin 配合用法

```ts
import { WorkPool } from "@harness-pi/plugins/controllers/work-pool";

const pool = new WorkPool({
  items: questionList,
  partition: (items) => groupByHeading(items),
  workerFactory: async (group) => {
    const session = new AgentSession({
      model, tools, systemPrompt,
      hooks: [
        watchdog({ turnTimeoutMs: 10 * 60_000 }),
        metrics({ sink: sharedSink }),
        leaseDecision({ currentLease: () => group.items[0]?.id ?? null }),
      ],
    });
    return { session, prompt: buildPrompt(group) };
  },
  maxConcurrency: 4,
  onGroupComplete: (id, summary) => console.log(`group ${id}: ${summary.reason}`),
});

const result = await pool.start();
```

### 4.5 失败模式

- **某 group 抛错**：当前实现把错误传播到 `runGroup` 的 promise → caller `start()` reject。建议改成 catch 每个 group 单独的失败放进 results 里，全部跑完再 return。
- **`partition` 返回空数组**：start 立即 resolve with `{ groups: [], totalItems: 0 }`。
- **某 heading 下 item 极多**：单 group 成为瓶颈（bidding-agent 已知 limitation）。要解决就用 `leaseQueue` 而不是 workPool。
- **caller signal abort**：当前在跑的 group 不立即停（要 caller signal 透传到 session），但不会再启动新 group。

### 4.6 测试要点

- 多 group 并发，确实并行（用 mock session 验证并发上限）
- 单 group 失败不影响其他
- 全部完成后 `onGroupComplete` 都被调用
- signal abort 中断 queue 但不杀已跑的

---

## 5. `leaseQueue`

### 5.1 目的

单 item 级别的 lease 模型。N 个 worker 各持一个 lease，处理完一个 item 释放 lease + 领下一个。比 `workPool` 更细粒度，适合 item 完成时间分布极不均的场景。来自 bidding-agent question-pool。

### 5.2 关键概念

- **Lease**：`{ itemId, workerId, attempt }`。worker 持有期间，只有 lease.itemId 的工作可以做。
- **Conflict**：worker 试图做 lease.itemId 之外的 item → 拒绝（plugin `leaseDecision` 实现）。
- **Stale lease**：worker 长时间没活动（watchdog 触发 / crash）→ lease 释放重新入队。

### 5.3 协议

```
caller
  └── leaseQueue.start(items)
        │
        ├── pendingQueue = [item1, item2, ...]
        │
        ├── 启动 K 个 worker
        │     each worker loop:
        │       ┌── leaseNext() → lease | null
        │       │
        │       ├── 创建 session 处理 lease.itemId
        │       │     session.run(buildPrompt(item))
        │       │       └── plugins 中 leaseDecision 用 currentLease() 拦不匹配的 call
        │       │
        │       ├── 完成 → releaseLease(lease, "done")
        │       │
        │       ├── 异常 → releaseLease(lease, "error")
        │       │       └── 入队重试（attempt += 1）
        │       │
        │       └── 没 next → worker 退出
        │
        └── 所有 worker 退出 → onAllComplete
```

### 5.4 完整设计（核心 API，不展开实现）

```ts
import type { AgentSession, RunSummary, HookContext } from "@harness-pi/core";

export interface QueueItem { id: string; payload: unknown; }

export interface QueueLease {
  itemId: string;
  workerId: string;
  attempt: number;
}

export interface LeaseQueueOptions<I extends QueueItem> {
  items: I[];
  /** 给某个 item 创建 session 的工厂。注意 hook 里要装 leaseDecision，
   *  其 currentLease 读 controller 的当前 lease（通过 ctx.state 或 closure）。 */
  workerFactory: (item: I, lease: QueueLease, ctx: { releaseLease: (status: "done" | "error" | "conflict") => void }) => Promise<{
    session: AgentSession;
    prompt: string;
  }>;
  /** 并发 worker 数。 */
  concurrency: number;
  /** 单 item 最大重试次数。默认 1（失败一次就放弃）。 */
  maxAttempts?: number;
  /** 进度 / 状态变化回调。 */
  onItemComplete?: (item: I, status: "done" | "error" | "conflict", summary?: RunSummary) => void;
}

export interface LeaseQueueResult {
  totalItems: number;
  completed: number;
  failed: number;
  conflicted: number;
  /** abort 后从未派发（或 abort 时回退）而被给终态的 item 数。 */
  skipped: number;
}

export class LeaseQueue<I extends QueueItem> {
  constructor(private opts: LeaseQueueOptions<I>) {}

  async start(signal?: AbortSignal): Promise<LeaseQueueResult> {
    // 实现要点（已发布）：
    // 1. pending queue（单线程 event loop 下 shift/splice 在 await 之间原子，K worker 不竞态）
    // 2. K 个 worker promise 并发：while (pending 非空 && !signal.aborted)
    //      lease = 取队首 + attempts 计数
    //      session = factory(item, lease, { releaseLease })
    //      summary = await session.run(prompt, { signal })
    //      status = releaseLease 优先；否则 summary.reason==="done" → done / 其余 → error
    //      非 done 且 attempt < maxAttempts → 回退队尾重试；否则 finalize（单点裁决）
    // 3. **abort 必给终态**：全部 worker exit 后，sweep pending 里残留的 item（从未派发 + abort
    //    时回退的）统一 finalize 成 "skipped" —— 每个 item 恰 finalize 一次（worker 与 sweep 互斥）。
    //    守恒：completed + failed + conflicted + skipped === totalItems，work item 不静默消失。
    // ……见 packages/plugins/src/controllers/lease-queue.ts。
  }
}
```

完整实现见 `packages/plugins/src/controllers/lease-queue.ts`（abort 必给终态 + 守恒，已被 `controllers.test.ts` 的混合终态/守恒用例覆盖）。

### 5.5 跟 plugin 配合用法

```ts
import { LeaseQueue } from "@harness-pi/plugins/controllers/lease-queue";

const queue = new LeaseQueue({
  items: questions,
  concurrency: 3,
  maxAttempts: 2,
  workerFactory: async (item, lease, ctx) => {
    const session = new AgentSession({
      model, tools, systemPrompt,
      hooks: [
        watchdog({
          turnTimeoutMs: 10 * 60_000,
          onTimeout: () => ctx.releaseLease("error"),  // watchdog 超时 → 释放 lease
        }),
        leaseDecision({
          currentLease: () => lease.itemId,
          onConflict: () => ctx.releaseLease("conflict"),
        }),
        metrics({ sink }),
      ],
    });
    return { session, prompt: buildPrompt(item) };
  },
  onItemComplete: (item, status) => console.log(`item ${item.id}: ${status}`),
});

const result = await queue.start();
```

### 5.6 失败模式

- **Lease 持有 worker crash**：watchdog 超时 → onTimeout 调 releaseLease → 入队重试
- **Conflict 频繁**：可能 LLM 真的搞错了 item id。`onItemComplete(status="conflict")` 上报频次，超阈值放弃。
- **重试无限循环**：`maxAttempts` 兜底，超过把 item 标 failed
- **死锁**：worker 都在等 lease 但 queue 空——不会发生（leaseNext() 返回 null worker exit）

### 5.7 测试要点

- 多 worker 真的并行不撞 lease
- 一个 worker 处理完真的领下一个
- 异常 worker 的 lease 被 release 给其他 worker
- maxAttempts 生效
- signal abort 让 worker 优雅退出

---

## 6. 未来 controller（v0.x 候选，v0 仅记录设计）

### 6.1 `sideQuestion`（Claude Code `/btw` 模式）

Fork 一个 lightweight agent **共享父 session 的 prompt cache**，回答一个一次性问题不影响主对话。借鉴 Claude Code [`utils/forkedAgent.ts`](https://github.com/badlogic/pi-mono) + [`utils/sideQuestion.ts`](https://github.com/badlogic/pi-mono) 156 行实现。

**v0 不实现，但这里写下完整设计**，目的是确保 [02-kernel `AgentSession`](02-kernel.md) 暴露的接口够支撑未来 fork——v0 提前关死接缝就很难补救。

#### 6.1.1 核心机制：`CacheSafeParams`

```ts
export interface CacheSafeParams {
  /** 父 session 的 systemPrompt —— 字节对齐才能命中 cache */
  systemPrompt: string;
  /** 父 session 的累计 messages —— 作为 cache 前缀 */
  forkContextMessages: ReadonlyArray<Message>;
  /** 父 session 的 model —— 不同 model 的 cache 不通用 */
  model: Model<any>;
  /**
   * 父 session 的 thinking 配置。⚠️ 必须跟父一致，否则 bust cache
   *（thinking 是 cache key 一部分）—— Claude Code forkedAgent.ts:99 红字警告
   */
  thinkingConfig: ThinkingConfig;
}
```

`AgentSession` 需要暴露一个 `snapshot()` 方法或 `getCacheSafeParams()` getter，让 fork 用：

```ts
class AgentSession {
  // ...
  getCacheSafeParams(): CacheSafeParams {
    return {
      systemPrompt: this.config.systemPrompt,
      forkContextMessages: this.state.messages,
      model: this.config.model,
      thinkingConfig: this.config.thinkingConfig,
    };
  }
}
```

#### 6.1.2 完整 API 草图

```ts
// packages/plugins/src/controllers/side-question.ts

export interface SideQuestionOptions {
  /** 父 session。fork 共享其 cache。 */
  parentSession: AgentSession;
  /** 提的问题（会被包成 system-reminder + 提示"无 tool, 单轮"）。 */
  question: string;
  /** Fork 能用的 tool。默认 []（禁 tool）。 */
  tools?: HarnessTool[];
  /** 最大 turn。默认 1。 */
  maxTurns?: number;
  /**
   * 跳过 cache write（适合一次性 fork，不污染未来 cache lookup）。
   * 默认 true，对应 Claude Code skipCacheWrite。
   */
  skipCacheWrite?: boolean;
  /** Hook 列表。空 = fork 不挂任何 plugin（不会写 metric）。 */
  hooks?: Hook[];
}

export interface SideQuestionResult {
  /** Fork 给出的回答（concat 所有 text block）；null 表示出错 / 模型不肯答。 */
  response: string | null;
  /** Fork 自己的 token usage（不混进父 session 计量）。 */
  usage: { input: number; output: number; cached: number };
}

const SIDE_QUESTION_WRAPPER = `<system-reminder>
This is a side question. Answer in a single response, no tools, no follow-up.
The main agent is NOT interrupted — it continues working independently.
You share conversation context but are a separate instance.
Do NOT reference being interrupted or what you were "previously doing".
If you don't know the answer, say so — do not offer to investigate.
</system-reminder>

`;

export async function sideQuestion(opts: SideQuestionOptions): Promise<SideQuestionResult> {
  const cacheParams = opts.parentSession.getCacheSafeParams();
  const wrappedQuestion = SIDE_QUESTION_WRAPPER + opts.question;

  const fork = new AgentSession({
    model: cacheParams.model,
    systemPrompt: cacheParams.systemPrompt,        // 字节对齐
    tools: opts.tools ?? [],
    initialMessages: [...cacheParams.forkContextMessages],  // cache 前缀
    maxTurns: opts.maxTurns ?? 1,
    hooks: opts.hooks ?? [],
    // skipCacheWrite 需要 kernel 支持透传到 pi-ai
  });

  const summary = await fork.run(wrappedQuestion);
  return {
    response: extractFinalText(fork.messages),
    usage: aggregateUsage(fork.messages),
  };
}
```

#### 6.1.3 设计要点（来自 Claude Code 的血泪）

1. **`systemPrompt` 必须字节对齐**：哪怕加一个空格都 bust cache。Fork 直接复用父引用最稳
2. **`thinkingConfig` 是 cache key 一部分**：fork 自己改 thinking budget 会让父 cache miss。要省 cost 不要改它
3. **`maxOutputTokens` 不能擅自改**：在 pi-ai 里 max_tokens 跟 thinking_budget 关联，clamp 后影响 cache。fork 想限输出请走"prompt 里说短点"
4. **`skipCacheWrite: true` 适合 fire-and-forget**：fork 写新 cache 等于浪费——下次没人会从这个 prefix 复用
5. **wrappedQuestion 的 `<system-reminder>` 是关键**：明确告诉 LLM "你是一个 fork，不要 tool 不要多轮"——Claude Code 注释里说不加这个 fork 经常想调 tool

#### 6.1.4 价值

- **debug**："上一步那个错误是什么意思" 不用打断主流程
- **用户辅助问题**："这个 tool 干嘛的" / "上下文里 X 字段含义"
- **元 reasoning**：父 agent 自己 fork 一个 "review my last decision" 副 agent
- **不污染**：父 session 的 messages / metric / cost-tracker 都不被影响

#### 6.1.5 为什么 v0 不做

- 需要 kernel 多暴露 `getCacheSafeParams()` + `skipCacheWrite` 透传，是非小改动
- v0 没有真实用例（bidding-agent 没用，Mario 自己也注释这是 "promptSuggestion / postTurnSummary / /btw 三种 caller 才需要"）
- v0.x 真的有需求时再做，**接缝留好就行**

### 6.2 `subAgent`（多 agent 编排）

主 agent 调一个 tool 触发子 agent 跑一个子任务。需要：sub-agent context 隔离、子 agent 的 RunSummary 转成父 agent 的 tool result。

```ts
const subAgentTool: HarnessTool = createSubAgentTool({
  name: "research_topic",
  systemPrompt: "You are a research specialist...",
  // ...
});
```

价值：分工、上下文隔离、并行。

### 6.3 `compactor`（自动 compaction）

监控 session.messages 总 token，达到阈值就调一次 "请总结之前对话" 把历史压成一段 summary message，替换老 messages。

价值：超长 conversation 不爆 context。

**v0 不做的理由**：compaction 策略很 application-specific，不同 agent 取舍不同；做一个通用的容易过度抽象。先让用户用 `transformMessagesBeforeLlm` 自己写。

---

## 7. Controller 设计原则总结

1. **Controller 调用 kernel，不修改 kernel**——controller 是 session 的客户
2. **每个 controller 一个文件**（除非 LOC > 400 才拆子模块）
3. **不依赖具体 plugin**——controller 通过 `workerFactory`/`sessionFactory` callback 让用户注入 session，里面挂什么 plugin 是用户的事
4. **接受 AbortSignal**——所有 long-running controller 必须支持外部 abort
5. **明确的完成协议**——`onComplete` / `onAllComplete` / `onItemComplete` 必须被调用一次，绝不悬挂

## 8. 下一步

- [05-plugins](05-plugins.md) —— controller 用到的 plugin（watchdog / leaseDecision）的实现细节
- [07-adapters](07-adapters.md) —— controller 内多 session 共享一个 sink 的模式
- [02-kernel](02-kernel.md) —— controller 调用的 `AgentSession.run()` 协议
