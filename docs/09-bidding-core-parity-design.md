# 09 · harness-pi 作为 bidding-agent Agent Core 的设计文档

> 目标读者：harness-pi 作者（=唯一生产用户）。
> 前置阅读：`01-architecture.md`（内核形状）、`06-controllers.md`（控制器层）、`08-claude-code-lessons.md`（四大 harness 借鉴）、`roadmap.md`（当前阶段）。
> 本文回答一个问题：**如果要用 harness-pi 替换 bidding-agent 的 agent core（在 Hybrid 架构下），还要做哪些工作；其中哪些必须内置进内核，哪些用「内核能力 + 插件系统」实现。**

---

## 0. 背景与目标

bidding-agent 现状：业务 loop 是套在 `@mariozechner/pi-coding-agent` per-turn loop 之外的一层 `session.subscribe` 回调图编排（1653 行 god-file `session.ts`），手搓了 lease pool / watchdog / 三套 `agent_end` 续跑 / CAS / QuestionWorkMemory resume。两套并发实现语义不对等，正确性靠 `this was a real prod bug` 注释维系。

已定的目标架构（Hybrid，见 bidding 架构评估）：

- **确定性答题/度量** → 声明式编排（`parallel()/pipeline()` + budget + resume + typed terminal result），不要 model-driven meta-agent。
- **开放式 KB 探索** → model-driven explorer（已有 WikiMaintainer，新增 bounded gap-explorer）。
- **覆盖率/准确率** → 反馈闭环（gap → explorer 补 KB → 重答），不是一个大 agent。

要用 harness-pi 当这套架构的 agent core，缺口分两类：

- **(A) parity blocker**：`pi-coding-agent` 今天给 bidding 的东西，harness-pi 必须补齐才能不退化。
- **(B) 净新增能力**：Hybrid 架构需要、而 `pi-coding-agent` 和 harness-pi 现状都没有的东西。

> 本文的核心不是「列 todo」，而是 **为每个能力定级：内核（built-in）/ 内核协议（protocol）/ 插件（plugin）/ 控制器（controller）/ 适配器（adapter）/ 应用（app）**——并说清楚为什么在那一层。

---

## 1. 划界总原则：什么才配进内核

harness-pi 的立身之本是「最小内核 + 自带电池的插件」「core domain-free」「hook-as-interceptor」。这条线不能因为迁移 bidding 而松动。判据如下，**三条全中才进内核**：

1. **它就是 loop 本身**——没法在外面用 hook 实现，因为它要*是*控制流的一部分（事件的发射点、resume 的 turn 重入时机、steering 队列的 drain 时机）。
2. **它是上层互操作的稳定契约**——必须由内核定义*类型/协议*，否则插件之间没法协作。推论：**内核定义协议，具体实现下沉到 adapter/plugin**。
3. **它 domain-free 且通用**——所有 agent 都要，且不含任何业务概念（`grep '"question"|"evidence"|"judgment"' packages/core/src` 必须仍为空）。

反向判据——**只要符合任一条就别进内核**：是「策略/政策」（可有多种实现且要可替换）、是具体 I/O 实现（PG / WS / 文件）、是 domain 概念、能用现有 hook 点在外面干净实现。

> 借鉴：kimi-code `loop/README.md` 明文「loop does not own sessions, wire transport, compaction execution, permissions UI, or durable protocol bridging — those are host-layer responsibilities」；iii.dev「A framework picks a position on the slider for you and locks you in」。harness-pi 已经是这条路线的认真实践，迁移期要继续守住，**而不是把 bidding 的业务/策略焊进内核**。

一个反复出现的模式，先点明，后面每个能力都套它：

> **机制（mechanism）进内核，策略（policy）进插件。协议（protocol）进内核，实现（impl）进 adapter。**

例如：steering 的「park 队列 + drain 时机」是机制（内核），「何时该 park、谁能回复」是策略（插件/app）；SessionStore 的「接口 + resume 重入」是协议+机制（内核），「落 PG 还是 JSONL」是实现（adapter）。

---

## 2. 能力分层总表

| # | 能力 | 类型 | 层级 | 为什么在这层 | 借鉴 |
|---|------|------|------|------|------|
| 1 | **Event Bus**：细粒度 LLM/turn/tool 流式事件发射 | A parity | **内核（机制+契约）** | 发射点在 loop 里，无法 hook；事件类型是上层稳定契约。但 transport 不进内核。 | codex 8-variant 线协议 · kimi durable/live 双轨 |
| 2 | **TerminalResult**：每次 run 的 typed 结果 | B 新增 | **内核（契约）** | 编排层依赖的稳定类型，loop 产出它 | — |
| 3 | **ToolResult envelope** 扩展（details/newMessages 已有，补 per-call meta） | A parity | **内核（契约）**（已部分有） | tool executor 产出，单 chokepoint 已在内核 | cc Tool result persistence · pi terminate |
| 4 | **SessionStore 协议 + resume 重入机制** | A parity | **内核协议 + 内核机制**；impl=adapter | resume 必须由 loop 重入（机制）；存储实现可换（adapter） | pi branching tree · codex rollout · kimi SessionStorage |
| 5 | **Steering / inject**：park 队列 + drain | B 新增 | **内核机制**；policy=plugin/app | drain 时机在 loop 里 | codex park-不-suspend · cc steering |
| 6 | **Compaction hook point + overflow 可观测事件** | A parity | **内核 hook 点 + 事件**；strategy=plugin | 触发在 turn 边界，`transformMessagesBeforeLlm` 已是内核 hook | iii.dev/kimi turn-boundary worker · cc cache-aware |
| 7 | **fail-closed 分类** | A parity | **内核 dispatcher 改造** | 是 dispatch 语义本身 | codex Guardian fail-closed |
| 8 | **声明式编排层**（parallel/pipeline/budget/resume/phase + typed result） | B 新增·分水岭 | **独立 package（建在内核之上）** | 编排*多个* session，不属于单 session 内核 | cc dynamic-workflows（确定性版） |
| 9 | **permissionGate** 声明式规则 | A parity | **插件**（挂在已有 decision hook + 单 chokepoint） | 纯策略 | cc 规则引擎 · codex exec-policy |
| 10 | **compaction 策略**（summarize / restart-fresh / cache-edit） | A parity | **插件** | 可替换策略 | cc 多 tier · bidding overflow→restart |
| 11 | **per-work-item metrics/cost 归账** | A parity | **插件**（已有 metrics，加 work-item 维度） | 策略性聚合 | — |
| 12 | **SessionStore adapter**（JSONL / Postgres） | A parity | **adapter**（peerDep `pg`） | 具体 I/O | codex thread-store SQLite |
| 13 | **Transport pump**（Event Bus → WebSocket） | A parity | **adapter / app** | transport | codex stdio-to-uds |
| 14 | **subAgent / gap-explorer**（覆盖率闭环） | B 新增·P2 | **controller + tool factory** | 编排/工具，非内核 | cc AgentTool · codex AgentControl（bounded） |
| 15 | Question / Evidence / Judgment / phase / cascade prompt 语义 | — | **application（bidding）** | domain，永不进内核 | — |

下面 §3 展开「进内核的」，§4 展开「用内核能力 + 插件实现的」，§5 划清留在 bidding 侧的，§6 排期，附录给接口草案。

---

## 3. 要内置进内核的能力（built-in）

每个能力按 **要怎么做（需求）→ 该怎么做（推荐设计 + 为什么在内核）→ 能怎么做（备选与取舍）** 展开。

### 3.1 Event Bus —— 流式事件发射 〔#1，内核机制+契约〕

**要怎么做。** bidding 的 WS UI 依赖中途 token / thinking delta + 工具进度，且要按题归账。harness-pi 现状只有粗粒度生命周期事件（`onLlmEnd` 等）回放，内核调的是 `complete()` 不是 `stream()`，回合中途不可观测。这是「能不能迁」的门槛。

**该怎么做（内核）。**
- 内核把 `_phaseLlmCall` 从 `pi-ai.complete()` 改为 `pi-ai.stream()`，消费 pi-ai 已有的流（pi-ai 本就支持，bidding 现在就靠它拿 thinking），**在内核里**把它再发射成一组稳定的 kernel 事件：`text_delta` / `thinking_delta` / `toolcall_delta` / `message_start` / `message_end` / `tool_exec_start` / `tool_exec_update` / `tool_exec_end` / `turn_start` / `turn_end`。
- 为什么进内核：发射点*就在循环里*（在 stream 的消费循环、tool executor 内部），没法用 hook 在外面拿到中途 chunk。事件的*类型*是 Event Bus、transport、metrics 全都依赖的稳定契约——契约必须由内核定义（判据 1+2）。
- 区分两条轨（借 kimi）：**recorded events**（进 transcript / store，durable）vs **live-only events**（token delta，给 UI，可丢）。live listener 抛错被内核隔离，不影响 loop（kimi 的 contract，直接抄）。
- **不进内核的**：WebSocket / SSE / JSONL 具体 transport —— 那是 adapter（§4.6）。内核只暴露一个 `session.events`（AsyncIterable 或 `on(type, cb)`），谁要 pump 到哪去自己接。

**能怎么做（备选）。**
- (a) AsyncIterable（`for await (const e of session.events)`）——背压天然，像 cc generator。
- (b) `on(type, handler)` 订阅——像 pi/kimi，listener 容错好做。
- 取舍：**两者都给**——内部用一个 bounded buffer 的 emitter，对外同时暴露 `on()` 和 `[Symbol.asyncIterator]`。live event 用 drop-oldest（UI 丢几帧无所谓），recorded event 不丢（要落 store）。不要 unbounded 队列（pi 的隐患）。

### 3.2 TerminalResult —— 每次 run 的 typed 结果 〔#2，内核契约〕

**要怎么做。** 声明式编排（#8）要能拿到「这次 run 干完了没、什么结局」。bidding 现在靠回调直接 mutate `ctx.currentQuestionTerminal` 这种共享可变 flag 传 terminal 信号——这是 god-file 耦合之源，也是 loop-eval 的 P1。

**该怎么做（内核）。** `session.run()` / `continue()` 返回一个判别联合 `TerminalResult`：

```ts
type TerminalResult =
  | { kind: "done"; stopReason: StopReason; usage: Usage; lastMessage: AssistantMessage }
  | { kind: "aborted"; reason: string }
  | { kind: "error"; phase: "llm" | "tool" | "hook"; error: unknown }
  | { kind: "max_turns" };
```
- 为什么进内核：这是 loop 的*产出*，且是编排层依赖的稳定类型（判据 1+2）。
- 关键设计：**内核只产出 domain-free 的 `kind`**。bidding 的 `filled / uncertain / failed` 是 domain 语义，由 application 从 `TerminalResult` + 自己的 tool 回调（judge/clarify 是否触发）**映射**出来——不能进内核（判据 3）。即：内核给你「这次 run 正常收敛 / 被 abort / 出错」，bidding 自己决定「正常收敛且 judge 触发 = filled」。

**能怎么做。** 备选是继续用现有 `RunSummary`（已有 `reason` 字段）。取舍：把 `RunSummary` 收敛成上面这个判别联合即可，不用新概念；重点是**让它成为唯一的 terminal 信号通道**，禁止 application 靠 mutate ctx 传 terminal（配合 §5 的 ctx 只读约束）。

### 3.3 ToolResult envelope 〔#3，内核契约，已部分有〕

**要怎么做。** bidding 的 evidence 校验、per-question 归账、tool 输出截断都挂在 tool result 上。harness-pi 的 `ToolExecResult` 已有 `details` / `newMessages`（v0.1 gate 已落）。

**该怎么做（内核）。** 保持现有 envelope；补一个 **per-call meta 钩子**：tool executor 在单 chokepoint（`ToolExecutor._executeOne`，已是内核）发 `tool_exec_end` 事件时携带 `{ toolName, callId, durationMs, isError, details }`，供 metrics 插件按 work-item 归账（#11）用。不要把「按 question 归账」塞进内核（domain）。

**能怎么做。** 现状基本够用，只是把归账所需 meta 放进事件 payload 而非让插件去 ctx 里翻。

### 3.4 SessionStore 协议 + resume 重入 〔#4，内核协议 + 内核机制；impl=adapter〕

**要怎么做。** bidding 落 PostgreSQL，watchdog 重启要从进度恢复，benchmark 要可复现。harness-pi 现状：`session.snapshot()` 扁平快照 + lifecycleRestart 靠内存 `[...session.messages]` 复制重发，**无 store 协议、无 resume-by-id**。roadmap 甚至把「不引入 PG sink」列进*明确不做*——**这是当前路线图最大的盲点：把 persistence 当 adapter 取舍，但 resume 机制本身是内核职责。**

**该怎么做。** 拆成两半，是本设计最重要的「内核 vs adapter」示范：

- **进内核（协议 + 机制）**：
  - 定义 `SessionStore` 接口（append-only + leaf/branch + resume-by-id），见附录 A。
  - 内核机制：构造 `AgentSession` 时可传 `store` + `sessionId`；run 时每个 turn 的 delta（messages、TerminalResult、compaction 边界）**append** 进 store；`AgentSession.resume(store, sessionId)` 能 rehydrate messages 并从正确的 turn 重入。**重入是 loop 控制流的一部分，必须内核做**（判据 1）。
  - 显式处理 compaction 边界：resume 时不能重发已被 summary 替换的前缀（这正是四大 harness 共识里「resume 重放要处理 compaction 边界」那条）。
- **下沉到 adapter（实现）**：`MemorySessionStore`（测试，内核包内可带）、`JsonlSessionStore`（文件）、`PostgresSessionStore`（peerDep `pg`，给 DDL 示例）。**内核零依赖 `pg`**（判据：实现可换）。

- 顺带：`lifecycleRestart` controller 改成 **从 store resume** 而非内存复制——既省内存（现状 100 session ≈ 250MB、messages 永不淘汰），又让重启天然可观测、可复现。

**能怎么做（取舍）。**
- 存储模型：**branching tree（pi 式）** vs 线性 rollout（codex 式）。取舍：**接口设计成 tree（带 `parentId` / `leafId`），但 v1 实现可以只用线性 append**——给 fork/sideQuestion（#14）留路，不提前实现分支导航。pi 的 tree 是「最优雅」，但 bidding 当前只需要线性 resume + fork-on-restart。
- 落盘时机：每 turn append（durable，崩溃损失 ≤1 turn）vs 批量。取舍：每 turn append（codex/kimi 都这么干，且 lazy 物化到首条真实内容才建文件——这条也抄）。

### 3.5 Steering / inject —— park 队列 + drain 〔#5，内核机制；policy=plugin〕

**要怎么做。** bidding 的 `clarify_capability` / `ask_user` 要把用户回复**插队**进当前或下一个 turn 的模型。harness-pi 现状：只有 `onPreToolUse` 同步 deny/allow + 协作式整 session abort，`appendMessage` 不能插队进行中的 turn（doc §9 已自陈）。这逼 bidding 在业务层绕开 kernel。

**该怎么做（内核机制）。** 借 iii.dev / codex 的「park 不 suspend」：
- 内核维护一个 **steering inbox**（队列）。loop 在两个安全点 drain 它：每个 turn 开始前、以及（可选）tool batch 之间。drain 时把 queued 的 user/system message 注入下一次 `buildMessages`。
- **为什么进内核**：drain 的*时机*在 loop 里（判据 1），且要保证「park 进来的消息不破坏 turn 原子性 / 不破坏 cache 前缀」——这只有 loop 自己能保证。
- 暴露 `session.steer(message)`（线程安全 enqueue）+ 一个 `onSteer` 事件。
- **不进内核的**：approval 这种「park 一个 tool call 等人批，batch 其余继续跑」的 *policy*——那是 permissionGate 插件（#9）的事；内核只提供「park + 在安全点恢复」的机制。

**能怎么做。** 备选是「suspend 整个 session 等回复」（实现简单但阻塞、且 server 上多 session 不友好）。取舍：**park（非阻塞）**，对齐 iii.dev 的明确主张，也契合 bidding server 多并发 session 的形态。

### 3.6 Compaction hook point + overflow 可观测事件 〔#6，内核 hook 点 + 事件；strategy=plugin〕

**要怎么做。** 长 RFQ / 多轮 ReAct 会超窗。harness-pi 现状：compaction 刻意排除在 loop 外，`transformMessagesBeforeLlm` pipe 已是内核 hook 点，但**没有标准插件**，且 `'length'` stopReason 被当普通 done、overflow 的 LLM error 直接变 `reason:"error"` 结束 run——**overflow 是「未处理」而非「已恢复」，且不可观测**。

**该怎么做。** 内核只补「可观测 + hook 点」，策略全在插件：
- **进内核**：(a) 把 `'length'` / prompt-too-long / context-overflow 这类 stopReason/error **识别出来并发成 `onContextOverflow` 事件**，而不是静默当 done 或 error；(b) 保留并明确 `transformMessagesBeforeLlm`（已有）作为「compaction 改写消息」的唯一 hook 点；(c) 在 turn 边界发 `onTurnBoundary` 事件供 compaction worker 订阅（借 iii.dev/kimi）。
- **进插件（§4.2）**：具体压缩策略。

**能怎么做。** 这条是「机制 vs 策略」最清楚的示范——内核绝不内置某一种 compaction 算法（cc 自己都有 4 种），只保证「越界可被观测、有标准 hook 点改写消息」。

### 3.7 fail-closed 分类 〔#7，内核 dispatcher 改造〕

**要怎么做。** decision hook（lease / auth / permission）当前默认 **fail-open**：抛错或超 200ms 当「无意见」放行——policy hook 挂掉恰恰是最该拒绝的时刻。这是 loop-eval 的 P0。

**该怎么做（内核）。** 这是 dispatch 语义本身，必须内核改：
- 给 decision hook 注册保留 `failClosed` 标志（已有），但**对「安全关键」类提供注册期校验**：要么内核暴露一个 `registerDecisionHook(hook, { critical: true })`，critical 的若没显式 `failClosed` 直接在注册期报错（fail-loud），避免作者忘设；要么把 permissionGate 这类插件默认 `failClosed:true`。
- decision 超时对安全类可配更长（200ms 对本地规则够，对要 RPC 的 policy 不够）。

**能怎么做。** 备选是「全局默认改 fail-closed」——太激进，会让无害的 context-injection hook 也变阻断。取舍：**默认仍 fail-open，但让「安全类」无法静默 fail-open**（注册期强制表态）。

---

## 4. 用「内核能力 + 插件系统」实现的能力（on top）

这些**不进内核**，建在 §3 的内核契约上。

### 4.1 声明式编排层 —— 分水岭 〔#8，独立 package〕

**要怎么做。** 这是用 harness-pi 替换 bidding god-file 的*核心价值*。bidding 的「答 N 题」是 deterministic-batch（work-list 已知、题独立、fan-out 可公式算），现在用 1653 行命令式回调图实现。要换成声明式：`parallel()` / `pipeline()` / lease pool + budget + resume + phase-progress，每个 work-item 返回 typed result。

**该怎么做（为什么不进内核）。**
- 它编排*多个* `AgentSession`，**不属于单 session 内核**——正如 cc 的 dynamic-workflows 在 loop 之上、harness-pi 现有 controllers 在 `AgentSession` 之上。它是一个**新 package / 新层**（可以就长在 `@harness-pi/plugins/controllers` 里，把现有 leaseQueue/workPool 升级进去）。
- 它**消费内核契约**：每个 work-item = 一次 `AgentSession.run()` → 拿 `TerminalResult`（#2）；用 `SessionStore`（#4）做 resume；订阅 Event Bus（#1）做 phase-progress；用 usage 事件做 budget。**正因为内核把这些做成了稳定契约，编排层才能薄。**
- 形态（确定性，非 model-authored）：

```ts
// 伪代码，建在 kernel 之上
const results = await pipeline(questions, {
  concurrency: ceilDiv(questions.length, 25),     // 公式，非模型决策
  budget: { totalTokens: 2_000_000 },
  store,                                            // resume 来源
  run: (q) => makeSession(q).run(),                 // 每题一次 AgentSession.run → TerminalResult
});
// results: { item, terminal: TerminalResult }[]，编排层保证每个 item 必 settle
```
- 关键不变量（直接解决 bidding 的「静默丢题」prod bug）：**每个 work-item 必返回 typed result，由编排层统一 settle**——不再有「忘了 carryOver onComplete 导致 pool 永挂」。

**能怎么做（取舍）。**
- **是否要 model-authored（CC dynamic-workflows 的「模型写 JS 脚本」）？不要。** 答题的 fan-out 已知，让模型 author 编排零信息增益 + 破坏可复现性/按题归账。只取它的*声明式原语形态*，编排脚本由 harness-pi/应用写死。
- **是把现有 controller 升级，还是新写一层？** 升级现有：把 `leaseQueue`（动态租约）/`workPool`（静态分组）统一成同一套带 `budget`/`resume`/typed-result 的声明式 API，消灭 bidding 现在两套语义不对等的 pool。

**实现注记（as-built）。** 上面伪代码的单段 `pipeline(questions, {run, …})` 形态实际落地为 `parallel(items, {run, concurrency?, signal?, budget?, onProgress?})`（`@harness-pi/plugins/controllers`，每 item 必返 `ItemOutcome` ok/failed/skipped）。**另补了一个多阶段 `pipeline(items, stages[], opts)`**（相对 bidding-architecture 报告里 `parallel()/pipeline()` 提法的缺口）：每 item 独立流过有序 stages、stage 间无 barrier、失败归因到具体 stage，搭在 `parallel()` 上复用其全部并发/budget/abort/进度语义。`leaseQueue`/`workPool` 暂仍各自保留 API——把它们合并成单一声明式 API 属 bidding 迁移期工作，本轮未做。详见附录 A 的 #8 块。

### 4.2 Compaction 策略插件 〔#10，插件〕

建在 §3.6 的内核 hook 点 + overflow 事件上。**至少给两种现成策略**：
- `compactRestartFresh`：监听 `onContextOverflow` → 触发 lifecycleRestart（#4 的 resume）开 fresh session 继承摘要。**这是 bidding 当前选的、也最便宜的策略**（doc-08 自己的结论：「overflow 时直接 abort + watchdog 重启 fresh 比在原 session 里魔法缩小 token 更直接」）。
- `compactSummarize`：在 `transformMessagesBeforeLlm` 里 LLM 总结早期消息 + 保留 recent tail + 写 compaction 边界进 store。
- （未来）`compactCacheAware`：对 DashScope/Qwen prefix cache 友好（借 cc cache_edits 思路，看 pi-ai cache 能力）。

为什么是插件：策略可替换、且 cc 自己都有 4 种——内核绝不选边。

### 4.3 permissionGate 插件 〔#9，插件〕

建在已有 `onPreToolUse` decision hook + 单 tool chokepoint 上。声明式 tool permission rules（pattern → allow/ask/deny），默认 `failClosed:true`（配合 §3.7）。bidding 的 6 处复制守卫（`currentQuestionMismatch` + `isAgentLocked`）收敛到这里——但**规则里那些 domain 判定（「这题是不是当前 lease 的题」）由 bidding 提供 predicate，permissionGate 只提供规则引擎骨架**（判据 3）。借 cc 规则引擎 / codex exec-policy 的形状。

### 4.4 per-work-item metrics / cost 归账 〔#11，插件〕

已有 `metrics` / `cost-tracker` / `token-budget` 插件。补：消费 §3.1 的 `tool_exec_end` + usage 事件，按编排层提供的 `workItemId`（不是 `questionId`！domain 中性）归账。bidding 把 `workItemId` 映射成 `questionId`。

### 4.5 SessionStore adapter（JSONL / Postgres）〔#12，adapter〕

实现 §3.4 的 `SessionStore` 接口。`PostgresSessionStore` peerDep `pg`，给 DDL 示例。这正是 roadmap 里「PostgresSink 触发条件 = 真实部署」——bidding 就是那个真实部署。

### 4.6 Transport pump（Event Bus → WebSocket）〔#13，adapter/app〕

订阅 §3.1 的 Event Bus，把 recorded + live 事件 pump 到 bidding 的 WS（每 session 一条 + per-question 标签）。**纯 transport，留在 adapter/app 侧。** 借 codex「stdout JSONL 让任意 transport 消费」的解耦思路。

### 4.7 subAgent / gap-explorer —— 覆盖率闭环 〔#14，controller + tool factory，P2〕

roadmap 已列 `sideQuestion` controller + `subAgent` tool factory。给 Hybrid 的反馈闭环用：检测 gap（uncertain/pending/coverage_gap）→ 派一个 **bounded explorer**（budget + 去重 + 人审 promote queue 作闸）去补 KB → 重答受影响题。explorer 复用编排层（#8）+ AgentSession，**不是顶层 meta-agent**。借 cc AgentTool / codex AgentControl，但严格 bounded。

---

## 5. 永远留在 application（bidding）侧的

内核 / 插件都不碰，否则 domain 泄漏（判据 3）：

- **Question / Evidence / Judgment / phase（searching/recovery/ready_to_judge）** 等领域概念。
- **L0→L1→L2 检索 cascade 的语义**：cascade 的*顺序保证*可以用工具 schema/gating（内核可提供「tool 依赖/解锁」原语），但「faq_cache→wiki→kb_search」这串具体工具是 bidding 的。
- **compliant 激进 / non_compliant 保守** 这种判定旋钮（prompt 语义）。
- **TerminalResult.kind → filled/uncertain/failed** 的映射。
- **覆盖率/准确率公式**（`computeMetrics`）。

⚠️ 顺带修内核里已知的一处 domain 泄漏：`lease-decision.ts` 默认 `argField:'questionId'`——改成无 domain 默认或强制显式传入。

---

## 6. 分阶段落地（spike-first，需求拉动）

> 战略前提（roadmap 自己写的）：框架作者 = 唯一生产用户，别在真空里堆框架。**让 bidding 单题 happy-path spike 当 forcing function**。

> **落地状态（截至 2026-06）**：图例 ✅ = harness-pi 机制层已落地（实现 + 测试 + 三门 + 合入 main）；🟡 = 部分落地；⬜ = 未做。
> **要点**：能力项 #1–#14 + 杂项的**机制层已全部 ✅**；但每个 Phase 的**验收**（用 harness-pi 实际跑通 bidding 单题 / 整份 RFQ）**全部 ⬜**——因为 bidding 还跑在 1653 行 god-file 上，迁移一行未动。即「目的地已就绪，列车还没开」。

**Phase 0 — spike 地基（解锁「能不能迁」）**
- ✅ #1 Event Bus（recorded + live 双轨：text/thinking/toolcall delta + 生命周期事件）
- ✅ #4 SessionStore 协议 + `MemorySessionStore` + `AgentSession.resume()` 重入机制（resume.test 15 例，含 compaction 边界裁剪 / high-water-mark / 非-done resume）
- ✅ #2 TerminalResult（`RunSummary` 富化：reason + usage + lastMessage + stopReason）
- ⬜ **验收：用 harness-pi 跑通 bidding 单题 run-through（检索→submit→judge），WS 看到 thinking，崩溃能 resume。**（即 roadmap v0.1 gate 未勾的「production-like spike」——待迁移）

**Phase 1 — 分水岭（解锁「迁了有没有价值」）**
- ✅ #8 声明式编排层：`parallel()` + 多阶段 `pipeline()` + budget + typed `ItemOutcome`（`leaseQueue`/`workPool` 暂仍各自保留，合并属迁移期工作）
- ✅ #12 `JsonlSessionStore` + `PostgresSessionStore`（注入 PgClient，pg-mem 契约 + 真 PG 集成测试）
- ✅ #13 WS transport pump（`EventPump` + `WebSocketSink`）
- ✅ #3 per-call meta（既有 onPostToolUse）+ #11 work-item 归账（`WorkItemAggregator`）
- ⬜ **验收：用编排层跑通 bidding 整份 RFQ（多题并发 + 按题归账 + benchmark 可复现），行为不弱于现状。**（待迁移）

**Phase 2 — 收口与安全**
- ✅ #6 overflow 事件（`onContextOverflow`）+ #10 `compactRestartFresh`
- ✅ #5 steering（`AgentSession.steer()` + `onSteer`，turn-start drain）
- ✅ #7 fail-closed 分类 + #9 `permissionGate`（规则引擎骨架，domain 谓词由调用方给）
- 🟡 #4 `PostgresSessionStore` ✅ ；**lifecycleRestart 从 store resume ⬜**（`AgentSession.resume()` 原语在，但没有 controller 把它接进「重启即续跑」流程——是 harness-pi 这边唯一未接的机制 glue）
- ✅ #9 杂项：ctx.state slot API（TypedStateMap）、around-hook 超时（结论：不加内核机制，协作式 abort）、去 `questionId` domain 默认（lease-decision argField 必填）

**Phase 3 — Hybrid 闭环**
- ✅ #14 subAgent（`subAgentTool`）/ gap-explorer（`GapExplorer`，bounded fan-out + 去重 + promote 闸骨架）+ 覆盖率反馈闭环骨架
- ✅ #10 `compactSummarize`（cache-aware 变体未做，待 benchmark 证明值得）
- ⬜ **验收：覆盖率闭环在 bidding 上跑出 KB 增益（≥3 paired / ≥200 题统计验证）。**（待迁移 + 实验）

**依赖关系**：#4 是 #8 resume 的前置；#1+#4 是 Phase 0 门槛；#8 是「迁了有没有价值」门槛；#6 是 #10 的前置；#5/#7/#9 收口期一起。**机制层这些前置已全部满足，剩下的全是「把 bidding 搬上来」的迁移工程**（详见 §5 留在 bidding 侧的领域层）。

---

## 7. 风险与开放问题

1. **pi-ai 0.53.1 SDK 边界**：Event Bus（#1）依赖 pi-ai 的 stream 能力 + cache header；compaction cache-aware（#4.2）依赖 pi-ai cache 集成。

   **✅ 已核验（2026-06，静态读 pi-ai 0.53.1 类型 + 真实 DashScope/Qwen 探针）：**
   - **stream 事件（#1）**：pi-ai 暴露 `start / text_start / text_delta / text_end / thinking_* / toolcall_* / done / error` 全套（`types.d.ts` 的 `AssistantMessageEvent`）；真实 qwen-turbo 流式实测发出 `start,text_start,text_delta,text_end,done`——内核 LiveEvent 的 delta 轨假设成立。
   - **error 不 sync throw（#6 命脉）**：真实 DashScope 坏请求（404）**不抛异常**，而是 resolve 成 `stopReason:"error"` + `errorMessage` 的 AssistantMessage（探针 `threwSync:false`）。内核「stopReason==='error' 时按 errorMessage 文案分类 overflow」的设计对得上真实 provider 形状。`StopReason` 含 `"length"`（截断＝无歧义 overflow）✅。
   - **usage / cache（#2/#11/#10）**：`Usage` 含 `input/output/cacheRead/cacheWrite/totalTokens/cost{}`；真实 Qwen 流式**确实返回 usage token 数**（`supportsUsageInStreaming` 成立）。`StreamOptions.cacheRetention:"none"|"short"|"long"` + `sessionId` 是 cache-aware（#10）可用的旋钮。（cost 由 `Model.cost` 驱动，DashScope 适配器另算 CNY，符合现状。）
   - **overflow 检测归属（影响 #6）⚠️**：pi-ai 0.53.1 **自带** `isContextOverflow(message, contextWindow?)` + `getOverflowPatterns()`（`utils/overflow.js`，含维护好的 OVERFLOW_PATTERNS + 「silent overflow＝usage.input>contextWindow」检测）。内核 `defaultIsContextOverflow` 目前是**平行另写**的一套 patterns，二者**会漂移**：内核**有** Qwen 的 `"range of input length"` 而 pi-ai **没有**（pi-ai 的可靠列表不含 DashScope/Qwen）；pi-ai 则多了 silent-overflow + 更多 provider。**建议（待 follow-up，属行为变更需单独走门）**：内核改为「组合 pi-ai 的 `getOverflowPatterns()` + 内核的 Qwen 补充」或直接委托 pi-ai 的 `isContextOverflow`，以继承上游维护与 silent-overflow，同时不丢 Qwen 覆盖。

   **残留（未验，成本所限）**：Qwen **真实** overflow 文案未实跑触发（需送 >1M token）。内核已据文档预置 `"range of input length"` 应对；待 bidding 首次真撞 Qwen overflow 时确认文案命中（或按上面建议委托 pi-ai）。
2. **resume 与 compaction 边界的交互**（#4 × #6）：resume 重放必须跳过被 summary 替换的前缀，否则重发被压缩内容。这是四大 harness 的共识难点，要专门测。
3. **编排层放哪个 package**（#8）：升级现有 `controllers` vs 新建 `@harness-pi/orchestration`。倾向前者（少一个包，复用 lease/workPool 测试），但若 API 形态差异大就独立。
4. **「作者=用户」的耦合风险**：每个 Phase 都要能独立验收、能回退；Phase 0/1 用独立 worktree spike，不动 bidding 主线，直到 parity 证明够用。
5. **不要为通用性过度设计**：第二个真实下游还不存在（roadmap v0.1 gate 未勾）。除 §3 列的内核项外，#14 这类 controller/tool 候选「触发条件 = bidding spike 证明需要」，否则留在 application 侧。

---

## 附录 A · 内核接口草案（TS sketch）

> 仅形态示意，类型对齐 pi-ai / 现有 `AgentSession`。

```ts
// ── #2 TerminalResult（domain-free）──────────────────────────
// 实现说明：未新造 TerminalResult 类型，而是把既有 `RunSummary` 富化成「结构化终态」——
// 判别字段是 `reason`（非 `kind`），并加上 `usage`（内核总是累加填充）/`lastMessage`/`stopReason`。
// 这样不破坏 154 个既有测试（它们读 .reason/.turns），同时给编排层 budget + work-item 终态。
interface RunSummary {
  turns: number; continuations: number;
  reason: "done" | "max_turns" | "aborted" | "error" | "max_continuations";
  usage: Usage;                       // 跨本次 run 累加（含 cost），内核总是填充
  lastMessage?: AssistantMessage;     // 最后一条 assistant（无 LLM 调用则缺省）
  stopReason?: StopReason;            // lastMessage 的 stopReason
  error?: Error; abortReason?: string;
}
// 业务层（bidding）从 reason + 自己的 tool 回调映射出 filled/uncertain/failed（不进内核）。

// ── #1 Event Bus（recorded + live 双轨）──────────────────────
type KernelEvent =
  | { track: "recorded"; type: "turn_start" | "turn_end" | "tool_exec_start" | "tool_exec_end"
      | "message_start" | "message_end" | "context_overflow" | "turn_boundary" | "steer"; payload: unknown }
  | { track: "live"; type: "text_delta" | "thinking_delta" | "toolcall_delta"; payload: unknown };

interface AgentSession {
  run(input: RunInput): Promise<TerminalResult>;
  continue(input: RunInput): Promise<TerminalResult>;
  // 流式：两种消费方式都给
  events: AsyncIterable<KernelEvent>;
  on(type: KernelEvent["type"], cb: (e: KernelEvent) => void): () => void;
  // #5 steering：线程安全 enqueue，loop 在安全点 drain
  steer(message: UserMessage | SystemMessage): void;
  // #4 持久化
  snapshot(): SessionSnapshot;
}

// ── #4 SessionStore（协议进内核；impl 进 adapter）────────────
// 注：以下为实现后的最终签名（代码是协议唯一真相源，packages/core/src/session-store.ts）。
// 相比初稿：append→appendEntry（返回落库 StoredEntry）、loadPathToLeaf→getPathToLeaf、
// fork 第二参 fromLeafId→fromEntryId（fork 点不必是 leaf）；parentId/seq 由 store 分配（不在 entry 内容里）。
interface SessionStore {
  appendEntry(sessionId: string, entry: SessionEntry): Promise<StoredEntry>; // append-only；同 sessionId 须串行
  getLeafId(sessionId: string): Promise<string | null>;
  getPathToLeaf(sessionId: string, leafId?: string): Promise<StoredEntry[]>; // 第一跳 miss=空；中途断链=throw
  fork(sessionId: string, fromEntryId: string): Promise<string>;      // 批量复制前缀 + 记 lineage，不改父
  getLineage(sessionId: string): Promise<ForkLineage | null>;         // 直接父，非始祖
}
interface StoredEntry { id: string; parentId: string | null; seq: number; entry: SessionEntry; }
type SessionEntry =
  | { kind: "message"; message: Message }
  | { kind: "compaction_boundary"; summary: Message }                 // resume 重放跳过其前缀（裁剪在 T4）
  | { kind: "terminal"; result: RunSummary };                         // RunSummary 即终态（T3 已富化）；T4 resume 落它

namespace AgentSession {
  // resume 重入是内核机制
  function resume(store: SessionStore, sessionId: string, deps: SessionDeps): Promise<AgentSession>;
}

// ── #12 SessionStore adapters（§4.5）─────────────────────────
// 实现说明：@harness-pi/adapters 实现上面 #4 协议。JsonlSessionStore（文件，torn-tail 容错 + 形状校验）；
//   PostgresSessionStore 经注入的最小 PgClient 接口（node-pg 的 Pool 天生满足、无需 cast），本包**零 pg
//   运行时依赖**（任何满足 PgClient 的 driver 都行——比 §4.5「peerDep pg」更松）。测试：pg-mem 跑 SessionStore
//   契约 + env-gated 真 PG 集成测试（POSTGRES_TEST_URL，docker postgres:16 实跑）覆盖模拟器测不了的——
//   migrate 幂等(重跑 IF NOT EXISTS)、真 jsonb 往返、真并发 UNIQUE(session_id,seq) 兜底（断言不变量而非
//   时序，防 flaky）。pg/@types/pg 仅 devDep；无 URL 时集成测试整段干净 skip。

// ── #5 Steering（park/drain，内核机制）─────────────────────
// 实现说明：草案的 KernelEvent "steer" 与 `steer(message: UserMessage | SystemMessage)` 落地为：
// 一个公共方法 `AgentSession.steer(message: Message)` + 一个 hook 事件 `onSteer`。pi-ai 无独立
// system role（Message = user|assistant|toolResult），故只接受 role:"user"（assistant/toolResult
// 抛错 fail-loud）。loop 在**每个 turn 开始的安全点**（_runOneTurn 顶部、onTurnStart 之前）drain
// inbox：原子 swap 取走队列、按序 push 进 messages、对每条 fire onSteer。这是「park 不 suspend」——
// 不打断进行中的 turn，排到下个安全点注入，保 turn 原子性 / cache 前缀不破。tool-batch 之间的
// （可选）drain 暂未做（YAGNI），turn-start drain 已覆盖 clarify 回复插队的主场景。
interface SteerInput { message: Message; turnIdx: number; }
// AgentSession.steer(message: Message): void   // 线程安全 enqueue（单线程 push 原子），非阻塞

// ── #6 Compaction overflow 观测点 ───────────────────────────
// 实现说明：未把 overflow 做成上面 KernelEvent 草案里的 recorded "context_overflow"，而是落成一个
// **hook 方法** `onContextOverflow`（与既有 onLlmEnd/onTurnEnd 同构，策略插件直接挂）。pi-ai 把「越界」
// resolve 成两种终态（不是 sync throw —— 那只在 provider 未注册时发生）：stopReason==="length"（无歧义截断）
// 与 stopReason==="error"+errorMessage 命中 overflow 文案。后者的判定经选项可整体替换，内核不选边。
// §3.6(c) 的 onTurnBoundary：已有 onTurnEnd 在每个 turn 边界 fire，compaction worker 直接订阅它，
// 不再新增冗余事件。
interface ContextOverflowInput {
  turnIdx: number;
  stopReason: "length" | "error";   // 判别来源（即触发时 assistant 的 stopReason）
  errorMessage?: string;            // stopReason==="error" 时的 provider 文案
  messageCount: number;             // 触发时 session.messages 条数（assistant 已 push）
}
interface AgentSessionOptions {
  // 把一次 error-stopReason 判成 overflow 的谓词；默认 defaultIsContextOverflow（OpenAI/Anthropic/DashScope 文案）
  isContextOverflow?: (errorMessage: string) => boolean;
}
// #10 compactRestartFresh（插件，§4.2）：compactOnOverflow() hook 在 onContextOverflow 里
// ctx.abort("compaction:…")，CompactRestartFresh 控制器据 isCompactionRestart(abortReason) 用 fresh
// session 重跑同一 prompt（丢掉越界 trace）。与 LifecycleRestart 共享该谓词，但语义相反（丢历史 vs 带历史）。
// #10 compactSummarize（插件，§4.2）：transformMessagesBeforeLlm hook，超阈值时用注入的 summarize(可调
// LLM)把早期消息总结成一条 + recent tail；按覆盖前缀缓存(resummarizeEvery 节奏)；只改模型 view 省 token，
// 不动 _messages。summarize 抛错被内核 pipe fail-open 吞掉 → 退化为不压缩(run 不中断)。
// 实现说明：doc 原文「写 compaction 边界进 store」未做——HookContext 刻意无 store 写权限(护 _flushToStore
// 高水位不变量)，store-boundary 属编排层职责。本 hook 压缩 view（与 trim-history 互补：语义压缩 vs 机械占位）。

// ── #7 fail-closed 分类 ─────────────────────────────────────
// 实现说明：草案的 `decisionHook(..., { critical })` wrapper 落地成 Hook 上的两个字段 + 一个注册期硬校验，
// 不另造 wrapper（保持 hook = 普通对象的一致形态）：
interface Hook { critical?: boolean; failClosed?: boolean; /* ... */ }
// assertCriticalDecisionHooks(hooks)：在 AgentSession 构造期 + use() 调用。critical:true 的 hook
//   1. 必须实现 decision 方法（onPreToolUse/onUserPromptSubmit，复用 DECISION_METHODS 判定）；
//   2. 必须显式声明 failClosed（true/false 皆可，但不能 undefined）——否则 throw（fail-loud）。
// 即「默认仍 fail-open，但安全类无法静默 fail-open」。decision 超时已可经既有 hook.timeout 放宽。
const gate: Hook = {
  name: "permissionGate", critical: true, failClosed: true,   // 显式表态 → 通过校验
  onPreToolUse(input, ctx) { /* allow / deny */ },
};
// ── #9 permissionGate（插件，§4.3）──────────────────────────
// permissionGate({ rules: [{ match, decision: "allow"|"ask"|"deny", reason? }], fallback?, onAsk?, ... })
//   match: string（精确）| RegExp（name 模式）| (call, ctx) => boolean（domain 谓词，由调用方提供）。
//   首条命中胜出；无命中走 fallback（默认 deny）；ask 经 onAsk 解析（无解析器 → deny）。
//   默认 critical:true + failClosed:true，故天然通过 #7 校验。规则引擎 domain-free，业务判定全在谓词里。

// ── #11 per-work-item metrics 归账（插件，§4.4）──────────────
// 实现说明：#3 per-call meta 已由既有 onPostToolUse（携带 call.name/id、result.isError/details、durationMs）
// 满足，无需内核改。#11 在既有 metrics 插件上补 work-item 维度：
//   metrics({ sink, workItemId })  // workItemId 戳进每条 MetricEvent（domain 中性，不是 questionId）
//   new WorkItemAggregator({ forward? })  // MetricsSink，按 workItemId rollup（token/tool/error/duration）
//     .rollup(id) / .all()           // 只对 llm.called/tool.called/error.observed 建 rollup；其余只透传
// 清理：lease-decision 的 argField 由「默认 questionId」改为**必填**（清除焊进通用插件的 domain 默认）。

// ── #8 声明式编排（parallel + pipeline，§4.1）──────────────
// 实现说明：§4.1 伪代码的单段 pipeline(items,{run}) 落地为
//   parallel(items, {run, concurrency?, signal?, budget?{total,cost}, onProgress?}) → Array<ItemOutcome>
//   （ok{value} / failed{error} / skipped{reason:"budget"|"aborted"}）。每 item 必 settle、按 index 有序；
//   budget 是派发阈值非硬上限（高并发超支≈在跑的并发数）；失败 / skip 不计费。
// 另补**多阶段** pipeline(items, stages: PipelineStage[], opts)（相对 bidding-architecture 报告的缺口）：
//   每 item 独立流过有序 stages、stage 间**无 barrier**（A 可在 stage2 而 B 仍在 stage0）；PipelineOutcome.failed
//   带 `stage` 下标归因；空 stages = identity(value===item)。搭在 parallel() 上（per-item「串行跑完所有 stage」
//   = parallel 的一个 run）复用其全部语义，只外加 stage 归因（内部 StageError 载体 + instanceof 守卫）。
//   leaseQueue/workPool 暂仍各自保留 API（统一成单一声明式 API 属 bidding 迁移期工作，未做）。

// ── 杂项「around-hook 超时」结论 ─────────────────────────────
// 评估后**不加内核机制**：around hook（wrapTurn/wrapToolExec）包裹 next()，而 next() 就是整个 turn /
// 单次 tool exec，时长本就合法可变——硬 race-timeout 要么误杀合法长任务、要么留悬空工作。正确机制是
// 协作式 ctx.abort：signal 穿进 LLM stream + tool.execute(args, ctx, signal) 让其尽快停；「多久算太久」
// 是策略，落在 watchdog 插件（一个 setTimeout 后 ctx.abort 的 wrapTurn）。机制进内核、策略进插件，故
// 内核**故意不**给 around hook 套 per-hook timeout。已加测试钉死（around hook 忽略 timeout 字段、
// ctx.abort 协作式 bound turn）。ctx.state slot API 已由 TypedStateMap + HookStateRegistry 提供（已存在）。

// ── #13 Transport pump（Event Bus → WebSocket，adapter）───────
// @harness-pi/adapters 的 EventPump：attachLive() 订阅 live 轨（session.on）+ pumpRecorded(stream)/
// forwardRecorded() 转发 recorded 轨（runStreaming），每条包成 TransportEnvelope { sessionId, tag?,
// track, seq, event } 交给注入的 sink.send。纯 transport、domain-free、零 ws 依赖（调用方接 ws.send）。
// 单 pump 单 session、seq 单调（失败 send 仍占 seq → 跳号=丢失检测）；sink.send 抛错两轨一致隔离
//（不杀 loop / 不炸 for-await），可选 onError 观测。tag 是 domain 中性 per-work-item 标签。
// WebSocketSink（同包）：把上面注入的 sink 接到 WebSocket 的现成适配器。结构化只要 { readyState; send(string) }
//   （浏览器原生 WebSocket + node ws 包都满足，零 ws 依赖）；readyState 非 OPEN 时不 send（避免断线后每条都抛
//   InvalidStateError）→ 干净丢 + 可选 onDrop；serialize 可注入（默认 JSON.stringify，映射前端协议）；OPEN 下
//   serialize/send 抛错原样上抛交 EventPump.onError——预期内丢 vs 意外抛错两层互斥、不重复兜底。domain-free。

// ── #14 subAgent / gap-explorer（controller + tool factory，§4.7，P2）─
// subAgentTool({ sessionFactory, maxSubAgents })：一个 HarnessTool，让模型把自包含子任务委派给 bounded
//   sub-agent（复用 AgentSession，父 signal 透传协作取消），子代理 lastMessage 文本回灌父模型、终态进
//   details——不是顶层 meta-agent。空任务/超 maxSubAgents 预算 throw（HarnessTool 错误合约）。
// GapExplorer({ sessionFactory, maxExplorers, promote, applyToKb })：覆盖率反馈闭环控制器。explore(gaps)：
//   去重(_seen,按 gap.id) + budget 闸(maxExplorers) + 复用 parallel() 派 explorer(每 gap 一次 run) → 据
//   **terminal.reason==="done"** 才进 explored（非 done=abort/max_turns/error → incomplete 桶 + 从 _seen
//   移除可重探，绝不拿半成品补 KB；注意 done≠完整，截断/overflow 仍 done，排它在 promote 里查 stopReason）→
//   人审 promote 闸 → applyToKb → 算 toReanswer(promoted 的 affects 并集)。domain-free：gap 判定/KB 写/
//   promote 全在调用方回调；控制器只给 bounded fan-out + 去重 + promote 闸 + 重答清单骨架。
```

## 附录 B · 一句话

> **内核只长「机制 + 协议 + domain-free 契约」**：Event Bus、TerminalResult、SessionStore 接口 + resume 重入、steering park/drain、overflow 可观测 + compaction hook 点、fail-closed 分类。
> **「内核能力 + 插件」长一切策略与编排**：声明式编排层（分水岭，建在 TerminalResult+Store+Bus+budget 之上）、compaction 策略、permissionGate、metrics 归账、store adapter、WS pump、explorer 闭环。
> **bidding 自己留住所有 domain**：Question/Evidence/Judgment/phase/cascade/旋钮/KPI 公式。
>
> roadmap 已点名 streaming / compaction / steering / ctx.state；本设计补上它漏的两个真正分水岭——**SessionStore + resume**（被误列为「明确不做」）和**声明式编排层 + TerminalResult**（只有控制器、没升级到声明式契约）。
