# 15 · Donor manifest：搬什么到 sage

> 本仓的身份由 [#207](https://github.com/chasey-myagi/harness-pi/issues/207) 拍板 D 定死：**参考实现 / 取材源（donor），不进任何下游的依赖树**。新内核在 [chasey-myagi/sage](https://github.com/chasey-myagi/sage) 重写，内核只有 **Log**（append-only 事实账本）与 **View seam**（从 Log 投影出模型这一 turn 看到的东西）两个原语，provider 适配自写，不再依赖 `@earendil-works/pi-ai`。
>
> 这份文档回答一个问题：**从这里搬什么到那边，每一条按什么形态搬。** 判定依据是 [#178](https://github.com/chasey-myagi/harness-pi/issues/178) 的盘点表与各源文件的文件头契约；行数为当前 `dev` 实测（不含 `__tests__`）。

## 0. 怎么读这份清单

每条有三个字段：

- **形态**——搬代码还是搬概念。三档：`整体搬`（换几个类型别名即可编译）/ `搬骨架`（结构照抄，内部实现重写）/ `搬概念`（只搬不变量与取舍，代码不要）/ `不搬`。
- **对 pi-ai 的耦合**——这是形态判定的主要依据。`type-only` 耦合换几个类型别名就断；`适配层`换 SDK 即作废。
- **为什么**——它解决的是哪个问题。搬过去之后如果答不出这一句，就别搬。

一条纪律：**`不搬` 的条目和 `整体搬` 的同等重要。** 把 pi-ai 适配层搬过去，等于把要甩掉的那层黑盒原样背走。

## 1. 按文件搬

| 文件 / 包 | 行数 | 对 pi-ai 的耦合 | 形态 | 为什么 |
|---|---|---|---|---|
| `packages/core/src/hook.ts` | 668 | type-only（`Message` / `Tool` / `ToolCall` / `Usage` / `AssistantMessage` 五个类型别名） | **整体搬** | hook 协议本体：四形态 + 统一 envelope + `ToolExecResult`。换掉那五个别名即可编译 |
| `packages/core/src/dispatcher.ts` | 655 | type-only | **整体搬** | 四形态各自的执行策略（并行 / 顺序短路 / 顺序 pipe / 洋葱嵌套）、timeout、fail-open 与 fail-closed 的分叉点 |
| `packages/core/src/context.ts` | 248 | type-only | **整体搬** | `HookContext` 的生命周期与 `TypedStateMap`；跨 plugin 协作的唯一合法通道 |
| `packages/core/src/session-store.ts` | 171 | type-only（`Message`） | **整体搬** | append-only + lineage + leaf pointer 的协议本体，`compaction_boundary` 是一等 entry。落盘实现下沉 adapter，内核零文件 / 零 `pg` 依赖 |
| `packages/core/src/session.ts` | 1652 | **运行时**依赖 pi-ai `stream()` | **搬骨架** | 编排结构可抄：三段式 phase、`TurnOutcome` 4 态、`RunSummary` 5 态、steer 安全点 drain、`_messages` append-only + HWM 不变量。**LLM 调用那段必须重写**——sage 的 View seam 正取代它 |
| `packages/core/src/tool-executor.ts` | 264 | type-only | **搬骨架** | 单 tool chokepoint：连续 `isConcurrencySafe` 的并行、unsafe 调用是屏障、`execute` throw → `isError` result 循环继续 |
| `packages/core/src/types.ts` | 172 | type-only | **搬骨架** | `HarnessTool` 的形状（含危险度元数据，见 §2） |
| `packages/core/src/llm-model.ts` | 187 | **适配层** | **不搬** | pi-ai 模型目录的薄封装，换 SDK 即作废 |
| `packages/core/src/context-overflow.ts` | 77 | **适配层** | **不搬** | 按 pi-ai 的 provider 错误形状识别 overflow，换 SDK 即作废 |
| `packages/core/src/testing.ts` | 410 | **适配层** | **不搬**（重写同名能力） | `createFakeModel` 按 pi-ai 的 `stream()` 契约造假。能力必须有，代码不要——sage 的 fake 要按 Log + View seam 造 |
| `packages/tools` | 1595 | **0 处引用** | **整体搬** | 七个第一方工具（read / bash / edit / write / grep / find / ls）+ 路径安全 + 截断。近乎逐行可搬 |
| `packages/adapters` | 667 | **0 处引用** | **整体搬** | NDJSON / Postgres session store、event pump、WebSocket sink。Postgres 那份把 lineage 推进写成单条 data-modifying CTE，不留半成功数据 |
| `packages/plugins` | 5898 | 9 处引用，8 处 `import type`（唯一的值引用是 `sub-agent-tool.ts` 的 `Type`） | **搬概念** | 值钱的是不变量与取舍，不是代码——逐条见 §3 |
| `packages/transcript` | — | — | **不搬** | 内核事件契约镜像，绑死本仓的事件形状。真正该搬的是它的收尾教训：**「声称一个完备的覆盖边界」本身就是缺陷**（#153） |

### 1.1 `packages/tools` 里两条具体的

- **路径安全（`path-utils.ts`，129 行）**：`resolveToolPath` 做 **realpath 双查**——`realpathSync.native(cwd)` 与目标路径上最近的已存在祖先各解析一次，再比前缀。只比字符串前缀挡不住符号链接逃逸，只解析目标挡不住 cwd 本身是链接。这套逐行搬。
- **截断（`truncate.ts`，188 行）**：head / tail / 行内三种截断策略 + `estimateReadTokens`，截断信息进 `ToolExecResult.details` 而不是混进 LLM 可见文本。这条契约（**非模型文本元数据走 `details`**）比截断算法本身值钱。

## 2. 按概念搬：三个最该原样保留的设计决断

这三条来自 #178 的结论，都是「当初可以选别的、选错了会疼很久」的决断。

### 2.1 hook 统一返回 envelope

四种形态（event `on*` / decision `onPreToolUse`·`onUserPromptSubmit` / transform `transform*` / around `wrap*`）**共用一个返回 envelope**，而不是每个 hook 点定义一套返回类型。

- **解决什么**：加一个 hook 点不需要改协议，也不需要让每个 plugin 作者学一套新的返回形状。
- **不这么做会怎样**：hook 点数量一多，返回类型就长成一片各自为政的联合类型，dispatcher 里全是 per-point 的特判。
- **搬过去注意**：envelope 的字段要按**输出型**语义收敛（`additionalContext` / `systemMessage` / `decision` / `updatedInput` / `continue`），形态决定哪些字段被读——event 形态返回 `decision` 应当被忽略而不是静默生效。

### 2.2 decision hook 的 `failClosed` + `critical` 注册期硬校验

- `failClosed`：decision hook 求值抛错或超时时，内核当 **deny** 处理，宁可错杀。默认 fail-open 的是普通 hook，**权限判定必须反过来**。
- `critical`：依赖关系在**注册期**硬校验（`verifyHookDependencies`），而不是等运行时才发现某个前置 hook 没挂。
- **解决什么**：安全闸门的失败模式必须是「拦住」，且「闸门没装上」要在启动时就报，不能变成一个静默放行的运行时分支。
- `permissionGate` 默认 `critical: true` + `failClosed: true` 就是这条的落地。

### 2.3 around hook 不套 timeout，改用协作式 abort

around（`wrap*`）hook 是洋葱嵌套的，早注册在外层。它**不套 timeout**——超时不是从外面把里面剁掉，而是传播 abort signal 让被包的那层自己收尾。

- **解决什么**：硬 timeout 会在任意一行代码中间截断，留下半截状态（写了一半的 store entry、拿了没还的 lease）。
- **配套的不变量**：`LeaseQueue` / `WorkPool` 的「abort 必给终态」——abort 时残留的 item / group 统一 finalize 成 `skipped` 并触发回调，保证 `completed + failed + conflicted + skipped === total`，不让 work item 静默消失。
- **搬过去注意**：单个 `AbortController`，caller 传入的 `signal` 与 `ctx.abort` 共用同一个，不要造第二个。

## 3. `packages/plugins`：搬概念不搬代码的 9 条

代码不搬（它们的签名绑死本仓的 hook 形态），搬的是每条的**不变量**和**取舍**。

### 3.1 microcompact 的 `keepRecent`

tool-result 级的廉价分档清理：不调 LLM、不总结，只把「旧的、可重取的」白名单工具输出换成短占位符（原文仍由 store durable 保存，模型真需要可以重新调工具）。

- **`keepRecent` 是核心**：永远保留**最近 N 条** toolResult 原文不动（默认 5）。cache 友好，且不破坏模型对近况的感知。
- **触发是有条件的**：按 token 体积超阈值触发，清到 `targetTokens` 即停，不是无条件按条数机械裁剪；可选 `gapMinutes`（cache 已冷）作为第二触发源。
- **顺序契约**：排在总结型压缩**之前**——先廉价清掉可重取的，再让昂贵的总结据清理后的真实 view 决定要不要花钱。
- **view-only**：只改本 turn 发给模型的 view（copy-on-write），绝不写回历史。sage 的 View seam 天然就是这个语义，这条应该从「插件纪律」升级成「内核保证」。

### 3.2 prefix-shape 的预测 / 实测对账

prompt-cache 前缀诊断：每次 LLM call 前 canonicalize 出 durable prefix（model/provider 标识 + system + tools schema）、算稳定 hash、与上一 turn 比，变了就分类原因（`model_or_provider_changed` / `system_prompt_changed` / `tool_schema_changed` / `provider_options_changed` / `stable`）。

- **值钱的是对账那一半**：在 `onLlmEnd` 用真实 `usage.cacheRead` 跟上面的预测对照，把诊断从「猜」变成「可证伪」。只报预测不对账的诊断没有价值。
- **诚实口径要一起搬**：prefix 稳定只是命中的**必要非充分**条件（history 增长本身会让公共前缀之后的后缀 miss），`stable` 不等于该 100% 命中。
- **本仓的两处盲区正是 sage 要消掉的**（#160）：system 指纹取的是构造期 pre-pipe base，看不到每 turn 改写的增量；provider options 内核不经 hook 暴露。在 Log + View seam 下，「这一 turn 实际发出去的 view」是一等对象，指纹应当直接对它取——盲区消失。

### 3.3 deferredTools 的 listing-only

一部分工具标成 deferred：默认**不进模型看到的 tool listing**，被激活（典型由 `toolSearch` 命中后写入激活集）才在**下一 turn** 出现。

- **纯 listing 收窄，不碰 execution**：deferred 工具始终在工具全集里，一旦被调用照常走查找 / 校验 / 权限闸。这条边界是整个设计成立的原因——收窄可见面不等于收窄能力面，不会造出「模型看不见所以我也不检查」的假安全。
- **已知的一 turn 滞后要写进文档而不是修**：token 估算读到的是上一 turn 写入的激活子集，turn-0 退回全集（保守高估，安全侧）。

### 3.4 subAgentTool 的纵横两闸

模型驱动的子代理原语——就是一个普通工具，复用一个 session 跑子任务、把结果回灌给父模型；**不是**顶层 meta-agent。

- **横向闸 `maxSubAgents`**（默认 8）：单层扇出上限，防一层里失控派发。
- **纵向闸 `maxDepth`**（默认 2）：跨层递归深度，靠一个透传 state key 逐层 +1。
- **两闸正交**，缺一条都会漏：只有横向闸挡不住「每层只派一个但嵌 50 层」。
- **domain-free**：工厂不认识任何业务概念，子任务怎么跑全在调用方注入的 `sessionFactory` 里；父 session 的 abort signal 透传给子（协作式取消，呼应 §2.3）。

### 3.5 postCompactFileReread 的 bounded 重读

压缩把早期消息（含文件的完整内容）压成一条 summary 后，模型 view 里只剩摘要描述，还可能已经过时。这条在压缩发生的**下一个 turn 开始**时，从最近消息里收集被引用过的文件路径，取**当前**内容注入。

- **bounded 是要点**：`maxFiles`（默认 5）+ 每文件 `maxBytes`（默认 8192），避免把刚省下的 token 又灌回去。
- **只重读一次**：压缩插件 set 一个 pending 标记，本插件下一 turn 消费并清除。不做成每 turn 重复注入。
- **路径解析由调用方注入**：内核不认识 `read` 工具长什么样；返回 `null` = 跳过（已删除 / 越权 / 不该重读）。
- **单挂它而不挂压缩 = 纯 no-op**，标记永不被 set。这种「缺前置时退化成零行为」的写法值得照搬。

### 3.6 LeaseQueue

单 item lease 模型：K 个 worker 各持一个 lease，处理完领下一个。适合 item 完成时间分布极不均的场景。

- **abort 必给终态**：残留（从未派发 / abort 时回退）的 item 在 `start()` 末尾统一 finalize 成 `skipped` 并触发回调，`completed + failed + conflicted + skipped === totalItems`。
- **per-attempt 指数退避**（`initialDelayMs` / `factor` / `maxDelayMs`，opt-in）：无退避的重试遇上 provider 限流就是重试风暴（#133）。
- **并发安全前提要跟着搬**：依赖单线程 event loop——取任务的 `shift()` / `splice()` 与 length 检查之间**禁止插入 await**。换到有真并发的运行时，这条不成立，要换成别的互斥。

### 3.7 WorkPool

把 N 个 work item 静态分组后并行跑到 K 个 session（每 group 一个 worker 跑完）。

- **跟 LeaseQueue 是一对取舍，不是二选一的冗余**：静态分组适合 item 耗时均匀、分组本身有语义（如按章节）的场景；动态领单适合耗时分布长尾。两个都留着，让调用方按分布选。
- 同样的 **abort 必给终态**：未启动的 group 进结果集标 `skipped: "aborted"` 并触发回调。

### 3.8 session-log 的 NDJSON

每个 session 一份 NDJSON 日志，复盘 / 调试 / 重放用。

- **backpressure 要处理**：`stream.write` 返 `false` 时不再 enqueue，避免 burst 写入 OOM；stream close / error 后置 `dead`，后续 write 直接丢并记 `deadReason`，不去等一个不可能到达的 drain。
- **脱敏是注入的，不是内置的**：库层默认不脱敏（保持通用），`redactToolArgs` 由消费者注入。
- **一条踩过的坑要一起搬**：session log 脱敏了，**resume 存储没有**——它为了能正确重放必须存完整原文。两份落盘的敏感度不同，别用同一套心智模型对待。

### 3.9 permissionGate 的 policy 思路

一组 `pattern → allow/ask/deny` 规则，**首条命中者胜出**，无命中走 `fallback`（默认 **deny**）。

- **机制 vs 策略**：插件只给规则引擎骨架，规则里的 domain 判定由调用方以 `match` 谓词提供。插件不认识任何业务概念。
- **`ask` 不是内核概念**：内核 decision 只有 allow / deny。`ask` 由 `onAsk` 解析器（可 async，比如 RPC 问人）落成 allow / deny；没给解析器时 `ask` → deny。
- **诚实边界必须跟着搬**：**字符串审批是筛子不是墙**（`bash("python -c …")` 即绕过）。它只降噪，不设安全边界；真边界在 OS 沙箱。把这条写进新仓的第一版文档，不要等第一次事故。

## 4. 不搬的，和为什么

| 不搬 | 理由 |
|---|---|
| `llm-model.ts` / `context-overflow.ts` / `testing.ts`（674 行） | pi-ai 适配层。换 SDK 即作废——搬它等于把要甩掉的那层原样背走 |
| `session.ts` 的 LLM 调用段 | 直接建在 pi-ai `stream()` 上。sage 的 View seam 正是取代它的那一层 |
| `packages/plugins` 的代码 | 签名绑死本仓 hook 形态。搬 §3 的 9 条概念，代码重写 |
| `packages/transcript` | 事件契约镜像，绑死本仓事件形状 |
| `/goal` 机制（PR #104、#111 的 v2 重设计） | 不进新设计（#207） |
| 本仓的 CI / 门禁配置 | 规模与形态不对口；新仓按自己的成熟度重建 |

## 5. 本仓从这里开始只做什么

- **卫生**：文档不撒谎（状态段指向 #207 的结论）、模板、注释。
- **取材文档**：就是这一份。
- **不做**：任何实现型工作。`docs/01`–`docs/14` 正文按 #182 的纪律保持「等于当前代码」，不因为新仓的设计去改本仓的契约文档。

路线收口见 [roadmap](roadmap.md)。
