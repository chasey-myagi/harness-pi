# 01 · Architecture

> 三层架构、完整目录结构、依赖流向、pi-mono 边界与不依赖 pi-agent-core 的依据。

## 1. 三层架构总览

```
┌──────────────────────────────────────────────────────────┐
│                  Controller layer                         │
│   lifecycle-restart · work-pool · lease-queue · ...      │
│   ─────────  调用 kernel，编排多 session  ─────────       │
└──────────────────────────────────────────────────────────┘
                            ↓ 使用
┌──────────────────────────────────────────────────────────┐
│                    Plugin layer                           │
│   watchdog · metrics · trim-history · session-log · ...  │
│   ─────────  Hook 实现，挂到一个 session  ─────────        │
└──────────────────────────────────────────────────────────┘
                            ↓ 注册到
┌──────────────────────────────────────────────────────────┐
│                    Kernel layer                           │
│   AgentSession · Hook protocol · loop · dispatcher       │
│   ─────────  最小内核，只暴露扩展点  ─────────              │
└──────────────────────────────────────────────────────────┘
                            ↓ 依赖
┌──────────────────────────────────────────────────────────┐
│              @earendil-works/pi-ai (L1)                     │
│   stream · complete · Tool · Context · OAuth · ...       │
└──────────────────────────────────────────────────────────┘
```

**关键不变量**：

- 上层可以依赖下层，下层**不许**依赖上层
- Plugin 之间**不直接互相 import**（要协作走 `ctx.state`）
- Controller 可以 compose plugin，但 plugin 不知道 controller 的存在
- Kernel 不知道**任何**plugin / controller 的存在；它只跟 `Hook` 接口对话

## 2. 完整目录结构

```
harness-pi/
├── docs/
│   ├── README.md           ← 索引
│   ├── 00-overview.md
│   ├── 01-architecture.md  ← 本文档
│   ├── 02-kernel.md
│   ├── 03-hook-system.md
│   ├── 04-context-injection.md
│   ├── 05-plugins.md
│   ├── 06-controllers.md
│   ├── 07-adapters.md
│   └── roadmap.md
│
├── packages/
│   ├── core/                              ← @harness-pi/core
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts                   ← 公共出口
│   │       ├── session.ts                 ← AgentSession 类
│   │       ├── hook.ts                    ← Hook 接口
│   │       ├── dispatcher.ts              ← Hook 派发逻辑
│   │       ├── context.ts                 ← HookContext 类
│   │       ├── types.ts                   ← HarnessTool, RunSummary
│   │       └── __tests__/
│   │
│   └── plugins/                           ← @harness-pi/plugins
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts                   ← 每个 plugin 一个 named export
│           │
│           ├── watchdog.ts                ← Around
│           ├── trim-history.ts            ← Transform
│           ├── empty-run-guard.ts         ← Event + abort
│           ├── tool-output-buffer.ts      ← Event + ctx.state
│           ├── session-log.ts             ← Event + NDJSON sink
│           ├── system-reminder.ts         ← Transform (additionalContext)
│           ├── batch-counter.ts           ← Event + callback
│           ├── lease-decision.ts          ← Decision
│           │
│           ├── metrics/
│           │   ├── index.ts               ← metrics() factory
│           │   ├── types.ts               ← MetricKind, MetricEvent
│           │   ├── recorder.ts            ← 批写 buffer
│           │   └── sinks/
│           │       ├── memory.ts          ← 默认，零依赖
│           │       ├── ndjson-file.ts     ← 零依赖
│           │       └── postgres.ts        ← peerDep on `pg`
│           │
│           └── controllers/               ← 不是 plugin，不挂 hook
│               ├── lifecycle-restart.ts   ← watchdog restart + carryover
│               ├── work-pool.ts           ← 并行分发到 N 个 session
│               └── lease-queue.ts         ← 单 item lease
│
├── examples/                              ← Phase 1+ 才有
│   ├── 01-bare-kernel/                    ← 5 行无 hook
│   ├── 02-with-plugins/                   ← 5 plugin 同挂
│   ├── 03-pool/                           ← 并行
│   └── 04-bidding-style/                  ← evidence + lease 复刻
│
├── package.json                           ← workspace 根
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .gitignore
└── README.md
```

## 3. 依赖流向

```
┌───────────────────────────────────────────────┐
│ @harness-pi/plugins                            │
│  - dependencies: @harness-pi/core              │
│  - peerDependencies: pg, @opentelemetry/*, ... │  ← 用户自己装
└────────────────────┬──────────────────────────┘
                     ↓
┌───────────────────────────────────────────────┐
│ @harness-pi/core                               │
│  - dependencies: @earendil-works/pi-ai           │
│  - 仅此一个 runtime dep                         │
└────────────────────┬──────────────────────────┘
                     ↓
┌───────────────────────────────────────────────┐
│ @earendil-works/pi-ai                            │
│  - 16 个 provider 适配 + OAuth + handoff       │
└───────────────────────────────────────────────┘
```

**Core 包的依赖必须最少**：除了 `pi-ai` 不引入任何 runtime dep。这样：

- 想自己写 plugin 的人 `npm install @harness-pi/core`，安装树极小
- 想用标准库的人 `npm install @harness-pi/plugins`，按需引入 sink 的 peerDep

## 4. 为什么不依赖 pi-agent-core

pi-agent-core 是个干净的库（agent-loop.js 307 行、agent.js 409 行），重写它本身**不是**目标。但它的扩展模型不匹配我们的需求。

### 4.1 扩展模型差异

pi-agent-core 给的扩展点：

| 扩展点 | 形态 |
|---|---|
| `session.subscribe(event => ...)` | observer，只能看，无返回值 |
| `transformContext: (messages) => messages` | 单一钩子位的 transform |
| `convertToLlm: (messages) => messages` | filter custom AgentMessage 类型 |
| `getApiKey: async (provider) => key` | OAuth refresh |
| `streamFn: (model, ctx, opts) => stream` | proxy 后端 |
| `steeringMode / followUpMode` | 终端 UX 的消息排队策略 |

harness-pi 需要的扩展点：

| 想要 | pi-agent-core 之上能做？ | 为什么 |
|---|---|---|
| `onLlmEnd / onToolEnd` 记 metric | ✅ subscribe 几个事件即可 | 观察够用 |
| `transformMessagesBeforeLlm` trim history | 🟡 `transformContext` 能做但只一个钩子位 | 多 plugin 共用一个 钩子位要互相 chain，脆且不可组合 |
| **`beforeToolUse → { deny }`** lease 拦截 | ❌ | pi-agent-core 一旦把 toolCall 收到事件流就开始执行，外部 observer 拦不住 |
| **`beforeToolUse → { modifyArgs }`** 注入参数 | ❌ | 同上 |
| **per-tool timeout / retry**（不 abort 整个 session） | ❌ | tool execute 在 loop 内同步等 |
| **`transformSystemPromptBeforeLlm`** per-turn 系统提示 | 🟡 `setSystemPrompt` 能做但要外部代码维持状态 | 容易跟其他 plugin 撞 |
| 多 plugin **协作 / 顺序契约** | ❌ | observer pattern 不约束顺序 |

红色那几条恰好是 production harness 最有价值的能力。**这是设计哲学差异**，不是缺 feature 几行能补的。pi-agent-core 不应该背我们的需求——它是给 pi-coding-agent 用的，目标是终端编码 agent 的状态管理。

### 4.2 重写 loop 的实际成本

pi-ai 给消费者留的"作业"很明确（参见 pi-ai README §Quick Start）：

1. `stream(model, context)` 拿一个 turn 的输出
2. 从 `response.content` 里挑 `toolCall`
3. `validateToolCall(tools, toolCall)` 校验
4. 执行 tool，结果作为 `toolResult` message 追加到 context
5. 看 `stopReason`，是 `toolUse` 就再来一轮，否则结束

加 hook 派发、abort 处理、around chain，整个 kernel 估计 **400-600 LOC**。可接受。

### 4.3 我们继续依赖 pi-ai 的（**绝对不重做**）

| 来自 pi-ai | 价值 |
|---|---|
| `stream` / `complete` + 16 个 provider | OAuth、context 长度报错、abort 协议、partial JSON tool args 解析、cross-provider handoff |
| `Context` / `Message` 类型 | 跨 provider 协议、序列化 |
| `Tool` + TypeBox schema | tool 定义统一 |
| `validateToolCall(tools, toolCall)` | tool args 校验 + 错误回灌 LLM |
| `registerApiProvider` | trim-history plugin 用（但作为 per-session opt-in，不是全局副作用） |
| `getEnvApiKey` / OAuth flow / `getModel` | 模型和密钥解析 |
| `AssistantMessage.usage` | token / cost 已算好 |
| `stopReason` / `errorMessage` / 部分内容 | abort/error 时 partial 内容已序列化 |

**pi-ai 解决"怎么跟所有 provider 干净地说话"。这是 Mario 投入最大的部分，我们绝对不重做。**

## 5. 模块边界与职责

### 5.1 Kernel（`@harness-pi/core`）

**做**：
- 维护 `AgentSession.messages` 数组
- 跑 loop（LLM call → tool → 再 call）
- 派发 hook（按形态走不同执行策略）
- 提供 `HookContext`（session id、turn 计数、`ctx.state` map、abort signal）
- 错误兜底（hook 抛错不破坏 session、tool 抛错转 isError result）

**不做**：
- 任何具体 plugin 的逻辑
- 任何 sink / 存储
- 任何 domain 概念
- 任何 metric kind 字典
- 任何 message 转换（除了 hook 让它做的）

### 5.2 Plugin（`@harness-pi/plugins/src/*.ts`）

**做**：
- 实现 `Hook` 接口
- 通过 `ctx.state` 跟其他 plugin 协作（约定 key 前缀）
- 通过 `ctx.appendMessage / additionalContext` 注入 context
- 通过 Sink 异步刷 I/O

**不做**：
- 在 hot path 做阻塞 I/O（见 [03-hook-system §性能契约](03-hook-system.md#9-性能契约)）
- 直接 import 另一个 plugin
- 假设其他 plugin 一定存在

### 5.3 Controller（`@harness-pi/plugins/src/controllers/*.ts`）

**做**：
- 持有/调用 N 个 `AgentSession` 实例
- 实现并行 / 队列 / 重启等高阶模式
- 负责 carryover、cleanup、aggregation

**不做**：
- 注册成 hook（它在 session 外面，不在 hook 派发链上）

### 5.4 Adapter（`@harness-pi/plugins/src/*/sinks/*.ts`）

**做**：
- 实现 plugin 自定义的 sink 接口（`MetricsSink`、`LogSink` 等）
- 异步 / 批量 写到外部系统（PG、文件、OTel）

**不做**：
- 在 hot path 做 sync I/O
- 知道自己被哪个 plugin 用

## 6. 模块边界的执行：grep 自检

为了保证 domain 概念不会渗透进 core，把以下 grep 加进 CI（Phase 1 起）：

```bash
# core 不能提到任何 bidding-agent 业务字眼
grep -rE '"question"|"evidence"|"judgment"|"compliant"|"finding"|"submitEvidence"' packages/core/src/

# core 不能依赖 plugins
grep -rE 'from\s+["\047]@harness-pi/plugins' packages/core/src/

# plugin 之间不能互相 import
grep -rE 'from\s+["\047]\.\.\/[a-z\-]+["\047]' packages/plugins/src/*.ts | \
  grep -vE 'from\s+["\047]\.\.\/metrics' # metrics 子模块允许 intra-package import

# core 不能 import controllers
grep -rE 'controllers/' packages/core/src/
```

任一返回非空就是 CI fail。

## 7. 包依赖图（npm 视角）

```
@harness-pi/plugins
├── @harness-pi/core           (workspace:* in dev, ^0.x in published)
├── peerDeps:
│   ├── pg                     (optional, postgres sink)
│   ├── @opentelemetry/api     (optional, OTel sink)
│   └── @opentelemetry/sdk-node (optional)
└── devDeps:
    ├── @types/pg
    └── ...

@harness-pi/core
├── @earendil-works/pi-ai        (^0.53.0 or whatever current)
└── devDeps:
    ├── @types/node
    ├── typescript
    └── vitest
```

注意 `@harness-pi/core` 的依赖只有 pi-ai 一个，安装树极小，给"想自己写 plugin"的人留干净起点。

## 8. 跨包 import 约定

```ts
// ✅ Kernel 内部
import { Hook } from "./hook.js";
import { stream, getModel, type Context } from "@earendil-works/pi-ai";

// ✅ Plugin 引用 kernel
import type { Hook, HookContext, ToolDecision } from "@harness-pi/core";

// ❌ Plugin import 另一个 plugin
import { metrics } from "../metrics/index.js"; // 禁止

// ❌ Kernel import plugin
import { watchdog } from "@harness-pi/plugins"; // 禁止，会形成循环

// ✅ Controller import kernel + 多个 plugin（compose 用）
import { AgentSession } from "@harness-pi/core";
import { watchdog, metrics } from "@harness-pi/plugins";
```

## 9. 接下来

- 想看 kernel 的 API 表面和 loop 算法 → [02-kernel](02-kernel.md)
- 想看 Hook 接口和执行模型 → [03-hook-system](03-hook-system.md)
- 想看每个 plugin 怎么写 → [05-plugins](05-plugins.md)
