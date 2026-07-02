# harness-pi 路线图

> 分阶段做事。每个阶段都有可验证产出；跑不通就收缩范围，不往下一阶段堆功能。

## 当前阶段 — v0.5.0

目标：把 `harness-pi` 补成可以被 spike/review 的基础框架，而不是直接迁移 `bidding-agent`。

已落地：

- `@harness-pi/core`：`AgentSession`、hook dispatcher、tool executor、context injection、continuation、abort/error 路径。
- `@harness-pi/plugins`（导出计数以 [05-plugins](05-plugins.md) 和 `packages/plugins/src/index.ts` 为准）：核心 12（watchdog、trim-history、empty-run-guard、tool-output-buffer、session-log、system-reminder、batch-counter、lease-decision、metrics、cost-tracker、token-budget、repeated-call-guard）+ 高级 / 0.3.x 新增（tool-stats、compact-summarize、auto-compaction、microcompact、summary-template、post-compact-file-reread、turn-end-guard、permission-gate、deferred-tools/tool-search/skills、prefix-shape）。
- `@harness-pi/plugins/controllers`（见 [06-controllers](06-controllers.md)）：lifecycle-restart、work-pool、lease-queue、compact-restart-fresh、compact-resume-from-boundary、persist-compaction-boundary、fork-session、parallel/pipeline（orchestrate）、sub-agent-tool/routed-sub-agent-tool/sub-agent-registry、gap-explorer。
- `@harness-pi/tools`：第一方 `read/bash/edit/write/grep/find/ls`，API/schema/default set 对齐 `pi-coding-agent@0.53.0`，无 `pi-coding-agent` runtime dependency。
- Offline examples：`examples/01-bare-kernel`、`examples/02-with-plugins`、`examples/03-tools`、`examples/04-batch-pipeline`、`examples/05-maker-verifier-loop`。

验收命令：

```bash
pnpm -r typecheck
pnpm -r test
pnpm -r build
pnpm --filter @harness-pi-example/01-bare-kernel start
pnpm --filter @harness-pi-example/02-with-plugins start
pnpm --filter @harness-pi-example/03-tools start
pnpm --filter @harness-pi-example/04-batch-pipeline start
pnpm --filter @harness-pi-example/05-maker-verifier-loop start
```

明确不做（v0.1 当时的范围划定 —— 历史口径，部分已超出）：

- 不做 `bidding-agent` 全量迁移。（仍然成立。）
- ~~不引入 PG sink。~~ —— 已实现，见下「Adapter 候选」`PostgresSink [x]`。
- ~~不实现完整 auto-compaction。~~ —— 已实现，见下「下一轮 core parity」`autoCompaction [x]`。
- ~~不把 streaming `message_update` / thinking parity 塞进 tools scope。~~ —— 已实现（独立于 tools scope），见下「下一轮 core parity」`message_update [x]`。

> 注：上面三条删除线是 v0.1 当时画的范围线；这些机制后来都已落地（见下文 `[x]` 项），此处保留作为历史记录，不代表当前状态。

## v0.1 gate

v0.1 之前必须满足：

- [x] docs 状态跟代码对齐：移除旧的状态和示例缺失描述。
- [x] 第一方基础 tools 落地，且可独立挂到 `AgentSession`。
- [x] `ToolExecResult.details` 保留到 `toolResult.details`，用于 truncation、diff、fullOutputPath 等非模型文本元数据。
- [x] tools 单测覆盖七个 tool 的 happy path、错误路径、cwd 解析、disabled 配置、operations override。
- [x] pi compatibility tests 固定校验 tool names、TypeBox schema shape、composite factory 默认集合。
- [x] core regression tests 覆盖 `details` 持久化。
- [ ] 至少一个第三方 / 非 bidding-agent production-like spike 跑通。
- [x] CI：GitHub Actions 已配置 build → typecheck → test（含真 Postgres service）和 workflow contract check。

## 下一轮 core parity

这些是 `bidding-agent` 迁移前的真实 blocker：

- [x] streaming `message_update` / thinking parity：thinking delta 本已在 live 轨；新增 `message_update` LiveEvent（内容块边界 `*_end` 发「已拼好整条消息」快照，携带 pi-ai `partial`，低频）+ EventPump 默认转发。
- [x] auto-compaction parity：`autoCompaction` plugin（`transformMessagesBeforeLlm`，估算 token 体积触发 + 可选 `onContextOverflow`→`compactRestartFresh` 兜底），不再要业务侧手搓触发逻辑。
- [x] steering parity：`AgentSession.steer()` + turn-start drain 已落地，TUI 运行中输入会 park 到下一 turn；`ask_user` 作为业务工具协议仍由 app / domain 层定义。
- [ ] `ctx.state` hardening：`TypedStateMap` + `HookStateRegistry` 已可用，但跨 plugin key 仍需更强约束或 slot API。——方案已裁决（branded `defineSlot` Slot API + `clear()` 收权 + escalate 选项，4 个失败模式 F1–F4 的解剖与候选权衡见 [13-architecture-deep-dive-verdicts §3](13-architecture-deep-dive-verdicts.md)）。

## Adapter 候选

- [x] `PostgresSink`（metrics）：通过最小 `PgClient` 注入（零 `pg` 依赖，与 `PostgresSessionStore` 同构），导出 `POSTGRES_METRICS_SINK_DDL`，子路径 `@harness-pi/plugins/metrics/sinks/postgres`。
- [ ] `OtelSink`（metrics）：peerDep on `@opentelemetry/api`。

触发条件：真实部署需要 dashboard 查询或统一 observability stack。

## Controller / plugin 候选

- [x] `permissionGate` plugin：声明式 tool permission rules。见 [05-plugins §5.20](05-plugins.md#520-permission-gate)。
- [x] `subAgent` tool factory：tool 触发隔离 context 的子 agent。见 [06-controllers §6.6](06-controllers.md#66-子代理体系subagenttool--routedsubagenttool--subagentregistry)（含 `routedSubAgentTool` + `SubAgentRegistry` 续聊）。
- [ ] `sideQuestion` controller：cache-safe forked subtask。仍是唯一未落地的 controller，见 [06-controllers §7.1](06-controllers.md#71-sidequestionclaude-code-btw-模式)。——深挖裁决：本体继续 defer；但 `getCacheSafeParams()` 的投影缺陷（autoCompaction 活跃时返回全量 `_messages` 而非 boundary 投影、不带 `llmOptions` → cache-safe 承诺不成立）应提前修，见 [13 §2](13-architecture-deep-dive-verdicts.md)。

触发条件：第二个真实 agent 或 `bidding-agent` spike 证明需要；否则留在 application 侧。

## 0.3.0 defer（按设计核验，挪到 0.3.1）

0.3.0 收尾时按设计核验 defer 以下两项到 **0.3.1**——这是**有意的 by-design 取舍**，不是缺机制：

- **O4（memdir 语义记忆）**：`lark-bot` 已有 MVP（多轮 LRU session cache），内核侧通用语义记忆暂无第二真实用例驱动，defer。
- **O5（子 agent 生命周期 event）**：内核成本高于预估、优先级 P3；§6.6 的子代理体系（bounded 两闸 + 续聊 registry）已满足当前模型驱动子代理需求，生命周期事件流 defer。

详细 by-design non-goals 见对应 PRD 的 non-goals 表（issue tracker）。

## bidding-agent 策略

不要现在全量替换。

推荐顺序：

1. 在 `bidding-agent` 内部先把 trim/watchdog/metrics 等接口形状对齐 harness-pi 的 hook/plugin 形状。
2. 用独立 worktree 做最小 happy-path spike，只验证一题 run-through。
3. spike 通过且外部 production-like spike / 真实规模验证有结果后，再评估全量替换。streaming `message_update`、第一方 tools、auto-compaction、Postgres metrics sink 已落地，不再作为当前 blocker；当前 blocker 是真实迁移证据和 coding-agent 能力面缺口（MCP、web、todo/plan、background bash、apply_patch/multi-edit、git/checkpoint、LSP、检索/记忆、sub-agent 管理面等）。

内核级风险预测已做（[13 §5](13-architecture-deep-dive-verdicts.md)）：迁移前只做三件外科手术（R1 resume 悬空 toolCall 修复——唯一确定性资损路径、R2 Usage 类型 pin、R3 LeaseQueue 退避），其余风险进 spike 必压的 7 条验证清单拿真实证据——"真实迁移证据"由此从口号变成可判定验收项。

风险理由：`harness-pi` 目前还没有外部 production 用户。框架作者和唯一生产用户如果是同一个人，线上问题会同时变成框架修复和业务修复。
