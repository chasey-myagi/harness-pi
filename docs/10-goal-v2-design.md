# /goal v2 设计 —— 独立 reviewer sub-agent（替代 in-loop verifier）

> 状态：**设计稿（未实现）**。对应 #111「Loop Engineering substrate」里的 `/goal` v2 重设计项。
> 关联：#88（/goal v1）、#87（progressVerifier roadmap）、#100（移除 in-loop verifier）、#105（flag 解析卫生）、
> `examples/05-maker-verifier-loop`（本设计的可运行 spike）。
>
> ⚠️ 这是「**若**重启 /goal 命令」的设计；要不要把它做成命令本身是开放决策（见 §7）。harness-pi 的定位是
> 卖 hook 零件库、不卖命令——v2 的价值首先是**模式**（maker-verifier），已由 example 05 以零件交付；
> 包装成 `/goal` 命令是次级的 dogfood 取舍。

## 1. 问题回顾：v1 为什么没差异化

`/goal` v1 = `turnEndGuard`(force-continue) + `tokenBudget`，并在 #100 **移除了 verifier**（`progressVerifier`
在回合内打断生产性回合、误杀正常推进，是被移除的根因）。

两条证据汇合（#111）：

- **内部证伪**：3 次真模型 dogfood（dashscope:qwen-plus），`turnEndGuard` 的 force-continue 主路
  （NOT_REACHED→强制续跑）**三次全 0 触发**。称职模型本来就会把 turn-loop 走到底，那条强制路只在 CI fake
  model 下可达 → 真实世界几乎不触发。
- **外部对账**：`/loop`+`/goal` 已是 Claude Code / Codex 的标准原语（commodity）；行业（"Loop Engineering"）
  点破防摆烂的真价值 = **生成者/验证者分离**（"别批改自己的作业"），而那正是 #100 删掉的 verifier。

**结论**：v1 差异化空，不是概念差，而是**把唯一有价值的零件（独立 verifier）拆了**，剩下纯 force-continue =
commodity。force-continue 从来不是卖点，**verify gate / maker-verifier 分离才是**。

## 2. 设计原则

1. **验证在回合之外**。reviewer 是独立上下文（不同 system prompt、不能改代码），不在生产回合内打断——结构上
   绕开 #100 移除 in-loop verifier 的根因。这是 #87 诉求的**正确形态**（#87 的意图保留、#100 的张力和解）。
2. **强制闸，不是可选工具**。验证必须发生在 maker 想停的那一刻，由内核保证调用——而不是把工具丢给 maker 让它
   "自觉"调。
3. **全部用现成件**。不进内核加新概念；v2 是 `turnEndGuard` + 独立 `AgentSession`（或 `subAgentTool`）+
   `tokenBudget`/`repeatedCallGuard` 的**组装**。

## 3. 关键设计判断：闸放在 `turnEndGuard.check`，不是 `subAgentTool`

#111 原文说"复用 subAgentTool / routedSubAgentTool"，这里**收紧一处常见误解**：

- `subAgentTool` 是给 **maker 模型**的一个**工具**——maker **主动**决定要不要调、何时调（用于把子任务委派出去）。
  把验证寄望于 maker 自觉调用 subAgentTool 是**可选**的：称职模型可能跳过、摆烂模型更会跳过 → 验证形同虚设。
- **强制验证闸**必须挂在 maker **想停的那一刻**——即 `turnEndGuard.check`。check 是内核在「模型自然停止 + 还有
  续跑预算」时**必然 fire** 的钩子；在 check 内部跑独立 reviewer，PASS 才放行、FAIL 回灌 gap 强制返工，验证
  就是**不可绕过**的 gate。

→ v2 用 **`turnEndGuard.check` 内跑独立 reviewer**。`subAgentTool` 仍可作为 maker 侧的委派工具并存，但不是验证
闸本身。`examples/05-maker-verifier-loop` 已用这套 wiring 跑通（独立 reviewer AgentSession + turnEndGuard 闸 +
tokenBudget/repeatedCallGuard 保险丝），是本设计的活 spike。

## 4. 架构

```
┌────────────────────────── maker session ──────────────────────────┐
│  系统提示：任务 + 工具（read/edit/write/bash...）                     │
│  turn-loop：干活……当模型自然想停（text, no tools）                    │
│      │                                                              │
│      ▼  onContinuationCheck                                         │
│  turnEndGuard.check ───────────────┐                               │
│      │                              ▼                              │
│      │                    ┌──── reviewer sub-agent ────┐           │
│      │                    │  独立 AgentSession          │           │
│      │                    │  系统提示：rubric(=--success)│           │
│      │                    │  无 edit 工具（只读/只判）    │           │
│      │                    │  输入：maker 的产出/ diff     │           │
│      │                    │  输出：PASS / FAIL: <gap>     │           │
│      │                    └──────────────┬──────────────┘           │
│      │                                   │                          │
│      ◀── PASS → {ok:true} 放行停止 ───────┤                          │
│      ◀── FAIL → {ok:false, message:gap} ─┘ 回灌 gap、强制返工         │
│                                                                    │
│  硬保险丝（并行挂着）：tokenBudget（总预算）/ repeatedCallGuard（无进展熔断）│
└────────────────────────────────────────────────────────────────────┘
```

终止矩阵：
- reviewer **PASS** → `reason:"done"`，verdict=reached。
- reviewer 连续 FAIL 到 `maxReworks` 上限 → turnEndGuard 放行停止（`reason:"done"`，但 verdict=未达成，
  展示为「N 轮返工仍未过」）。**有界，绝不无限转。**
- `tokenBudget` 耗尽 / `repeatedCallGuard` 熔断 → `reason:"aborted"`，abortReason 区分来源。

## 5. reviewer 设计要点

- **独立上下文**：全新 `AgentSession`，system prompt = rubric（来自 `--success`），**不挂 edit/write/bash**
  （只读判定，物理上不能改代码——"别批改自己的作业"的强约束）。
- **输入 = maker 的可验证产出**。toy spike 里是 `submit(solution)`；真实编码场景应喂 **diff / 改动文件内容 /
  测试输出**，而不是整个对话历史（既省 token 又聚焦验收物）。这是落地时要定的 seam（见 §7）。
- **输出协议**：要求 reviewer 回 `PASS` 或 `FAIL: <one-line gap>`。解析失败按 FAIL 兜底（保守：判不出就返工）。
- **model 选择**：reviewer 可与 maker 同 model，也可换更便宜/更严的 model（reviewer 任务比生成简单）。作为
  `routedSubAgentTool` 的一种 agent_type 分派也可行。
- **成本**：每次 review = 一次 sub-agent run = 真实 token。`maxReworks` + `tokenBudget` 共同封顶，避免 review
  本身烧穿预算。

## 5b. 落地必踩的两个 wiring 坑（来自 example 05 + codex 交叉验证）

把这套从零件拼出来时，有两处内核/插件交互必须显式处理，否则「有界 loop」会在未测路径上失效：

1. **`maxContinuations` 要从 `maxReworks` 抬高**。内核在 fire `onContinuationCheck` **之前**先查
   `maxContinuations`（默认 5）；turnEndGuard 每次 FAIL→force 算一次 continuation。若不抬高，`maxReworks ≥ 5`
   会在最后一次评判 check 触发前就以 `reason:"max_continuations"` 退出，reviewer 永远等不到那次 PASS。
   修法：`maxContinuations = maxReworks + 1`（+1 留给最终评判的那次 check）。
2. **关掉 `tokenBudget` 的「递减收益」启发式**（`diminishingThreshold: 0`），只保留显式预算上限。递减检测按
   maker 每 turn 的 token delta 判「无进展」，但 maker-verifier loop 的实际进展发生在**回合外的 reviewer**、
   不计入 maker delta —— 简洁回合会被误判摆烂、在 reviewer 评判前 abort（`reason:"aborted"`）。

## 6. CLI 表面（复用 v1 解析 + #105 卫生）

```
/goal <task> --success <验收标准> [--max-reworks N] [--budget N]
```

- `--success` 从 v1 的「注入 prompt 的提示」升级为 **reviewer 的 rubric**（PASS/FAIL 依据）。这是语义升级，
  解析器复用 #105 修过的 flag 卫生（词边界、重复 flag last-wins、空值清空）。
- `--max-reworks` = `turnEndGuard.maxRetries`（v1 的 `--max-turns` 语义并入；kernel turn 上限单独配）。
- `--budget` = `tokenBudget`。
- 去掉 v1 的 `GOAL_STATUS` 自报协议（让 maker 自报达成 = 自批作业，正是要消除的）——达成与否由**独立
  reviewer** 判，不由 maker 自陈。

## 7. 开放决策（不在本设计内拍板）

1. **要不要做成命令**：定位是「卖零件不卖命令」。example 05 已把模式作为零件交付；`/goal` v2 作为命令只是
   dogfood 的便利封装，**可选**。若做，它应是「用现成 hook 拼好的一个预设组合」，而非内核新增。
2. **reviewer 怎么看 maker 的工作**：真实编码场景喂 diff / 测试输出的 seam 如何取（需接 first-party tools 的
   改动追踪或让 maker 显式 submit 验收物）。
3. **relaunch / 解 HOLD**：本设计**不自动解 HOLD**——#111 明确「行业文章不给新性能数据」。relaunch 需 owner
   拍板，且真正剩的成熟度缺口是 bidding-migration 验证（见 `docs/roadmap.md`、CLAUDE.md 成熟度三层），与本
   设计正交。

## 8. 验收（落地时）

- maker-verifier loop 的纯逻辑单测（reviewer FAIL→强制返工→PASS→停；达 maxReworks 上限有界停止）——已由
  `examples/05-maker-verifier-loop` 覆盖，命令化时移植/扩展。
- `/goal` 命令解析单测复用并扩展 #105 的 goal.test.ts（`--success` 作 rubric 的端到端织入）。
- 若接真 provider：一次真模型 dogfood，证明独立 reviewer 在称职模型下**确有**打回-返工发生（补上 v1 force-continue
  三次 0 触发的差异化空洞）。
