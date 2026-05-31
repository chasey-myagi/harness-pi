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

**Phase 0 — spike 地基（解锁「能不能迁」）**
- #1 Event Bus（最小：text/thinking delta + turn/tool 事件）
- #4 SessionStore 协议 + `MemorySessionStore` + resume 重入机制
- #2 TerminalResult
- 验收：用 harness-pi 跑通 bidding **单题** run-through（检索→submit→judge），WS 能看到 thinking，崩溃能 resume。即 roadmap v0.1 gate 那个未勾选的「第三方/production-like spike」。

**Phase 1 — 分水岭（解锁「迁了有没有价值」）**
- #8 声明式编排层（合并两套 pool → `parallel()/pipeline()`+budget+resume+typed result）
- #12 `JsonlSessionStore`（先文件，PG 后置）
- #13 WS transport pump
- #3 per-call meta + #11 work-item 归账
- 验收：用编排层跑通 bidding **整份 RFQ**（多题并发 + 按题归账 + benchmark 可复现），行为不弱于现状。

**Phase 2 — 收口与安全**
- #6 overflow 事件 + #10 `compactRestartFresh`（先要这个，最便宜）
- #5 steering（clarify 回复插队）
- #7 fail-closed 分类 + #9 permissionGate（收敛 6 处守卫）
- #4 `PostgresSessionStore` + lifecycleRestart 从 store resume
- #9 杂项：ctx.state slot API、around-hook 超时、去 `questionId` domain 默认

**Phase 3 — Hybrid 闭环**
- #14 subAgent / gap-explorer + 覆盖率反馈闭环
- #10 `compactSummarize` / cache-aware（若 benchmark 证明值得）

**依赖关系**：#4 是 #8 resume 的前置；#1+#4 是 Phase 0 门槛；#8 是「迁了有没有价值」门槛；#6 是 #10 的前置；#5/#7/#9 收口期一起。

---

## 7. 风险与开放问题

1. **pi-ai 0.53.0 SDK 边界**：Event Bus（#1）依赖 pi-ai 的 stream 能力 + cache header；compaction cache-aware（#4.2）依赖 pi-ai cache 集成（bidding 有单独的 pi-ai upgrade 计划）。先确认 pi-ai 暴露了哪些，再定 #1/#6 的内核事件粒度。
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

// ── #7 fail-closed 分类 ─────────────────────────────────────
session.use(
  decisionHook("onPreToolUse", handler, { critical: true /* 未显式 failClosed 则注册期报错 */ })
);
```

## 附录 B · 一句话

> **内核只长「机制 + 协议 + domain-free 契约」**：Event Bus、TerminalResult、SessionStore 接口 + resume 重入、steering park/drain、overflow 可观测 + compaction hook 点、fail-closed 分类。
> **「内核能力 + 插件」长一切策略与编排**：声明式编排层（分水岭，建在 TerminalResult+Store+Bus+budget 之上）、compaction 策略、permissionGate、metrics 归账、store adapter、WS pump、explorer 闭环。
> **bidding 自己留住所有 domain**：Question/Evidence/Judgment/phase/cascade/旋钮/KPI 公式。
>
> roadmap 已点名 streaming / compaction / steering / ctx.state；本设计补上它漏的两个真正分水岭——**SessionStore + resume**（被误列为「明确不做」）和**声明式编排层 + TerminalResult**（只有控制器、没升级到声明式契约）。
