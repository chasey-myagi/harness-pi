# 02 · Kernel

> `AgentSession` 的 API 表面、完整 loop 算法、消息管理、错误处理、HookContext 生命周期、内存管理。

## 1. AgentSession API

```ts
export interface AgentSessionOptions {
  model: Model<any>;                 // pi-ai 的 Model
  tools: HarnessTool[];              // pi-ai Tool + execute()
  systemPrompt?: string;             // 初始 system prompt（可被 hook 改写）
  hooks?: Hook[];                    // 构造时一次性注册
  maxTurns?: number;                 // 防失控硬上限，默认 200
  initialMessages?: Message[];       // 续跑时传入（如 watchdog restart）
}

export interface RunSummary {
  turns: number;                     // 实际跑了多少 turn
  reason: "done" | "max_turns" | "aborted" | "error";
  error?: Error;                     // reason === "error" 时填
  abortReason?: string;              // reason === "aborted" 时填
}

export class AgentSession {
  readonly id: string;               // session UUID
  readonly messages: ReadonlyArray<Message>;  // 当前 conversation；只读引用

  constructor(options: AgentSessionOptions);

  /** 后期挂 hook（构造时也可经 options.hooks）。返回 this 用于链式。 */
  use(hook: Hook): this;

  /** 追加 user prompt，跑到 done / aborted / max_turns。 */
  run(prompt: string, opts?: { signal?: AbortSignal }): Promise<RunSummary>;

  /** 不追加新消息，从当前 messages 继续（watchdog restart / 外部续跑用）。 */
  continue(opts?: { signal?: AbortSignal }): Promise<RunSummary>;

  /** 主动停。当前 turn 走完即退出；硬中断走 AbortSignal。 */
  abort(reason?: string): void;

  /** 序列化 / 持久化 / 调试用 */
  snapshot(): SessionSnapshot;
}
```

`HarnessTool` 在 [types.ts](../packages/core/src/types.ts) 定义，是 pi-ai `Tool` 的扩展：

```ts
export interface HarnessTool extends Tool {
  /** 执行函数。kernel 在 validateToolCall 通过后调用。 */
  execute(
    args: Record<string, unknown>,
    ctx: HookContext,         // tool 也能读 ctx.state
    signal: AbortSignal,
  ): Promise<ToolExecResult>;

  /** UI 显示用（debug、log）；默认 name */
  label?: string;

  /**
   * 旧名字别名（向后兼容工具改名）。LLM 学过老名字时，老 toolCall.name 也能匹配。
   * 借鉴 Claude Code `Tool.aliases`。
   */
  aliases?: string[];

  /**
   * 本次 tool 调用是否可以跟同 turn 其他 concurrency-safe 工具**并行执行**。
   * 默认 false（保守）。借鉴 Claude Code `Tool.isConcurrencySafe`。详见 §2.3。
   */
  isConcurrencySafe?(input: Record<string, unknown>): boolean;
}
```

`ToolExecResult` 含可选 `newMessages` 字段，允许 tool 往 conversation 追加额外 message。
属于**高级用法**——大多数 plugin 应优先用 hook 的 `additionalContext` 注入；只有当一个"附加 message" 是 tool 输出语义的一部分（如 "完成后追加一条说明"）才用 `newMessages`。详见 [04-context-injection §6](04-context-injection.md#6-通过-tool-返回值注入-newmessages)。

## 2. Loop 算法（完整伪代码）

```
async run(prompt):
  ctx = new HookContext(this)
  outcome = await dispatcher.fireEvent("onSessionStart", { prompt }, ctx)
  if outcome.continue === false:
    return { turns: 0, reason: "aborted", abortReason: outcome.stopReason }

  // 应用 SessionStart 的注入
  for each result in outcome.results:
    if result.initialUserMessage:
      this.messages.push({ role: "user", content: result.initialUserMessage })
    if result.additionalContext:
      pendingAttachments.push(makeAttachment(result.additionalContext, "SessionStart"))

  this.messages.push({ role: "user", content: prompt })

  for turnIdx in 0..maxTurns:
    if ctx.signal.aborted: break with reason="aborted"
    ctx.turnIdx = turnIdx
    await dispatcher.fireEvent("onTurnStart", { turnIdx }, ctx)

    // Around chain 包裹 turn 主体
    await dispatcher.runAround("wrapTurn", ctx, async () => {

      // ─────────── 1. 准备 LLM 输入 ───────────
      sysPrompt   = await dispatcher.firePipe("transformSystemPromptBeforeLlm", this.systemPrompt, ctx)
      // pendingAttachments 在这里以 attachment-style user message 拼进 messages
      msgsForLlm  = applyPendingAttachments([...this.messages], pendingAttachments)
      pendingAttachments.length = 0

      // ─────────── 2. UserPromptSubmit（如本 turn 第一条是 user message） ───────────
      lastMsg = msgsForLlm[msgsForLlm.length - 1]
      if lastMsg.role === "user" && turnIdx === 0:
        subOutcome = await dispatcher.fireEvent("onUserPromptSubmit", { userMessage: lastMsg }, ctx)
        // 类似 SessionStart 处理：additionalContext 拼成 attachment
        msgsForLlm = applyHookResults(msgsForLlm, subOutcome.results)

      // ─────────── 3. LLM call ───────────
      t0 = now()
      try:
        stream = piAi.stream(this.model, { systemPrompt: sysPrompt, messages: msgsForLlm, tools: this.tools }, { signal: ctx.signal })
        assistant = await consumeStream(stream)
      catch err:
        await dispatcher.fireEvent("onError", { phase: "llm", err }, ctx)
        throw  // bubble out, settled by outer try in run()

      llmDurationMs = now() - t0
      llmOutcome = await dispatcher.fireEvent("onLlmEnd", { msg: assistant, durationMs: llmDurationMs }, ctx)
      this.messages.push(assistant)

      // ─────────── 4. 工具执行（含并行优化）───────────
      toolCalls = assistant.content.filter(b => b.type === "toolCall")
      toolResults = []

      // 4.0 把 toolCalls 按 isConcurrencySafe 分两批
      // 注意：findToolByName 要走 aliases 匹配
      safeBatch    = []
      sequential   = []
      for call in toolCalls:
        tool = findToolByName(this.tools, call.name)  // 含 aliases
        safe = !!tool?.isConcurrencySafe?.(call.arguments)
        (safe ? safeBatch : sequential).push(call)

      // 单个 call 执行的子流程（4a-4d）封装成函数
      async function executeOne(call):
        if ctx.signal.aborted: return null  // 跳过
        // 4a. PreToolUse decision（顺序 short-circuit）
        decision = await dispatcher.fireDecision("onPreToolUse", { call }, ctx)
        if decision?.decision === "deny":
          result = { content: [{type:"text", text: decision.reason ?? "denied"}], isError: true }
          return { call, result }
        args = decision?.updatedInput ?? call.arguments
        // 4b. 校验
        try:
          validated = piAi.validateToolCall(this.tools, {...call, arguments: args})
        catch err:
          result = { content: [{type:"text", text: err.message}], isError: true }
          await dispatcher.fireEvent("onError", { phase: "tool", err, call }, ctx)
          return { call, result }
        // 4c. 执行（around chain 包裹）
        try:
          tool = findToolByName(this.tools, call.name)
          t1 = now()
          rawResult = await dispatcher.runAround("wrapToolExec", { call, ctx }, async () => {
            return await tool.execute(validated, ctx, ctx.signal)
          })
          toolDurationMs = now() - t1
        catch err:
          rawResult = { content: [{type:"text", text: err.message}], isError: true }
          await dispatcher.fireEvent("onError", { phase: "tool", err, call }, ctx)
        // 4d. PostToolUse: event + transform
        postOutcome = await dispatcher.fireEvent("onPostToolUse", { call, result: rawResult, durationMs: toolDurationMs }, ctx)
        finalResult = postOutcome.lastUpdatedToolOutput ?? rawResult
        return { call, result: finalResult }

      // 4e. safe 批并行执行
      safeResults = await Promise.all(safeBatch.map(executeOne))
      // 4f. unsafe 批顺序执行
      seqResults = []
      for call in sequential:
        if ctx.signal.aborted: break
        seqResults.push(await executeOne(call))

      // 4g. 按 toolCalls **原顺序** push 进 messages（保证 toolCall ↔ toolResult 顺序匹配）
      orderedResults = mergeByOrder(toolCalls, safeResults, seqResults)
      for {call, result} in orderedResults:
        this.messages.push(toolResultMsg(call.id, result))
        // 4h. ⚠️ 处理 ToolResult.newMessages —— tool 主动追加的额外 message
        if result.newMessages:
          for msg in result.newMessages:
            this.messages.push(msg)
        toolResults.push(result)

      // ─────────── 5. Turn end ───────────
      await dispatcher.fireEvent("onTurnEnd", { assistantMessage: assistant, toolResults }, ctx)
    })

    // 决定要不要再来一轮
    if ctx.signal.aborted: reason = "aborted"; break
    if assistant.stopReason !== "toolUse": reason = "done"; break
    if pendingExternalAbort: reason = "aborted"; break
  else:
    reason = "max_turns"

  await dispatcher.fireEvent("onSessionEnd", { turns: turnIdx+1, reason }, ctx)
  return { turns: turnIdx+1, reason }
```

注意几个**关键的执行点**：

1. **`onSessionStart`** 在第一条 user message **入 messages 之前** 触发——SessionStart hook 可以注入 `initialUserMessage` 取代或先于 prompt
2. **`onUserPromptSubmit`** 在 LLM call 之前触发，hook 可以 deny prompt 或注入 `additionalContext`
3. **`wrapTurn`** 包整个 turn 主体（含 LLM call + 所有 tool call + turn 内 event）
4. **`onPreToolUse`** 在 `validateToolCall` **之前** 触发，能改 args（让校验过那个改后的）
5. **`wrapToolExec`** 只包 tool.execute()，不包 PreToolUse / PostToolUse
6. **`onPostToolUse`** 在 tool result push 到 messages **之前** 触发，hook 可以改 result
7. **`onTurnEnd`** 是 turn 收尾的最后一个 hook，可以 abort
8. **`ToolResult.newMessages`** 在 toolResult **之后** 追加到 messages（同步 push，不重新触发 hook）

详细的执行策略（并行 vs 顺序）见 [03-hook-system §执行模型](03-hook-system.md#3-执行模型按-hook-形态分).

### 2.3 同 turn 多 tool 并行执行（基于 `isConcurrencySafe`）

借鉴 Claude Code Tool.ts:402 的 `isConcurrencySafe`。当一次 assistant message 含多个 toolCall 时：

1. **分组**：按 `tool.isConcurrencySafe?.(call.arguments)` 把 calls 分两批
   - `safe` 批：满足函数返回 `true`
   - `sequential` 批：默认（函数缺省 / 返回 false / 抛错）
2. **并行 safe 批**：`Promise.all(safeBatch.map(executeOne))`
3. **顺序 sequential 批**：`for...of` await 一个一个跑
4. **按原顺序 push 进 messages**：保证 toolCall ↔ toolResult 在 conversation 里顺序匹配（pi-ai 严格要求）

**性能收益**：bidding-agent 单 turn 多 `submit_evidence`（按不同 questionId）/ 多 `kb_search`，并行能省一截 wall-clock。

**hook 派发不变**：每个 call 仍然各自跑 PreToolUse → execute → PostToolUse 全链路；并行的只是 `tool.execute()` 本身。

**`ctx.state` 写竞态**：并行 hook 同时写 `ctx.state` 同一个 key 会 race。约定：concurrency-safe 工具的 plugin 协作通过**不同 key**或**幂等聚合**避免冲突。例如 metrics plugin 走 push-to-queue（sink 自己 sequence），不直接 mutate ctx.state 计数器。

**默认值的选择**：保守地默认 `false`（不并行）。tool 作者明确知道安全才声明 `true`。例：
- ✅ safe：`Read` / `Grep` / `kb_search` / `WebSearch`
- ❌ unsafe（默认）：写文件 / 改 ctx.state 同一 key / bash 命令

### 2.4 `aliases` —— 工具改名向后兼容

`findToolByName(tools, name)` 内部按以下顺序匹配：

1. `tool.name === name`
2. `tool.aliases?.includes(name)`

LLM 学过旧名字、给新版工具加 aliases，旧 toolCall 仍能路由到新 execute。bidding-agent 改过几次工具名（v1 → v2 参数），这种向后兼容能省迁移痛苦。

## 3. 消息管理

### 3.1 `session.messages` 的语义

- **只追加，不修改**：kernel 永远只 `push`，从不 `splice` 或就地改既有 message
- **持久化**：所有 push 到 messages 的内容都是 conversation 真实历史，序列化时全部带上
- **对外只读**：`AgentSession.messages` 返回 `ReadonlyArray`；要改要走 hook 或 `appendMessage`

### 3.2 Transient vs Persistent 注入

| 注入路径 | 进 `session.messages`？ | LLM 看见？ |
|---|---|---|
| `transformMessagesBeforeLlm` 返回新数组 | ❌ | ✅（仅本次 call） |
| `additionalContext` 字符串 | ❌（包成 attachment，本次 call 拼进 msgsForLlm） | ✅ |
| `ctx.appendMessage(msg)` | ✅ | ✅（下次 call） |
| `initialUserMessage`（SessionStart 专用） | ✅（push 到 messages） | ✅ |
| `ToolResult.newMessages` | ✅（紧跟 toolResult 之后入 session.messages） | ✅（下次 call） |
| `HookResult.systemMessage` | ❌ **永不进 messages**（仅 emit 给 console / consoleSink） | ❌ |

详见 [04-context-injection](04-context-injection.md)。

### 3.2a `systemMessage` 边界过滤

`HookResult.systemMessage` 是给**用户 / log / console** 看的，**永远不发给 LLM**。

实现层面：kernel 把所有 hook 返回的 `systemMessage` 串成数组，通过一个独立的 `onSystemMessage(msg, ctx)` 回调 emit（默认实现：`console.log`）。**绝不**进 `session.messages` 或 `pendingAttachments`。

借鉴 Claude Code Tool.ts:207 的 `appendSystemMessage` —— 他们用 `Exclude<SystemMessage, SystemLocalCommandMessage>` 在类型层 enforce 这个边界。我们用约定 + 单独 sink 通道实现。

### 3.3 `pendingAttachments` 的生命周期

`pendingAttachments` 是 turn 边界内的 transient buffer。

- SessionStart hook、UserPromptSubmit hook 返回的 `additionalContext` 进 `pendingAttachments`
- 进入 LLM call 前，`applyPendingAttachments(messages, pendingAttachments)` 把这些 attachment 拼进 `msgsForLlm`（仅这次 call 看到）
- 拼完即清空

**关键**：attachment 不进 `session.messages`，因此：
- 序列化时不带（重启时不还原 transient context）
- 下次 turn 重新跑 hook 决定是否再注入

这跟 Claude Code 的 `createAttachmentMessage` 模式一致，详见 [04-context-injection §3](04-context-injection.md#3-attachment-message-模式)。

## 4. AbortSignal 传播

```
caller AbortSignal (run(opts.signal))
       │
       ↓ 合成 chain
       ↓ 通过 ctx.signal 暴露
       ↓ 传给 pi-ai stream({signal})
       ↓ 传给 tool.execute(args, ctx, signal)
       ↓ 传给每个 hook（hook 可选用，多用于带超时的工作）
```

`abort()` 方法的语义：**当前 turn 走完才退出，不打断 LLM stream**。要硬打断走 caller 的 AbortSignal。

为什么这么设计：
- 直接 abort LLM stream 会丢失已生成的部分（pi-ai 的 partial 内容也丢）
- 直接 abort tool 可能让外部资源处于不一致状态（写到一半的文件、未 commit 的 DB transaction）
- 让 plugin 自己决定要不要在 around hook 里 abort（如 watchdog 用 `ctx.signal` 硬中断超时的 turn）

## 5. 错误处理

### 5.1 错误分类

| 错误来源 | 处理 | 影响 |
|---|---|---|
| **Tool throw** | catch → `{ isError: true, content: [err.message] }` 作为 toolResult 回灌 | 当前 tool 失败，不影响 turn，LLM 看见错误自己决定怎么办 |
| **Tool args validation 失败** | 同上 | 同上 |
| **LLM call throw**（network / auth / context overflow） | `onError(phase="llm")` + 重新 throw | turn 失败，run() 返回 `reason="error"` |
| **Hook throw** | catch → `onError(phase="hook", hookName)` + 记 metric + **继续**（fail-open） | 单个 plugin 挂不影响 session |
| **Hook timeout** | cancel → 记 `outcome="cancelled"` + 继续（fail-open） | 同上 |
| **`ctx.signal.aborted`** | 当前 turn 走完即退，`reason="aborted"` | 外部主动停 |

### 5.2 fail-open vs fail-closed 的选择

**默认 fail-open**：hook 挂了 → 继续。理由：

- 一个坏 plugin 不该整死 session
- production 稳定性优先于"严格保证 plugin 运行"
- 失败有 metric 上报，用户能发现

**例外：Decision hook 不强制 fail-open**——如果用户的 lease-decision hook 挂了，是 deny 还是 allow？

我们的选择：**fail-open**（按 allow 处理）。理由：deny 是少数路径，allow 是常态；hook 挂了应该让 session 继续而不是阻塞。

但 plugin 作者可以在 `try/catch` 里自己决定——比如：

```ts
onPreToolUse(call, ctx) {
  try {
    return checkLease(call);
  } catch (err) {
    // 我宁愿 deny 也不让坏 lease 状态把 call 放过去
    return { decision: "deny", reason: "lease check failed: " + err.message };
  }
}
```

### 5.3 `onError` hook 的语义

```ts
onError?(input: { phase: "llm" | "tool" | "hook"; err: Error; call?: ToolCall; hookName?: string }, ctx): void | Promise<void>;
```

- 只用于 **观察**，不能改流程
- 不返回 `decision` / `continue` 等字段
- 重做错误恢复请用 `wrapTurn` / `wrapToolExec`

## 6. `maxTurns` 默认 200

为什么 200：
- bidding-agent 实测单 session 处理 100+ 题
- 余量 2x，触发 = 实质 bug（不是容量不够）
- 防 LLM 死循环不停调 tool

触发时 `RunSummary.reason === "max_turns"`，用户能看到日志。

## 7. HookContext 生命周期

`HookContext` 是 session 级单例，在 `new AgentSession()` 时创建（但 `run()` 时才 attach signal）。生命周期跟 session 等长。

```ts
class HookContext {
  readonly sessionId: string;         // UUID
  turnIdx: number;                    // kernel 每 turn 更新
  signal: AbortSignal;                // 每次 run() 时合成
  readonly state: Map<string, unknown>;  // plugin 协作总线
  readonly messages: ReadonlyArray<Message>;  // 引用 session.messages

  // 持久化注入（push 到 session.messages）
  appendMessage(msg: Message): void;

  // 主动 abort 当前 session（当前 turn 走完后退）
  abort(reason: string): void;

  // 内部事件总线（极少用，详见 03-hook-system §10）
  emit(event: { type: string; [k: string]: unknown }): void;
}
```

**`ctx.state`** 是 plugin 之间的共享黑板：

- 约定 key 前缀（`"watchdog.lastActivityTs"`）防撞名
- 类型不安全（`Map<string, unknown>`）——用户自行 cast
- session 结束 GC，不持久化

详见 [05-plugins §ctx.state 约定](05-plugins.md#3-ctxstate-约定).

## 8. 内存管理

### 8.1 messages 数组永不 evict

Kernel 不主动 trim `session.messages`。理由：
- conversation 真实历史的语义不能由 kernel 决定
- plugin（`trim-history`）可以通过 `transformMessagesBeforeLlm` 让 LLM **看到**精简版，但 `session.messages` 留全份
- 用户要做 compaction 自己写 plugin

### 8.2 长 session 的内存开销

```
N turn × M tool call/turn × K bytes tool result
+ N turn × ~5KB assistant message
+ images base64
```

10 turn × 5 tool × 50KB ≈ 2.5MB / session。100 个并发 session ≈ 250MB。可接受。

要节约：plugin 在 `transformMessagesBeforeLlm` 里把 tool result 内容替换成占位符（保留 toolCallId / toolName 元数据），LLM 看不到老内容但 messages 数组里还在。

### 8.3 ctx.state 不会 GC

`ctx.state` 跟 session 等长。plugin 如果往里塞大对象（如完整 PDF 渲染图）要小心——session 不结束就不释放。

建议：plugin 把 cache 放在 `ctx.state` 时带 TTL 或上限，参考 `tool-output-buffer`（见 [05-plugins](05-plugins.md)）。

## 9. 微妙点清单

整理 bidding-agent 一年踩坑 + Claude Code 注释里的"血泪"，归纳成 kernel 必须注意的微妙点：

1. **HookContext 共享**：整个 session 共用一个实例。`turnIdx` 由 kernel 在 turn 边界更新。不要每次 hook call 新建 ctx。

2. **`appendMessage` 时机**：往 `this.messages` 推。如果在 turn 进行中调用，下次 `transformMessagesBeforeLlm` 看得到（因为 messages 是引用）。但不会插队当前正在跑的 LLM call。

3. **`ctx.abort()` 语义**：当前 turn 走完才退出，不打断 LLM stream。要硬中断走外部 `AbortSignal`。

4. **Hook 抛错绝不破坏 session**：catch + log + `onError(phase="hook")` + 继续。绝不让一个坏 plugin 拖垮整个 session。

5. **Hook timeout 兜底**：每个 hook 都有 timeout（默认按形态 100-500ms）。timeout = fail-open（视为不发表意见 / 不改值）。

6. **Stream 消费要全部 await**：参照 pi-ai README 100-150 行；要处理 `text_delta` / `thinking_delta` / `toolcall_delta` / `done` / `error`。漏 event 会让 partial JSON tool args 没收完就开始执行 → 工具收到不完整参数。

7. **`stopReason` 检查时机**：`stopReason !== "toolUse"` 时结束循环——含 `"stop"` / `"length"` / `"error"` / `"aborted"`。"length"（context 满）也是结束信号。

8. **Aborted message 仍要 append**：pi-ai 的 abort 会返回带 `stopReason: "aborted"` 的 partial AssistantMessage，必须 push 到 messages（否则 cross-provider handoff 时丢失上下文）。

9. **Multi-tool 同 turn**：一个 assistant message 可能含 N 个 toolCall。**逐个执行**，每个都要 push 一个对应的 toolResult。pi-ai 要求 toolCall / toolResult 严格配对。

10. **AbortController 链**：caller 的 signal、kernel 自己合成的 signal、watchdog plugin 起的 timer——三者要 link 成一条 chain。建议用 `AbortSignal.any([s1, s2, s3])`（Node 20+ 支持）。

11. **`session.snapshot()` 不导出 hook**：序列化时只导 messages / model 标识 / `ctx.state` 的可序列化键。hook 实例本身不导（恢复时需要重新挂）。

12. **TS strict null checks**：所有 hook 返回值都是 `T | void | Promise<T | void>`——caller 必须先 check non-null。

## 10. 验收 4 条（再列一遍）

1. `examples/01-bare-kernel`：5 行注册，跑通一个**零 hook**的最简 agent
2. `examples/02-with-plugins`：watchdog + metrics + log + buffer + trim 五个 plugin 同时挂，跑通 happy path
3. `grep -rE '"question"|"evidence"|"judgment"' packages/core/src/` 必须为空
4. **第三方 agent**：用 harness-pi 写一个跟 bidding-agent 完全无关的 agent，不需要给 core 加任何 feature

第 4 条没过之前 **API 不冻结**。

## 10a. Helper exports

Kernel 导出几个常用 message 构造 helper，避免 plugin / controller / 业务代码各自手写。借鉴 Claude Code `utils/messages.ts` 的 `createUserMessage` / `createAttachmentMessage` 模式。

```ts
// @harness-pi/core 导出
export function createUserMessage(content: string | Content[]): Message;

export function createAttachmentMessage(opts: {
  type: "hook_additional_context" | "tool_result_overflow" | (string & {});
  content: string;
  hookName?: string;
  hookEvent?: string;
}): Message;
```

**`createAttachmentMessage` 物理形态**：

- `role: "user"` —— 跨 provider handoff 时被原样保留（pi-ai 注释承诺）
- `content`：纯 text，里面包 `<system-reminder>...</system-reminder>` 或类似 wrap（由 plugin 决定）
- `_meta`：harness-pi 自定义字段，kernel 内部识别（用于 transcript 渲染、序列化时区分），**pi-ai 不会发给 LLM**

**为什么不复用 `toolResult` 形态**：toolResult 必须配对 toolCall，伪造 toolCallId 在某些 provider 上会报错；user message 跨 provider 最稳。

未来若加更多 helper（如 `createSystemMessage` / `createInterruptionMessage`），按需补充。

---

## 11. 实现路径

按 [roadmap Phase 1](roadmap.md#phase-1--kernel-跑通) 走。预计 LOC：

- `session.ts` 250-300 行
- `dispatcher.ts` 100-150 行
- `context.ts` 50 行
- `hook.ts` 200 行（类型，无逻辑）
- `types.ts` 50 行
- `index.ts` 10 行
- **小计 ~700 行**

测试 ~800 行。
