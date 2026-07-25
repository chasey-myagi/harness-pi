# Task Plan: `@harness-pi/transcript` 空包骨架 + 内核事件镜像 + 双向编译期断言

## Linked Issue

GH-153

## Spec Packet

- Product: `specs/GH153/product.md`
- Tech: `specs/GH153/tech.md`

## 实现任务

- [ ] `SP153-T1` 建包骨架（`package.json` / `vitest.config.ts` / `src/index.ts` / `README.md`）。Owner: agent. Done when: `packages/transcript` 进 pnpm workspace，`dependencies` 为空，`private: true`，`files` 列的文件都真实存在。Verify: `pnpm --filter @harness-pi/transcript test -- import-graph`.
- [ ] `SP153-T2` 两个 tsconfig：`tsconfig.json`（只 `exclude` `__tests__`，断言留在主路径上）与 `tsconfig.browser.json`（`types: []` + 额外 `exclude` `__typecheck__`）。Owner: agent. Done when: 两份配置各自可独立 `tsc -p` 运行。Verify: `pnpm --filter @harness-pi/transcript typecheck`.
- [ ] `SP153-T3` 必填闭包镜像 `src/contract/core-mirror.ts`，文件头带 12 项省略字段清单。Owner: agent. Done when: `SessionEvent` 8 arm 与 `LiveEvent` 6 arm 及其类型闭包全部镜像完成。Verify: `pnpm --filter @harness-pi/transcript exec tsc -p . --noEmit`.
- [ ] `SP153-T4` 透传水位类型 `src/contract/watermark.ts`（`{seq, epoch}` + 快照信封）。Owner: agent. Done when: 类型存在且注释写明语义与发号权归 GH-154、本包不自造 seq。Verify: `grep -q 'GH-154\|#154' packages/transcript/src/contract/watermark.ts`.
- [ ] `SP153-T5` 双向断言 `src/contract/__typecheck__/core-mirror.assert.ts`：两条事件轨各两向，外加 pi-ai 三个叶子类型各两向；文件头写明四种盲区并声明为实测台账。Owner: agent. Done when: 断言随 `tsc -p .` 一起被编译且通过。Verify: `pnpm --filter @harness-pi/transcript test -- "断言的静态完整性"`.
- [ ] `SP153-T6` `typecheck` 脚本两段 `&&` 串联，并在 PR 描述中记录相对其余 4 包的三处有意偏离。Owner: agent. Done when: 脚本依次跑完两个 tsconfig 且以 `&&` 串联。Verify: `pnpm --filter @harness-pi/transcript test -- "typecheck 脚本以 && 串联两段"`.
- [ ] `SP153-T7` 七个 `typecheck-fixtures/`：01-05 期望非零退出（四种漂移 + node 全局探针），06-07 期望零退出（盲区台账 / 公开出口面）。fixture 05 必须 `extends` 真正的 `tsconfig.browser.json`。Owner: agent. Done when: 七个 fixture 各自退出码符合预期。Verify: `pnpm --filter @harness-pi/transcript test -- fixture`.
- [ ] `SP153-T8` `typecheck-fixtures/scanner-corpus/` 标本语料：十种说明符形态、两种三斜线指令、三种全局访问形态、四种同名属性负向对照、`.mts`/`.cts`/`.tsx` 扩展名。Owner: agent. Done when: 扫描器命中集合与预期**精确相等**。Verify: `pnpm --filter @harness-pi/transcript test -- "扫描器本身有判别力"`.
- [ ] `SP153-T9` `src/__tests__/contract-drift.test.ts`：注入式变异（复制 contract 树 → 制造真实漂移 → 连同真实断言一起编译 → 断言非零退出且报错落在断言文件上）、fixture 表、断言静态完整性、browser 门 `--listFiles`。Owner: agent. Done when: `@ts-nocheck` 与「别名改指镜像自己」两种绕过都会让测试变红。Verify: `pnpm --filter @harness-pi/transcript test -- 注入式变异`.
- [ ] `SP153-T10` `src/__tests__/import-graph.test.ts`：runtime 图 allowlist（只准相对说明符）+ 全局标识符 + 三斜线指令扫描、包元数据、构建产物（含 dist 非空守卫与断言空壳检查）。Owner: agent. Done when: 四类断言全部覆盖且各有正向对照。Verify: `pnpm --filter @harness-pi/transcript build && pnpm --filter @harness-pi/transcript test -- import-graph`.
- [ ] `SP153-T11` 提交 `pnpm-lock.yaml` 的 `packages/transcript` importer 条目，并把变异测试临时目录加进 `.gitignore`。Owner: agent. Done when: lockfile 含该 importer 且 `.mutation-tmp/` 已忽略。Verify: `pnpm install --frozen-lockfile && git check-ignore -q .mutation-tmp/`.
- [ ] `SP153-T12` 逐条变异验证每个守门人：人为制造失效 → 确认对应测试变红 → 还原。Owner: agent. Done when: tech.md「变异验证记录」列出的十二条全部被抓。Verify: 见 `specs/GH153/tech.md` 的变异验证记录段。
- [ ] `SP153-T13` 全量绿 + 工作流合同校验。Owner: agent. Done when: 全仓 build/typecheck/test 与 spec 校验均通过。Verify: `pnpm -r build && pnpm -r typecheck && pnpm -r test && python3 checks/check_workflow.py --repo . --spec-dir specs/GH153`.
- [ ] `SP153-T14` 过 review-gate 三门后提 PR 回 `dev`。Owner: human. Done when: `/test-review` -> `/code-review` -> `/linus-review` 三门 PASS 且 owner 批准。Verify: `python3 checks/review_gate.py --repo . --evidence <evidence.json>`.

## Pre-Edit Checklist

已读取目标文件（`packages/core/src/session.ts`、`packages/core/src/hook.ts`、pi-ai `types.d.ts`）、
附近测试（`packages/tools/src/__tests__/tools.test.ts`、`apps/coding-agent/src/__tests__/workspace-safety.test.ts`）、
现有 patterns 与 imports（`packages/adapters` 建包 commit `05c718c`、`tsconfig.base.json`、两条 CI workflow）。
Assumptions 与 tradeoffs 见 `tech.md` 的「备选方案」与「风险」——其中「直接转发内核类型」一条是最强的
对手方案，否决理由是「契约要跨序列化边界」而非「browser 不安全」。
dependency/config impact：无 runtime 依赖，不动根配置与 workspace glob；`.gitignore` 加一行。

## 并行拆分

本 PR 内部不拆并行：T3 → T5 → T7 → T9 是一条类型依赖链，T1/T2 是它的前置。
真正可并行的是**本 issue 之外**——GH-147 → GH-144 是另一条独立轨道，与 transcript 四环无依赖关系；
GH-168 的帧级 golden 族同样不依赖本 issue。

## 验证

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm -r typecheck
pnpm -r test
python3 checks/check_workflow.py --repo . --spec-dir specs/GH153
```

Pre-existing failures: 无（基线 `origin/dev` 实测 1220 passed / 18 skipped / 0 failed）。
Not run, with reason: 真 Postgres 集成测试未在本地跑（需 `POSTGRES_TEST_URL`；CI 挂 `postgres:16` service 会跑）。

## Handoff Notes

- 本 issue 的 AC 经三轮修订。**R1**：删除「镜像带上 GH-140 工具危险度元数据」（该三字段全仓零读取点、
  不挂在任何事件上，镜像它只会产出永远 `undefined` 的字段）。**R6**：「不 `exclude` `__typecheck__` 的话
  devDep 会泄漏进 `dist`」是假的——`import type` 被完全擦除，实测 emit 出的 `.d.ts` 字面就是 `export {};`。
  据此建立的第三个 tsconfig、三段脚本与两条守它们的测试全部删除。**R7**：「四种漂移都抓得住」是过度声称，
  盲区台账从 2 条扩到 4 条并落成可执行 fixture。逐条依据见 issue 正文「AC 修订记录」。
- 注入式变异测试会在包根创建 `.mutation-tmp/`（已进 `.gitignore`，`afterAll` 清理）。它比任何静态检查都强：
  静态检查挡的是「断言长得不对」，注入式变异证明的是「断言此刻真的在约束镜像」。
- `dist/` 无跨包引用这条检查依赖 `build` 先于 `test`（仓库铁律）。`dist/` 缺失或半成品时测试**主动失败**，
  不静默跳过；**陈旧** dist 不在覆盖范围内，注释已如实声明。
- 后置提醒：GH-168 / GH-154 让 `apps/coding-agent` 或 host 依赖本包**之前**，必须先摘掉 `private` 并补 `LICENSE`。
