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
| 05 | [plugins](05-plugins.md) | plugin 解剖、`ctx.state` 约定、12 个标准库 plugin 的完整设计 | 写新 plugin 的人 |
| 06 | [controllers](06-controllers.md) | lifecycle-restart / work-pool / lease-queue 三个 controller、未来 controller 占位 | 编排多 session / 高阶模式的人 |
| 07 | [adapters](07-adapters.md) | Sink 接口、内存 / NDJSON / Postgres / OTel sink、peerDep 约定 | 实现新 sink / 写 metrics 后端的人 |
| 08 | [claude-code-lessons](08-claude-code-lessons.md) | 系统扫描 Claude Code 源码后按模块整理"借鉴 / 拒绝 / 推迟"清单 + 具体 API 改动建议 | 想看设计选型依据 / 验证 prior art 的人 |

## 路线图

[roadmap](roadmap.md) —— v0.1 readiness 剩余 scope、production 风险和后续 hardening 计划。

## 项目状态

- ✅ Core kernel、hook dispatcher、message transform / around / event hooks 已实现
- ✅ 标准库 plugins 和 controllers 已实现，仍未经过外部 production 验证
- ✅ `@harness-pi/tools` 提供 read / bash / edit / write / grep / find / ls 第一方基础 tools
- ✅ 离线 examples 已覆盖 bare kernel、plugins、tools 三条路径
- ⚠️ 暂不建议现在全量替换 `bidding-agent`；streaming `message_update`、auto-compaction 和 production sink 仍是迁移前置项

## 文档维护原则

1. **每个 doc 单一聚焦**。一个 doc 一个主题，超过 800 行就拆。
2. **决策依据 > 接口描述**。代码本身能说明 "what"，文档要说 "why"。
3. **bidding-agent / Claude Code 的真实证据放在脚注或引用**，让后人能追溯设计来源。
4. **API 改动同步更新文档**。v0.1 之前接口仍可调整，但不要让 roadmap / README 和代码状态分叉。
