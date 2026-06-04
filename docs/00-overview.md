# 00 · Overview

> 项目定位、目标用户、跟 pi-mono 的关系、设计哲学。

## 1. 一句话定位

**harness-pi 是给后端 / 服务端 / headless agent 的运行时基础设施**，建立在 [`@earendil-works/pi-ai`](https://github.com/badlogic/pi-mono/tree/main/packages/ai) 之上，提供 hook 系统、生命周期管理、metrics、Context 注入、基础 coding tools、并行编排等"驾驭 agent 所必需的东西"——而把 agent 内核保持最小。

## 2. 谁该用 harness-pi

- 把 agent 部署成 **后端 HTTP / WebSocket 服务**
- 跑 **批处理 / scheduled worker** 处理大量任务
- 嵌入到 **业务系统**（CRM / 工单 / RFP / 合规 / 审核）做特定领域 agent
- 需要 **production observability**（metrics / trace / 配额 / 错误归因）
- 需要 **第一方基础工具**（read / bash / edit / write / grep / find / ls），但不想把 `pi-coding-agent` 拉进服务端 runtime
- 需要 **并行多 worker**（pool / queue / lease）
- 需要 **可定制的拦截/注入**（lease 冲突拦截、动态 system prompt、staleness reminder）

典型场景：bidding-agent 这种"上传文件 → agent 处理 → 用户审核"流程；研究助手；PR review agent；客服路由 agent；多租户 SaaS agent 后台。

## 3. 谁不该用 harness-pi

- 想要 **终端交互式编码 agent**——用 [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) 现成的，那个跟 IDE/Shell 集成、有 `/login`、`/resume`、skill / extension / theme 系统。
- 已经全栈用 **LangChain / LangGraph / LlamaIndex**——他们覆盖了 RAG / chain / graph 等更高层抽象，本项目不重复。
- 只是想 **一次性写个 demo 跑通 LLM 调用**——直接用 `pi-ai`，30 行搞定，连 kernel 都不需要。

## 4. 跟 pi-mono 的关系

pi-mono 是三层独立的 package。我们消费 L1，**不**消费 L2，跟 L3 平级。

```
┌─────────────────────────────────────────────────────────┐
│   @earendil-works/pi-ai —— unified LLM API + tool spec  │  L1  ← 我们 100% 依赖
├──────────────────────────┬──────────────────────────────┤
│  @earendil-works/        │  @harness-pi/core            │  L2
│    pi-agent-core         │  (我们自己写 kernel，hook 一  │
│  (Mario 的 agent 内核，   │   等公民)                     │
│   observer pattern)      │                               │
├──────────────────────────┼──────────────────────────────┤
│  @earendil-works/        │  @harness-pi/plugins         │  L3
│    pi-coding-agent       │  (watchdog / metrics / ...)  │
│  (终端编码 agent)         │                               │
└──────────────────────────┴──────────────────────────────┘
        目标：终端程序员             目标：后端 / 服务 / 嵌入
```

**详细的"为什么不基于 pi-agent-core"**：见 [01-architecture.md §4](01-architecture.md#4-为什么不依赖-pi-agent-core)。

**社交契约**：

- 不动 pi-mono 一行代码
- README 写明 "Built on `@earendil-works/pi-ai`. Inspired by pi-coding-agent's philosophy. Not affiliated."
- 类比：**LangGraph 之于 LangChain Core / Remix 之于 React Router**——下游应用框架，明确站在上游肩膀上，不挑战上游

## 5. 设计哲学（按重要性排序）

### 5.1 最小内核

Kernel（`@harness-pi/core`）只做三件事：

1. **agent loop**（LLM call → tool exec → tool result → 再 call → 直到 done / max_turns / abort）
2. **hook 派发**（按 hook 形态用不同执行策略）
3. **生命周期**（`run` / `continue` / `abort` 的协议）

不做：metrics、persistence、observability、orchestration、UI、CLI、provider 适配、auth 流程。**任何 domain 概念都不许漏进 core**（grep 不到 `question` / `evidence` / `judgment`）。

LOC 预算是压力线，不是 KPI。`session.ts` 已经是完整实现；新增能力继续优先往 `ToolExecutor`、plugin、controller 或 tools 包拆，而不是把 domain 逻辑塞进 core。

### 5.2 Hook 一等公民

跟 pi-agent-core 的**核心区别**：pi-agent-core 给观察者（subscribe），harness-pi 给拦截器（hook）。

- 我们的 hook 可以 **deny / modify / inject context / abort**
- pi-agent-core 的 `subscribe` 只能看，看完事情已经发生了

为什么这个差异关键：bidding-agent 一年踩出来的 lease 冲突、per-tool timeout、动态 system prompt、staleness reminder——这些都需要"在 LLM 调用前/工具执行前真正介入"，observer pattern 做不到。

详见 [03-hook-system.md](03-hook-system.md)。

### 5.3 Plugin 自带电池

`@harness-pi/plugins` 提供"production agent 几乎一定需要"的 12 个标准 plugin：

watchdog · trim-history · empty-run-guard · tool-output-buffer · session-log · metrics · system-reminder · batch-counter · lease-decision · cost-tracker · token-budget · repeated-call-guard

每个 plugin 都以 hook 实现为主，尽量保持小而独立，通过 `ctx.state` 和显式 helper 协作。详见 [05-plugins.md](05-plugins.md)。

### 5.4 Controller 解决高阶模式

pool / queue / lifecycle-restart 这类"编排多个 session"的能力不是 hook，是 **Controller**——它们调用 kernel 而不是包裹 kernel。

详见 [06-controllers.md](06-controllers.md)。

### 5.5 基础 tools 第一方支持

`@harness-pi/tools` 提供 `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls` 七个基础 tool，public factory API 对齐 `pi-coding-agent@0.53.0`：

- `createCodingTools(cwd, options)` 默认 `read,bash,edit,write`
- `createReadOnlyTools(cwd, options)` 默认 `read,grep,find,ls`
- `createAllTools(cwd, options)` 返回完整 tool record
- `ToolsOptions.disabled` 可关闭默认集合中的部分 tool

实现是第一方代码，不把 `pi-coding-agent` 作为 runtime dependency。兼容性由 schema/default-set snapshot tests 兜住。

默认 factory 以传入的 `cwd` 作为文件工具边界；`read/write/edit/grep/find/ls` 默认拒绝逃出 `cwd` 的绝对路径、`..`、`~` 路径。确实需要 pi-coding-agent 式全盘访问时，调用方必须显式设置 per-tool `allowOutsideCwd: true`。`bash` 默认清理明显敏感的环境变量并设置 120s 超时；它仍然是 host shell，生产服务必须按租户/worker 再做外层隔离。

### 5.6 Adapter 走 peerDep

Postgres sink、OTel sink、其他外部系统集成都走 peerDep——你不装 `pg`、`@opentelemetry/*` 等就不引入。`@harness-pi/plugins` 本身只带 in-memory 和 NDJSON file 这种零依赖 sink。

详见 [07-adapters.md](07-adapters.md)。

### 5.7 性能契约：plugin 不做阻塞 I/O

Hot path 上的 plugin **只允许同步操作或 push-to-queue**。需要持久化走 Sink 异步批 flush。10 个标准 plugin 同时挂，hook overhead < 100μs。

详见 [03-hook-system.md §性能契约](03-hook-system.md#9-性能契约)。

## 6. 明确不做的（anti-positioning）

| 不做 | 理由 |
|---|---|
| Verify-then-Commit 工具协议 | RAG/citation 类 agent 的 application pattern，不是 harness 该背的 |
| Work item lock 状态机 | HITL 特定；用 hook 组合出来即可 |
| Question / Evidence / Judgment 等任何 domain 概念 | bidding-agent 自己的领域 |
| 内置 DB schema | Sink 走接口 + peerDep；core 只有 in-memory sink |
| 内置 metric kinds 字典 | 只给 generic 几个；用户走 module augmentation 扩 |
| Frontend / dashboard | 独立 repo，将来再说 |
| pi-coding-agent 的 extension API 兼容 | 方向完全不同（终端 UX vs 服务端运行时） |
| pi-coding-agent runtime dependency | 基础 tools 自己实现；兼容靠测试，不靠偷运行时代码 |
| MCP 集成 | Mario 不做，我们也不做；要用 plugin 自己接 |
| 多 agent orchestration | 单 agent 内核先做扎实，多 agent 是 Controller 层 |
| 替 pi-ai 做任何事 | Provider 接入、OAuth、cross-provider handoff——pi-ai 已经做了 |
| 内置 RAG / vector store | 那是 langchain/llamaindex 的事，不是 harness |
| 内置 compaction 策略 | 用户用 `transformMessagesBeforeLlm` 自己做 |

## 7. 项目状态

| Phase | 状态 |
|---|---|
| 0 设计签字 | 已完成到可实现状态，文档仍需随代码同步 |
| 1 Kernel 跑通 | 已实现：`AgentSession`、dispatcher、tool executor、core tests |
| 2 标准库 plugin | 已实现：watchdog / trim / guard / buffer / log / metrics / budget 等 |
| 3 Controller 层 | 已实现第一版：lifecycle-restart / work-pool / lease-queue |
| 4 第一方 tools | 已实现：`@harness-pi/tools` 七个基础 tools |
| 5 第三方 agent 反向验证 | 未完成 |
| 6 bidding-agent 反向消费 | 不建议现在全量替换；先 spike |
| 7 公开 / 冻结 v0.1 | 未完成 |

详见 [roadmap](roadmap.md)。

当前风险：核心机制已实现并有测试覆盖（`message_update` 渐进式 streaming、auto-compaction、PG metrics sink、`ctx.state` slot API 均已落地），但**尚无外部 production 用户**——真 LLM provider 的 streaming/error/overflow smoke、`bidding-agent` 真实迁移 spike 都还没做（成熟度三层详见 [README](../README.md)「当前状态」）。

## 8. 下一步

如果你是第一次读这份文档：

1. 现在读完 → 读 [01-architecture](01-architecture.md) 看全貌
2. 关心 hook 接口 → 跳 [03-hook-system](03-hook-system.md)
3. 关心 plugin 怎么写 → 跳 [05-plugins](05-plugins.md)
4. 关心怎么并行跑 → 跳 [06-controllers](06-controllers.md)

如果你是来 review 设计：

1. 看 [03-hook-system](03-hook-system.md)（核心 API 表面）
2. 看 [05-plugins](05-plugins.md) §标准库（12 个 plugin 的形态——这是 API 的反向验证）
3. 看 [02-kernel](02-kernel.md) §loop 算法（确保实现路径清晰）
