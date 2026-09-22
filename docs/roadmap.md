# harness-pi 路线图

> **本仓不排期。** [#207](https://github.com/chasey-myagi/harness-pi/issues/207) 拍板 D：harness-pi 维持 [#178](https://github.com/chasey-myagi/harness-pi/issues/178) 的定位——参考实现 / 取材源（donor），不进任何下游的依赖树。新内核在 [chasey-myagi/sage](https://github.com/chasey-myagi/sage) 重写（总纲 <https://github.com/chasey-myagi/sage/issues/1>），内核只有 Log 与 View seam 两个原语，provider 适配自写，不再依赖 `@earendil-works/pi-ai`。

## 现在做什么

只有两件：

1. **卫生**——文档不撒谎、模板、注释。
2. **取材文档**——[15-donor-manifest](15-donor-manifest.md)：搬什么到 sage，每条按什么形态搬（整体搬 / 搬骨架 / 搬概念 / 不搬）。

不做任何实现型工作。已有的代码照常可跑、照常取材，只是不再新增能力。

`docs/01`–`docs/14` 正文保持「等于当前代码」（[#182](https://github.com/chasey-myagi/harness-pi/issues/182) 的纪律），不因新仓的设计去改本仓的契约文档。

## 保留议题

下面这些方向本身没被否掉，只是不在这个仓库做。**需求拉动时在 sage 建票**，不从这里迁移 issue。原始论证见 [13-architecture-deep-dive-verdicts](13-architecture-deep-dive-verdicts.md) 与 [14-production-coding-agent-architecture](14-production-coding-agent-architecture.md)。

| 工作包 | 内容 |
|---|---|
| **A · 防护反转** | headless 默认挂运行时护栏（预算 / watchdog / 成本追踪）、工具危险度元数据、permissionGate policy 模式——护栏先于烧钱 |
| **B · 装配地基** | 声明式装配 + 分层配置链，把 god-function 拆成可组合的 features，observability 收成 recipe |
| **C · 安全纵深** | bash `exec` 是唯一安全咽喉点；OS 级沙箱薄版 + 项目信任门，三层都要，缺 OS 沙箱就是假安全 |
| **D · 交付形态** | 事件渲染单管线 + output-guard、transport-neutral 审批通道、headless 命令协议、会话格式版本号 + one-shot 契约 |

四条之外还有两个未收敛的内核议题：持久化演进（可分叉的 session store）与 `ctx.state` 的跨 plugin 约束。它们在 Log + View seam 下的形状跟这里不同，属于 sage 的重新设计范围，不是本仓的待办。

## 已落地的事实

当前代码状态（机制层面已实现、有测试覆盖）以下列文档与各 `index.ts` 的实际导出为准，不在本文重复维护：

- 内核与 hook 协议 → [02-kernel](02-kernel.md)、[03-hook-system](03-hook-system.md)
- plugin 标准库 → [05-plugins](05-plugins.md)
- controller → [06-controllers](06-controllers.md)
- 第一方 tools 与依赖边界 → [01-architecture](01-architecture.md)
- sink / session store → [07-adapters](07-adapters.md)
- 编码能力评测 → [swe-bench-eval](swe-bench-eval.md)

验收命令：

```bash
pnpm -r typecheck
pnpm -r test
pnpm -r build
```

离线 examples（`examples/01-bare-kernel` … `examples/05-maker-verifier-loop`）全部可跑、CI verify。

## 没有做、也不会在这里做的

- `bidding-agent` 全量迁移与迁移 spike；外部 production-like spike 与真实规模验证。
- `sideQuestion` controller、`OtelSink`、memdir 语义记忆、子 agent 生命周期事件流。
- `apps/coding-agent` 的产品化能力面（MCP、web、todo/plan、background bash、git/checkpoint、LSP、检索/记忆等，见 [11-coding-agent-product-roadmap](11-coding-agent-product-roadmap.md)）。

这些不是「以后补」，是**本仓不做**。若在新设计下仍然成立，在 sage 重新建票。
