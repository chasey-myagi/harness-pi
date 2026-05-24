# harness-pi 路线图

> 分阶段做事。**每个阶段都有可验证的产出**，跑不通就停下来想，不往下一阶段走。

## Phase 0 — 设计签字（**当前阶段**）

**目标**：定死 Hook 接口形状，避免 v0 之后被迫破坏性改动。

- [x] Repo 骨架（README、`@harness-pi/core` package、tsconfig、workspace）
- [x] `packages/core/src/hook.ts` v1 类型定义（待 v2 重写）
- [x] `packages/core/src/types.ts`（HarnessTool + helper exports）
- [x] `packages/core/src/session.ts` stub
- [x] 文档拆分成 9 份按模块写：
  - [x] [README](README.md) 索引
  - [x] [00-overview](00-overview.md)
  - [x] [01-architecture](01-architecture.md)
  - [x] [02-kernel](02-kernel.md)
  - [x] [03-hook-system](03-hook-system.md)
  - [x] [04-context-injection](04-context-injection.md)
  - [x] [05-plugins](05-plugins.md) —— 11 个标准 plugin
  - [x] [06-controllers](06-controllers.md)
  - [x] [07-adapters](07-adapters.md)
  - [x] [08-claude-code-lessons](08-claude-code-lessons.md) —— prior art 调研 + 借鉴清单
- [x] 系统扫描 Claude Code 源码、按模块整理借鉴/拒绝清单（落进对应 docs + types.ts）
- [ ] **用户 review 9 份 doc + types.ts + hook.ts v1，签字**
- [ ] 把 hook.ts 按 [03-hook-system §2 v2 设计](03-hook-system.md#2-hook-接口定义) **重写一遍**
- [ ] 一页定位 doc 发给 Mario（社交礼貌，非阻塞）

**产出**：可被 review 的 API 表面 + 完整设计依据。无运行时代码。

**不做**：实现 session.ts、安装任何依赖、写 plugin。

---

## Phase 1 — Kernel 跑通

**目标**：`AgentSession.run()` 能在 hook 全部为空时跑完一道 happy path。

- [ ] `pnpm install`（首次拉 pi-ai）
- [ ] 实现 `session.ts`（按 [02-kernel §2 loop 算法](02-kernel.md#2-loop-算法完整伪代码) 走）：
  - [ ] HookContext 构造 + state map（按 [02-kernel §7](02-kernel.md#7-hookcontext-生命周期)）
  - [ ] 主循环
  - [ ] `appendMessage` / `abort` / `snapshot`
- [ ] 实现 `dispatcher.ts`（按 [03-hook-system §10](03-hook-system.md#10-dispatcher-实现)）：
  - [ ] `fireEvent`（并行）
  - [ ] `fireDecision`（顺序短路）
  - [ ] `firePipe`（顺序）
  - [ ] `buildAroundChain`（reduceRight 嵌套）
  - [ ] `invoke` with timeout + try/catch + fail-open
  - [ ] `mergeResults`（按 [03-hook-system §5 合并规则](03-hook-system.md#5-合并规则)）
- [ ] stream 消费器（消化 pi-ai event stream → AssistantMessage）
- [ ] `examples/01-bare-kernel/`：用 Anthropic + 一个 `echo` tool 跑 5 行 demo
- [ ] `packages/core/__tests__/`：
  - [ ] hook dispatch 单测（4 种形态 × 多 hook 顺序）
  - [ ] context injection 单测（4 种机制各一）
  - [ ] tool error 路径单测（throw → isError result 回灌）
  - [ ] abort 路径单测（caller signal / ctx.abort / watchdog）

**验收**：example 01 真的能调通 Anthropic 跑一道题；single hook 注册的几个用例 typecheck 干净。

**不做**：任何 plugin、metrics sink、persistence。

---

## Phase 2 — 标准库第一批 plugin

**目标**：把 [05-plugins](05-plugins.md) 的 11 个 plugin 实现，每个 ≤100 LOC（cost-tracker / token-budget 可能略多）。

- [ ] 建 `packages/plugins/`
- [ ] [`watchdog`](05-plugins.md#51-watchdog)（around）
- [ ] [`trim-history`](05-plugins.md#52-trim-history)（transform）
- [ ] [`empty-run-guard`](05-plugins.md#53-empty-run-guard)（event + ctx.abort）
- [ ] [`tool-output-buffer`](05-plugins.md#54-tool-output-buffer)（event + ctx.state）
- [ ] [`session-log`](05-plugins.md#55-session-log)（event + NDJSON）
- [ ] [`system-reminder`](05-plugins.md#56-system-reminder)（transient context）
- [ ] [`batch-counter`](05-plugins.md#57-batch-counter)（event + 回调）
- [ ] [`lease-decision`](05-plugins.md#58-lease-decision)（decision）
- [ ] [`metrics`](05-plugins.md#59-metrics) + `MetricsSink` 接口 + `MemorySink` + `NdjsonFileSink`
- [ ] [`cost-tracker`](05-plugins.md#510-cost-tracker)（event；可选依赖 metrics sink）
- [ ] [`token-budget`](05-plugins.md#511-token-budget)（event + continue 决策；advanced，可选依赖 cost-tracker）

每个 plugin **自带最小测试 + JSDoc 示例**。

**验收**：
- `examples/02-with-plugins/` 同时挂 5 个 plugin（watchdog + metrics + log + buffer + trim），跑通且 metrics 能 dump 出 12+ 个事件
- `examples/02b-cost-and-budget/` 挂 metrics + cost-tracker + token-budget，跑一个会撞预算的 prompt，验证 budget 触发 continue/stop
- `grep -rE '"question"|"evidence"|"judgment"' packages/{core,plugins}/src/` 为空

**不做**：PostgresSink、并行 pool、lifecycle restart。

---

## Phase 3 — Controller 层 + 重 sink

**目标**：用 kernel + plugin 拼出 bidding-agent 现在自己造的运行模式。

- [ ] [`lifecycleRestart`](06-controllers.md#3-lifecyclerestart) controller
- [ ] [`workPool`](06-controllers.md#4-workpool) controller
- [ ] [`leaseQueue`](06-controllers.md#5-leasequeue) controller
- [ ] `PostgresSink`（peerDep on `pg`）+ DDL 示例
- [ ] `examples/03-pool/`：并行 5 worker 各自跑 4 个 echo task

**验收**：lease-queue 模式跑通；watchdog 触发后 lifecycle-restart 自动重启且不丢 carryover。

---

## Phase 4 — 第三个 agent 反向验证

**目标**：用 harness-pi 写一个**跟 bidding-agent 完全无关**的真 agent。

候选：
- PR review agent（消费 GitHub diff、产出评审意见）
- Web research agent（搜索 + 总结 + 引用）
- 任务流水线 agent（接 Slack/Linear，按规则分发）

**这是 API 是否真通用的唯一可靠信号**。要求：
- 不给 `@harness-pi/core` 加任何新方法 / hook 字段
- 不在 plugin 里偷偷加 domain 概念
- 写完后回头看，新 agent 用了哪些 plugin、写了多少自己的 plugin、core 改没改

**验收**：第三个 agent 跑通，core/plugins 零修改。失败就回 Phase 1 改设计。

---

## Phase 5 — bidding-agent 反向消费

**目标**：把 bidding-agent 改造成 harness-pi 的消费者，验证存量代码大幅瘦身。

- [ ] 把 bidding-agent 的 `session.ts`（65KB）改用 `@harness-pi/core` + 几个 plugin
- [ ] 把 watchdog / metrics / trim / buffer / log 全部换成标准库
- [ ] 保留 bidding-agent 特定的：tool 实现（submit_evidence / judge_question / kb_search）、prompt 模板、Excel/KB layer
- [ ] 目标：session.ts 从 65KB → 10KB 以内

**验收**：bidding-agent 在 harness-pi 之上 e2e 跑通一道完整 task（含证据提交、判断、ask_user 回路）。

---

## Phase 6 — 公开 / 冻结 v0.1

- [ ] 发包到 npm（`@harness-pi/core` + `@harness-pi/plugins`）
- [ ] 写一篇 blog post 讲设计取舍
- [ ] 通知 Mario（不求 endorse，礼貌告知）
- [ ] v0.x 至少跑半年再考虑 v1（API 一旦冻结，破坏性改动成本高）

---

## 当前位置

**Phase 0 进行中 —— 等用户 review 9 份 doc + types.ts + hook.ts v1 签字。**

下一步触发条件：用户对 hook.ts 形状 + 文档设计满意（或提出需要改的地方，改完再签字），方进入 Phase 1。
