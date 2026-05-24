# 04 · Context Injection

> 四种 Context 注入机制 + system prompt 重写、attachment message 模式、决策树、完整示例。

## 1. 总览

**"Context 注入"指 plugin 通过 hook 影响 LLM 在下一次 call 看到什么。**

harness-pi 提供 5 个注入入口，按"持久化 / transient"和"作用对象"两个维度划分：

| # | 入口 | 哪个 hook 用 | 持久化进 `session.messages`？ | 作用对象 |
|---|---|---|---|---|
| 1 | `additionalContext: string` | 所有 event / decision hook | ❌ transient | 拼成 attachment message，下次 LLM call 看到 |
| 2 | `initialUserMessage: string` | 仅 `onSessionStart` | ✅ persistent | 作为初始 user message 入 `session.messages` |
| 3 | `updatedInput: Record<string, unknown>` | 仅 `onPreToolUse` | N/A | 改 tool args（execute 前生效） |
| 4 | `updatedToolOutput: ToolExecResult` | 仅 `onPostToolUse` | ✅（替换 toolResult） | 改 tool result（push 到 messages 前生效） |
| 5 | `transformSystemPromptBeforeLlm(prompt) → string` | 单独的 transform hook | ❌（每 turn 重算） | 改 system prompt |
| 附 | `ctx.appendMessage(msg)` | 任意 hook 内部调用 | ✅ persistent | 任意 push 一条消息进 session.messages |

**关键 contrast**：

- pi-agent-core 的 `transformContext` 是单一钩子位，多个 plugin 共用会互相 chain，脆且不可组合
- Claude Code 把这五种入口正式化为 envelope 字段，每种用途单独命名，**正是我们要学的**

## 2. `additionalContext` 的聚合模型

借鉴 Claude Code，**transient context 不是 pipe，是 aggregate**：

```ts
// Hook A 返回：{ additionalContext: "<reminder>turn idx > 8, please wrap up</reminder>" }
// Hook B 返回：{ additionalContext: "<reminder>file foo.ts changed externally</reminder>" }
// Hook C 不返回 additionalContext

// 合并后（按注册顺序）：
additionalContexts = [
  "<reminder>turn idx > 8, please wrap up</reminder>",
  "<reminder>file foo.ts changed externally</reminder>",
];

// kernel 在 LLM call 前包成一条 attachment message，拼到 messages 末尾：
const attachment = {
  role: "user",
  content: [{
    type: "text",
    text: additionalContexts.join("\n\n"),  // 或者更结构化的包装
  }],
  // 内部标记：这是 hook 加的，不是用户真的发的
  _meta: { type: "hook_additional_context", hookEvent: "onTurnStart" },
};
msgsForLlm = [...messages, attachment];
```

### 2.1 为什么 aggregate 不 pipe

|  | pipe（前→后改 string） | aggregate（每个独立给一段，最后拼） |
|---|---|---|
| 互相影响 | ✅ Hook B 看到 Hook A 修改后的版本 | ❌ 各自独立 |
| 并行执行 | ❌ 必须顺序 | ✅ 可并行 |
| Plugin 之间耦合 | 高（隐式依赖前者输出格式） | 低（各管各的） |
| 适合场景 | 渐进式 transform（trim → re-format → ...） | 多 plugin 独立贡献 reminder |

**结论**：transient context 注入用 aggregate 更干净。pipe 用在 `transformSystemPromptBeforeLlm`（system prompt 是一段连续 string，pipe 自然）。

## 3. Attachment message 模式

借鉴 Claude Code 的 `createAttachmentMessage({ type: 'hook_additional_context', hookName, hookEvent, content })`：

```
session.messages 真实历史：
  [0] user:        "上传了 RFP 文档，开始分析"
  [1] assistant:   "好的，我先查看一下知识库" + toolCall(grep, "...")
  [2] toolResult:  "..."
  [3] assistant:   "找到 3 处相关..."
  ...

kernel 进入 turn N，调用 hook 拿到 additionalContexts，包成 attachment：
  msgsForLlm = [
    ...session.messages,
    {
      role: "user",
      content: [{ type: "text", text: "<hook-context>...</hook-context>" }],
      _meta: { hookEvent: "onTurnStart", hookNames: ["watchdog", "system-reminder"] },
    },
  ]

LLM call(model, msgsForLlm) 拿到这个 view
session.messages 本身不改
下次 turn 重新跑 hook，决定要不要再注入
```

### 3.1 为什么不直接 splice 进 messages

**理由 1：序列化干净**。重启 / 恢复 session 时不带 transient context（hook 重新跑会自己决定要不要再加）。

**理由 2：可识别**。attachment message 带 `_meta` 标记，transcript 渲染 / 调试 / metric 都能分辨"这是 hook 加的还是用户真发的"。

**理由 3：避免多 plugin 撞车**。如果让 plugin 直接改 messages 数组，多个 plugin 同时改会撞 race。aggregate 模式天然分离。

**理由 4：cache key 稳定**。Claude / DashScope 的 prefix cache 依赖 messages 字节稳定。如果 transient context 混入 messages 会破坏 cache hit。attachment 在 messages 之后追加，不影响 prefix。

### 3.2 Attachment message 的物理格式

候选 A：纯 user message（看起来跟用户发的一样）：

```ts
{
  role: "user",
  content: [{ type: "text", text: "<system-reminder>...</system-reminder>" }],
  _meta: { type: "hook_additional_context", ... },  // 我们自己加，pi-ai 不识别
}
```

候选 B：用 pi-ai 的 toolResult 模式：

```ts
{
  role: "toolResult",
  toolCallId: "hook-context-" + randomUUID(),
  toolName: "__hook__",
  content: [{ type: "text", text: "..." }],
  ...
}
```

**选 A**。理由：
- user message 跨 provider handoff 时都被原样保留（pi-ai 注释里说的）
- toolResult 必须配对 toolCall，我们伪造一个 toolCallId 会让某些 provider 报错
- `_meta` 字段 pi-ai 不会序列化进 LLM 请求（只透传我们自己的代码）

但 `<system-reminder>...</system-reminder>` tag 包裹的纯文本作为内容，是 Claude Code 验证过的方案，LLM 会识别这是 system 提示而不是用户真的发的。

## 4. 决策树：什么时候用哪个

```
                想注入什么？
                     │
       ┌─────────────┼──────────────┐
       │             │              │
   想改 LLM 看到的    想改 tool       想改 system prompt
   一段额外文字       行为/输入/输出
       │             │              │
       │             │              transformSystemPromptBeforeLlm
       │             │
       │       ┌─────┴───────┐
       │       │             │
       │   改 args         改 result
       │       │             │
       │  onPreToolUse    onPostToolUse
       │  updatedInput    updatedToolOutput
       │
   要持久化？
       │
   ┌───┴───┐
   是      否
   │       │
   是 SessionStart？
   │       │
   ┌─┴─┐   │
   是  否  │
   │   │   │
   init  ctx.    additionalContext
   UserMsg appendMessage   (attachment)
```

### 4.1 速查表

| 我想做的事 | 用哪个入口 |
|---|---|
| 加一条 reminder，只这一次 LLM call 看到 | `additionalContext` |
| 加一条 reminder，所有后续 turn 都看到 | `ctx.appendMessage({ role: "user", content: "..." })` |
| Session 开始前预置一条 user message（取代用户的 prompt） | `initialUserMessage`（仅 SessionStart） |
| 把 tool args 里的敏感信息脱敏 | `onPreToolUse → updatedInput` |
| 把 tool result 截断到 4KB | `onPostToolUse → updatedToolOutput` |
| Per-question 动态改写 system prompt | `transformSystemPromptBeforeLlm` |
| 拦截一次 tool call 并告诉 LLM 为什么 | `onPreToolUse → { decision: "deny", reason: "..." }` |

## 5. 五个完整示例

### 5.1 Staleness reminder（additionalContext）

场景：检测到外部文件被改动，下次 LLM call 加 reminder。

```ts
import type { Hook } from "@harness-pi/core";

export function fileStaleness(opts: { watch: string[] }): Hook {
  const mtimes = new Map<string, number>();

  return {
    name: "file-staleness",

    async onSessionStart(_input, _ctx) {
      // 初始化 mtime 快照
      for (const path of opts.watch) {
        mtimes.set(path, statSync(path).mtimeMs);
      }
    },

    async onTurnStart(_input, _ctx) {
      const changed: string[] = [];
      for (const path of opts.watch) {
        const cur = statSync(path).mtimeMs;
        if (cur !== mtimes.get(path)) {
          changed.push(path);
          mtimes.set(path, cur);
        }
      }
      if (changed.length === 0) return;
      return {
        additionalContext: `<system-reminder>The following files were modified externally since the last turn:\n${changed.map(p => `- ${p}`).join("\n")}\nRe-read them if relevant to your current work.</system-reminder>`,
      };
    },
  };
}
```

**效果**：LLM 下次 call 在 messages 末尾看到一个 attachment message 含这段 reminder。不进 `session.messages`，下次 turn 文件没变就不加。

### 5.2 Lease conflict（decision + reason）

场景：bidding-agent 的 lease 冲突拦截。

```ts
import type { Hook, HookContext } from "@harness-pi/core";

export function leaseDecision(opts: {
  currentLeaseQuestionId: () => string | null;
  onConflict?: (call, reason) => void;
}): Hook {
  return {
    name: "lease-decision",

    onPreToolUse(input, _ctx) {
      const argQid = (input.call.arguments as any)?.questionId;
      const leaseQid = opts.currentLeaseQuestionId();
      if (!leaseQid || !argQid || argQid === leaseQid) return;

      const reason = `tool ${input.call.name} used stale questionId ${argQid}; current lease is ${leaseQid}`;
      opts.onConflict?.(input.call, reason);
      return {
        decision: "deny",
        reason,
        // 还能同时给 LLM 一段 transient context 解释拦截
        additionalContext: `<system-reminder>Tool call to ${input.call.name} was rejected: ${reason}. Process the currently leased question first.</system-reminder>`,
      };
    },
  };
}
```

**效果**：tool 不执行，LLM 看到一个 toolResult 含拒绝原因 + 一条 attachment 解释。

### 5.3 Per-question system prompt swap（transformSystemPromptBeforeLlm）

场景：bidding-agent 的 `setSystemPrompt` per-question 重写。

```ts
import type { Hook, HookContext } from "@harness-pi/core";

export function questionContextInjector(opts: {
  getCurrentQuestion: (ctx: HookContext) => { id: string; text: string } | null;
}): Hook {
  return {
    name: "question-context",

    transformSystemPromptBeforeLlm(prompt, ctx) {
      const q = opts.getCurrentQuestion(ctx);
      if (!q) return;

      return `${prompt}\n\n## 当前处理的问题\n\nID: ${q.id}\n\n${q.text}`;
    },
  };
}
```

**效果**：每次 LLM call 的 system prompt 都是基础 prompt + 当前问题。不动 `session.messages`，不影响 cache prefix（cache key 算 system prompt + messages 整体，system prompt 改了 cache 也会变——这是问题，需要权衡）。

如果要保 cache，可以反过来：system prompt 保持稳定，当前问题走 `additionalContext` 放到 messages 末尾。

### 5.4 Tool args 注入（updatedInput）

场景：所有 tool call 自动注入 questionId（避免 LLM 漏传）。

```ts
import type { Hook } from "@harness-pi/core";

export function autoInjectQuestionId(opts: {
  getCurrentQuestionId: () => string | null;
  targetTools: string[];
}): Hook {
  return {
    name: "auto-inject-question-id",

    onPreToolUse(input, _ctx) {
      if (!opts.targetTools.includes(input.call.name)) return;
      const qid = opts.getCurrentQuestionId();
      if (!qid) return;
      if ((input.call.arguments as any).questionId === qid) return;

      return {
        updatedInput: { ...input.call.arguments, questionId: qid },
      };
    },
  };
}
```

**效果**：所有目标 tool 的 args 自动带 `questionId`，validateToolCall 看到的是改后的。

### 5.5 Tool result 截断（updatedToolOutput）

场景：tool 返回 10MB 输出会撑爆 context；截断到 4KB。

```ts
import type { Hook } from "@harness-pi/core";

const MAX_BYTES = 4 * 1024;

export function toolResultTruncator(): Hook {
  return {
    name: "tool-result-truncator",

    onPostToolUse(input, _ctx) {
      const text = input.result.content
        .filter(c => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
      if (text.length <= MAX_BYTES) return;

      const head = text.slice(0, MAX_BYTES);
      return {
        updatedToolOutput: {
          ...input.result,
          content: [
            { type: "text", text: head + `\n\n[truncated: showing ${MAX_BYTES} of ${text.length} bytes]` },
            // 保留 image content 不截
            ...input.result.content.filter(c => c.type !== "text"),
          ],
        },
        systemMessage: `Truncated tool ${input.call.name} output from ${text.length} → ${MAX_BYTES} bytes`,
      };
    },
  };
}
```

**效果**：进 `session.messages` 的是截断后的 toolResult；用户 console 会看到 systemMessage 提示。

### 5.6 Persistent injection（ctx.appendMessage）

场景：外部事件触发（用户点击审批），把审批结果作为一条 user message 入 session。

```ts
// 这不是 hook，是外部代码主动调 session：
const ctx = session.getHookContext();  // kernel 暴露 getter
ctx.appendMessage({
  role: "user",
  content: `[approval] User approved action ${actionId}`,
});

// 下次 turn 的 LLM call 会看到这条新 user message
// session.messages 永久保留
```

或者在某个 hook 里：

```ts
onPostToolUse(input, ctx) {
  if (input.call.name === "submit_for_approval") {
    // 异步等待审批，到了就 push
    waitForApproval(input.result).then(decision => {
      ctx.appendMessage({
        role: "user",
        content: `[external] approval decision: ${decision}`,
      });
    });
  }
}
```

注意 `appendMessage` 是同步 push，但**当前 turn 正在跑的 LLM call 不会看到新 message**（已经发出去了）。下次 turn 才看到。

## 6. 通过 tool 返回值注入 (`newMessages`)

借鉴 Claude Code `ToolResult.newMessages`（`Tool.ts:322`）。Tool 在执行成功后可以返回额外 message 一起入 conversation：

```ts
const judgeQuestionTool: HarnessTool = {
  name: "judge_question",
  // ...
  async execute(args, ctx, signal) {
    const result = await persistJudgment(args);
    const batchCount = (ctx.state.get("batch-counter.count") as number) ?? 0;

    return {
      content: [{ type: "text", text: JSON.stringify({ ok: true, judgment: args.judgment }) }],
      // ✨ 额外追加一条 user message，让 LLM 看到批次状态
      newMessages: batchCount >= 7 ? [
        createUserMessage("[system] 已完成 8 题，请收尾本批次。"),
      ] : undefined,
    };
  },
};
```

kernel 处理顺序：

```
tool.execute() → ToolExecResult { content, newMessages }
                       ↓
[PostToolUse hook 派发，可改 updatedToolOutput]
                       ↓
push toolResult message 到 session.messages
                       ↓
if newMessages: 逐条 push 到 session.messages
```

### 6.1 跟 `additionalContext` 的区别 ⚠️

|  | `additionalContext`（hook） | `newMessages`（tool） |
|---|---|---|
| 触发方 | plugin | tool 自己 |
| 持久化 | ❌ transient | ✅ persistent |
| 进 `session.messages` | ❌ | ✅ |
| 序列化 / 恢复时还原 | ❌ | ✅ |
| 谁能用 | 任何 plugin 在多种 hook 里 | 仅 tool 在 execute 返回值里 |

### 6.2 什么时候用 `newMessages`

✅ **适合**：
- 附加 message 是 tool 输出**语义的一部分**（不是 cross-cutting concern）
- 想让"附加 message"跟 toolResult 一起被序列化、重启时还原
- 例：`run_bash` 跑了一个交互式命令，附加用户提示"按 q 退出"

❌ **不适合（请改用 hook `additionalContext`）**：
- 跨多个工具 / 跨整个 session 的提醒（如"已用 80% 预算"）
- 由全局状态决定的注入（如 staleness / lease 冲突）
- 用户配置的 reminder 模板

**默认偏好**：能用 hook 就用 hook。只有当注入语义跟 tool 强耦合（"这条 message 离开了这个 tool 就没意义"）才用 `newMessages`。

### 6.3 跟其他注入入口的对照表（更新版）

| # | 入口 | 哪个 hook 用 | 持久化进 `session.messages`？ | 作用对象 |
|---|---|---|---|---|
| 1 | `additionalContext: string` | 所有 event / decision hook | ❌ transient | 拼成 attachment message |
| 2 | `initialUserMessage: string` | 仅 `onSessionStart` | ✅ persistent | 作为初始 user message |
| 3 | `updatedInput: Record` | 仅 `onPreToolUse` | N/A | 改 tool args |
| 4 | `updatedToolOutput: ToolExecResult` | 仅 `onPostToolUse` | ✅ | 改 tool result |
| 5 | `transformSystemPromptBeforeLlm` | 独立 transform | ❌（每 turn 重算） | 改 system prompt |
| 6 | `ctx.appendMessage(msg)` | 任意 hook 内部 | ✅ persistent | push 任意 message |
| 7 | **`ToolResult.newMessages`** | **tool execute 返回值** | **✅ persistent** | **tool 后追加 message** |

`HookResult.systemMessage` 不在这张表——它**不进 messages**，仅 emit 给 console，详见 [02-kernel §3.2a](02-kernel.md#32a-systemmessage-边界过滤)。

---

## 7. 跟 hook 形态的对应关系

| Hook 形态 | 能用的注入字段 |
|---|---|
| Event (`on*`) | `additionalContext`, `systemMessage`, `initialUserMessage`(仅 SessionStart) |
| Decision (`onPreToolUse`) | `decision`, `reason`, `updatedInput`, `additionalContext`, `stopReason`, `continue` |
| Decision (`onUserPromptSubmit`) | `decision`, `additionalContext`, `continue`, `stopReason` |
| Transform pipe (`transformSystemPromptBeforeLlm`) | 直接返回 string（不走 envelope） |
| Around (`wrapTurn`, `wrapToolExec`) | 无返回值；要注入用 `ctx.appendMessage` 或在 next() 后改 result |
| Event (`onPostToolUse`) | `updatedToolOutput`, `additionalContext`, `systemMessage` |

无效字段 dispatcher 忽略（dev mode 可以 warn）。

## 8. 序列化语义

| 注入入口 | `JSON.stringify(session.messages)` 带不带？ |
|---|---|
| `additionalContext` | ❌ 不带（不进 session.messages） |
| `initialUserMessage` | ✅ 带（push 进 session.messages） |
| `updatedInput` | ✅（改后的 args 写进 assistant message 的 toolCall.arguments；本身 pi-ai 序列化时带） |
| `updatedToolOutput` | ✅（改后的 result push 进 session.messages） |
| `transformSystemPromptBeforeLlm` 改后的 prompt | ❌ 不带（session.systemPrompt 本身不存改写历史） |
| `ctx.appendMessage` | ✅ 带 |
| **`ToolResult.newMessages`** | **✅ 带（push 进 session.messages）** |
| `HookResult.systemMessage` | ❌ 永不带（不进 messages） |

**含义**：恢复 session 时，transient 部分（reminder / dynamic system prompt / systemMessage）会消失；hook 重新跑会自己决定要不要再加。这是设计目的。

## 9. 常见反模式

### 9.1 ❌ 用 `additionalContext` 注入完整 RAG 结果

```ts
// ❌ 一次注入 50KB context，cache 失效、token 飙升
return { additionalContext: ragSearch(query) };  // 50KB
```

**为什么不行**：每 turn 都会跑 hook，每次 50KB 全量注入，cache hit 也救不了（attachment 在 messages 末尾，不在 cache prefix）。

**怎么办**：让 LLM 自己用 tool 拉 RAG 结果，或者只注入"提示有可用 RAG，请使用 X tool"，不直接塞结果。

### 9.2 ❌ 频繁修改 system prompt

```ts
// ❌ 每 turn 都改一次 system prompt，prefix cache 永远不 hit
transformSystemPromptBeforeLlm(prompt, ctx) {
  return prompt + `\n\nTurn ${ctx.turnIdx} at ${Date.now()}`;
}
```

**为什么不行**：DashScope / OpenAI prefix cache 要求 system prompt 字节稳定。每 turn 改 = 每 turn miss cache。

**怎么办**：动态 context 走 `additionalContext`（放在 messages 末尾），system prompt 保持稳定。

### 9.3 ❌ 在 `onPostToolUse` 改 args

```ts
// ❌ args 已经被 execute 用掉了，改没用
onPostToolUse(input, ctx) {
  return { updatedInput: { ... } };  // dispatcher 忽略，无效字段
}
```

**为什么不行**：`updatedInput` 仅 `onPreToolUse` 有效。execute 已经发生了。

**怎么办**：要改入参用 `onPreToolUse`；要改返回值用 `updatedToolOutput`。

### 9.4 ❌ Plugin 之间用 `additionalContext` 通信

```ts
// ❌ 别这样：
// Plugin A:
onTurnStart(_, ctx) { return { additionalContext: "secret data" }; }
// Plugin B:
onPreToolUse(input, ctx) {
  const secret = parseFromMessages(ctx.messages);  // 从 attachment 里抠 plugin A 的数据
}
```

**为什么不行**：`additionalContext` 是给 LLM 看的，不是 plugin 间通信渠道。LLM 会看到 "secret data" 莫名其妙。

**怎么办**：plugin 协作走 `ctx.state.set()` / `ctx.state.get()`。

## 10. 下一步

- [02-kernel §3 消息管理](02-kernel.md#3-消息管理) —— `pendingAttachments` 在 kernel 主循环里怎么处理
- [03-hook-system §4 HookResult envelope](03-hook-system.md#4-hookresult-返回-envelope) —— 各字段的语义
- [05-plugins](05-plugins.md) —— 实际 plugin 用这些注入入口的例子
