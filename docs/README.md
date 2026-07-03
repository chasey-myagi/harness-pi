# harness-pi 文档

按编号顺序阅读。每一份文档单独聚焦一个模块/主题，跨文档用相对链接交叉引用。

## 阅读路径

| # | 文档 | 内容 | 建议读者 |
|---|---|---|---|
| 00 | [overview](00-overview.md) | 一句话定位、谁该用、谁不该用、跟 pi-mono 的关系、设计哲学 | 第一次接触本项目的人 |
| 01 | [architecture](01-architecture.md) | 三层架构（Kernel / Plugins / Controllers）、目录结构、pi-mono 依赖边界 | 想了解全貌的人 |
| 02 | [kernel](02-kernel.md) | `AgentSession` API、loop 算法、消息管理、错误处理、HookContext 生命周期 | 实现或 review kernel 的人 |
| 03 | [hook-system](03-hook-system.md) | Hook 接口、四种形态、执行模型（并行 vs 顺序）、timeout、性能契约 | 写 plugin / 改 kernel 的人 |
| 04 | [context-injection](04-context-injection.md) | 四种 context 注入机制 + system prompt 重写、attachment message 模式 | 想理解"hook 怎么改 LLM 看到什么"的人 |
| 05 | [plugins](05-plugins.md) | plugin 解剖、`ctx.state` 约定、核心 12 + 高级 plugin 的完整设计 | 写新 plugin 的人 |
| 06 | [controllers](06-controllers.md) | lifecycle-restart / work-pool / lease-queue、compaction、fork/orchestrate、sub-agent 等 controller | 编排多 session / 高阶模式的人 |
| 07 | [adapters](07-adapters.md) | Sink 接口、内存 / NDJSON / Postgres / OTel sink、peerDep 约定 | 实现新 sink / 写 metrics 后端的人 |
| 08 | [claude-code-lessons](08-claude-code-lessons.md) | 系统扫描 Claude Code 源码后按模块整理"借鉴 / 拒绝 / 推迟"清单 + 具体 API 改动建议 | 想看设计选型依据 / 验证 prior art 的人 |
| 09 | [bidding-core-parity-design](09-bidding-core-parity-design.md) | bidding-agent 迁移前的 core parity 设计与落地追踪 | 评估 production 迁移风险的人 |
| 10 | [goal-v2-design](10-goal-v2-design.md) | `/goal v2` 独立 reviewer sub-agent 设计；当前是设计稿，不是已实现命令 | 关心 maker-verifier / goal loop 的人 |
| 11 | [coding-agent-product-roadmap](11-coding-agent-product-roadmap.md) | coding-agent 产品化差距：MCP、web、todo、sub-agent 管理、git/checkpoint、LSP 等能力面 | 规划 dogfood app 的人 |
| 12 | [agent-loop-development-workflow](12-agent-loop-development-workflow.md) | 如何用 surface-neutral maker-verifier loop 来开发 harness-pi 本身 | 设计 agent-driven 开发流程的人 |
| 13 | [architecture-deep-dive-verdicts](13-architecture-deep-dive-verdicts.md) | L1/L2 六议题架构深挖裁决：三工作包、不做清单、迁移 spike 7 条验证清单（完整论证见 [对比报告 HTML](harness-pi-vs-pi-mono-hooks.html)） | 决定下一阶段内核投入的人 |
| 14 | [production-coding-agent-architecture](14-production-coding-agent-architecture.md) | 生产级 coding-agent 架构：headless 硬化、装配地基、安全纵深（沙箱/信任门）、交付形态（RPC 第四态）——回答"凭什么敢让它无人值守改代码"（能力面见 11） | 把 coding-agent 推向生产的人 |

## Agent workflow

| 文档 | 内容 | 建议读者 |
|---|---|---|
| [AGENT_SURFACES](AGENT_SURFACES.md) | Codex、Claude Code、generic agent runner 如何共享同一 Pilot 合同 | 配置 agent 入口的人 |
| [AGENT_CODING_RULES](AGENT_CODING_RULES.md) | agent 写代码时的反模式和行为规则 | 所有 coding agent |
| [REVIEW_RUBRIC](REVIEW_RUBRIC.md) | advisory review 的检查清单、三审 review-gate 和禁止越权措辞 | reviewer agent / human reviewer |

## 路线图

[roadmap](roadmap.md) —— v0.1 readiness 剩余 scope、production 风险和后续 hardening 计划。

## 项目状态

- ✅ Core kernel、hook dispatcher、message transform / around / event hooks、streaming `message_update`、steering、auto-compaction 机制已实现
- ✅ 标准库 plugins 和 controllers 已在库层实现，仍未经过外部 production 验证
- ✅ `@harness-pi/tools` 提供 read / bash / edit / write / grep / find / ls 第一方基础 tools
- ✅ 离线 examples 已覆盖 bare kernel、plugins、tools、batch pipeline、maker-verifier loop
- ⚠️ 暂不建议现在全量替换 `bidding-agent`；streaming `message_update`、auto-compaction 和 Postgres metrics sink 已落地，不再是迁移前置项，剩余风险是外部 production-like spike、`bidding-agent` 最小迁移 spike 和真实规模验证——内核级风险预测（R1–R5）与 spike 必压的 7 条验证清单见 [13-architecture-deep-dive-verdicts](13-architecture-deep-dive-verdicts.md)
- ⚠️ `apps/coding-agent` 的产品化能力面仍是设计 / 待实现：MCP、web、todo/plan、background bash、apply_patch/multi-edit、git/checkpoint、LSP、检索/记忆、sub-agent 管理面等见 [11-coding-agent-product-roadmap](11-coding-agent-product-roadmap.md)

## 文档维护原则

1. **每个 doc 单一聚焦**。一个 doc 一个主题，超过 800 行就拆。
2. **决策依据 > 接口描述**。代码本身能说明 "what"，文档要说 "why"。
3. **bidding-agent / Claude Code 的真实证据放在脚注或引用**，让后人能追溯设计来源。
4. **API 改动同步更新文档**。v0.1 之前接口仍可调整，但不要让 roadmap / README 和代码状态分叉。
