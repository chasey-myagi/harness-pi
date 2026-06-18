# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> 上层还有 `../CLAUDE.md`(通用 LLM 编码准则:先想清楚、简单优先、外科手术式修改、目标驱动)与全局 `~/.claude/CLAUDE.md`(代码风格:`X | None`、保留异常链等)。本文件只补 **harness-pi 仓库专属**的架构与约定,不重复那些。

## 这是什么

`harness-pi` 是一个把 pi-ai agent 跑成**后端服务/批处理 worker** 的最小运行时 harness(pnpm + TypeScript monorepo)。三层定位:

- **L1 `@earendil-works/pi-ai`**:统一 LLM API + tool spec + event stream。我们是它的**消费者,不动它一行**。
- **L2 `@harness-pi/core`**:自己写的 agent 内核。**故意不基于 `pi-agent-core`**——换来 **hook 作为一等公民**。
- **L3 `@harness-pi/plugins` / `/adapters` / `/tools`** + apps `@harness-pi/coding-agent`（CLI dogfood）、`@harness-pi/lark-bot`（飞书机器人，多轮 LRU session cache）。

不是 `pi-coding-agent` 的 fork(那是终端 UX 扩展);方向是服务端 agent 运行时。详见 `docs/00-overview.md`、`docs/01-architecture.md`。

> **L1 不变量「不动它一行」仍然成立,但允许「在消费面之上收口」。** `@harness-pi/core` 可提供薄 DX seam——把自定义 Model 构造与 provider options 的人体工学集中到内核一侧,而**完全不碰 pi-ai 源码**:
> - `makeOpenAICompatibleModel(spec)`(`packages/core/src/llm-model.ts`):造 OpenAI-compatible 自定义 Model,**零 `as Model` cast、无 `cost:{0,0,0,0}` 占位**(返回窄类型 `Model<"openai-completions">` 让条件 `compat` 字段正确解析)。
> - `LlmOptions` + `resolveLlmOptions()`:`AgentSessionOptions.llmOptions` 的 typed 形态(`Omit<StreamOptions,"signal"> & { providerExtras }`),`{apikey}` typo 编译期失败;provider 专属键走 `providerExtras` 逃生口。
>
> 这是「在咽喉点封装上游公共面」,不是改 L1。下游(coding-agent / engram / bidding-agent)应从 `@harness-pi/core` 拿这两个,**别直接 import `@earendil-works/pi-ai`**——seam 是单一咽喉点,上游 churn `Model` 类型时只动 `llm-model.ts` + `index.ts` re-export。
>
> **若将来真需改 L1 行为**,升级阶梯是:`pnpm patch`(软 fork,留在 version train、自动重应用;但 tarball 只发 `dist`,只能 patch 编译产物)→ 硬 fork+vendor(仅当 patch 做不到且需跨多 release 持续,如未用 provider SDK 瘦身)作最终储备。上游(`github.com/earendil-works/pi-mono`, MIT)当前健康,fork 期权永不过期,**现在不 fork**。

## 架构大图(读多个文件才能拼出的部分)

**内核极简 + 一切皆 hook。** `@harness-pi/core` 只做两件事:跑 pi-ai 的 LLM-tool 循环 + 派发 hook。**无** metric / watchdog / pool / DB / frontend——这些全是 `@harness-pi/plugins` 里的 hook 实例。改内核前先问:这能不能做成 hook?

**三个概念别混(`docs/05/06/07`):** 权威清单 = `packages/plugins/src/index.ts`(plugin)与 `packages/plugins/src/controllers/index.ts`(controller)的实际导出。
- **Plugin**(20 个 `Hook` 工厂 + `toolSearch`/`skills` 工具工厂 + `defaultSummarize` 辅助件):钩 loop 事件的装饰器。核心 12:watchdog / trimHistory / emptyRunGuard / toolOutputBuffer / sessionLog / systemReminder / batchCounter / leaseDecision / metrics / costTracker / tokenBudget / repeatedCallGuard。0.3.0 新增:toolStats / compactSummarize / autoCompaction(+`hybridTokenCounter`/`TokenCounter`/per-model 窗口)/ microcompact / summary-template(`defaultSummarize`)/ postCompactFileReread / turnEndGuard(timeout 默认 30s)/ permissionGate / deferredTools+toolSearch+skills(O1/O2 渐进暴露,共享 `deferred.activated` 激活集)。
- **Controller**:编排一/多个 session。lifecycleRestart / workPool / leaseQueue / compactOnOverflow+CompactRestartFresh / CompactResumeFromBoundary / persistCompactionBoundary(C1 onAfterFlush collect-return seam)/ forkSession / parallel / pipeline / subAgentTool+routedSubAgentTool(横向 maxSubAgents + 纵向 maxDepth 两闸)+SubAgentRegistry(续聊句柄,bounded LRU/TTL/abort)/ gapExplorer。`sideQuestion` 仍未落地(docs/06 §7.1)。
- **Adapter**:plugin 的 I/O 后端(metric sink、log sink、`SessionStore`)。**走接口 + peerDep,不强加具体 driver**;自定义 metric kind 用 TS module augmentation,不改内核。

**`AgentSession`(`packages/core/src/session.ts`,本仓库最重的文件)**:`run`/`continue` → turn loop →三段式 phase(`_phaseLlmCall` → `_phaseToolBatch` → `_phaseTurnEnd`)。几个**必须知道、否则会改错**的不变量:
- **Tool 执行顺序屏障**:unsafe tool call(`isConcurrencySafe()===false`,如 bash/edit/write)是**屏障**;只有**连续的** safe 段并行(read/grep/find/ls)。保留模型撰写的调用顺序——别退回「先全部 safe 再全部 unsafe」(会让 read 看到 edit 之前的陈旧状态)。见 `tool-executor.ts`。
- **双轨事件**:`LiveEvent`(经 `session.on()`,回合进行中)vs `SessionEvent`(经 `runStreaming()`,recorded 轨)。`message_update` 是**中间态、逐块 partial 快照**(在每个内容块 `*_end` 发),**不是权威终态**——要终态用 `message_end`。`testing.ts` 的 fake model **忠实复刻** pi-ai 的渐进式 `partial`(每事件独立快照),别退回「全程复用最终 message」。
- **持久化 HWM**:`SessionStore` append-only、`_persistedCount` 逐条推进(失败停在已成功处、下次重试、绝不重复 append)。`strictPersistence` 模式把「落盘不全的 done」提级为 `reason:"error"` 并填 `RunSummary.persistenceErrors`(只提级 done,不覆盖 aborted/max_turns)。`resume()` 从 store 重建。
- **越界观测**:内核只 fire `onContextOverflow`,不内置 compaction 策略——压缩/重启全在插件。

**first-party tools(`@harness-pi/tools`)**:`read/bash/edit/write/grep/find/ls`,默认拒绝逃出传入 `cwd`。**`bash` 是 host shell,不是 sandbox**;生产需外层隔离。

## 常用命令

```bash
pnpm install                       # 安装(CI 用 --frozen-lockfile)
pnpm -r build                      # 全量构建(tsc -p .,各包出 dist)
pnpm -r typecheck                  # 全量类型检查(tsc --noEmit)
pnpm -r test                       # 全量测试(vitest run)
```

**⚠️ 顺序铁律:`build` 必须先于 `typecheck`/`test`。** 下游包(coding-agent、examples)按各包**已构建的 dist**(package exports)做类型检查与跨包导入。改了某个库的**公共类型/导出**后,必须先 `pnpm --filter <pkg> build` 再跑下游 typecheck,否则报「Property X does not exist」是 dist 陈旧、不是真错。

```bash
# 单包 / 单测试 / watch
pnpm --filter @harness-pi/core test
pnpm --filter @harness-pi/core test -- src/__tests__/session.test.ts   # 单文件
pnpm --filter @harness-pi/core test -- -t "部分测试名"                 # 按名筛
pnpm --filter @harness-pi/core test:watch

# 真 Postgres 集成测试(默认 env-gated 整段 skip;给了 URL 才跑)
POSTGRES_TEST_URL=postgres://postgres:test@localhost:5432/harness_pi_test pnpm --filter @harness-pi/adapters test

# 跑 dogfood agent / 示例
pnpm --filter @harness-pi/coding-agent start -- --cwd . --model dashscope:qwen-plus "inspect this repo"
pnpm --filter @harness-pi-example/01-bare-kernel start   # examples/ 下 01~04
```

dogfood agent(命令名 **`hpi`**):默认 full mode 挂全部 tools(`--read-only` 只挂只读);`--disable bash,write` 关指定 tool;session log 默认对高危 tool args 脱敏(`--log-args full|none`、`--no-log`)。详见 `README.md` Dogfood 段。

## 分支流程与发布(本仓库强约定)

**🚫 永不直推 `main`。** `main` 已设 GitHub 分支保护:require PR + `ci` check 必绿(strict / 分支需 up-to-date)+ linear history + enforce_admins + 禁 force-push/删除。**含 owner 自己**。

- **开发**:从 `dev` 切 feature 分支 → 改 → PR **回 `dev`**(CI 绿即快速合)。
- **发布**:从 `dev` 提 PR 到 `main`(必须 CI 绿)→ 合并 → bump 版本 → 发 npm + 打 tag。

**CI**(`.github/workflows/ci.yml`,on push/PR to main|dev):`install --frozen-lockfile → build → typecheck → test`,挂 `postgres:16` service + `POSTGRES_TEST_URL`,让那 18 个真 PG 集成测试在 CI 真跑(pg-mem 与真 PG 有已知偏差,单链路靠模拟器背书不够)。

**发布**:5 个包(4 库 + CLI `hpi`)统一版本号。
```bash
TOK=$(security find-generic-password -a "$USER" -s NPM_TOKEN -w)   # keychain,带 bypass-2FA
# 在 repo 根写临时 .npmrc(//registry.npmjs.org/:_authToken=$TOK),trap 删
pnpm -r publish --access public --no-git-checks                    # 拓扑序,workspace:* 自动替换,examples(private)跳过
```
**两套认证别混**:`git push` 用 gh 账号 `chasey-myagi`(推完切回 `endlesschasey-ai`);npm 发布用 keychain `NPM_TOKEN`(npm 账号 `chasey.myagi`)。

## 成熟度定位(别误读 / 别在文档里夸大)

当前 **0.4.0 = hardened spike preview**。区分三层(`README.md`「当前状态」):
1. **机制已实现** ✅(代码 + 本地/CI 测试覆盖)。
2. **provider 已验证**(真 LLM 跑 smoke):streaming/error/budget-bound continuation 已验证(`scripts/d0-smoke.ts` A/B/D,`pnpm --filter @harness-pi/coding-agent run smoke:provider`);reactive overflow 在容忍型 provider 测不了,由 `context-overflow.test.ts` 覆盖(#82 已知限制)。
3. **bidding-migration 已验证**(真 `bidding-agent` spike)——**未做**。

→ **spike-ready,不是 `bidding-agent` 的生产替代品**。剩的是「真实环境验证」,不是缺机制。
