# harness-pi

> A minimal service-runtime harness for [@earendil-works/pi-ai](https://github.com/earendil-works/pi-mono)-based agents.

## 定位

```
┌─────────────────────────────────────────────────────────┐
│   @earendil-works/pi-ai —— unified LLM API + tool spec  │  L1 ← 我们站在这上面
├──────────────────────────┬──────────────────────────────┤
│  @earendil-works/        │   @harness-pi/core           │  L2
│  pi-agent-core           │                              │
│  (Mario 的 agent 内核)    │   (我们的 agent 内核，         │
│                          │    hook 系统作为一等公民)      │
├──────────────────────────┼──────────────────────────────┤
│  @earendil-works/        │   @harness-pi/plugins        │  L3
│  pi-coding-agent         │   (watchdog / metrics /      │
│  (终端编码 agent)         │    trim / buffer / log ...)  │
│                          │                              │
│  目标用户：终端里的程序员  │   目标用户：把 agent 部署       │
│                          │   成后端服务/批处理 worker     │
└──────────────────────────┴──────────────────────────────┘
```

- **不动 pi-ai 一行代码**，只是它的消费者。
- **不基于 pi-agent-core**：自己写 agent loop，换来 hook 作为一等公民。
- **不是 pi-coding-agent 的 fork/extension**：那是终端 UX 扩展系统；我们做的是后端/服务端 agent 的运行时 harness，方向不同。
- **基础 tools 第一方支持**：`@harness-pi/tools` 提供 `read/bash/edit/write/grep/find/ls`，API 对齐 `pi-coding-agent@0.53.0`，但不把 `pi-coding-agent` 当 runtime dependency。
- **默认 cwd 边界**：文件类 tools 默认拒绝逃出传入 `cwd`；需要全盘访问必须显式 opt in。`bash` 仍是 host shell，生产环境需要外层 sandbox/worker 隔离。

## 哲学

1. **Kernel 极简**。`@harness-pi/core` 只做两件事：跑 pi-ai 的 LLM-tool 循环 + 派发 hook。无 metric、无 watchdog、无 pool、无 compaction 策略——内核只 fire `onContextOverflow` / `onContinuationCheck` / `onAfterFlush` 等观测点，策略全在插件/控制器。
2. **一切皆 hook**。watchdog、metrics、trim/auto/micro-compaction、tool output buffer、log、empty-run guard、lease decision、permission gate、token/cost/tool-stats、turn-end guard、deferred-tools/skills——全部是 hook 实例，全部在 `@harness-pi/plugins` 里（20 个 `Hook` 工厂 + `toolSearch`/`skills` 工具工厂，详见 [docs/05-plugins](docs/05-plugins.md)）。
3. **基础 coding tools 是一等包**。服务端 agent 也需要 read/grep/bash 这类工具；它们不该由每个消费者重写。
4. **Plugin ≠ Controller ≠ Adapter**。
   - Plugin：钩 loop 事件（装饰器形态）
   - Controller：orchestrate 一/多个 session（work-pool、lifecycle-restart、fork-session、parallel/pipeline、sub-agent-tool/registry、compact-restart/resume、gap-explorer，详见 [docs/06-controllers](docs/06-controllers.md)）
   - Adapter：plugin 的 I/O 后端（metric sink、log sink、session store）
5. **不强加 DB**、**不强加 frontend**、**不强加 metric kinds**。Sink 走接口 + peerDep；自定义 metric kind 用 TS module augmentation。

## 当前状态

`harness-pi` 现在处在 **v0.3.1** 阶段：core loop、hook dispatcher、standard plugins、controllers、first-party tools、dogfood coding agent、offline examples 和测试都已经落地，足够做 spike/review。

判断成熟度时区分三个层级，别把它们混为一谈：

1. **机制已实现**（mechanism implemented，代码 + 本地测试通过）：包括 streaming `message_update` / thinking parity、完整 auto-compaction、PG sink——这些**都已经落地并有本地测试覆盖**，不再是迁移 blocker。
2. **provider 已验证**（provider-verified）：用真实 provider 跑 streaming / error / overflow 的 smoke。**尚未完成。**
3. **bidding-migration 已验证**（bidding-migration-validated）：用真实 `bidding-agent` 做一次 spike 跑通。**尚未完成。**

结论：harness-pi 已经 **spike-ready**，但**还不是 `bidding-agent` 的生产替代品**。剩下的差距是「真实 provider 在规模下的验证」+「一次 bidding-agent 迁移 spike」，**不是缺机制**。当前建议仍是先把 `bidding-agent` 内部接口形状对齐，再用 worktree 做最小 happy-path spike。

## Dogfood Agent

`apps/coding-agent` 是当前唯一真实 agent 应用，用来对标 `pi-coding-agent` 的核心 coding loop：真实 model、真实 repo、第一方 tools、session log、metrics、token/cost/tool/耗时报告。

```bash
pnpm --filter @harness-pi/coding-agent start -- --cwd . --model provider:model "inspect and summarize this repo"
pnpm --filter @harness-pi/coding-agent start -- --cwd . --model dashscope:qwen-plus
```

- model 来源：`--model provider:modelId` 或 `HARNESS_PI_MODEL`。
- DashScope/Qwen 可用 `dashscope:qwen-plus` 或 `qwen:qwen-plus`，凭据来自 `DASHSCOPE_API_KEY` 或 `QWEN_API_KEY`；已知 Qwen 文本模型会显示人民币 token 成本估算，未知 DashScope 模型保持 `n/a`。
- 默认 full mode 挂 `read/bash/edit/write/grep/find/ls`；`--read-only` 只挂 `read/grep/find/ls`。
- `--disable bash,write` 可以关闭指定基础 tool。
- 默认 log 目录是 `.harness-pi/logs`；`--metrics-file path.ndjson` 可写 metrics。
- 默认对 session log 里的高危 tool args 脱敏（`write` 内容、`edit` 文本、`bash` 命令仅记长度，不落原文，避免密钥/源码静默写进 `.harness-pi/logs`）；`--log-args full` 记原始 args（仅本地调试）；`--log-args none` 完全不记 args；`--no-log` 关闭整个 session log。
- **`.harness-pi/` 落盘与 gitignore**：session log 已默认脱敏（见上），但 **resume 存储**（`.harness-pi/sessions/*.jsonl`，TUI / `--resume` 用）为了能正确**重放续跑**保存**完整原文**消息历史（含 `write` 内容、`bash` 命令等），**不脱敏**。启动时若检测到当前仓库未把 `.harness-pi/` 加入 `.gitignore`，会打印一条告警——请务必把 `.harness-pi/` 加入 `.gitignore`，以免敏感内容被误提交。
- **安全边界**：`bash` 是 host shell，不是 sandbox。full mode 只应在你明确允许修改的 workspace 里运行。

## Layout

```
harness-pi/
├── apps/
│   └── coding-agent/ # @harness-pi/coding-agent —— real dogfood coding agent
├── packages/
│   ├── core/         # @harness-pi/core —— AgentSession + hook protocol
│   ├── plugins/      # @harness-pi/plugins —— watchdog / metrics / trim / log ...
│   └── tools/        # @harness-pi/tools —— read / bash / edit / write / grep / find / ls
├── docs/             # architecture, hook, plugin, controller, adapter docs
├── examples/
│   ├── 01-bare-kernel/
│   ├── 02-with-plugins/
│   └── 03-tools/
└── README.md
```

## License

MIT
