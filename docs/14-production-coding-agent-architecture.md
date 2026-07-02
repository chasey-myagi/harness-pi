# 14 · 生产级 coding-agent 架构设计（headless 硬化 × 装配地基 × 安全纵深 × 交付形态）

> **状态**：Design。本文回答一个问题：**一个 headless、无人值守、跑在别人 repo 里的 coding-agent，凭什么敢让它自主改代码并开 PR。**
> **与 [11-coding-agent-product-roadmap](11-coding-agent-product-roadmap.md) 的分工**：docs/11 回答"缺哪些**能力**（MCP/web/todo/git/LSP…）"；本文回答"怎么把能力**硬化成敢上生产的东西**"——是结构与防护问题，不是能力清单。docs/11 已裁决的能力优先级、三层职责表、non-goals 全部维持，本文不翻案。
> **与 [13-architecture-deep-dive-verdicts](13-architecture-deep-dive-verdicts.md) 的咬合**：本文的运行时护栏依赖内核 #127（R1 坏历史）/#133（R3 退避）；server 形态依赖 R5 fencing；质量门排在迁移 spike #138 前后两半。
> **研究方式**：3 路并行深挖（现状解剖 / pi-coding-agent 对标 / 三硬骨头设计），先实读源码、结论挂 file:line、只出方案。file:line 基于当次快照，随代码演进可能漂移。

## 0. 定位判断：生产级 = headless 优先，不是更肥的 TUI

仓库证据（harness-pi 服务端定位、docs/11 目标原文"**后端**·CLI"、bidding 迁移主线、lark-bot 服务形态、SWE-bench 无人值守管线）指向同一结论：**交互 CLI 手感已接近对齐 Claude Code，真正的空白是 headless 形态**。而现状是倒置的：

> **防护与无人值守程度成反比。** TUI 全副武装（permissionGate + JSONL 落盘 + strictPersistence + compactSummarize，`cli.ts:225-260`）；而 headless one-shot 不挂门、不落盘、无 watchdog、无 tokenBudget（`cli.ts:225-238` 注释明说 one-shot/readline 无弹窗不挂门）——`hpi "task"` 等价 `--yolo` 裸跑 host bash。越接近生产形态防护越少，与"后端优先"定位正好倒置。

**"生产级"的操作定义** = headless 形态获得与 TUI 同级、甚至更强的防护 + 声明式可配置装配 + 可被第三个 app（bidding worker）复用的装配地基——**而不是再堆 TUI 功能**。

## 1. 总纲：一个架构反转 + 一句对标

**架构反转：能力不再由 mode 隐式决定，mode 退化为纯 transport。** 现状 `args.tui` 这一个布尔隐式决定了权限、落盘、compaction 全套能力，这是下列多个差距的共同病根。生产级架构把三件事解耦：

```
装配（AgentFeatures 声明式）× 防护（policy，按信任等级不按 mode）× 交付形态（TUI/one-shot/REPL/RPC，只管渲染与 transport）
```

**对标结论**：pi-coding-agent（0.80.3）证明了"SDK 薄壳 + 四态进程 + JSONL RPC"是单机 coding-agent 的正确骨架。harness-pi 不需要再造骨架——它的内核天生有 pi 缺的内脏：decision hook 真拦截、双轨事件、strictPersistence、controller 编排。**把壳补上，hpi 就是"pi 的骨架 + 生产级的内脏"。**

## 2. 现状架构性差距（不是能力清单，是结构问题）

按严重度排序，证据均实读：

| 编号 | 差距 | 证据 | 坏结果 | 严重度 |
|---|---|---|---|---|
| G1 | 防护与无人值守程度成反比 | `cli.ts:225-238`（one-shot 不挂门/不落盘）；runtime 仅一行 stderr 警告兜底 | headless 裸跑 host bash，崩了不可恢复、跑飞无上限 | 高 |
| G2 | 装配 god-function + mode 隐式决定能力 | `buildAgentContext()` 215 行单函数（`agent.ts:295-510`），加一能力改四处；hooks 顺序铁律只活在注释（`agent.ts:378-379`） | 每次扩展改四处、易漏、顺序错就 compaction/trim 打架 | 高 |
| G3 | 配置面缺层 | `config.ts` 仅 provider onboarding；无 `.hpi.json`/profile/覆盖序 | 四来源只有 flag+env 且互相独立，撑不起 profile 化 | 高 |
| G4 | 跨 app 装配重复、presets 触发条件已满足 | lark-bot 字面复制 `createPiAiCostModel`、`resolveModel` 语义分叉（严格 throw vs 容错 fallback） | 两个消费者在抄同一份、第三个（bidding）在路上；分叉是 bug 温床 | 中 |
| G5 | session 治理缺失 | sessionId=文件名即全部治理（`cli.ts:55-57`）；resume 存储全文不脱敏（`README:85`） | 无 list/GC/配额；服务形态多租户/合规不可接受 | 中（headless 前置） |
| G6 | 事件渲染双头 | `TuiAction` 已 domain-free（`event-bridge.ts:18-24`），但 headless 走 `output.ts` 另一套 | 加 WS/HTTP transport 会出第三套 | 中低 |
| G7 | 编排能力被 TUI 绑架 | `/goal`/`/multi` 入口只有 TUI slash（`app.ts:428-557`），hook 组合在 agent 层本可复用 | headless 拿不到 goal/multi——恰是无人值守最需要的 | 中低 |

## 3. 架构蓝图：六个设计块

### 3.1 装配地基：`AgentFeatures` + app 内 SDK 化（解 G2/G3/G4）

- 落地 docs/11 Phase 0 的 `AgentFeatures` 声明式装配 + 四层配置链（默认 ← `.hpi.json` ← flag ← env），用 TypeBox 校验配置（上游 settings 无 schema 校验、字段拼错静默 undefined 是反面教材，工具 schema 已在用 TypeBox、零新依赖）。
- 把装配抽成可 import 的 `createCodingSession(features)`（app 内 sdk.ts，上游 P11 "SDK-first 薄壳"模式）——RPC/TUI/server 都是它的消费者，嵌入方不用 fork CLI。hooks 组合顺序铁律从注释提升为装配器内的显式约束。
- **presets 触发条件已满足**：观测四件套（sessionLog+metrics+costTracker+toolStats）先升 hook-set recipe，按 docs/11 §4 既定阶梯（2 个消费者抄同一份 → 升 `@harness-pi/presets`）走；`resolveModel` 语义分叉先在 recipe 层统一。

### 3.2 防护基线反转（P0，最优先）

headless/one-shot **默认挂** tokenBudget（硬帽 abort）+ watchdog + costTracker + permissionGate（policy 模式），`--yolo` 仅在"调用方已在容器里"时允许（SWE-bench 场景）。permissionGate 的 ask 在无人值守下变为**策略自动决 + 审计**，不是静默全放行。

**这是任何 headless 自主运行的裸命门槛，也是内核 #138 spike 的前置**——#138 的 7 条验证清单本身要在真 provider 上烧钱跑，没有护栏就是拿钱验证"会不会烧钱"。依赖 #127（坏历史不再进重试循环）/#133（限流不雪崩）先行。

### 3.3 安全纵深：三层都要，缺 OS 沙箱就是假安全

现状 `bash` 是裸 host shell（`tools/src/index.ts:290,819` 直接 `spawn(command,{shell:true})`），read/edit/write 靠 `resolveToolPath` 钉 cwd（`:235` 等）**但 bash 完全绕过**；唯一防护 `safeShellEnv()` 只脱密钥、不挡文件破坏与外联（`:882-887`）。三个崩法：prompt injection → `curl|sh` 任意执行、越界写 `~/.ssh`、数据外联 `curl -d @.env`。

分层纵深防御（明确反对"只做 permissionGate 字符串审批"——`bash("python -c ...")` 即绕过，是筛子不是墙）：

- **咽喉点现在就钉死**：`BashToolOptions.operations.exec` 注入口（`tools/src/index.ts:85-91`）是唯一安全接缝。**接缝先于实现**——文档与 API 层面写明"默认 `defaultExec` 仅供 trusted 环境；生产必须经此注入沙箱化 exec"。否则将来有人绕过它加 tool，沙箱就漏了。
- **`sandboxCapability`**（薄版，docs/11 §13.1 既定）：mac `sandbox-exec` seatbelt / linux `bwrap`+seccomp+landlock 生成的 exec 实现注入 bash tool，文件写钉 cwd、网络默认关。能力 opt-in（给了就沙箱、没给同现状，不破坏"本来就在容器里"的 SWE-bench 场景）。~500-800 LOC，不改 tool 不改内核。
- **permissionGate 降级定位**：只负责**降低审批噪音**（allowlist + 会话缓存 + 目录信任），不作为安全边界。
- **Project Trust 信任门**（当前真实安全缺口）：hpi 已接 skills 却无信任门，clone 恶意仓库 = 任意代码执行 + prompt 注入（上游 `trust-manager.ts:29-37` 的 canonical-path 信任库、未信任则项目层配置不加载）。项目层资源（skills/配置/SYSTEM.md 类）加载前过信任门，headless 用显式 `trustOverride`。**优先级随 skills 同档**。
- **工具危险度元数据**（`isReadOnly/isDestructive/isOpenWorld`，docs/08 2.3）：持久权限规则与沙箱策略都需要它做分类判据；给 7 个第一方工具补声明，是 permissionGate policy 化的前置。
- **容器/worktree 是 server 形态的外层兜底**（部署责任，非仓库代码），与上述叠加。

### 3.4 交付形态：第四态 RPC + 审批协议先行 + 事件单管线（解 G6/G7）

- **`hpi --mode rpc`**：JSONL stdin/stdout 命令协议（prompt/steer/abort/fork/compact/get_state），**不是 HTTP server**——进程生命周期=会话生命周期、无鉴权面、天然多租隔离。命令到内核原语的映射几乎现成（`run()`/`steer()`/`runStreaming()` 双轨事件/`forkSession`/compaction 控制器）。这是 hpi 从"参考实现"变"可嵌入产品"的最短路径。**它是交付形态不是能力**，docs/11 矩阵没有这项。协议类型独立成模块给嵌入方 import（上游 wire type 直接绑内部 session-manager 类型是反面教材）。
- **transport-neutral 审批通道**：把 permissionGate 的 askUser 抽象成请求-响应协议，TUI 对话框 / RPC 消息往返 / headless policy 自动决三选一注入。**协议是一等公民，TUI 只是一种渲染器**（上游 Extension 直接 import 终端组件 `@earendil-works/pi-tui` 是反面教材）。这是 docs/11"持久权限 P2"的前置——否则持久规则做了也只在 TUI 可用。
- **事件渲染收口成单管线**：`TuiAction` 已是 domain-free 中间表示，统一为"SessionEvent/LiveEvent → 中间动作 → 各 transport 渲染器"，消灭 headless `output.ts` 双头、堵住 RPC 第三套。顺手完成 one-shot 的 NDJSON stdout 契约 + output-guard（接管 stdout 防野 `console.log` 打碎 JSONL 协议 + 背压）。
- **编排入口去 TUI 化**：`/goal`/`/multi` 的 hook 组合抽到 app 层可复用入口，headless 也能用（无人值守最需要"有目标自续跑"和 fan-out）。

### 3.5 部署形态：现在不建 server，只坐实两个契约

隔离边界**只能切在进程/容器，不能切在进程内**（bash 无法进程内约束跨任务）。所以 server 的正确形态是"CLI 与 server 分包，server = 无状态编排层 + 每任务一次性隔离 worker（复用 one-shot CLI 子进程）"，队列语义直接复用 leaseQueue（item = 一次 worker 调用）。

**但现在是 YAGNI**——只坐实 one-shot 的两个契约：① turn 上限 flag（现状靠 subprocess timeout 硬杀是个坑）；② LiveEvent NDJSON 出 stdout（transport pump 最小形态）。**触发条件 = 第一个真实 issue→PR bot 需求或第二个并发多 repo 场景**；届时才建 server 分包 + fencing-aware store（内核 R5 的 vNext 项）。在此之前批量跑（SWE-bench）用"外部 orchestrator + 多个 one-shot 子进程"已够。

### 3.6 质量门：三层按时间尺度分离，与 #138 前后排序

"生产级"= 能回答"这次自主改动敢不敢合"。三层各管一个时间尺度：

- **运行时护栏（每 run，同步硬帽）**：tokenBudget 硬帽 + watchdog + costTracker，超预算/超时主动 abort 并标终态。**#138 之前必须到位**（先有帽子再烧钱验证）。
- **健康度信号（每 run，派生标签）**：从 `RunSummary`（reason/abortReason/usage）+ metrics 算出 `clean`/`degraded`/`suspect`——done 还是 max_turns？重试几次？cache 命中率？悬空 toolCall 扫描（复用 R1 修复逻辑）过没过？决定 PR 自动合还是挂 human-review label。**阈值等 #138 真实数据标定，不拍脑袋。**
- **抽样 eval（人触发/夜间 cron，非 PR 门）**：把 `swe-bench-eval.md` 手工管线固化成脚本，跑 Verified-mini-50，报 resolved / empty-patch / error 三率 vs 基线 delta。**不进 PR 门**（数小时 + $10-15/次 + flaky，当 PR 门会瘫痪开发）。全量 Lite-80（#117）排在 #138 之后。

metrics dashboard 口径也要以"run 健康度"为一等维度：done-rate / 平均重试次数 / cache 命中率 / p95 cost per resolved——不是"发了多少 event"。

## 4. 三条贯穿性硬约束

1. **安全接缝先于安全实现**：`sandboxCapability` 可以晚做，但"bash `exec` 是唯一安全咽喉点"这个约束现在就要在文档和 API 上钉死。
2. **护栏先于烧钱**：运行时护栏是 server 并发和 #138 真 provider 验证的共同前置。护栏不到位，后两者都是拿钱验证"会不会失控"。
3. **隔离切在进程/容器，不切在进程内**：bash 无法进程内约束——"多租户隔离"和"不可信执行隔离"都只能靠外层 worker/容器。这条决定了 server 必须是分包 + 一次性 worker，而不是进程内多模式。

## 5. 落地顺序（与内核三工作包衔接）

1. **现在（#138 之前，与内核 #127/#133 同期并行）**：防护反转包（headless 默认护栏 + policy 化 permissionGate + 工具危险度元数据）+ 装配地基（AgentFeatures/config 分层/SDK 化/observability recipe）。
2. **紧随（成为可嵌入产品）**：事件单管线 + transport-neutral 审批协议 + RPC 第四态 + bash exec 咽喉点文档钉死 + sandboxCapability 薄版 + project trust + session 版本号。
3. **需求拉动（不预建）**：server 分包（触发：真实 bot 需求）、eval 回归门 dashboard 化（触发：#138 数据标定）、rewind UX（**注意：它很可能是内核议题① `BranchableSessionStore` 候选 B 的第一个触发者**——真做时走既定 B 路径，不自造）。

## 6. 不做清单（与"做"同权重）

| 不做 | 理由 | 触发条件 |
|---|---|---|
| 现在建 server | 无真实 bot 需求，进程内多租是伪隔离 | 第一个 issue→PR bot 或第二个并发多 repo |
| HTTP server 形态 | JSONL stdio 无鉴权面、天然隔离，更简单 | RPC stdio 撑不住的规模证据 |
| 字符串审批当安全边界 | `bash("python -c …")` 即绕过，是筛子 | —（结构性否决） |
| PR-blocking eval 门 | 数小时/$10-15/flaky，会瘫痪开发 | —（改用夜间/人触发） |
| 进程内沙箱进 tools 包 | tools 保持 domain-free；沙箱是注入 exec 口的 capability | —（结构性否决） |
| mergeCapabilities / preset 函数化 | docs/11 §5 已裁决先走 recipe | 第 3 个消费者且装配显著趋同 |
| OAuth / 账号计费 / 资源包 / themes | BYO-key 定位、服务端不需要 | — |
| 上游模块级单例 / all-or-nothing 信任 | 多 session server 形态全是隐患 | —（结构性否决，任何件都显式构造注入） |

顺手修正：docs/08 的 2.8（deferred/searchHint）状态已事实完成应标 done；docs/08 有 5 条"core 视角 skip"在 app 视角该翻案（6.1 permission 系统、2.3 工具危险度、2.2 bash 取消语义、3.4 structuredOutput、4.2 Task 子集）——最后 2.2/2.3/6.1 互为前置。

## 7. 落地追踪

对应 GitHub issues 建立后在此回填编号。本文档是设计的权威沉淀；issue 与本文冲突时以更新时间新者为准，并回改另一方。
