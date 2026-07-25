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
  tsconfig.json              # build + typecheck：只 exclude __tests__（断言在主路径上）
  tsconfig.browser.json      # lib ES2022+DOM, types: [], 额外 exclude __typecheck__
  vitest.config.ts
  src/
    index.ts
    contract/
      index.ts
      core-mirror.ts                     # 必填闭包镜像
      watermark.ts                       # {seq, epoch} 透传水位 + 快照信封
      __typecheck__/core-mirror.assert.ts # 双向可赋值断言 + 键集钉死
    __tests__/
      contract-drift.test.ts             # 注入式变异 + fixture 子进程 tsc
      import-graph.test.ts               # runtime 图扫描 + dist 产物扫描
  typecheck-fixtures/                    # 包根，落在两个 tsconfig 的 include 之外
    01-mirror-missing-arm/                 # 期望非零退出
    02-mirror-extra-arm/
    03-mirror-missing-required-field/
    04-mirror-extra-required-field/
    05-node-global-probe/
    06-blind-spots/                        # 期望**零**退出：盲区台账的可执行形态
    07-public-surface/                     # 期望**零**退出：包入口出口面
    scanner-corpus/                        # 不编译，只给 import 扫描器当标本
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

`SessionEvent` 与 `LiveEvent` 各两条；pi-ai 三个叶子类型各两条（拓扑上冗余，为的是让 pi-ai 的版本漂移
直接报在自己头上，而不是伪装成一条 `SessionEvent` 的错）。

**键集钉死：把上面那张省略表从散文变成断言**

上面那张「被省略的可选字段」表原本是**手维护清单**——而本包的整个论点就是「手维护的清单必须由机器钉住」，
同一个包不该有两套标准。所以每个具名类型的顶层键集也写成断言：

```ts
type OmittedKeys<Core, Mirror> = Exclude<keyof Core, keyof Mirror>;
type ExtraKeys<Core, Mirror> = Exclude<keyof Mirror, keyof Core>;
/** 双向 extends：多一个少一个都不行 */
type SameKeys<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const _omitToolExecResult: SameKeys<
  OmittedKeys<CoreToolExecResult, MirrorToolExecResult>,
  "details" | "newMessages"
> = true;
```

它**关掉了盲区 1 与盲区 2 在具名类型顶层的那一半**：core 新增可选字段、或镜像多出可选字段，
双向可赋值断言对此**完全无感**（实测两个方向都 `EXIT=0`），键集断言会让 `Exclude` 多出一项、
编译失败。

**覆盖边界（不许过度声称）**：`keyof` 只看顶层，且作用在 union 上得到的是各成员键的**交集**
（实测 `keyof MirrorSessionEvent` 只有 `"type"`）。所以：

| | 已钉 | 未钉 |
| --- | --- | --- |
| 8 个具名类型的顶层键集（含 `Usage["cost"]` 那一层） | ✅ | |
| `SessionEvent` / `LiveEvent` 各 arm 里的**匿名内联对象** | | ❌ 仍是盲区，fixture 06 记的就是这一层 |
| `readonly` 修饰符漂移 | | ❌ `keyof` 看不见修饰符 |

**两段串联的 `typecheck`（相对其余 4 包的唯一脚本偏离）**

```
tsc -p . --noEmit && tsc -p tsconfig.browser.json
```

第一段等价于其余包，**双向断言就挂在里面**——`tsconfig.json` 只 `exclude` 掉 `__tests__`，
断言目录留在主路径上，因此 `build` 与 `typecheck` 都会编译它。第二段是 browser 门。

> **修正记录**：早期版本用的是三段，第二段 `tsconfig.typecheck.json` 存在的理由是
> 「不 `exclude` `__typecheck__` 的话 devDep `@harness-pi/core` 会泄漏进 `dist`」。
> 这句话**是错的**——`import type` 被完全擦除，实测 emit 出的 `.d.ts` 字面就是 `export {};`，
> `.js` 里零 import（`tsconfig.base.json` 未开 `verbatimModuleSyntax`）。那条假前提曾撑起
> 一个额外 tsconfig、一段额外脚本和两条只为守它们而存在的测试。现已全部删除；
> 代价换成 `dist/` 里一个 `export {}` 的死文件，由 `files` 的 `!**/__typecheck__/**` 挡在 tarball 外。

**fixture 用类型手术，不复制镜像**

每个 fixture 6 行以内，用 `Exclude` / `Omit` / 交叉类型在真实镜像上做手术，因此镜像演化时 fixture
不需要跟着改：

| fixture | 手术 | 期望失败方向 |
| --- | --- | --- |
| 01 | `Exclude<MSessionEvent, {type:"continuation-check"}>` | `Core → Mirror` |
| 02 | `MSessionEvent \| {type:"ghost-arm"; whatever:string}` | `Mirror → Core` |
| 03 | `Omit<TurnEndArm, "toolResultsCount">` | `Mirror → Core` |
| 04 | `TurnStartArm & {ghostField:string}` | `Core → Mirror` |
| 05 | `process.env` + `Buffer.from()`，`extends` 真正的 `tsconfig.browser.json` | 编译失败（证明 browser 门有判别力） |
| 06 | 四种已实测盲区各写一对双向断言 | **编译通过**——台账的可执行形态，与 01-04 对称 |
| 07 | 从包入口 import 全部公开类型并各用一次 | **编译通过**——出口断链会让它变红 |

fixture 05 **必须 `extends` 真配置**，不能手抄 `lib` / `types`。抄副本的话，把
`tsconfig.browser.json` 的 `types` 放宽或 `exclude` 改坏时探针纹丝不动——守门人守的是它自己。
`exclude` 那一半探针管不到（它的 program 里只有 `probe.ts`），由 `--listFiles` 断言补上。

## Product-to-Test Mapping

| Product invariant | Implementation area | Verification |
| --- | --- | --- |
| P1 runtime 图只用相对说明符 + 无 node 全局 + 无三斜线 reference | `src/**` | `import-graph.test.ts`「runtime 图 browser-safe」+「扫描器本身有判别力」两个 describe |
| P2 `dependencies` 为空 | `package.json` | `import-graph.test.ts`「包元数据」 |
| P3 `dist/` 无非相对说明符 / 无 reference 指令 / 无 `__tests__` 落点；断言产物是空壳且被 `files` 挡在 tarball 外 | `tsconfig.json` 的 `exclude` + `package.json` 的 `files` | `import-graph.test.ts`「构建产物」（AST 判定，非文本包含） |
| P4 core 新增**新 discriminant** arm → 失败 | `__typecheck__/core-mirror.assert.ts` | fixture 01 |
| P5 镜像多出 arm → 失败 | 同上 | fixture 02 |
| P6 core 新增必填字段 → 失败 | 同上 | fixture 03 |
| P7 core 删除字段 → 失败 | 同上 | fixture 04 |
| P8 断言不可被绕过 | `__typecheck__` 留在主路径 + `package.json` 的 `typecheck` | **注入式变异**（决定性）：复制 `src/contract/` → 在副本镜像上制造真实漂移 → 连同真实断言文件一起编译 → 断言非零退出且报错落在断言文件上。它一并堵死 `@ts-nocheck`、逐条 `@ts-ignore`、别名改指镜像自己。外加静态检查（无抑制指令、确实从内核 import）与脚本形态断言（`&&` 串联两段） |
| P9 盲区如实记录、且声明为实测台账 | `core-mirror.assert.ts` 文件头 + fixture 06 | fixture 06（期望**零**退出，台账的可执行形态）。**刻意没有文本断言**：台账是一件「盲区变得抓得住就该更新」的东西，给它装 `toContain` 绊网只会让每次正常措辞调整都变红，且失败信息什么都不告诉人。台账被整段删掉时 fixture 06 会红。 |
| P10 browser 门有判别力 | `tsconfig.browser.json` | fixture 05（`extends` 真配置）+ `--listFiles` 断言（正向锚点 `core-mirror.ts` 在 program 内、无 `@types/node` / `vitest` / `__tests__` / `__typecheck__`） |
| P11 dist 缺失/半成品都失败 | — | `import-graph.test.ts`「dist/ 存在且不为空」 |
| P12 公开出口面不断链 | `src/index.ts` / `src/contract/index.ts` 的 `export type *` | fixture 07（期望**零**退出） |
| P13 扫描器每条分支有正向对照 | `typecheck-fixtures/scanner-corpus/` | 「扫描器本身有判别力」——命中集合**精确匹配**，外加同名属性不误报的负向对照 |
| P14 具名类型顶层键集钉死（省略清单不再是手维护散文） | `__typecheck__/core-mirror.assert.ts` 的 `SameKeys<OmittedKeys<…>>` / `SameKeys<ExtraKeys<…>, never>` | **注入式变异第 5 条**：在副本镜像上删掉 `ToolExecResult.isError?` 这个**可选**字段 → 断言 `tsc` 非零退出，且诊断文本含 `Type 'true' is not assignable to type 'never'`（这句只可能来自 `SameKeys`，因此证明是键集层抓的，不是别的层顺手抓的）。另有对照实验：同一变异下只留 4 条双向断言时 `tsc` **零退出、零诊断** |

**变异验证记录**——每条都实跑过（人为制造该失效 → 确认对应测试变红 → 还原）。
**列表而不是计数**：计数是手维护的，前两轮 review 各抓到它漂过一次。

- 掏空断言（留注释删声明）
- 断言加 `// @ts-nocheck`（静态检查与注入式变异各抓一次）
- 把 `CoreSessionEvent` 别名改指镜像自己
- `typecheck` 退回单段形式 / 把 `&&` 换成 `;`
- browser 门 `types: ["node"]` / `exclude: []`
- runtime 图混入 `import ts from "typescript"`
- `dist/` 清空（半成品 build）
- `src/index.ts` 改成 `export {}`
- 拆掉扫描器的 `ImportEquals` 分支
- 拆掉 shorthand 例外 / 拆掉宿主全局解构例外 / 把解构例外做过头（负向对照抓）
- `MirrorLiveEvent` 换成 `any`
- `files` 去掉 `!**/__typecheck__/**`（`npm pack` 实测抓）
- fixture 03 失去漂移（验合并 project 的逐条文件锚点）
- 镜像删掉一个**可选**字段（验键集断言——双向断言对这种完全无感）

## 数据流

本包在本 issue 阶段**只有类型，没有运行时逻辑**：无输入、无输出、无持久化、无外部调用。
`src/index.ts` 只做 re-export。运行时代码从 GH-166 开始。

## 备选方案

- **直接转发内核类型**（`export type { SessionEvent, LiveEvent } from "@harness-pi/core"`，不建镜像）
  —— **这是最强的一条对手，必须认真否决而不是略过**。它的诱惑力很实在：没有镜像就没有漂移，
  于是四条盲区台账、四条双向断言、五个 fixture、`core-mirror.ts` 那张 12 行省略字段表**全部蒸发**。
  而且它在技术上是可行的：实测 `import type { SessionEvent, LiveEvent } from "@harness-pi/core"`
  在**本仓自己那份 `tsconfig.browser.json`**（`lib: ["ES2022","DOM"]` + `types: []`）下 `EXIT=0`，
  core 连同 pi-ai 的类型闭包在类型层面确实是 browser-safe 的；`import type` 被完全擦除，运行时零字节。

  **否决理由不是「browser 不安全」，是「这份契约要跨序列化边界」。** 本包的消费面是 #154 的
  host↔surface 通道（WS / JSON）与 Electron 的 renderer 边界，内核类型里有三样东西过不去：
  `RunSummary.error?: Error`（宿主类，`JSON.stringify` 后只剩 `{}`，`structuredClone` 会抛）、
  `ToolExecResult.details?: unknown`（消费者无从解构）、`ToolExecResult.newMessages?: Message[]`
  （把整条 `Message` union 连同 `toolResult` / `user` 分支拖进 UI 契约）。转发方案下这些字段
  **在类型上存在但在传输后不存在**，是最难查的一类 bug；镜像方案下它们从签名里就不存在。

  次要代价：转发会让 `dist/*.d.ts` 带上非相对说明符，消费者必须能解析 core 的类型，
  等于 core 成为类型层面的 peer dependency，本 spec 的「`dependencies` 为空」不变量要重写。

  **若 #167 发现镜像维护成本高于预期，这条应当被重新评估**——重估的判据是「契约是否仍需跨进程」，
  不是「镜像烦不烦」。
- **非对称 `Pick` 镜像**（只镜像可渲染子集，单向断言）：抓不住「core 删除字段」与「镜像多出 arm」两类漂移。
  其主张的好处（不把 `Error` / `Message[]` 拖进契约）在对称方案下同样成立——那些字段都是**可选**的，直接省略即可。
- **运行时 schema 校验（zod / typebox）**：把编译期问题推迟到运行时，且给 browser 包引入运行时依赖。否决。
- **不建独立包，直接在 `apps/coding-agent` 内做投影**：无法被 Electron renderer 复用，等于维持现状。否决。

## Dependencies And Configuration

- New dependencies: **无 runtime 依赖**。devDependencies: `@harness-pi/core`（`workspace:*`，同房规）、
  `@earendil-works/pi-ai`、`@types/node`、`typescript`、`vitest`——全部与其余包版本区间一致。
- New configuration: 新包的 3 个配置文件（`tsconfig.json` + `tsconfig.browser.json` + `vitest.config.ts`），
  外加 `typecheck-fixtures/` 下两个合并 project 的 tsconfig；`pnpm-lock.yaml` 新增 importer 条目；
  根 `.gitignore` 加一行 `.mutation-tmp/`。
  **不动**根 `tsconfig.base.json`、`pnpm-workspace.yaml`（glob 已覆盖 `packages/*`）、任何 workflow 文件。
- Why existing project choices are insufficient: 相对其余 4 包共**三处**有意偏离，逐条写进 PR 描述——
  (1) `tsconfig.json` 有 `exclude`（其余 4 包都没有，`packages/core/dist/__tests__` 就是这么来的），
  只排除 `__tests__`；(2) `typecheck` 多一段 browser 门；(3) `exports` 多一个 `./package.json` 出口。
- 依赖协议**沿用房规 `workspace:*`**。曾短暂改成 `workspace:^`，理由是「`*` 在 `pnpm pack` 时被替换成
  精确版本，会逼着 5 个包每次一起重发」——但本包是 `private: true`，且 `@harness-pi/core` 是它的
  **devDependency**，永远不会被 pack 或 publish，那条替换行为对它不可能发生。偏离房规而理由用不上，
  正是 cargo cult 的形状，已改回。摘掉 `private` 时再连同其余 4 包一起讨论。

## 风险

- Security: 无。本包不含运行时代码、不碰 IO、不解析不可信输入。
- Compatibility: 新包不被任何现有包依赖，`pnpm -r` 拓扑序不受影响；不改动任何既有文件的行为。
- Performance: `typecheck` 由一段变两段（多一次 browser 门 `tsc`）。`test` 起 **9 次 `tsc` 子进程**
  （4 次注入式变异含对照组 / 1 次主 tsconfig 正向对照 / 1 次 01-04 合并 project / 1 次 06-07 合并
  project / 1 次 05 探针 / 1 次 browser `--listFiles`）外加 1 次 `npm pack --dry-run`。
  **实测耗时**（本机、`packages/transcript` 内 `vitest run`、机器空闲）：3.5–4.1s，单条最慢约 0.4s，
  `vitest.config.ts` 的 `testTimeout` 是 60s。**但这个数字对并发负载很敏感**——review 期间三个
  reviewer agent 同时跑时，同一套测试被测到 85s、单条最慢 16s。CI 上 `pnpm -r test` 并发加载时更接近
  后者，60s 的余量不像空闲态看上去那么宽。
  01-04 合并成一个 project 是这轮把 spawn 从 13 降到 9 的主要来源，且判别力更强：锚点从「进程退出码」
  换成「诊断落在哪个文件上」，逐条钉死落点，而不是「有一条报错就算过」。若日后仍成瓶颈，
  注入式变异那 4 次是下一个合并对象。
- Maintenance: fixture 用类型手术而非复制镜像，镜像演化时无需同步修改。
  **一处前瞻性冲突**：`ToolExecResult.details?: unknown`（`hook.ts:43-46`）被省略的理由是「`unknown`
  是断言盲区」，但内核那边的注释写明这个字段存在的目的正是「truncation / diff / fullOutputPath 等
  UI / trace 需要」——也就是本包的用途。M0 省掉它是对的（没有消费者，且 `unknown` 确实不受断言保护），
  但 #167 的投影器很可能需要它。届时的正确做法是给它一个**结构化的**镜像类型，而不是原样搬 `unknown`。
  这条写在这里，免得 #167 重新发现一遍。
  **已知残留**：`ToolCall.arguments` 是 `Record<string, any>`，该字段不受断言保护，已在注释中标明。
- Agent surface drift: 无。

## 测试计划

- [ ] Unit tests: `contract-drift.test.ts` —— 注入式变异（对照组 + 删 arm + 删深层必填字段 +
      改坏 LiveEvent arm + 删可选字段验键集断言）、主 tsconfig 与 browser 门的正向对照（各带
      `--listFiles` 锚点）、fixture 01-05（期望非零退出）与 06-07（期望零退出）、断言的静态完整性
      （无抑制指令 / 确实从内核 import / 声明齐全）、`typecheck` 脚本形态。
      `import-graph.test.ts` —— runtime 图 allowlist 扫描、扫描器标本语料的精确命中匹配 + 负向对照、
      包元数据、构建产物（含 `npm pack --dry-run` 实测 tarball）。
      **刻意不写条数**：手维护的计数是本包最容易漂的东西，前两轮 review 各抓到一次。
- [ ] Integration tests: 无（本包此刻无运行时行为）。
- [ ] Manual verification: `pnpm -r build && pnpm -r typecheck && pnpm -r test` 全绿；
      `python3 checks/check_workflow.py --repo . --spec-dir specs/GH153` 通过。

## 回滚方案

整个改动是**新增文件 + lockfile**，不修改任何既有源文件。回滚 = 删除 `packages/transcript/` 与
`specs/GH153/`，`pnpm install` 重生 lockfile。无数据迁移、无下游依赖、无 feature flag 需要清理。
