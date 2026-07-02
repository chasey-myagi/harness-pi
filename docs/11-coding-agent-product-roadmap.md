# 11 · Coding Agent 产品化设计报告

> **状态**：Design — 把 `apps/coding-agent` 从 "dogfood / harness 参考实现" 推向 "可媲美 Claude Code / Codex 的后端·CLI coding agent" 的总纲。
> **配套**：本文是总纲；每个能力（Capability/plugin）另有一份独立设计文档，见 §7 与 `docs/caps/`。
> **姊妹篇**：本文回答"缺哪些**能力**"；[14-production-coding-agent-architecture](14-production-coding-agent-architecture.md) 回答"怎么把能力**硬化成敢上生产的东西**"（headless 防护反转、装配地基、安全纵深、RPC 交付形态）。两文互不重复：能力优先级看本文，结构与防护看 14。
> **前置**：先读 `00-overview` / `01-architecture` / `03-hook-system` / `05-plugins` / `06-controllers`。

---

## 0. 摘要

**论点**：harness-pi 的 **运行时/loop 层已经达到产品档**（streaming、审批、steering、resume、compaction、goal、并行 sub-agent、cost、护栏），真正缺的是 **coding agent 的"能力面"**（MCP、代码智能、补丁式编辑、git/checkpoint、检索、后台执行、todo、sub-agent 管理、web）和 **配置化装配 + 文档驱动的开发模式**。

**目标边界**：做到在 **agentic loop + 核心能力面** 上媲美 cc/codex；**不追** IDE 插件、账号/计费、托管沙箱（沙箱靠外层隔离，见 §3）。

**核心方法**：
1. **三层分工**：内核只给机制、插件给能力、app 用**配置开关**装配（"我们有能力，用不用是用户的事；开发者可用内置、也可替换，但有参考"）。
2. **能力以三种形态交付**：tool pack / hook+tool Capability / hook-set recipe（§4）。
3. **文档驱动开发**：每个能力先写设计文档 → TDD 垂直切片 → review-gate 三审 → 标成熟度（§7）。

---

## 1. 现状盘点（已经做了多少）

### 已强：运行时/loop 层（与 cc/codex 同档）
- 多 provider（pi-ai ~24 家）、模型自动探测、`.env`
- TUI / headless one-shot / REPL 三形态；token 流式 + thinking
- 工具审批门（`permissionGate`）、mid-run steering、Esc 取消
- 崩溃恢复 resume（每 turn 落盘 + `strictPersistence`）
- compaction（`/compact` 手动 + `--compact` 自动）、`/goal` 循环、`/multi` 并行只读 sub-agent
- 护栏：`emptyRunGuard` / `repeatedCallGuard`；观测：`sessionLog` / `metrics` / `costTracker` / `toolStats`
- 安全：cwd 边界、`.harness-pi` gitignore 告警、bash env 脱密钥、log 脱敏
- 测试重（约一半 LOC 是测试）

### 薄/缺
- **工具面只有 7 个第一方工具**（read/bash/edit/write/grep/find/ls）
- **controllers 零使用**；`subAgentTool`/`SubAgentRegistry` 已存在但 app 未接、且无 model-facing 管理面
- **无 todo/plan、无 MCP、无 web、无后台执行、无代码智能、无补丁式编辑、无 git/checkpoint、无检索/记忆**
- `config.ts` 仅 provider onboarding——**没有功能开关层**
- 约 11/23 插件被 app 用到；`watchdog`（一个跑 shell 的 agent 居然没装看门狗）、`autoCompaction`、`postCompactFileReread`、`deferredTools+toolSearch+skills` 都未接

---

## 2. 设计原则：谁决定什么（三层）

| 层 | 职责 | 决定权 | 红线 |
|---|---|---|---|
| **L2 内核 `core`** | 跑 loop + 派发 hook + 安全派发 | 零功能、零意见 | 不加 feature、不加 DB/frontend、不内置策略 |
| **L3 插件 `plugins`/`tools`/adapters** | **能力**住这里（opt-in） | "我们有这个能力" | 能力之间不强耦合、走接口 + peerDep |
| **App `coding-agent`** | **配置驱动装配** | "用不用是用户/开发者的事" | 既是产品、又是**参考实现** |

> **极简内核 ≠ 没功能**。它=**能力 opt-in（在 L3）+ 配置驱动（在 app）+ 给开发者可复制/可替换的参考**。内核保持极简，能力是否暴露、是否启用全在外层。

---

## 3. 差距分析：对标 cc/codex 还缺什么

### A. 能力面（最大缺口）
| 缺口 | 现状 | 目标形态 | 追/不追 |
|---|---|---|---|
| MCP 客户端 | ❌ | 新 `@harness-pi/mcp` adapter + tool pack | **追**（一接全是工具，table-stakes） |
| 代码智能 / LSP | ❌ | tool pack（诊断/定义/引用） | **追**（中后期） |
| 补丁式编辑（multi-edit / apply_patch） | ⚠️ 仅单处唯一串替换 | tool | **追** |
| Web（fetch/search） | ❌ | `webTools` pack | **追** |
| 后台执行（bg bash + poll + kill） | ⚠️ 仅同步 | hook+tool Capability | **追** |
| sub-agent 管理（spawn/list/continue/cancel） | ⚠️ 基建有、未接、无管理面 | tool + 外置 registry | **追**（差异化） |
| 检索 / 记忆 | ❌ | Capability（轻量文件版） | 追（中后期） |
| **沙箱隔离** | ❌ bash=host shell | **薄 `sandboxCapability`（mac=seatbelt / linux=bwrap）+ 外层 worker 兜重型** | **追薄版**（决策已修订，见 §13） |

### B. 工作流可信度
- ❌ git 集成（diff/commit/PR/**checkpoint 回滚**）——有崩溃 resume，无"撤销我的修改"
- ❌ 自验证闭环默认未接（有 `turnEndGuard`/`subAgentTool` 零件，未拼成 maker-verifier 默认）
- ⚠️ 权限只有 allow-once（无持久 allow/deny/目录信任）
- ❌ todo/plan（无 checklist → 长任务 drift）

### C. 产品层
- ❌ 配置文件/profile、IDE 插件、Web UI、更新机制
- ⚠️ **system prompt 仅 3 行占位**——真产品需一套调过的 coding agent 准则
- ⚠️ BYO-API-key（开发者工具 OK，非托管产品）→ **不追账号/计费**

> **媲美 cc/codex 的定义**：在 **agentic loop + 核心能力面（A）+ 工作流可信度（B）** 上对齐；**产品层（C）只补"开发者可用"的部分**（配置、tuned prompt），不做 IDE/账号。

---

## 4. 能力清单与形态（每个能力"以什么方式"做）

**三种形态 + controller 单列**（依据 `03-hook-system` 排序语义与 `06-controllers` 边界）：

- **Tool 包**（无排序语义，最安全）：`codingTools`[已有] · `webTools` · `mcpTools`
- **hook+tool Capability**（单一功能、自包含、自管 `ctx.state` key）：`{ hooks?, tools? }`
- **hook-set recipe**（纯 hook 组合）：**先做成 examples/docs 配方**，够 2 个消费者抄同一份再升 `@harness-pi/presets` 包
- **Controller**（编排 session，**不进 Capability**）：`subAgentTool`/`SubAgentRegistry` —— Capability 只暴露 tool+观测 hook，registry 由消费者构造

### 能力矩阵

| 能力 | 现状 | 形态 | 配置开关 | 接什么 | 优先级 |
|---|---|---|---|---|---|
| watchdog | 有·未接 | hook | `watchdog`(默认 ON) | `watchdog` | P0 |
| compaction 策略 | 有 summarize | hook（单一所有者） | `compaction: summarize\|auto\|off` | compactSummarize **或** autoCompaction | P0 |
| postCompactFileReread | 有·未接 | hook | 随 compaction | `postCompactFileReread` | P0 |
| skills / toolSearch / deferred | 有·未接 | hook+tool Capability | `skills` / `toolSearch:auto` | `skillsCapability`(trio) | P0 |
| **todo list** | ❌ | hook+tool Capability | `todo` | `todoCapability`（systemReminder+tool） | **P1** |
| **sub-agents + 管理** | ⚠️ 基建有 | tool + 外置 registry | `subAgents.manage` | `subAgentTool` + list/continue/cancel 工具 | **P1** |
| goal 循环 | 有 `/goal` | controller 组合 | `goal` | createGoalSession | P1 |
| **mcp** | ❌ | adapter + tool pack | `mcp.servers` | `@harness-pi/mcp` | **P1** |
| **web** | ❌ | tool pack | `web` | `webTools` | P2 |
| **backgroundBash** | ❌ | hook+tool Capability | `backgroundBash` | start→id/poll/kill（reminder 随生命周期，kill 后不复活） | P2 |
| 补丁式编辑 | ⚠️ | tool | `editMode` | multiEdit/apply_patch 工具 | P2 |
| planMode | ❌ | hook+tool Capability | `planMode` | permissionGate gate 编辑 + `exit_plan` | P2 |
| git / checkpoint | ❌ | tool + Capability | `git` / `checkpoint` | 改前快照 + 回滚工具 | P2 |
| 持久权限 | ⚠️ allow-once | hook | `permission: allowlist` | 扩 permissionGate | P2 |
| 代码智能 / LSP | ❌ | tool pack | `lsp` | LSP 桥 | P3 |
| 记忆 / 检索 | ❌ | hook+tool Capability | `memory` | 文件记忆 + recall hook | P3 |

---

## 5. 内核侧与插件侧改动（支撑能力的最小重构）

### 内核 `core`：三件小事，全部 opt-in / 向后兼容（**零 feature**）
1. **`Capability` 类型**（type-only，零运行时）：`interface Capability { hooks?: Hook[]; tools?: HarnessTool[] }`，统一词汇；内核对它无运行时感知。
2. **`orderBefore?` / `orderAfter?`**（Hook 可选字段）+ 让已 order-aware 的 `verifyHookDependencies` 检查：把"散在注释里的排序铁律"（compactSummarize-before-trimHistory 等）变成机器可检声明。**不**给 dispatch 加 phase 排序（`注册序=执行序` 是冻结契约，只检查不重排）。
3. **`strictHookValidation?: boolean`**（镜像 `strictPersistence`）：把 `duplicate-name`/`conflict`/排序违规从 warning 提级为构造期 throw。默认 false。

**明确不做**：工具运行时可变（冻结正确，配置=用开关后的集合构造）、merge/dedup 逻辑、任何 feature。

### 插件 `plugins`
- 给互斥/有序家族补 `conflictsWith` + `orderBefore/After` 声明（compaction 家族、多 tokenBudget、prefixShape↔deferred）
- `deferredTools` 播种改**幂等**（merge 进现有 Set，不覆盖）→ 修两个 Capability 各带 deferredTools 时静默丢工具
- 正式化 `Capability` + 出件：`skillsCapability` / `todoCapability` / `backgroundBashCapability` / `subagentsCapability`
- 工具包：`webTools`；MCP 单开 `@harness-pi/mcp` 包（隔离 peerDep）
- dev-only `lintHooks(hooks)`（扫坏序 + 重名）+ 启动 echo 最终有序列表
- **hook-set 预设做成 examples/配方，不做成 plugins 函数**

**明确不做**：`mergeCapabilities()`（用朴素 spread）、controller 进 Capability、preset/重 peerDep 进核心 plugins 包。

---

## 6. 配置驱动装配（`AgentFeatures`）

来源优先级：**默认 ← 配置文件 `.hpi.json`/`~/.hpi/config.json` ← CLI flag ← env**。

```ts
export interface AgentFeatures {
  watchdog?: boolean;                                   // 默认 ON
  compaction?: "summarize" | "auto" | "off";            // 单一所有者，三选一
  todo?: boolean;
  goal?: boolean;
  skills?: boolean | { dir?: string };
  toolSearch?: boolean | "auto";                        // auto = 工具超阈值才渐进披露
  subAgents?: boolean | { maxSubAgents?: number; maxDepth?: number; manage?: boolean };
  mcp?: { servers: McpServerSpec[] };
  web?: boolean;
  backgroundBash?: boolean;
  planMode?: boolean;
  git?: boolean; checkpoint?: boolean;
  permission?: "ask" | "allowlist" | "yolo";
  memory?: boolean;
}

// 装配层 = 给开发者看的"参考实现"
function assembleCapabilities(f: AgentFeatures, cwd: string): Capability[] {
  const caps: Capability[] = [];
  if (f.todo)           caps.push(todoCapability());
  if (f.subAgents)      caps.push(subagentsCapability({ cwd, ...optsOf(f.subAgents) }));
  if (f.skills)         caps.push(skillsCapability(loadSkills(f.skills)));
  if (f.web)            caps.push({ tools: webTools() });
  if (f.mcp)            caps.push({ tools: mcpTools(f.mcp.servers) });
  if (f.backgroundBash) caps.push(backgroundBashCapability());
  if (f.planMode)       caps.push(planModeCapability());
  return caps; // 朴素 spread 进 AgentSession options
}
```

**参考实现结构**：`apps/coding-agent/src/capabilities/<name>.ts`，**一能力一文件**，每个文件就是"如何接这个能力"的范例。开发者两条路：① 配置开关直接用内置；② 复制某文件改成业务版。

---

## 7. 开发模式（怎么做）

### 7.1 文档驱动：每个能力一份设计文档
位置 `docs/caps/<name>.md`，**先写文档再写代码**。统一模板：

```markdown
# Capability: <name>
- 动机 / 它解决什么、不解决什么
- 形态：tool pack / hook+tool Capability / controller（选一并说明理由）
- 公共接口：工厂签名 + 返回 { hooks?, tools? }
- 工具 schema：name / description / parameters（给模型看的）
- ctx.state 键：自己拥有哪些 key（带 plugin 前缀），是否与他人共享
- 排序约束：orderBefore / orderAfter / conflictsWith（声明，不写注释）
- 配置开关：AgentFeatures 里对应字段 + 默认值
- 安全/资源：abort/timeout/cwd 边界/后台进程生命周期
- 测试策略：通过公共接口验证的行为（不测实现细节）
- 成熟度：机制实现 / provider 验证 / 真实任务验证（三层，见 7.3）
- 对标：cc/codex 同名能力的差异与取舍
```

### 7.2 实现：TDD 垂直切片 + review-gate
- `/tdd`：一个测试 → 一个实现，**通过公共接口验证行为**，测试扛得住重构
- 三审门：`/test-review`（测试质量）→ `/code-review`（实现质量）→ `/linus-review`（好品味/消除特殊情况）→ 合 `dev`
- 分支/发布按仓库强约定（不直推 main，PR 回 dev，CI 绿）

### 7.3 成熟度三层（每能力标注，别夸大）
1. **机制已实现**（代码 + 本地/CI 测试）
2. **provider 已验证**（真 LLM 跑通）
3. **真实任务验证**（dogfood 任务集 / SWE-bench 实例跑通）

### 7.4 文档编号
- `docs/11`（本文，总纲）
- `docs/caps/*.md`（每能力一份，模板见 7.1）
- 复用现有：`08-claude-code-lessons`（持续补 cc/codex 教训）、`swe-bench-eval.md`（客观尺）

---

## 8. 路线图（下一步做什么）

> 验收标准：每阶段产出 = 设计文档 + 通过三审的 TDD 切片 + `AgentFeatures` 开关 + 能在 dogfood 跑通。

### Phase 0 · 装配地基（零内核改动，立刻见效）
- `AgentFeatures` + 配置文件解析（建在 `config.ts` 旁）
- 接上 4 个"有但没用"件：`watchdog`(默认 ON) / `autoCompaction`(可选策略) / `postCompactFileReread` / `skills`+`toolSearch`
- **里程碑**：配置开关模式钉死；"我们有能力"可被配置暴露。

### Phase 1 · 你点名的两个 + MCP（最高 ROI）
- `todoCapability`（systemReminder + patch-by-id 工具）
- `subagentsCapability`（接 `subAgentTool` + list/continue/cancel 管理面；manager 保持控制，不做 handoff）
- `@harness-pi/mcp`（接外部 MCP 服务器，一次性补最大能力缺口）
- **里程碑**：长任务有 checklist、能管子 agent、工具面可被 MCP 无限扩展。

### Phase 1.5 · 内核安全闸（小 PR 并行）
- `orderBefore/After` + `strictHookValidation` + compaction/budget 家族补声明 + deferredTools 幂等 + `lintHooks`
- **里程碑**：配置化组合从"能跑"到"安全可验证"。

### Phase 2 · 能力面补齐
- `webTools` → `backgroundBash` → 补丁式编辑（multiEdit/apply_patch） → `planMode` → git/checkpoint → 持久权限
- **里程碑**：编辑/执行/检索/可信度对齐 cc/codex 主流工作流。

### Phase 3 · 上限
- 代码智能/LSP 桥 → 记忆/检索 → tuned system prompt + 默认 maker-verifier 自验证闭环
- **里程碑**：在 dogfood 任务集 + SWE-bench 上达到对标分。

---

## 9. 成功标准：媲美 cc/codex 怎么判定

| 维度 | 判定 | 尺 |
|---|---|---|
| Agentic loop | 已基本对齐 | 现有 smoke + dogfood |
| 能力面 | A 类缺口清零（除沙箱外层） | 能力矩阵全绿 |
| 客观能力 | resolved rate 对标 | `swe-bench-eval.md`（Verified 子集，先 80 实例）|
| 真实手感 | dogfood 任务集通过率 | 自建 N 条真实编码任务（修 bug/加 feature/重构）|
| 可扩展 | 开发者能 30 分钟接一个自定义能力 | 用 `docs/caps` 模板 + 一个 example 验证 |

**底线判定**：一个开发者能**只靠配置开关**得到一个 cc/codex 档的后端/CLI coding agent，或**复制一份 capability 文件**接上自己的业务工具——且每一步都有文档、有测试、有成熟度标注。

---

## 10. 风险与红线
- **不把能力塞进内核**：每加一个能力先问"能不能做成 hook/tool/Capability"。
- **不做 `mergeCapabilities` / 不把 controller 装进 Capability**：朴素 spread + controller 外置。
- **沙箱不自研**：bash 是 host shell，安全靠外层 worker/容器，文档化而非内置。
- **成熟度不夸大**：三层标注，未验证不写"已支持"。
- **排序是 load-bearing**：任何 hook-set 组合必须过 `lintHooks`/`strictHookValidation`，否则只做成配方不做成函数。

---

## 11. 对标 cc/codex 参照系总则（本轮源码调研结论）

读了 Claude Code（`src/`，真实 TS 源码 ~1900 文件）与 Codex（`codex-rs` Rust core）两套真源码后，定一条**分工参照系**——每个能力跟谁、抄什么：

- **跟 Claude Code（CC）**：工具形状（multi-hunk Edit、Task V2、background-bash 三件套、WebFetch/Search、ToolSearch/deferred）、权限模型（modes + 规则 by source + 目录信任）、plan mode、memory 四类法、被动 LSP 诊断。
- **跟 Codex**：沙箱（seatbelt/bwrap）+ execpolicy 审批规则、`apply_patch` 四级模糊匹配 + 多文件事务、config + profiles 覆盖层、plan/todo 用「回灌进下一 turn 上下文」而非工具返回值。
- **两边都做的取最优**：MCP（Codex 的每工具审批粒度 + CC 的 scope/命名空间）、sub-agent 管理（CC 的 `TaskOutput` 统一轮询 + Codex 的 `wait_agent` 超时）、background 执行（CC 的 id→delta-poll→kill）。

**一句话**：**形状与产品手感跟 CC，底层安全与编辑健壮性跟 Codex，分布式/并发能力取两家最优。**

---

## 12. 逐能力对标详表（哪些做 / 怎么做 / 做到什么样 / 参照谁）

| 能力 | 参照系 | 它们的关键机制（可抄） | 我们现状 | 做成什么样（标准） | 形态 | 优先级 |
|---|---|---|---|---|---|---|
| **补丁式编辑** | Codex(模糊)+CC(形状) | Codex `apply_patch` 四级模糊：exact→右裁空白→双侧裁→unicode 归一(EN-DASH/弯引号→ASCII)+ `@@` 上下文锚 + 多文件事务 + `delta.exact` 置信位；CC `Edit` 多 hunk `[{old_str,new_str}]` + mtime+内容 hash 防并发改 + 禁 Edit/Write 同文件 | 仅单处唯一串替换 | `edit` 升**多 hunk**(CC 形状) + 改前 stat+hash 校验；再加 `apply_patch`(Codex 容错格式) | tool | **P1**(上提) |
| **任务/todo** | Codex(回灌)+CC(任务态) | Codex `update_plan` 事件回灌、**单一 in_progress** 不变量、plan 进下一 turn 上下文(非 RPC 返回)；CC 弃整数组 `TodoWrite`→**Task V2**(Create/Update/Get/List + `TaskOutput` 轮询 + `blocks`/`blockedBy` 依赖边) | ❌ 无 | `todo` **patch-by-id** 工具 + `systemReminder` 回灌(=Codex 上下文模型)；进阶加依赖边 | hook+tool Capability | **P1** |
| **sub-agent 管理** | both | Codex `spawn_agent`/`wait_agent`(timeout 2–120s)/`close_agent`/`send_message`；CC `Agent` + `TaskOutput`(block+timeout 增量轮询) + `TaskStop` + `SendMessage`(续聊) | `subAgentTool`+`SubAgentRegistry.continueSubAgent` **已有**、未接、无 model 面 | 接 `subAgentTool` + 暴露 model 面四件套 **spawn/poll/cancel/continue**(我们的 registry 已比 CC 的 fire-and-forget 强) | tool + 外置 registry | **P1** |
| **后台执行** | CC | `Bash run_in_background`→shell id；`BashOutput`→**只取增量**；`KillShell`/`TaskStop`；assistant 模式 15s 自动转后台 | 仅同步 bash | `start→id / delta-poll / kill`；**reminder 随生命周期、kill 后绝不复活**(CC 已知 bug 教训) | hook+tool Capability | P2 |
| **MCP** | both | Codex：每工具/每服务器 `approval_mode` + `server:tool` 前缀 + `ui.visibility.model` 过滤 + 也能当 MCP server；CC：scope 层级(enterprise>…>plugin) + `plugin:name:server` 命名 + 多 transport(stdio/http/sse/ws) + 签名去重 | ❌ 无 | 新 `@harness-pi/mcp` adapter：**stdio 优先** + server 命名空间 + 每服务器审批模式 + 去重；暂跳 OAuth/enterprise | adapter + tool pack | **P1** |
| **沙箱+审批** | Codex | Seatbelt(`sandbox-exec -p`)/bwrap+landlock(namespace+seccomp) 包命令；`execpolicy` 前缀规则 DSL(Starlark, allow/prompt/forbidden, 最严胜) + 启发式兜底；4 审批模式(UnlessTrusted/OnRequest/Granular/Never) + **会话级 ApprovedForSession** + **持久 amendment**(写规则文件) + `CODEX_SANDBOX_NETWORK_DISABLED` 网络闸 | bash=裸 host shell | **薄 `sandboxCapability`**(~500-800 LOC TS)：按 `workspace_write`/`network` 标志用 seatbelt/bwrap 包 bash；+ execpolicy 式规则上 `permissionGate`(allow/ask/deny + 会话缓存) | capability + hook | **P2**(安全关键，可前置) |
| **权限模型** | CC(规则)+Codex(缓存) | CC modes(default/acceptEdits/plan/bypass/dontAsk) + `alwaysAllow/Deny/Ask` 规则 by source(user/project/local/cli/cmd/session) + 目录信任 `additionalWorkingDirectories` + `prePlanMode` + 投机分类器竞速；Codex 会话级 approve + 持久规则文件 | 仅 allow-once | 扩 `permissionGate`：modes + 持久 allow/deny(by source) + 目录信任 + 会话缓存 | 扩现有 hook | P2 |
| **plan mode** | CC | `EnterPlanMode` 存 `prePlanMode` + strip 危险规则；`ExitPlanModeV2` 带 `allowedPrompts`(语义授权 `{tool,prompt}`) + 还原 mode；Codex plan 模式禁 `update_plan` | ❌ 无 | `planModeCapability`：mode=plan 时 `permissionGate` gate 编辑 + `exit_plan` 工具(语义授权出门) | hook+tool Capability | P2 |
| **worktree 隔离** | CC | `EnterWorktree` 建 git worktree+branch + 清 system-prompt cache 重算 env；`ExitWorktree` 脏工作区/git 锁时 **fail-closed 拒删** | 有 `forkSession`/`isolation:worktree` 概念 | `worktreeCapability`：开/关 + 脏工作区拒删 + 退出还原 cwd | tool + controller | P2 |
| **web** | CC | `WebFetch`(url+prompt，小模型后处理，预批准 host 免审)；`WebSearch`(≤8 次/查，title+url) | ❌ 无 | `webTools` pack | tool pack | P2 |
| **压缩/上下文** | CC | 阈值 warn=cw−20k / autocompact=cw−13k / blocking=cw−3k + **熔断 3 次连失**；snip→microcompact→context-collapse→autocompact；system prompt **静/动态 cache 边界** `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`(静态段 scope=global) | 有 autoCompaction/microcompact/compactSummarize/prefixShape(基本 1:1) | 补 **system-prompt 静/动态 cache 边界标记** + **熔断计数**；压缩后破 cache 通知 | 增强现有 hook | P1(小) |
| **memory** | CC | 4 类 `user/feedback/project/reference` frontmatter；**post-sampling 抽取**(token+toolcall 阈值门控、非每 turn)；recall 进 user context(非 attachment) | ❌ 无 | 可选 `memoryCapability`：文件版 + post-tool 抽取 hook + recall 进上下文 | hook+tool Capability | P3 |
| **代码智能/LSP** | CC | **被动诊断**(post-sampling attachment，非工具) + 可选 `LSPTool`(goToDefinition/findReferences/hover/documentSymbol/workspaceSymbol/callHierarchy)；Codex 无 LSP 核心工具 | ❌ 无 | 可选：被动诊断 hook + opt-in `LSPTool` | tool pack + hook | P3 |
| **渐进披露** | CC(已对齐) | >40 工具自动 defer；`ToolSearch` 按需加载；内置工具按名排序稳 cache | **已有** `deferredTools`+`toolSearch` | 加 **>40 自动 defer** 阈值 + 名排序稳 cache | 已有，微调 | P1(微) |
| **skills/AGENTS.md** | both | Codex skills frontmatter(name/description/whenToUse/deps/policy) + 隐式调用白名单 + `SKILL.md` 发现；AGENTS.md **root→cwd 遍历** + 32KB 字节预算 + `project_doc_fallback_filenames` | 有 skills 插件 + 项目指令加载 | 接上 skills；项目指令补 **fallback 名**(AGENTS/CLAUDE/README) + 字节预算 + provenance | capability | P0/P1 |
| **配置/profiles** | Codex | 嵌套 TOML(`model`/`approval`/`sandbox`/`mcp_servers`/`skills`/`project_doc`) + **profiles 作覆盖层**(合并非继承) | config 仅 onboarding | `AgentFeatures` 嵌套分段 + **profiles overlay** | app 配置 | P0 |

---

## 13. 关键决策修订（相对本文前半，依据源码调研）

1. **沙箱：从「不追·交外层」改为「追薄版 `sandboxCapability`」。**
   理由：Codex 证明本地薄沙箱**可分离、可落地**——macOS 用 `sandbox-exec -p <policy>` 包命令、Linux 用 bwrap(namespace+seccomp)，纯命令包装，~500-800 LOC TS 即可，对 agent 透明。范围：只做**文件系统读写限制 + 网络闸**(按 `workspace_write`/`network` 标志)，审批复用我们自己的 `permissionGate`。重型进程级隔离仍留给外层 worker。参考：`codex-rs/sandboxing/src/seatbelt.rs:623-771`、`manager.rs:321-462`、`spawn.rs`(env 注入)。

2. **编辑：`edit` 升 multi-hunk + 加 `apply_patch`。**
   现状单处唯一串替换落后两家。CC 的 `Edit` 本身就是多 hunk(`hunks:[{old_str,new_str}]`)+ mtime/hash 防并发改；Codex `apply_patch` 多了**四级模糊匹配**(对 copy-paste 漂移容错)。先做 multi-hunk(CC 形状，简单)，再加 apply_patch 容错格式。优先级 P2→**P1**。参考：`codex-rs/apply-patch/src/seek_sequence.rs:12-106`。

3. **sub-agent 管理：不是「无人做过」。** 早前「无框架有完整 list/continue/cancel」的判断**过头了**——Codex 有 `spawn/wait/close/send_message`，CC 有 `Agent/TaskOutput/TaskStop/SendMessage`。我们已有 `SubAgentRegistry.continueSubAgent`(比 CC 的 fire-and-forget 还强)，**补 model 面四件套即可对齐甚至领先**。

4. **todo：不止 patch-by-id，可走依赖边。** CC 已从整数组 `TodoWrite` 进化到 Task V2(`blocks`/`blockedBy`)。我们先做 patch-by-id + systemReminder 回灌(Codex 模型)，进阶可加依赖边。

5. **LSP 不当主线工具。** CC 也是**被动诊断为主**(post-sampling attachment) + LSPTool 为可选 opt-in；Codex 干脆不做。我们 P3、opt-in。

6. **压缩我们基本对齐 CC**，只缺 **system-prompt 静/动态 cache 边界标记** + 熔断计数——小补丁，P1。

---

## 14. 源码参考索引（每个 capability 设计文档的一手资料）

写 `docs/caps/<name>.md` 时，直接拉这些文件对账：

| 能力 | Claude Code (`src/`) | Codex (`codex-rs/`) |
|---|---|---|
| 编辑 | `tools/` Edit/Write | `apply-patch/`、`apply-patch/src/seek_sequence.rs`、`core/src/tools/handlers/apply_patch.lark` |
| 任务/todo | `tools/` Task V2、`tasks/types.ts` | `core/src/tools/handlers/plan.rs`、`plan_spec.rs` |
| sub-agent | `tools/AgentTool/`、`coordinator/coordinatorMode.ts`、`tasks/LocalAgentTask/` | `core/src/tools/spec_plan.rs:812-869`(spawn/wait/close) |
| 后台执行 | `tools/` Bash+`BashOutput`+`KillShell`、`tasks/` | `core/src/tools/handlers/shell*.rs`(exec_command/write_stdin) |
| MCP | `services/mcp/`(22 文件: client.ts/config.ts) | `codex-mcp/src/connection_manager.rs`、`config/src/mcp_types.rs` |
| 沙箱+审批 | `hooks/useCanUseTool.tsx`、`utils/permissions/` | `sandboxing/src/seatbelt.rs`+`landlock.rs`+`manager.rs`、`execpolicy/`、`core/src/exec_policy.rs` |
| plan mode | `tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts` | `core/src/tools/handlers/plan.rs`(plan 模式禁 update_plan) |
| 权限 | `hooks/useCanUseTool.tsx`、`types/permissions.ts`、`Tool.ts:123-148` | `protocol/src/protocol.rs:871-934`、`core/src/tools/sandboxing.rs:41-115` |
| 压缩/上下文 | `services/compact/autoCompact.ts`、`context.ts`、`constants/prompts.ts` | `config`(auto_compact_token_limit) |
| memory | `services/SessionMemory/`、`memdir/`、`services/extractMemories/` | `config`(MemoriesToml: rollout 整合) |
| LSP | `services/lsp/`(LSPClient/LSPDiagnosticRegistry)、`tools/` LSPTool | (无) |
| 配置/profiles | `services/` settings、`schemas/` | `config/src/config_toml.rs:154-472`、`profile_toml.rs`、`docs/config.md` |
| skills/AGENTS.md | `skills/loadSkillsDir.ts`、`services/plugins/` | `core-skills/src/model.rs`、`core/src/agents_md.rs:35-151`、`docs/skills.md` |
| worktree | `tools/` Enter/ExitWorktree | (无；Codex 用 sandbox 而非 worktree) |
| 渐进披露 | `tools.ts`(>40 defer)、ToolSearch | (Codex `code-mode` 命名空间) |
| 循环/recovery | `query.ts`(while-true + 恢复路径)、`QueryEngine.ts` | `core/src/` turn/exec |

> **循环对比的结论**：CC 的恢复路径(prompt-too-long→reactive compact、max-output→8k→64k 升档、media→strip)是**硬编码不可插拔**；harness-pi 的三段式 + hook 让恢复**可插拔**——这是我们相对 CC 的**架构优势**，应把 CC 的恢复策略**移植成 hook**，而非内置。
