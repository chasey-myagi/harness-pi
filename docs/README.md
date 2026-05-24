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
| 05 | [plugins](05-plugins.md) | plugin 解剖、`ctx.state` 约定、11 个标准库 plugin 的完整设计 | 写新 plugin 的人 |
| 06 | [controllers](06-controllers.md) | lifecycle-restart / work-pool / lease-queue 三个 controller、未来 controller 占位 | 编排多 session / 高阶模式的人 |
| 07 | [adapters](07-adapters.md) | Sink 接口、内存 / NDJSON / Postgres / OTel sink、peerDep 约定 | 实现新 sink / 写 metrics 后端的人 |
| 08 | [claude-code-lessons](08-claude-code-lessons.md) | 系统扫描 Claude Code 源码后按模块整理"借鉴 / 拒绝 / 推迟"清单 + 具体 API 改动建议 | 想看设计选型依据 / 验证 prior art 的人 |

## 路线图

[roadmap](roadmap.md) —— Phase 0-6 的分阶段计划。当前在 **Phase 0：设计签字**。

## 项目状态

- ✅ 骨架（`packages/core/` + `pnpm-workspace`）
- ✅ Hook 接口草案 v1（[`packages/core/src/hook.ts`](../packages/core/src/hook.ts)）
- ✅ types.ts v2（[`packages/core/src/types.ts`](../packages/core/src/types.ts)：HarnessTool 加 `isConcurrencySafe` + `aliases`、ToolExecResult 加 `newMessages`、暴露 `createUserMessage` / `createAttachmentMessage`）
- ✅ Claude Code 借鉴整理完毕（[08-claude-code-lessons](08-claude-code-lessons.md)，9 条 ✅ 落进 docs，2 条 ❌ 驳回，2 条 ⚠️ 降级保留）
- ⏳ Hook 接口 v2（按 [03-hook-system §2](03-hook-system.md#2-hook-接口定义) 重写 hook.ts，**等用户签字后做**）
- ⏳ Kernel 实现（等 v2 接口签字）
- ❌ 任何 plugin 实现
- ❌ 任何 examples 跑通

## 文档维护原则

1. **每个 doc 单一聚焦**。一个 doc 一个主题，超过 800 行就拆。
2. **决策依据 > 接口描述**。代码本身能说明 "what"，文档要说 "why"。
3. **bidding-agent / Claude Code 的真实证据放在脚注或引用**，让后人能追溯设计来源。
4. **API 改动前先改文档**，文档审过再动代码。Phase 0 严格执行。
