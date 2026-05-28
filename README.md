# harness-pi

> A minimal service-runtime harness for [pi-ai](https://github.com/badlogic/pi-mono)-based agents. Sibling to [pi-coding-agent](https://github.com/badlogic/pi-mono); not affiliated with `badlogic/pi-mono`.

## 定位

```
┌─────────────────────────────────────────────────────────┐
│   @mariozechner/pi-ai  ——  unified LLM API + tool spec  │  L1 ← 我们站在这上面
├──────────────────────────┬──────────────────────────────┤
│  @mariozechner/          │   @harness-pi/core           │  L2
│  pi-agent-core           │                              │
│  (Mario 的 agent 内核)    │   (我们的 agent 内核，         │
│                          │    hook 系统作为一等公民)      │
├──────────────────────────┼──────────────────────────────┤
│  @mariozechner/          │   @harness-pi/plugins        │  L3
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

1. **Kernel 极简**。`@harness-pi/core` 只做两件事：跑 pi-ai 的 LLM-tool 循环 + 派发 hook。无 metric、无 watchdog、无 pool。
2. **一切皆 hook**。Watchdog、metrics、trim history、tool output buffer、log、empty-run guard、lease decision——全部是 hook 实例，全部在 `@harness-pi/plugins` 里。
3. **基础 coding tools 是一等包**。服务端 agent 也需要 read/grep/bash 这类工具；它们不该由每个消费者重写。
4. **Plugin ≠ Controller ≠ Adapter**。
   - Plugin：钩 loop 事件（装饰器形态）
   - Controller：orchestrate 一/多个 session（pool、lifecycle restart）
   - Adapter：plugin 的 I/O 后端（metric sink、log sink）
5. **不强加 DB**、**不强加 frontend**、**不强加 metric kinds**。Sink 走接口 + peerDep；自定义 metric kind 用 TS module augmentation。

## 当前状态

`harness-pi` 现在处在 **v0.1 readiness** 阶段：core loop、hook dispatcher、standard plugins、controllers、first-party tools、offline examples 和测试都已经落地，足够做 spike/review。

还不应直接全量替换 `bidding-agent`：这个框架尚未经过第三方 production 验证，streaming `message_update`/thinking parity、完整 auto-compaction、PG sink 仍是迁移 blocker。当前建议是先把 `bidding-agent` 内部接口形状对齐，再用 worktree 做最小 happy-path spike。

## Layout

```
harness-pi/
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
