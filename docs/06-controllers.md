# 06 · Controllers

> Controller 定义、跟 Plugin 的本质区别、已落地 controller 的完整设计、仍未落地的 controller 占位。
>
> **权威清单 = `packages/plugins/src/controllers/index.ts` 实际导出。** 截至 0.3.0，已落地：`lifecycleRestart`、`workPool`、`leaseQueue`（§3–5，从 bidding-agent parity 起步），以及 §6 的 compaction 控制器三件套（`compactRestartFresh` / `compactResumeFromBoundary` / `compactOnOverflow`+`persistCompactionBoundary`）、`forkSession`、`parallel`/`pipeline`、子代理体系（`subAgentTool` / `routedSubAgentTool` / `SubAgentRegistry`）、`gapExplorer`。§7（原「未来 controller」）现仅余 `sideQuestion` 一个真未落地项。

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

## 2. 标准 Controller 一览

**bidding-agent parity 起步的三个（§3–5）：**

| Controller | 用途 |
|---|---|
| `lifecycleRestart` | watchdog abort 后自动重启（含 carryover 协议） |
| `workPool` | 给定 N 个 work item，按 group 分到 K 个并行 session |
| `leaseQueue` | 单 item lease 模型，worker 完成一个领下一个 |

**0.3.0 已落地的其余 controller（§6）：**

| Controller / 工厂 | 用途 |
|---|---|
| `compactOnOverflow` (Hook) + `CompactRestartFresh` | overflow→abort→fresh 重跑同一 prompt（最便宜，丢越界 trace） |
| `CompactResumeFromBoundary` | overflow→abort→写 boundary→`resume()` 续跑（保留压缩成果，需 store） |
| `persistCompactionBoundary` (Hook) | C1：`onAfterFlush` collect-return seam，把已持久化前缀总结成 durable boundary |
| `forkSession` / `forkSessionAll` | 从父 snapshot 派生 N 个独立探索子 session（同一 item 纵向探索） |
| `parallel` / `pipeline` | 声明式编排原语：已知 work-list bounded fan-out，每 item 必返 typed outcome |
| `subAgentTool` / `routedSubAgentTool` | 模型驱动的 bounded 子代理工具（横向 maxSubAgents + 纵向 maxDepth 两闸） |
| `SubAgentRegistry` | 子代理续聊句柄（bounded LRU/TTL/abort） |
| `GapExplorer` | 覆盖率反馈闭环：gap→bounded explorer 补 KB→人审 promote→算重答集 |

> §3–5 给出三个 parity controller 的完整设计；§6 给出 0.3.0 controller 的完整设计；§7 留仍未落地的占位。

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

## 6. 0.3.0 已落地 controller

> 这些都已在 `packages/plugins/src/controllers/` 落地、有 `__tests__/` 覆盖。compaction 三件套（§6.1–6.3）建在内核 `onContextOverflow` / `onAfterFlush` 之上；§6.4–6.7 是 fork / 编排 / 子代理 / 反馈闭环。

### 6.1 `compactRestartFresh`（+ `compactOnOverflow`）

#### 6.1.1 目的

最便宜的 compaction 策略（docs/09 §4.2）：overflow 时直接 **abort + fresh 重跑同一 prompt**（丢掉越界的 ReAct trace），比在原 session 里魔法缩小 token 更直接。拆成两个可独立组合的件：

- `compactOnOverflow()` —— 一个 **Hook**：监听内核 `onContextOverflow` → `ctx.abort("compaction:…")`，让本次 run 以 `reason:"aborted"` + 该 abortReason 收尾。
- `CompactRestartFresh` —— 一个**控制器**：捕捉 compaction-class abort → 用 fresh session 重跑同一 prompt，直到非 compaction abort 或重启次数耗尽。

#### 6.1.2 完整设计

详见 [`packages/plugins/src/controllers/compact-restart-fresh.ts`](../packages/plugins/src/controllers/compact-restart-fresh.ts)。

```ts
export const COMPACTION_OVERFLOW_REASON = "compaction:overflow";
export function compactOnOverflow(opts?: { reason?: string }): Hook;  // reason 必须 "compaction:" 前缀
export function isCompactionRestart(abortReason: string | undefined): boolean;  // 谓词
export class CompactRestartFresh {
  constructor(opts: { sessionFactory: () => AgentSession; maxRestarts?: number });  // 默认 3
  run(prompt: string, opts?: { signal? }): Promise<CompactRestartResult>;  // 含 restarts 计数
}
```

`sessionFactory` 里**务必装 `compactOnOverflow()`**，否则 overflow 不变成 compaction abort、控制器无从感知。`isCompactionRestart` 谓词同时可作 `LifecycleRestart` 的 `isRetryable`（给想「带历史重启」的调用方）。

#### 6.1.3 失败模式

- **overflow 来自初始 prompt 本身过大**：每次 fresh 重跑会同样越界，控制器在 `maxRestarts` 后返回最后一次 aborted summary（**不假装恢复成功**）。这种场景应改用 §6.2（resume）或 §5.15 view 压缩。
- **只代理 `signal`** 给每次 `run`，其余 run 选项不穿透（与 LifecycleRestart 同）。

#### 6.1.4 为什么不复用 `LifecycleRestart`

它 `continue()` 并搬入 `[...session.messages]`（带历史续跑），对 overflow 恰恰会再次越界。compactRestartFresh 要相反语义：**丢掉**越界 trace、fresh 重跑。

#### 6.1.5 测试要点

- happy（不重启）/ overflow→fresh 重跑成功 / 持续 overflow 用尽 maxRestarts 返回 aborted
- 非 `compaction:` 前缀 abort 不触发重启（`compact-restart-fresh.test.ts`）

---

### 6.2 `compactResumeFromBoundary`

#### 6.2.1 目的

`compactRestartFresh` 的兄弟（docs/09 §4.2），同建在 overflow→abort 之上，但**恢复方式相反**：overflow abort 后，把当下 live messages **总结成一条覆盖全量的 summary**、写一条 `compaction_boundary` entry，再 `AgentSession.resume()` 从 boundary `continue()` 续跑。**保留压缩后的成果**（不像 fresh 丢掉整段越界 trace）。

#### 6.2.2 完整设计

详见 [`packages/plugins/src/controllers/compact-resume-from-boundary.ts`](../packages/plugins/src/controllers/compact-resume-from-boundary.ts)。

```ts
export class CompactResumeFromBoundary {
  constructor(opts: {
    store: SessionStore;          // 必需：boundary 落盘、resume 从它重建
    sessionId: string;            // 首跑 + resume 同一 lineage
    sessionOptions: Omit<AgentSessionOptions, "store"|"sessionId"|"initialMessages"|"resumedMessageCount">;
    summarize: (messages) => Message | Promise<Message>;  // 覆盖全量的一条 summary，domain-free
    maxRestarts?: number;         // 默认 3
  });
  run(prompt: string, opts?: { signal? }): Promise<CompactResumeResult>;  // 含 restarts
}
```

复用 `compactOnOverflow`（Hook）+ `isCompactionRestart`（谓词）；`sessionOptions.hooks` 里**务必装 `compactOnOverflow()`**。boundary **覆盖它之前全部前缀**，resume 重建出的 messages 就是 `[summary]` 一条（最大压缩）——只要 summarize 真把内容压短，每次 resume 起点都比上次小，进展有保证（不像 fresh 在初始 prompt 过大时反复同样越界）。

#### 6.2.3 失败模式（诚实边界）

- **需要 `store`**（compactRestartFresh 不需）。
- **`maxRestarts` 耗尽**（如单条 summary 仍超窗）→ 返回最后一次 aborted summary（不假装恢复）。
- **`summarize` 抛错**：`run()` 直接 reject（fail-loud）。因 summarize 在 `appendEntry` 之前调用，抛错时不留半成品 orphan boundary——store 不损坏。

#### 6.2.4 测试要点

- overflow→写 boundary→resume continue 成功；resume 后 messages == [summary]+新 turn
- maxRestarts 耗尽返回 aborted；summarize 抛错 reject 且不留 orphan boundary（`compact-resume-from-boundary.test.ts`）

---

### 6.3 `persistCompactionBoundary`（C1 · onAfterFlush collect-return seam）

#### 6.3.1 目的

把 compaction 边界**主动**写进 store（durable resume 优化），不等 overflow。挂内核 `onAfterFlush`（每 turn flush 到 store 之后 fire）：`shouldCompact` 为真且距上次 boundary 足够远时，把**已持久化前缀**总结成一条 summary 并**返回** `{ compactionBoundary: summary }`，由**内核**在 in-band、awaited、串行的路径上把它当作 store 末尾一条 `compaction_boundary` 写盘。

#### 6.3.2 完整设计

详见 [`packages/plugins/src/controllers/persist-compaction-boundary.ts`](../packages/plugins/src/controllers/persist-compaction-boundary.ts)。

```ts
export function persistCompactionBoundary(opts: {
  shouldCompact: (input: { persistedCount: number; messages: Message[] }) => boolean;
  summarize: (flushedMessages: Message[]) => Promise<Message> | Message;  // 覆盖全部已持久化前缀
  minTurnsBetween?: number;   // 默认 1
  timeout?: number;           // 默认 60_000（见下）
}): Hook;
```

**return-based，不持有写能力（关键不变量）**：本 hook **只返回** summary、**不调任何 store 写**。早期版本给 hook 一个 detached `appendCompactionBoundary`，被 review 抓出 data-loss / store-corruption（超时时 detached append 仍在飞、乱序落在后续 turn 之后 → resume 当成「丢弃之前一切」静默删已完成 turn；且与下一轮 flush 并发打同一 sessionId）。改成「返回 → 内核串行写」后，summarize 超时只是返回被忽略，**绝不产生 detached 写**。

**先提交节流高水位、再做慢活**：`ctx.state.set(KEY, turnIdx)` 在 `await summarize` **之前**——否则超时让 await reject、set 不执行、节流高水位不前进、下一 turn 又触发 summarize，`minTurnsBetween` 形同虚设。boundary 是 best-effort 优化，跳过一次无碍。

**timeout 默认 60s**：`onAfterFlush` 走 event 类、dispatcher 默认仅 100ms，不放宽真 LLM summarize 必定超时 → 零 boundary 落盘（但不数据损坏，内核拿不到返回就不写）。

**HWM 不变量**：内核写 boundary 只往 store 加一条 entry，**不动** `_persistedCount` / `_messages`——live session 全量历史与续跑行为完全不变。boundary 覆盖语义与 view-only 压缩（§5.14/5.15）正交：那些省 token、这里省 resume 重放。

#### 6.3.3 测试要点

- shouldCompact 真且超 minTurnsBetween → 返回 boundary、内核串行写
- summarize 超时只是被忽略、不产 detached 写；HWM 不被动（`persist-compaction-boundary.test.ts`）

---

### 6.4 `forkSession` / `forkSessionAll`

#### 6.4.1 目的

从父 session 拷贝当前 messages snapshot，跑一个独立子 session。与 `lifecycleRestart`（同一逻辑 session 跨 worker 状态续传）/ `workPool`（不同 work item 横向并行）都不同：fork 是**同一 item 的纵向探索**（「我有 3 个候选方案，平行 try 一遍」）。

#### 6.4.2 完整设计

详见 [`packages/plugins/src/controllers/fork-session.ts`](../packages/plugins/src/controllers/fork-session.ts)。

```ts
export function forkSession(
  parent: AgentSession,
  factory: (initialMessages: Message[]) => AgentSession,
  opts?: { prompt?: string; signal?: AbortSignal },
): Promise<ForkResult>;  // { summary, messages }
export function forkSessionAll(parent, forks): Promise<Array<settled ForkResult>>;
```

- 子 session 拿父 `snapshot().messages` 作 initialMessages（copy，父不被影响、不暂停）。
- **过滤悬挂 tool 调用**：父若在 tool batch 中途被 fork，snapshot 会含「无 result 的 toolCall」，直接喂 pi-ai 会 400 → `filterIncompleteToolCalls`（始终返 copy）。
- **防 self-fork**（M4）：`factory` 返回的若 === parent 直接抛（否则 child.run 会 mutate 父、破坏 fork 语义）。
- 不传 `prompt` 走 `continue()`（直接从历史接着算）；子完成后 summary + 完整 messages 返回，**caller 决定如何 merge（不自动 merge）**。
- `forkSessionAll`：`Promise.allSettled` 风格并行，失败一个不影响其他。

#### 6.4.3 测试要点

- snapshot copy 父不变；悬挂 toolCall 被过滤；self-fork 抛
- prompt / continue 两条路径；forkSessionAll 一失败不影响其他（`phase3.test.ts`）

---

### 6.5 `parallel` / `pipeline`（声明式编排原语）

#### 6.5.1 目的

替换「手搓 lease/work pool + 散落的 onComplete 回调」那一坨命令式编排（bidding-agent god-file 病根之一），把「每个 work-item 必 settle」从注释纪律变成原语级保证。**domain-free + 与 AgentSession 解耦**：`run` 回调由调用方提供（里面可建 AgentSession 跑一题、shell 子进程、任何 async 工作）。

#### 6.5.2 完整设计

详见 [`packages/plugins/src/controllers/orchestrate.ts`](../packages/plugins/src/controllers/orchestrate.ts)。

```ts
export function parallel<I, R>(items, opts: {
  run: (item, index) => Promise<R>;     // throw → status:"failed"，不让整个 parallel reject
  concurrency?: number;                 // 默认 1，夹到 [1, items.length]
  signal?: AbortSignal;                 // 停止派发新 item；未派发 → skipped:"aborted"
  budget?: { total; cost: (value, item) => number };  // 派发阈值（非硬上限）
  onProgress?: (p: { done; total; spent }) => void;
}): Promise<ItemOutcome<I,R>[]>;        // 与输入等长、按 index 有序

export function pipeline<I, R>(items, stages: PipelineStage<I>[], opts?): Promise<PipelineOutcome<I,R>[]>;
```

- **每个 item 恰一个 typed outcome**（ok / failed / skipped），按 index 有序，**永不静默丢失**。
- **budget 是派发阈值、非硬上限**：派发决策在 item 开始前、计费在完成后，高并发下超支上限 ≈ 在跑的并发数（`concurrency:1` 最多超 1 个）。只有 `ok` 结果累加 `cost`（失败不计费）。
- `pipeline` = 多阶段版 parallel：每 item **独立**流过有序 stages、**stage 之间无 barrier**；失败时额外记是哪个 stage 抛的（`stage`，0-based），该 item 其余 stage 不再跑。abort 只挡新 item 派发（已进管线的跑完剩余 stage，避免半截产物）。`pipeline` 搭在 `parallel` 上、复用其全部已测并发/派发/abort/进度逻辑。

#### 6.5.3 测试要点

- 等长有序 outcome、每 item 恰一终态、永不丢
- run 抛 → failed；budget/abort → skipped（含 sticky stopReason）
- pipeline stage 归因、stage 间无 barrier、abort 跑完已进管线 item（`orchestrate.test.ts` / `pipeline.test.ts`）

---

### 6.6 子代理体系：`subAgentTool` / `routedSubAgentTool` / `SubAgentRegistry`

#### 6.6.1 目的

让模型把一个自包含子任务委派给一个 **bounded sub-agent**（docs/09 §4.7）。借 cc AgentTool / codex AgentControl 形态，但**严格 bounded**——它就是一个普通 `HarnessTool`，复用 `AgentSession` 跑子任务、把结果回灌父模型，**不是顶层 meta-agent**。**domain-free**：子任务怎么跑（tools/systemPrompt）全在调用方的 `sessionFactory` 里。

#### 6.6.2 两闸：横向 maxSubAgents + 纵向 maxDepth

详见 [`packages/plugins/src/controllers/sub-agent-tool.ts`](../packages/plugins/src/controllers/sub-agent-tool.ts)。

```ts
export function subAgentTool(opts: {
  sessionFactory: (task, ctx) => AgentSession;
  name?; description?;
  maxSubAgents?: number;   // 横向闸：本 tool 实例最多派几个，默认 8
  maxDepth?: number;       // 纵向闸：跨层递归深度，默认 2
  onSpawn?: (session) => void;  // opt-in 续聊接缝（S4）
}): HarnessTool;
export function routedSubAgentTool(opts: { specs: AgentSpec[]; ... }): HarnessTool;  // 按 agent_type 路由
export function subAgentResult(sub, summary): ToolExecResult;  // spawn / 续聊共用的整形
```

- **横向 `maxSubAgents`**（默认 8）：单 tool 实例的扇出预算，防单层失控扇出。
- **纵向 `maxDepth`**（默认 2，#45）：从顶层 session（depth 0）算起的嵌套上限。透传机制：spawn 子 session 时给它挂一个 `onSessionStart` hook 把子 `ctx.state` 的 `subAgent.depth` 设为 父+1；子若也挂 subAgentTool，execute 时读到的已是递增后的深度。**零内核改动**（只用现成 `use()`/`onSessionStart`）。两闸正交：纵向闸挡在横向计数之前（超深尝试不消耗本层 maxSubAgents 预算）。
- 空任务 / 超预算 / 超深都 `throw`（HarnessTool 错误合约，kernel 包成 isError 回灌模型）。父 signal 透传给 sub-agent（协作式取消）。
- **`routedSubAgentTool`（#59）**：多规格、按 `agent_type` 路由的变体。共享同一套两闸 + `spawnSubAgent`；差别只在参数多一个 `agent_type` 枚举（值 = 各 spec 的 `type`）、description 拼进每个 spec 的 `whenToUse` 供模型路由。type 重复构造期 fail-loud。

#### 6.6.3 `SubAgentRegistry`（续聊句柄，S4）

详见 [`packages/plugins/src/controllers/sub-agent-registry.ts`](../packages/plugins/src/controllers/sub-agent-registry.ts)。

把已 spawn 的子 session 按 id 留住，让父能按 id 续聊。**资源安全是头等约束**（cc 曾因 sub-agent 句柄无界保留爆 36.8GB），故三道闸：

```ts
export class SubAgentRegistry {
  constructor(opts?: { maxRetained?; ttlMs?; parentSignal?: AbortSignal });  // 默认 16 / 5min
  readonly retain: (session: AgentSession) => void;  // 接到 subAgentTool({ onSpawn })
  continueSubAgent(id, message, runOpts?): Promise<ToolExecResult>;  // typed 交付（同 spawn shape）
  clear(): void;  get size(): number;
}
```

- **硬上限 `maxRetained`**（默认 16）：超上限按 **LRU** 驱逐最久未用的；
- **TTL `ttlMs`**（默认 5 分钟）：每次 retain/continue 前先扫掉过期项；
- **父 abort 清空**：`parentSignal` abort → 清空全部（once，子不再可续、GC 回收）。
- **opt-in**：默认 `subAgentTool` 不接 registry（子跑完即弃，0.2.4 逐字节一致）；只有把 `registry.retain` 接到 `subAgentTool({ onSpawn })` 才留住。`retain` 是箭头属性（解构传递 `this` 不丢）。
- **typed 交付**：`continueSubAgent` 调内核已有 `session.run(message)` 续跑，返回与 `spawnSubAgent` **同形状** ToolExecResult（text + details 含 sessionId/usage）。id 不存在/被驱逐 → 抛清晰 error。**不可重入**：同一 id 上一次 run 未结束时再续聊会让内核抛「already in progress」。

#### 6.6.4 测试要点

- 横向超 maxSubAgents 抛、纵向超 maxDepth 抛（两闸正交）；空任务抛；signal 透传；routed 按 agent_type 分派、非法 type / 重复 type fail-loud（`gap-explorer.test.ts`）
- registry：LRU/TTL/父 abort 三闸驱逐、retain 解构不丢 this、continueSubAgent typed 交付 / 未知 id 抛（`sub-agent-registry.test.ts`）

---

### 6.7 `GapExplorer`（覆盖率反馈闭环）

#### 6.7.1 目的

docs/09 §4.7 的反馈闭环（原 roadmap 的 sideQuestion controller 落点）：检测到 gap（调用方判定）→ 派 **bounded explorer** 去补 KB → 受影响 work-item 重答。explorer 复用 §6.5 `parallel()` + AgentSession——**不是顶层 meta-agent**，就是「每个 gap 一次 `AgentSession.run`」的确定性 fan-out。**domain-free**：gap 怎么判、explorer 怎么跑、finding 怎么写 KB、谁来 promote 全在调用方注入的回调里。

#### 6.7.2 完整设计

详见 [`packages/plugins/src/controllers/gap-explorer.ts`](../packages/plugins/src/controllers/gap-explorer.ts)。

```ts
export class GapExplorer {
  constructor(opts: {
    sessionFactory: (gap: Gap) => AgentSession;
    concurrency?: number;       // 默认 4
    maxExplorers?: number;      // 单次 explore() budget 闸，默认不限
    promote?: (finding) => boolean | Promise<boolean>;  // 人审闸，默认全 promote
    applyToKb?: (finding) => void | Promise<void>;
    signal?: AbortSignal;
  });
  explore(gaps: Gap[]): Promise<GapExplorerResult>;
}
```

三道闸：**budget**（单次最多派 `maxExplorers`，超出 skipped:"budget"、下次可再来）、**去重**（同 `gap.id` 探过不再探；失败/中止/超预算的从 `_seen` 移除以便重试）、**人审 promote**（finding 先过 `promote()` 才 `applyToKb`，拒掉的不写 KB、也不再重探）。

**关键诚实点**：`AgentSession.run()` **不 throw**——abort/max_turns/LLM error 都 resolve 出对应 reason 的 RunSummary（不是抛异常），故 explorer 全部以 `status==="ok"` 回来。**必须看 `terminal.reason`**：只有 `"done"` 才算有效 finding（绝不拿半成品/被截断的 run 补 KB）；非 done → `incomplete`、从 `_seen` 移除以便重探。且 `reason==="done"` ≠「答案完整」（provider 截断 stopReason==="length" / error 仍以 done 收尾）——要排半成品，在注入的 `promote(finding)` 里查 `finding.terminal.stopReason`。最后 `toReanswer` = promoted findings 的 `affects` 并集（去重）。

#### 6.7.3 测试要点

- budget 超派 skipped、去重命中 skipped、失败/中止可重探
- 非 done 进 incomplete 不 promote；promote 拒掉不写 KB；toReanswer 是 promoted affects 并集（`gap-explorer.test.ts`）

---

## 7. 仍未落地的 controller（占位，仅记录设计）

### 7.1 `sideQuestion`（Claude Code `/btw` 模式）

Fork 一个 lightweight agent **共享父 session 的 prompt cache**，回答一个一次性问题不影响主对话。借鉴 Claude Code [`utils/forkedAgent.ts`](https://github.com/badlogic/pi-mono) + [`utils/sideQuestion.ts`](https://github.com/badlogic/pi-mono) 156 行实现。

**v0 不实现，但这里写下完整设计**，目的是确保 [02-kernel `AgentSession`](02-kernel.md) 暴露的接口够支撑未来 fork——v0 提前关死接缝就很难补救。

#### 7.1.1 核心机制：`CacheSafeParams`

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

#### 7.1.2 完整 API 草图

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

#### 7.1.3 设计要点（来自 Claude Code 的血泪）

1. **`systemPrompt` 必须字节对齐**：哪怕加一个空格都 bust cache。Fork 直接复用父引用最稳
2. **`thinkingConfig` 是 cache key 一部分**：fork 自己改 thinking budget 会让父 cache miss。要省 cost 不要改它
3. **`maxOutputTokens` 不能擅自改**：在 pi-ai 里 max_tokens 跟 thinking_budget 关联，clamp 后影响 cache。fork 想限输出请走"prompt 里说短点"
4. **`skipCacheWrite: true` 适合 fire-and-forget**：fork 写新 cache 等于浪费——下次没人会从这个 prefix 复用
5. **wrappedQuestion 的 `<system-reminder>` 是关键**：明确告诉 LLM "你是一个 fork，不要 tool 不要多轮"——Claude Code 注释里说不加这个 fork 经常想调 tool

#### 7.1.4 价值

- **debug**："上一步那个错误是什么意思" 不用打断主流程
- **用户辅助问题**："这个 tool 干嘛的" / "上下文里 X 字段含义"
- **元 reasoning**：父 agent 自己 fork 一个 "review my last decision" 副 agent
- **不污染**：父 session 的 messages / metric / cost-tracker 都不被影响

#### 7.1.5 为什么仍未落地

- 需要 kernel 多暴露 `getCacheSafeParams()` + `skipCacheWrite` 透传，是非小改动
- 没有真实用例（bidding-agent 没用，上游也注释这是 "promptSuggestion / postTurnSummary / /btw 三种 caller 才需要"）
- 真有需求时再做，**接缝留好就行**

> **原 §6.2 `subAgent` / §6.3 `compactor` 已落地、移出占位**：模型驱动的子代理 → §6.6（`subAgentTool` / `routedSubAgentTool` / `SubAgentRegistry`）；自动 compaction → §5.15 `autoCompaction`（view 压缩）+ §6.1–6.3（overflow/boundary 控制器）。

---

## 8. Controller 设计原则总结

1. **Controller 调用 kernel，不修改 kernel**——controller 是 session 的客户
2. **每个 controller 一个文件**（除非 LOC > 400 才拆子模块）
3. **不依赖具体 plugin**——controller 通过 `workerFactory`/`sessionFactory` callback 让用户注入 session，里面挂什么 plugin 是用户的事
4. **接受 AbortSignal**——所有 long-running controller 必须支持外部 abort
5. **明确的完成协议**——`onComplete` / `onAllComplete` / `onItemComplete` 必须被调用一次，绝不悬挂

## 9. 下一步

- [05-plugins](05-plugins.md) —— controller 用到的 plugin（watchdog / leaseDecision）的实现细节
- [07-adapters](07-adapters.md) —— controller 内多 session 共享一个 sink 的模式
- [02-kernel](02-kernel.md) —— controller 调用的 `AgentSession.run()` 协议
