# Tech Spec: `@harness-pi/transcript` 空包骨架 + 内核事件镜像 + 双向编译期断言

## Linked Issue

GH-153

## Product Spec

`specs/GH153/product.md`

## Codebase Context

| Area | Files | Current behavior | Why relevant |
| --- | --- | --- | --- |
| 内核事件轨 | `packages/core/src/session.ts:56-64`, `:77-103` | `SessionEvent` 8 arm / `LiveEvent` 6 arm，纯数据 union | 镜像的源头 |
| 事件类型闭包 | `packages/core/src/session.ts:221-257`（`RunSummary`）、`packages/core/src/hook.ts:34-55`（`ToolExecResult`） | 两个接口各带 2-3 个可选字段（`Error` / `unknown` / `Message[]`） | 决定哪些字段必须省略 |
| pi-ai 类型 | `@earendil-works/pi-ai` `dist/types.d.ts`（`AssistantMessage` / `ToolCall` / `Usage` / `StopReason` / `TextContent` / `ThinkingContent`） | 纯数据 interface，`Api` / `Provider` 实为 `string` | 镜像闭包的叶子 |
| 包骨架惯例 | `packages/adapters/package.json`, `packages/core/tsconfig.json`, `packages/core/vitest.config.ts` | 4 包同构：`build: tsc -p .` / `typecheck: tsc -p . --noEmit` / `test: vitest run`；**无 `exclude`** | 新包的模板与需要偏离之处 |
| CI 门 | `.github/workflows/ci.yml:47,51,54,57` | `install --frozen-lockfile → build → typecheck → test` | lockfile 与 typecheck 脚本形态的硬约束 |
| 第二条 CI 门 | `.github/workflows/workflow-check.yml`, `checks/check_workflow.py` | PR 到 `dev` 时校验 spec packet 与 `tasks.md` 格式 | 本 spec 自身要过的门 |
| 子进程测试先例 | `apps/coding-agent/src/__tests__/workspace-safety.test.ts` | 用 `execFileSync` 起子进程做断言 | fixture 测试的写法依据 |

## Existing Patterns Read

- Files read: `packages/core/src/session.ts`、`packages/core/src/hook.ts`、`packages/adapters/package.json`、
  `packages/core/tsconfig.json`、`packages/core/vitest.config.ts`、`tsconfig.base.json`、
  `.github/workflows/ci.yml`、`.github/workflows/workflow-check.yml`、`checks/check_workflow.py`
- Tests read: `packages/tools/src/__tests__/tools.test.ts`、`apps/coding-agent/src/__tests__/workspace-safety.test.ts`
- Similar implementations: `packages/adapters`（本仓最近一次新建包，commit `05c718c`，10 个文件 + 329 行 lockfile）

## 设计方案

**包结构**

```
packages/transcript/
  package.json               # private:true, dependencies 为空, devDeps 挂 core/pi-ai
  tsconfig.json              # build：exclude __typecheck__ 与 __tests__
  tsconfig.typecheck.json    # exclude: [] —— 把断言与测试都纳入编译
  tsconfig.browser.json      # lib ES2022+DOM, types: [], exclude 同 build
  vitest.config.ts
  src/
    index.ts
    contract/
      index.ts
      core-mirror.ts                     # 必填闭包镜像
      watermark.ts                       # {seq, epoch} 透传水位 + 快照信封
      __typecheck__/core-mirror.assert.ts # 4 条双向断言
    __tests__/
      contract-drift.test.ts             # 5 个 fixture 子进程 tsc
      import-graph.test.ts               # runtime 图扫描 + dist 产物扫描
  typecheck-fixtures/                    # 包根，落在三个 tsconfig 的 include 之外
    01-mirror-missing-arm/
    02-mirror-extra-arm/
    03-mirror-missing-required-field/
    04-mirror-extra-required-field/
    05-node-global-probe/
```

**镜像形态：必填闭包，不是「可渲染子集」**

双向可赋值 ≈ 结构等价。能省的只有**可选字段**；`AssistantMessage` 的 8 个必填与 `Usage` 的 10 个数字
一个都跑不掉。省略清单（写进 `core-mirror.ts` 文件头）：

| 省略字段 | 出处 | 为什么省 |
| --- | --- | --- |
| `RunSummary.error?: Error` | `session.ts:253` | `Error` 是宿主类，不可结构化克隆，不应进浏览器契约 |
| `ToolExecResult.details?: unknown` | `hook.ts:45` | `unknown` 是断言盲区，留着等于自欺 |
| `ToolExecResult.newMessages?: Message[]` | `hook.ts:54` | 会把整条 `Message` union 拖进契约 |
| `AssistantMessage.responseModel? / responseId? / diagnostics? / errorMessage?` | pi-ai `types.d.ts` | provider 侧元数据，M0 无消费者 |
| `RunSummary.abortReason? / persistenceErrors?` | `session.ts:254-256` | 同上 |
| `TextContent.textSignature? / ThinkingContent.thinkingSignature? / ToolCall.thoughtSignature?` | pi-ai `types.d.ts` | 不透明的 provider 续话 blob，非渲染信息 |

**双向断言**

```ts
const _sessionEventCoreToMirror: MirrorSessionEvent = null as unknown as CoreSessionEvent;
const _sessionEventMirrorToCore: CoreSessionEvent = null as unknown as MirrorSessionEvent;
```

`SessionEvent` 与 `LiveEvent` 各两条，共 4 条。

**三段串联的 `typecheck`（相对其余 4 包的有意偏离）**

```
tsc -p . --noEmit && tsc -p tsconfig.typecheck.json && tsc -p tsconfig.browser.json
```

第一段等价于其余包；第二段把 `__typecheck__` 与 `__tests__` 纳入编译（`exclude: []`），是断言真正
被执行的地方；第三段是 browser 门。CI 只跑 `pnpm -r typecheck`，不写成串联则第二、三段永不执行。

**fixture 用类型手术，不复制镜像**

每个 fixture 6 行以内，用 `Exclude` / `Omit` / 交叉类型在真实镜像上做手术，因此镜像演化时 fixture
不需要跟着改：

| fixture | 手术 | 期望失败方向 |
| --- | --- | --- |
| 01 | `Exclude<MSessionEvent, {type:"continuation-check"}>` | `Core → Mirror` |
| 02 | `MSessionEvent \| {type:"ghost-arm"; whatever:string}` | `Mirror → Core` |
| 03 | `Omit<TurnEndArm, "toolResultsCount">` | `Mirror → Core` |
| 04 | `TurnStartArm & {ghostField:string}` | `Core → Mirror` |
| 05 | `process.env` + `Buffer.from()`，browser 配置 | 编译失败（证明 browser 门有判别力） |

## Product-to-Test Mapping

| Product invariant | Implementation area | Verification |
| --- | --- | --- |
| P1 runtime 图无 node/跨包说明符 | `src/**` | `import-graph.test.ts` |
| P2 `dependencies` 为空 | `package.json` | `import-graph.test.ts` |
| P3 `dist/` 0 处 core 引用 | `tsconfig.json` 的 `exclude` | `import-graph.test.ts`（读 `dist/`，缺失则**失败**而非跳过） |
| P4 core 新增 arm → 失败 | `__typecheck__/core-mirror.assert.ts` | fixture 01 + `contract-drift.test.ts` |
| P5 镜像多出 arm → 失败 | 同上 | fixture 02 |
| P6 core 新增必填字段 → 失败 | 同上 | fixture 03 |
| P7 core 删除字段 → 失败 | 同上 | fixture 04 |
| P8 断言不允许「存在但不被编译」 | `package.json` 的三段 `typecheck` | fixture 01-04 全部经由与 `tsconfig.typecheck.json` 同源的配置运行 |
| P9 两种盲区如实记录 | `core-mirror.assert.ts` 文件头 | `contract-drift.test.ts` 断言文件头含盲区说明 |
| P10 browser 门有判别力 | `tsconfig.browser.json` | fixture 05 |

## 数据流

本包在本 issue 阶段**只有类型，没有运行时逻辑**：无输入、无输出、无持久化、无外部调用。
`src/index.ts` 只做 re-export。运行时代码从 GH-166 开始。

## 备选方案

- **非对称 `Pick` 镜像**（只镜像可渲染子集，单向断言）：抓不住「core 删除字段」与「镜像多出 arm」两类漂移。
  其主张的好处（不把 `Error` / `Message[]` 拖进契约）在对称方案下同样成立——那些字段都是**可选**的，直接省略即可。
- **运行时 schema 校验（zod / typebox）**：把编译期问题推迟到运行时，且给 browser 包引入运行时依赖。否决。
- **不建独立包，直接在 `apps/coding-agent` 内做投影**：无法被 Electron renderer 复用，等于维持现状。否决。

## Dependencies And Configuration

- New dependencies: **无 runtime 依赖**。devDependencies: `@harness-pi/core`（`workspace:^`）、
  `@earendil-works/pi-ai`、`@types/node`、`typescript`、`vitest`——全部与其余包版本区间一致。
- New configuration: 新包的 4 个配置文件（3 个 tsconfig + vitest.config）；`pnpm-lock.yaml` 新增 importer 条目。
  **不动**根 `tsconfig.base.json`、`pnpm-workspace.yaml`（glob 已覆盖 `packages/*`）、任何 workflow 文件。
- Why existing project choices are insufficient: 其余 4 包 build 与 typecheck 共用同一个 tsconfig 且无
  `exclude`；本包必须 `exclude` 断言目录（否则 devDep 泄漏进 `dist`），因而必须补第二段 typecheck，
  否则断言不被编译。这是**有意偏离**，理由写进 PR 描述。
- `workspace:^` 而非其余包的 `workspace:*`：`*` 在 `pnpm pack` 时被替换成精确版本，会逼着 5 个包每次一起重发。

## 风险

- Security: 无。本包不含运行时代码、不碰 IO、不解析不可信输入。
- Compatibility: 新包不被任何现有包依赖，`pnpm -r` 拓扑序不受影响；不改动任何既有文件的行为。
- Performance: `typecheck` 由一段变三段，本包多两次 `tsc`；`test` 多 5 次子进程 `tsc`。CI 增量为秒级。
- Maintenance: fixture 用类型手术而非复制镜像，镜像演化时无需同步修改。
  **已知残留**：`ToolCall.arguments` 是 `Record<string, any>`，该字段不受断言保护，已在注释中标明。
- Agent surface drift: 无。

## 测试计划

- [ ] Unit tests: `contract-drift.test.ts`（5 个 fixture 子进程 `tsc`，全部期望非零退出；外加断言文件头
      含两种盲区说明）；`import-graph.test.ts`（runtime 图说明符/标识符扫描、`package.json` 的
      `dependencies` 为空、`dist/` 无 core 引用）。
- [ ] Integration tests: 无（本包此刻无运行时行为）。
- [ ] Manual verification: `pnpm -r build && pnpm -r typecheck && pnpm -r test` 全绿；
      `python3 checks/check_workflow.py --repo . --spec-dir specs/GH153` 通过。

## 回滚方案

整个改动是**新增文件 + lockfile**，不修改任何既有源文件。回滚 = 删除 `packages/transcript/` 与
`specs/GH153/`，`pnpm install` 重生 lockfile。无数据迁移、无下游依赖、无 feature flag 需要清理。
