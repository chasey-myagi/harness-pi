# 13 · 架构深挖裁决（L1/L2）：六议题、三工作包、不做清单

> 来源：[harness-pi-vs-pi-mono-hooks.html](harness-pi-vs-pi-mono-hooks.html) 第二部分（2026-07-02，3 路并行深挖，
> 每路强制"先实读源码 → 具体失败场景 → ≥2 候选与权衡 → 立场明确的推荐"）。本文档是其裁决的 markdown 沉淀，
> 供 roadmap / issue 引用；论证细节、SVG 图与完整候选方案对比见 HTML 报告。
> 范围锚定 **L1 消费面与 L2 内核机制**，刻意不重复 [11-coding-agent-product-roadmap](11-coding-agent-product-roadmap.md) 的 L3 能力面。
> 文中 file:line 基于 0.5.0 当时快照，随代码演进可能漂移。

## 0. 六议题裁决速览

| # | 议题 | 一句话裁决 | 代码动不动 |
|---|---|---|---|
| ① | 持久化：线性 vs 树 | 数据模型**已是树形**（entry 带 `parentId`），缺的只是"移动 leaf"原语——期权不过期，不现在行权；只写演进文档 + footgun 禁令 | 只写文档 |
| ② | sideQuestion controller | 本体继续 defer；但 `getCacheSafeParams()` 名不副实（见 §2），接缝修正提前做 | 修一处接缝 |
| ③ | ctx.state 硬化 | 4 个可指认行号的失败模式实锤；上 branded Slot API + `clear()` 收权，渐进迁移、运行时零变化 | 要做（roadmap 挂名项） |
| ④ | 轻量模式 / 分层 | 消费负担被 examples 证伪，作者负担该由文档治；只做文档路标 | 只做文档路标 |
| ⑤ | 迁移内核风险预测 | 5 个真风险，R1 是**确定性资损路径**；迁移前只做 3 件外科手术，其余进 7 条 spike 清单 | 3 件小手术 |
| ⑥ | L1 seam 中期策略 | "下游别直接 import pi-ai"的约定已与现实背离；lint 强制 + 定向收口，不做完整 facade | 半天收口 |

## 1. 议题 ①：持久化演进

**认知修正**：争论不是"线性 vs 树"。存储数据模型早就是树形——entry 带 `parentId`、`getPathToLeaf` 接受任意历史
`leafId`、接口注释明写"未来可分叉成树"（session-store.ts）。真正缺的是"移动 leaf"的 API 原语。
pi-mono 的对照也修正了另一个误读：它的分支是**单活跃分支 rewind 模型**（`moveTo(entryId)`），且可变 leaf 本身用
append-only 的 `"leaf"` entry 实现——与 HWM 哲学不冲突。

三个真实坏结果：

1. **现存 footgun**：协议暴露了"按历史 leaf 读"（`getPathToLeaf(sessionId, oldLeaf)`），但内核没有配套的"按历史
   leaf 写"——调用方绕过 `resume()` 自行重建历史再 `continue()`，append 仍挂到当前 leaf 之后，内存历史与落盘
   lineage 静默错位。
2. **fork 存储放大**：`store.fork()` 是批量复制前缀；1000 条 entry 的父 session 派 8 个探索分支 = 8000 行纯重复。
3. **无 checkpoint 重试**：leaseQueue 重试整 item 从零跑，turn 40/50 失败要重付 40 turn 的 token。

**裁决**：现在不实现任何方案；两条演进路径写死并绑定触发条件：

- **候选 B**（`BranchableSessionStore extends SessionStore`，加 `setLeaf(sessionId, entryId)` + `resume` 可选
  `leafId`）：现有 store 零改动（feature-detect）、内核约 5 行、HWM/compaction boundary 天然路径作用域。
  **触发条件 = 第一个真实 rewind / checkpoint-retry 消费者**（最可能来自 leaseQueue 中途重试）。
- **候选 C′**（adapter 级零拷贝 fork：API 不动，Postgres 实现改"插 1 行 branch-root 引用 + 递归 CTE 读取"）。
  **触发条件 = fork 存储放大被真实规模数据证实**（gap-explorer / maker-verifier fan-out）。
- **明确不做候选 A**（契约破坏性升级为多 leaf 全树）：没有任何现有消费者需要多 leaf 并行写，纯投机。

近期唯一动作（零成本）：在 `session-store.ts` / `resume()` 文档注释里明令"按历史 `leafId` 读出的路径**不可**用于
续写，rewind 必须等 BranchableSessionStore"。

## 2. 议题 ②：sideQuestion 与 `getCacheSafeParams()` 缺陷

最强场景：lark-bot 挂着 turn 60 / 120k token 的服务端 run，运营问"它现在到哪一步了"。`steer()` 污染正式历史；
`subAgentTool` 模型驱动、人触发不了；`forkSession` 功能可用但成本坏——排查"为什么成本坏"时发现**现存缺陷**：

> **`getCacheSafeParams()` 与 live 投影不一致**。autoCompaction 活跃时父 session 发给 LLM 的是
> `[boundary.summary, …slice(coveredCount)]` 投影（特意复用同一 summary 对象保 prefix bytes 稳定）；而
> `getCacheSafeParams()` 返回**全量 `_messages`**，也不携带 `llmOptions`（pi-ai `StreamOptions.sessionId` 正是
> provider 侧 session 级缓存的钥匙）。fork 出的"cache-safe"子 session 首个请求前缀与父完全不同 → 必然 cache
> miss、全价 input。名字承诺的 cache-safe 在压缩场景下不成立。

**裁决**：controller 本体继续 defer（"非它不可"的调用方只有 lark-bot 一个候选）；`getCacheSafeParams()` 修正提前做——
返回 boundary 投影后的 view + 过滤 incomplete toolCalls + 携带 `llmOptions`。这不是投机：它修正现有公开 API 的
名不副实，并顺手把未来 sideQuestion 的全部内核前置条件清零（真需求来时只是 plugins 层约 60 行 recipe，
见 [06-controllers §7.1](06-controllers.md#71-sidequestionclaude-code-btw-模式)）。

否决的两个替代设计：内核内联 `session.ask()`（绕 `_running` 互斥、打穿 live 事件配对契约、污染有状态 pipe hook）；
turn 边界注入 + 回滚 `_messages`（HWM 依赖 append-only 绝不 splice，直接违反核心不变量）。
另有待验证项：pi-ai 无 `skipCacheWrite` 等价物（只有 `cacheRetention`），§7.1 设计要点第 4 条落地前需向上游确认。

## 3. 议题 ③：ctx.state 硬化（Slot API）

跨 plugin 共享 state 的真实案例有三组：`deferred.activated`（deferredTools 导出常量，toolSearch/skills
read-modify-write）、`cost-tracker.stats`（tokenBudget 直读）、`post-compact.pending`（autoCompaction 与
compactSummarize 两个写者）。内核自己也是用户（`harness-pi.activeBoundary`）。

四个失败模式（全部可指认行号，详见 HTML 报告）：

| 编号 | 失败模式 | 坏结果 |
|---|---|---|
| F1 类型幽灵 | 动态 key（batch-counter 运行期拼 key）脱离 augmentation | 只能 `as` 强转；registry 方案对"每实例一 key"结构性无解 |
| F2 字符串绕过 | `set()` 对非字面量 key 退回 `unknown` 全放行 | 脏写后 pipe fail-open 静默跳过 → deferred 工具全量泄漏，零报错定位 |
| F3 clear() 核弹 | `TypedStateMap` 公开暴露 `clear()` | 任一 plugin 误清全锅：内核 activeBoundary 失效 → 投影失效可能直接 overflow |
| F4 依赖声明短板 | 只有注册期 warning，不阻塞不排序；`prefers` 纯文档字段 | 50 plugin 规模下手工维护偏序；state 依赖与 hook 声明无机器可查关联 |

**裁决**：做 branded **Slot API**（`defineSlot<T>(key, { owner, validate? })` 返回携带 phantom type 的 slot 对象；
`TypedStateMap` 加 slot overload，string 老路标 `@deprecated` 渐退；物理 key 仍是 string → 运行时行为零变化，
14 个文件分 PR 渐进迁移）+ `clear()` 收权（移出公开面，5 行先行 PR）+ `missing-required` escalate-to-throw 选项。

**不做**：capability 注入（类型最强但破坏三件套公共 API、与 per-session state 模型冲突、丢全局可观测性——留作
三件套出现第三个消费者时的定向重构）；namespace 视图（只治皮毛）；**自动拓扑排序**（注册顺序在本内核是语义——
decision 短路序 / pipe 变换序 / around 嵌套层次都由它决定，自动重排等于静默改行为）。

## 4. 议题 ④：轻量模式

"认知负担"拆开是两个问题：**消费负担**被 examples 证伪（example 02 装配 6 个 plugin 就是平铺数组，bare kernel
67 行，消费者不需要理解四形态）；**作者负担**真实存在，但本质是文档可发现性 + fail-open 默认值的锋利边，不是
"形态太多"——四形态各自对应不可互换的执行语义，砍哪个都是砍能力。
另修正一个类比：pi-mono 三层不是"给同一用户的渐进披露"，是三个不同产品面各自演化、层间不连通——不能拿来论证
harness-pi 该分层。

**裁决**：只做文档路标（README 三档入门：① bare kernel 抄 example 01 → ② 挑常用 plugin 抄 example 02 →
③ 写自己的 hook 才读 docs/03），一小时，**不写一行代码**。preset 工厂违背"L2 零 opinion、App 层装配"教义
（coding-agent 的装配代码就是 preset 的活体），冻结为"第 2 个外部真实消费者出现且装配显著趋同"时的期权；
简化 facade（两套注册面）是最差选项。

## 5. 议题 ⑤：迁移内核风险（R1–R5）与 spike 清单

### R1（高危，确定性资损）：悬空 toolCall → resume 后 provider 400 死循环

链条：abort/崩溃落在 tool batch 中间 → `executeBatch` 在屏障处 break → `_phaseToolBatch` 对缺 result 的 call
直接 continue、**不合成占位 toolResult** → 坏形状历史（assistant(toolUse) + 部分 toolResult）原样落盘 →
`resume()` 逐字重放不修形状 → 严格 OpenAI-compatible 端点（DashScope）对未配对 tool_call 返 400 →
LeaseQueue 无退避立即重试，每次都在同一条坏历史上炸 → maxAttempts 耗尽，item 以 error 终态丢弃。
CLI dogfood 从未暴露它只因人会重开会话；无人值守批处理下是确定性死循环。

**加固（迁移前做）**：在 `resume()` 重放层做对话不变量修复——扫尾部 assistant 的 toolCall，为无配对者合成
`isError: true` 占位 toolResult。不放 `transformMessagesBeforeLlm`：pipe 只改发给 LLM 的视图，坏历史仍在 store、
每次 resume 都要重修；resume 修一次即固化。fake model + abort mid-batch + MemorySessionStore 可完全复现单测。

### R2（已发生）：pi-ai `Usage` 字段漂移

`_accumulatedUsage` 逐字段手写累加，注释自己警告"上游加字段会静默漏算"——核对结果上游**已经加了**
（0.80.x 的 `reasoning` / `cacheWrite1h`；本仓库锁 0.74.2 没有）。升级后 tokenBudget/costTracker 对 reasoning
开销全盲。**加固**：一行级类型 pin（`keyof Usage` 完备性断言），上游加字段即编译失败。

### R3（真）：provider 限流 × 无退避重试

LeaseQueue attempt 重试无任何 backoff、WorkPool 只有 per-pool 并发帽——K 个 worker 同时撞限流 → 同时立即重试 →
限流窗口被自己顶死。**加固**：LeaseQueue 加 per-attempt 指数退避选项（十几行）。全局 QPS 闸等 spike 证据。

### R4（真，不预修）：compaction 估算漂移 × 文案依赖

主动路径靠 token 估算 + 用户自报 `contextWindow`；反应式兜底靠 errorMessage regex（#82 已知测不了）。
复合场景：估算低估 + 文案漂移 → overflow 被当普通 error → 接 R3 循环烧钱。**动作**：spike 量化"估算 vs 每 turn
真实 `usage.input`"漂移率；超阈值用真实 usage 做校准因子（纯插件层）。`isContextOverflow` 可注入已是逃生口。

### R5（低概率，不预修）：跨进程双 resume 无 fencing

store 串行契约是进程内的；PG 的 `UNIQUE(session_id, seq)` 是"炸出来"不是"协调掉"——at-least-once 队列下双
worker resume 同一 session，best-effort 下静默丢一侧工作。**动作**：spike 必测 double-resume；队列驱动的生产
部署 `strictPersistence` 默认开。fencing token 是 vNext 级。

判定为伪/低优先：`strictPersistence` 在 PG 抖动下语义核对无误（真实问题只是逐条 await 写放大，量级问题等实测）；
usage 在 lifecycle-restart 下重叠累加是已文档化语义，对账走 metrics sink。

### 迁移 spike 验证清单（压不到这 7 条就不算验证了内核）

| # | 压什么 | 通过标准 |
|---|---|---|
| 1 | watchdog abort 落在 tool batch 中间 → resume → continue | provider 不 400（R1 修复生效） |
| 2 | 人为触发 DashScope 限流（并发拉满） | 无立即重试风暴；attempt 间有退避；无 overflow 误判 |
| 3 | 长 session 跑到真实 overflow | 主动 compaction 先于 provider 报错触发；量化估算漂移 % |
| 4 | 同 sessionId 双 worker 并发 resume | 一侧 fail-loud（strict 下终态 error），无脏写、无静默丢失 |
| 5 | PG 断连 30s 窗口再恢复 | HWM 续传不重不漏；内存积压有界；strict/best-effort 终态符合文档 |
| 6 | `RunSummary.usage` vs provider 账单对账（含一次 lifecycle-restart） | 偏差可解释（重叠累加语义），metrics sink 口径正确 |
| 7 | watchdog 超时 vs policy-deny 混合出现 | lifecycle-restart 只重试 `watchdog:` 前缀（契约成立） |

## 6. 议题 ⑥：L1 seam 定向收口

grep 全仓非测试代码 26 处 `@earendil-works/pi-ai` import 归类：core 10 文件是 seam 本体（合法）；
plugins 8 文件是**纯冗余 bypass**（core index 已 re-export 全部这些名字，改 import 来源即可）；
两个**真实缺口**——coding-agent compaction.ts 的带外 LLM 调用（value import `complete`）、
coding-agent/lark-bot 各自直连模型目录四函数（`getModels`/`getProviders`/`getEnvApiKey`/`calculateCost`）；
scripts 冒烟脚本合理豁免。**约定当前已与现实背离，且无机制 enforce。**

上游 churn 实测：371 commits / 近 4 个月触及 `packages/ai`（约 3/天）；本仓库锁 0.74.2，已落后 6 个 minor。
但绝大多数 additive——最大威胁不是编译爆炸，是 R2 那类静默语义漂移。fork 期权维持不动。

**裁决**：做定向收口（否决完整 facade——re-export treadmill、出口面爆炸、对 additive churn 边际收益低）：

1. ESLint `no-restricted-imports` 在 core 之外禁 pi-ai（scripts 豁免）——把咽喉点从注释约定变成 lint 强制；
2. plugins 8 处冗余 import 机械改从 `@harness-pi/core` 拿；
3. core 新增 `completeText(model, messages, llmOptions)` 薄封装 + catalog 四函数纯 re-export（不包装）;
4. seam 文档补"升级 playbook"：bump → 跑 Usage 类型 pin → 跑 pi compatibility tests → 跑 d0-smoke。

## 7. 总裁决：三个工作包（未来 2–3 个月）

排序逻辑：**确定性资损 > 现存 API 名不副实 > roadmap 挂名未完成项 > 证据工程 > 一切投机设计**。

1. **内核信实性修复包**：R1 resume 修复 + `getCacheSafeParams()` 投影修正 + R2 Usage 类型 pin。
   共同点是"现有 API 的承诺与实际行为不一致"，全部纯本地可测、十行级外科手术、不引入新概念。
2. **ctx.state 硬化**：`clear()` 收权（5 行 PR 先行）→ `defineSlot` Slot API → 三组跨 plugin key 迁移 →
   其余私有 key 顺手渐进。roadmap 挂名项落地；F2/F3 类故障在批处理环境症状离病因极远，几乎不可调试。
3. **迁移证据工程**：L1 seam 定向收口 + R3 退避（合计约一天）作为前置，然后执行 7 条 spike 验证清单——
   把 roadmap 里"真实迁移证据"从口号变成可判定验收项；升级 pi-ai 0.80.x 顺带走一次新 playbook。

## 8. 不做清单（与"做"同权重）

| 不做什么 | 理由 | 触发条件（重新评估） |
|---|---|---|
| 分支持久化实现（B/C′） | seam 已在，期权不过期 | B：第一个 rewind/checkpoint-retry 消费者；C′：fork 放大被真实数据证实 |
| sideQuestion controller 本体 | 只有 lark-bot 一个候选调用方 | lark-bot 真出现"问询进行中 run"需求（落地仅 60 行 recipe） |
| preset / 简化 facade / 轻量模式 | 消费负担被证伪；facade 制造两套注册面 | 第 2 个外部真实消费者且装配与 coding-agent 显著趋同 |
| pi-ai 完整 re-export facade | additive churn 下边际收益低，treadmill 成本高 | 上游出现破坏性 churn 常态化 |
| hook 自动拓扑排序 | 注册顺序是语义，重排即静默改行为 | —（结构性否决） |
| capability 注入重构 | 破坏公共 API、与 per-session state 模型冲突 | activation 三件套出现第三个消费者 |
| 多 leaf 全树 store 契约 | 无消费者需要多 leaf 并行写，纯投机 | —（结构性否决） |

## 9. 落地追踪

对应 GitHub issues（2026-07-02 建立）。本文档是裁决的权威沉淀；issue 与本文冲突时以更新时间新者为准，并回改另一方。

| 工作包 | Issue | 内容 | 被阻塞于 |
|---|---|---|---|
| 1 · 内核信实性 | [#127](https://github.com/chasey-myagi/harness-pi/issues/127) | R1 resume() 悬空 toolCall 形状修复 | — |
| 1 · 内核信实性 | [#128](https://github.com/chasey-myagi/harness-pi/issues/128) | getCacheSafeParams() 投影修正 | — |
| 1 · 内核信实性 | [#129](https://github.com/chasey-myagi/harness-pi/issues/129) | R2 Usage 字段完备性类型 pin | — |
| 2 · ctx.state 硬化 | [#130](https://github.com/chasey-myagi/harness-pi/issues/130) | TypedStateMap.clear() 移出公开面（F3） | — |
| 2 · ctx.state 硬化 | [#131](https://github.com/chasey-myagi/harness-pi/issues/131) | defineSlot Slot API | — |
| 2 · ctx.state 硬化 | [#135](https://github.com/chasey-myagi/harness-pi/issues/135) | key 迁移到 slot + escalate 选项 | #131 |
| 3 · 迁移证据工程 | [#132](https://github.com/chasey-myagi/harness-pi/issues/132) | L1 seam 补缺（completeText + re-export + playbook） | — |
| 3 · 迁移证据工程 | [#136](https://github.com/chasey-myagi/harness-pi/issues/136) | seam lint 强制 + 冗余 import 收口 | #132 |
| 3 · 迁移证据工程 | [#133](https://github.com/chasey-myagi/harness-pi/issues/133) | R3 LeaseQueue per-attempt 指数退避 | — |
| 3 · 迁移证据工程 | [#137](https://github.com/chasey-myagi/harness-pi/issues/137) | pi-ai 0.74.2 → 0.80.x 升级（playbook 首航） | #129、#132 |
| 3 · 迁移证据工程 | [#138](https://github.com/chasey-myagi/harness-pi/issues/138) | 迁移 spike：7 条内核验证清单（HITL） | #127、#133、#137 |
| 文档 | [#134](https://github.com/chasey-myagi/harness-pi/issues/134) | 持久化演进路径 + leafId 只读禁令 + README 三档路标 | — |
