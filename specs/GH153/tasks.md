# Task Plan: `@harness-pi/transcript` 空包骨架 + 内核事件镜像 + 双向编译期断言

## Linked Issue

GH-153

## Spec Packet

- Product: `specs/GH153/product.md`
- Tech: `specs/GH153/tech.md`

## 实现任务

- [ ] `SP153-T1` 建包骨架（`package.json` / `vitest.config.ts` / `src/index.ts`）。Owner: agent. Done when: `packages/transcript` 进 pnpm workspace，`dependencies` 为空，`private: true`，跨包依赖用 `workspace:^`。Verify: `node -e "const p=require('./packages/transcript/package.json');if(Object.keys(p.dependencies||{}).length||p.private!==true)process.exit(1)"`.
- [ ] `SP153-T2` 三个 tsconfig（`tsconfig.json` 含 `exclude`、`tsconfig.typecheck.json` 的 `exclude: []`、`tsconfig.browser.json` 的 `types: []` + 同款 `exclude`）。Owner: agent. Done when: 三份配置各自可独立 `tsc -p` 运行。Verify: `pnpm --filter @harness-pi/transcript exec tsc -p tsconfig.browser.json`.
- [ ] `SP153-T3` 必填闭包镜像 `src/contract/core-mirror.ts`，文件头带省略字段清单。Owner: agent. Done when: `SessionEvent` 8 arm 与 `LiveEvent` 6 arm 及其类型闭包全部镜像完成。Verify: `pnpm --filter @harness-pi/transcript exec tsc -p . --noEmit`.
- [ ] `SP153-T4` 透传水位类型 `src/contract/watermark.ts`（`{seq, epoch}` + 快照信封）。Owner: agent. Done when: 类型存在且注释写明语义与发号权归 GH-154、本包不自造 seq。Verify: `grep -q 'GH-154\|#154' packages/transcript/src/contract/watermark.ts`.
- [ ] `SP153-T5` 双向断言 `src/contract/__typecheck__/core-mirror.assert.ts`（4 条），文件头写明两种盲区。Owner: agent. Done when: 断言在 `tsconfig.typecheck.json` 下编译通过。Verify: `pnpm --filter @harness-pi/transcript exec tsc -p tsconfig.typecheck.json`.
- [ ] `SP153-T6` `typecheck` 脚本三段串联，并在 PR 描述中记录相对其余 4 包的有意偏离。Owner: agent. Done when: `pnpm --filter @harness-pi/transcript typecheck` 依次跑完三个 tsconfig。Verify: `pnpm --filter @harness-pi/transcript typecheck`.
- [ ] `SP153-T7` 五个 `typecheck-fixtures/`（4 个漂移反例 + 1 个 node 全局探针），落在包根、三个 tsconfig 的 `include` 之外。Owner: agent. Done when: 五个 fixture 各自 `tsc -p` 非零退出。Verify: `pnpm --filter @harness-pi/transcript test -- contract-drift`.
- [ ] `SP153-T8` `src/__tests__/contract-drift.test.ts`：子进程跑五个 fixture 断言非零退出，并断言断言文件头含两种盲区说明。Owner: agent. Done when: 测试通过且任一 fixture 变成零退出时测试会失败。Verify: `pnpm --filter @harness-pi/transcript test -- contract-drift`.
- [ ] `SP153-T9` `src/__tests__/import-graph.test.ts`：runtime 图说明符与标识符扫描 + `dependencies` 为空 + `dist/` 无 `@harness-pi/core` 引用（`dist/` 缺失时**失败**，不静默跳过）。Owner: agent. Done when: 三类断言全部覆盖。Verify: `pnpm --filter @harness-pi/transcript build && pnpm --filter @harness-pi/transcript test -- import-graph`.
- [ ] `SP153-T10` 提交 `pnpm-lock.yaml` 的 `packages/transcript` importer 条目。Owner: agent. Done when: lockfile 含该 importer。Verify: `pnpm install --frozen-lockfile`.
- [ ] `SP153-T11` 全量绿 + 工作流合同校验。Owner: agent. Done when: 全仓 build/typecheck/test 与 spec 校验均通过。Verify: `pnpm -r build && pnpm -r typecheck && pnpm -r test && python3 checks/check_workflow.py --repo . --spec-dir specs/GH153`.
- [ ] `SP153-T12` 过 review-gate 三门后提 PR 回 `dev`。Owner: human. Done when: `/test-review` -> `/code-review` -> `/linus-review` 三门 PASS 且 owner 批准。Verify: `python3 checks/review_gate.py --repo . --evidence <evidence.json>`.

## Pre-Edit Checklist

已读取目标文件（`packages/core/src/session.ts`、`packages/core/src/hook.ts`、pi-ai `types.d.ts`）、
附近测试（`packages/tools/src/__tests__/tools.test.ts`、`apps/coding-agent/src/__tests__/workspace-safety.test.ts`）、
现有 patterns 与 imports（`packages/adapters` 建包 commit `05c718c`、`tsconfig.base.json`、两条 CI workflow）。
Assumptions 与 tradeoffs 见 `tech.md` 的「备选方案」与「风险」。dependency/config impact：无 runtime 依赖，
不动根配置与 workspace glob。

## 并行拆分

本 PR 内部不拆并行：T3 → T5 → T7 → T8 是一条类型依赖链，T1/T2 是它的前置。
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

- 本 issue 的 AC 已于 2026-07-25 收窄，删除了「镜像带上 GH-140 工具危险度元数据」一条——该三字段全仓
  **零读取点**且不挂在任何事件上，镜像它只会产出永远 `undefined`、断言永远抓不住的字段。详见 issue 正文
  「AC 修订记录 R1」。
- `dist/` 无 core 引用这条检查依赖 `build` 先于 `test`（仓库铁律）。`import-graph.test.ts` 在 `dist/`
  缺失时**主动失败并提示先 build**，不静默跳过。
- 后置提醒：GH-168 / GH-154 让 `apps/coding-agent` 或 host 依赖本包**之前**，必须先摘掉 `private`
  并补 `LICENSE` 与 `README.md`。
