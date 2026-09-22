# harness-pi

> A minimal service-runtime harness for [@earendil-works/pi-ai](https://github.com/earendil-works/pi-mono)-based agents.

[![npm](https://img.shields.io/npm/v/%40harness-pi%2Fcore?label=%40harness-pi%2Fcore)](https://www.npmjs.com/package/@harness-pi/core)
[![CI](https://github.com/chasey-myagi/harness-pi/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/chasey-myagi/harness-pi/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **[#207](https://github.com/chasey-myagi/harness-pi/issues/207) 拍板 D：本仓是参考实现 / 取材源（donor），不进依赖树，不再开发新功能。** 新内核在 [chasey-myagi/sage](https://github.com/chasey-myagi/sage) 重写。要搬什么、按什么形态搬，见 [docs/15-donor-manifest](docs/15-donor-manifest.md)。详见[当前状态](#当前状态)。

```bash
# 代码照常可跑；npm 上的四个包（core / plugins / tools / adapters）停在 0.5.0，不再发新版
pnpm add @harness-pi/core @harness-pi/plugins @harness-pi/tools
# 可选：@harness-pi/adapters（NDJSON / Postgres / OTel 等 sink 后端）
```

## 定位

| 层 | pi 官方栈（面向终端里的程序员） | harness-pi（面向后端服务 / 批处理 worker） |
|---|---|---|
| **L3 上层形态** | `pi-coding-agent`——终端编码 agent 与 UX 扩展系统 | `@harness-pi/plugins`（watchdog / 预算 / compaction / sub-agent / work-pool…）+ `@harness-pi/tools` |
| **L2 agent 内核** | `pi-agent-core`（Mario 的 agent 内核） | `@harness-pi/core`（自己的 loop，hook 是一等公民） |

两栈共同站在 **L1** [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi-mono)（统一 LLM API + tool 规范）上。

- **不动 pi-ai 一行代码**，只是它的消费者。
- **不基于 pi-agent-core**：自己写 agent loop，换来 hook 作为一等公民。
- **不是 pi-coding-agent 的 fork/extension**：那是终端 UX 扩展系统；我们做的是后端/服务端 agent 的运行时 harness，方向不同。
- **基础 tools 第一方支持**：`@harness-pi/tools` 提供 `read/bash/edit/write/grep/find/ls`，API 对齐 `pi-coding-agent@0.53.0`，但不把 `pi-coding-agent` 当 runtime dependency。
- **默认 cwd 边界**：文件类 tools 默认拒绝逃出传入 `cwd`；需要全盘访问必须显式 opt in。`bash` 仍是 host shell，生产环境需要外层 sandbox/worker 隔离。

## Quickstart

```ts
import { AgentSession, Type, type HarnessTool } from "@harness-pi/core";
import { createFakeModel } from "@harness-pi/core/testing";
import { watchdog, trimHistory } from "@harness-pi/plugins";

const echo: HarnessTool = {
  name: "echo",
  description: "Echo back the message",
  parameters: Type.Object({ msg: Type.String() }),
  async execute(args) {
    return { content: [{ type: "text", text: `echoed: ${args["msg"]}` }] };
  },
};

// 离线可跑：fake model 按脚本吐 toolCall；换成 pi-ai 的 getModel(...) 即真实 agent
const model = createFakeModel([
  { content: [{ type: "toolCall", name: "echo", arguments: { msg: "hi" } }] },
  { content: [{ type: "text", text: "All done." }] },
]);

const session = new AgentSession({
  model,
  tools: [echo],
  systemPrompt: "You echo what the user says.",
  hooks: [watchdog({ turnTimeoutMs: 10_000 }), trimHistory({ keepRecent: 4 })],
});
const summary = await session.run("call echo for me");
```

可运行示例见 [`examples/`](examples/)：`01-bare-kernel` → `02-with-plugins` → `03-tools` → `04-batch-pipeline` → `05-maker-verifier-loop`，全部离线可跑、CI verify。

## 哲学

1. **Kernel 极简**。`@harness-pi/core` 只做两件事：跑 pi-ai 的 LLM-tool 循环 + 派发 hook。无 metric、无 watchdog、无 pool、无 compaction 策略——内核只 fire `onContextOverflow` / `onContinuationCheck` / `onAfterFlush` 等观测点，策略全在插件/控制器。
2. **一切皆 hook**。watchdog、metrics、trim/auto/micro-compaction、tool output buffer、log、empty-run guard、lease decision、permission gate、token/cost/tool-stats、turn-end guard、deferred-tools/skills——全部是 hook 实例，全部在 `@harness-pi/plugins` 里：**22 个 plugin 工厂 + 14 个 controller 构件**（精确口径以 [docs/05-plugins](docs/05-plugins.md)、[docs/06-controllers](docs/06-controllers.md) 与各 `index.ts` 实际导出为准）。
3. **基础 coding tools 是一等包**。服务端 agent 也需要 read/grep/bash 这类工具；它们不该由每个消费者重写。
4. **Plugin ≠ Controller ≠ Adapter**。
   - Plugin：钩 loop 事件（装饰器形态）
   - Controller：orchestrate 一/多个 session（work-pool、lifecycle-restart、fork-session、parallel/pipeline、sub-agent-tool/registry、compact-restart/resume、gap-explorer，详见 [docs/06-controllers](docs/06-controllers.md)）
   - Adapter：plugin 的 I/O 后端（metric sink、log sink、session store）
5. **不强加 DB**、**不强加 frontend**、**不强加 metric kinds**。Sink 走接口 + peerDep；自定义 metric kind 用 TS module augmentation。

## harness-pi 与 Loop Engineering

"Loop Engineering"——把 agent 跑成**带护栏的循环**（"harness 的上一层"）——正在成为共识。Claude Code / Codex 把 `/loop`、`/goal` 这类循环做成**不透明的内置命令**；harness-pi 的定位是互补的另一端：**不卖某一条 loop 命令，卖装那台循环的可编程零件**。一条生产级 loop 需要的护栏，在 harness-pi 里几乎都已是 first-class hook / controller（且方向正是后端服务 / 批处理 agent，不是终端 UX）：

| Loop 需要的护栏 | harness-pi 现成件（均已 ship + 测试覆盖） |
|---|---|
| 停止条件 / 验收闸门 | `turnEndGuard`（模型想停时跑 check，不过则回灌原因强制续跑） |
| 生成者 / 验证者分离（maker-verifier） | `subAgentTool` / `routedSubAgentTool`——把验证放进**回合之外的独立 sub-agent**（不同指令、只回 PASS/FAIL），符合"别批改自己的作业" |
| 硬保险丝（预算 / 无进展 / 熔断） | `tokenBudget` / `repeatedCallGuard` / `emptyRunGuard` / `watchdog` |
| 上下文经济（cache 友好） | `autoCompaction` + **封存投影**（v0.5.0）+ `prefixShape` 前缀诊断 |
| 知识固化（skills） | `skills` / `deferredTools`（O1/O2 渐进暴露） |
| 外置状态 / 可恢复 | `SessionStore`（append-only）+ `compaction_boundary` |
| 并行 / 扇出编排 | controllers：`parallel` / `pipeline` / `workPool` / `forkSession` |

> Claude Code 给你一个不透明的 `/goal`；harness-pi 给你**装那台摇柄的零件**。用上表的现成 hook 可以从零件拼出一条 maker-verifier loop（生成者干活 → 独立 reviewer 回合外判 PASS/FAIL → 预算 / 无进展做硬保险丝），不依赖任何内置命令——可运行示例见 [`examples/05-maker-verifier-loop`](examples/05-maker-verifier-loop)。

## 编码能力评测（SWE-bench）

用 [`claw-swe-bench`](https://github.com/opensquilla/claw-swe-bench) 把 harness 当受控变量（统一 prompt / 预算 / workspace 契约 / 补丁提取），SWE-bench **官方评估器**（隐藏测试）判 resolved：

- 单实例 smoke（`sphinx-doc__sphinx-8721`，qwen-plus）：**resolved 1/1**；
- pilot 6 有效实例（qwen-plus）：**3/6 resolved**，连同 smoke 跨 7 实例 **4/7**。

诚实口径：pilot 量级 ≠ 榜单数字；Lite-80 管线已打通、真数字未跑；Apple Silicon emulation 下的结果适合自检与相对对比，正式数字应上 x86_64 复跑。方法、复现步骤与「怎么诚实读结果」见 [docs/swe-bench-eval.md](docs/swe-bench-eval.md)。

## 当前状态

**[#207](https://github.com/chasey-myagi/harness-pi/issues/207) 拍板 D（2026-09-22）：harness-pi 是参考实现 / 取材源（donor），不进任何下游的依赖树，不再开发新功能。**

理由两条：它自己站在第三方 `@earendil-works/pi-ai`（13309 行手写代码，本仓只用到其中 13 个运行时符号、2 个 provider）之上，说不清 loop 里发生了什么，这是结构性的；而新设计要改的是内核原语——模型这一 turn 看到的 view 要从「三条 transform pipe 改写出来的副作用」变成「从 append-only Log 投影出来的一等对象」——改造的代价高于重写。

新内核在 **[chasey-myagi/sage](https://github.com/chasey-myagi/sage)** 重写：内核只有 **Log** 与 **View seam** 两个原语，provider 适配自写。**从这里搬什么、按什么形态搬（整体搬 / 搬骨架 / 搬概念 / 不搬），见 [docs/15-donor-manifest](docs/15-donor-manifest.md)。**

代码本身照常可跑、照常取材。判断成熟度时区分三个层级，别把它们混为一谈：

1. **机制已实现**（代码 + 测试通过）：core loop、hook dispatcher、streaming `message_update` / thinking parity、完整 auto-compaction、22 plugin 工厂、14 controller 构件、NDJSON/Postgres/OTel sink——CI 挂真 Postgres service 跑 adapters 的 18 个集成测试。0.5.0 的旗舰能力是 **cache-aware 封存投影**——`compaction_boundary` 是 live 投影一等公民，上下文投影前缀字节稳定、对 provider prompt-cache 友好。
2. **provider 已验证**：真实 provider（DashScope/Qwen）smoke——streaming、error 提级、budget-bound continuation（小预算下跨 autoCompaction 续跑）已验证（`pnpm --filter @harness-pi/coding-agent run smoke:provider`，key 经 env 注入不落盘，任一 ✗ 则非零退出）；SWE-bench 官方评估 pilot 见上节。reactive overflow（>窗口强行触发）在容忍型 1M 窗口 provider 上测不了，由确定性测试 `context-overflow.test.ts` 覆盖——已知限制。
3. **生产迁移已验证**：**没有，也不会有。** 用真实生产业务 agent（内部代号 `bidding-agent`）完成迁移 spike 这件事本仓不做。它一直是「机制已实现」与「生产替代品」之间的唯一差距，现在这个差距由 sage 来填。

npm 上的四个包停在 **0.5.0**，不再发新版；`main` 是 0.6.0 发布候选（[#169](https://github.com/chasey-myagi/harness-pi/pull/169)，49 commits 的 hardening wave），不再正式 bump。路线收口见 [docs/roadmap.md](docs/roadmap.md)。

## Dogfood Agents

**`apps/coding-agent`**——对标 `pi-coding-agent` 核心 coding loop 的终端编码 agent：真实 model、真实 repo、第一方 tools、session log、metrics、token/cost/tool/耗时报告。

```bash
pnpm --filter @harness-pi/coding-agent start -- --cwd . --model dashscope:qwen-plus "inspect and summarize this repo"
```

- model 来源：`--model provider:modelId` 或 `HARNESS_PI_MODEL`。
- DashScope/Qwen 可用 `dashscope:qwen-plus` 或 `qwen:qwen-plus`，凭据来自 `DASHSCOPE_API_KEY` 或 `QWEN_API_KEY`；已知 Qwen 文本模型会显示人民币 token 成本估算，未知 DashScope 模型保持 `n/a`。
- 默认 full mode 挂 `read/bash/edit/write/grep/find/ls`；`--read-only` 只挂 `read/grep/find/ls`。
- `--disable bash,write` 可以关闭指定基础 tool。
- 默认 log 目录是 `.harness-pi/logs`；`--metrics-file path.ndjson` 可写 metrics。
- 默认对 session log 里的高危 tool args 脱敏（`write` 内容、`edit` 文本、`bash` 命令仅记长度，不落原文，避免密钥/源码静默写进 `.harness-pi/logs`）；`--log-args full` 记原始 args（仅本地调试）；`--log-args none` 完全不记 args；`--no-log` 关闭整个 session log。
- **`.harness-pi/` 落盘与 gitignore**：session log 已默认脱敏（见上），但 **resume 存储**（`.harness-pi/sessions/*.jsonl`，TUI / `--resume` 用）为了能正确**重放续跑**保存**完整原文**消息历史（含 `write` 内容、`bash` 命令等），**不脱敏**。启动时若检测到当前仓库未把 `.harness-pi/` 加入 `.gitignore`，会打印一条告警——请务必把 `.harness-pi/` 加入 `.gitignore`，以免敏感内容被误提交。
- **安全边界**：`bash` 是 host shell，不是 sandbox。full mode 只应在你明确允许修改的 workspace 里运行。`bash` tool 的 `BashOperations.exec`（`packages/tools`）是**唯一安全咽喉点**——把 OS 级沙箱接进来的唯一接缝。默认 `defaultExec` 仅供 trusted 环境；**生产 / headless / 跑在不可信输入上时，必须经 `operations.exec` 注入沙箱化 exec**（`permissionGate` 的字符串审批是筛子不是墙，只降噪不设边界）。设计见 [docs/14 §3.3](docs/14-production-coding-agent-architecture.md)。

**`apps/lark-bot`**——跑在同一内核上的飞书（Lark）个人助手 bot：大脑 `deepseek-v4-flash`（经 pi-ai），`lark-cli` 长连接消费 IM 事件（无公网 endpoint 也能跑），lark-cli 工具族白名单 + 破坏性操作拦截 + `remember` 自生长记忆。详见 [apps/lark-bot/README.md](apps/lark-bot/README.md)。

## Layout

```
harness-pi/
├── apps/
│   ├── coding-agent/ # @harness-pi/coding-agent —— dogfood 终端编码 agent
│   └── lark-bot/     # @harness-pi/lark-bot —— dogfood 飞书助手 bot（deepseek-v4-flash）
├── packages/
│   ├── core/         # @harness-pi/core —— AgentSession + hook protocol
│   ├── plugins/      # @harness-pi/plugins —— 22 plugin 工厂 + 14 controller 构件
│   ├── tools/        # @harness-pi/tools —— read / bash / edit / write / grep / find / ls
│   ├── adapters/     # @harness-pi/adapters —— NDJSON / Postgres / OTel 等 sink
│   └── transcript/   # @harness-pi/transcript —— 内核事件契约镜像（孵化中）
├── docs/             # 00–15 编号文档 + SWE-bench 评测手册（docs/README.md 为索引）
├── examples/         # 01-bare-kernel … 05-maker-verifier-loop（离线可跑）
└── README.md
```

## License

MIT
