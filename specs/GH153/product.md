# Product Spec: `@harness-pi/transcript` 空包骨架 + 内核事件镜像 + 双向编译期断言

## Linked Issue

GH-153

## 用户问题

内核对外有两条事件轨——coarse 的 `SessionEvent`（`packages/core/src/session.ts:56-64`，经 `runStreaming()`
暴露）与 fine 的 `LiveEvent`（同文件 `:77-103`，经 `session.on()` 订阅）。今天唯一把两轨归一的实现是 TUI
私有的 `apps/coding-agent/src/tui/event-bridge.ts` 的 append-only 动作流；headless 侧则完全另起炉灶
（`apps/coding-agent/src/output.ts:128` 直接把事件格式化成字符串）。

结果是：任何**非终端**的界面（菜西的 Electron renderer、未来的 web / iOS surface）都拿不到一份可复用的
「事件 → 可渲染状态」投影，只能各写一遍。而一旦各写一遍，内核事件加一个 arm 时，各端会**静默漏渲染**——
没有任何编译期或测试期信号。

本 issue 解决的是这个问题的**第一环**：先立一个 browser-safe 的投影包，并把「内核事件形状漂移」变成
**构建失败**，而不是运行时的空白区域。

## Assumptions

- 投影包必须能原样跑在浏览器与 Electron renderer 里，因此不能 import 内核、不能碰 node 内置、不能写盘。
- 内核事件类型会继续演化；镜像与内核之间需要一条自动化的绑定，而不是靠人记得同步。
- `{seq, epoch}` 的语义、发号权、journal 保留策略归 GH-154（host 常驻服务）；本包只透传。

## 目标

- 建立 `packages/transcript`（`@harness-pi/transcript`）包骨架，进 pnpm workspace，与其余 4 包同构。
- `src/contract/` 自持一套内核事件的**必填闭包镜像**，投影器（GH-166 / GH-167）只吃这套镜像。
- 用**双向**编译期 assignability 断言把镜像与内核绑住，并**验证这条断言本身有效**（四种漂移形态各一个反例）。
- 用 `tsconfig.browser.json` + import 图扫描双重保证 browser-safe，并**验证 browser 配置本身有判别力**。

## 非目标

- 不做任何 op / store / 投影器逻辑（→ GH-166 / GH-167）。
- 不触碰 `apps/coding-agent`（→ GH-168）。
- 不定义 L4 view registry、turn-cursor 分页、多 agent roster、订阅档位（已移出 M0，另立 issue）。
- 不自行分配 `seq`、不定义补帧协议（→ GH-154）。
- 不发布到 npm（包 day-1 设 `private`）。

## Agent Surface Impact

- [x] 无 surface-specific 行为。
- [ ] 影响 Codex instructions。
- [ ] 影响 Claude Code instructions。
- [ ] 影响 generic agent runner instructions。

## Behavior Invariants

1. 包的 runtime 图（`src/**`，排除 `__typecheck__` 与 `__tests__`）**只使用相对说明符**
   （`./` / `../`）。这是 allowlist 而非 denylist：denylist 挡不住内置子路径（`fs/promises`）、
   也挡不住自带 `.d.ts` 的第三方包（`import ts from "typescript"` 能同时溜过 denylist 与
   browser 门）。runtime 图另需 0 处 `process` / `Buffer` / `__dirname` / `__filename` / `global`
   标识符（含 `globalThis.process` 这种经宿主对象的访问）、0 处三斜线 `reference` 指令。
2. 包的 `dependencies` 为空；`@harness-pi/core` 与 `@earendil-works/pi-ai` 只出现在 `devDependencies`。
3. 构建产物 `dist/` 中 0 处非相对说明符、0 处三斜线 `reference` 指令、0 处 `__tests__` 落点。
   判定走 AST，不走文本包含——文件头那句「不能 import `@harness-pi/core`」会被 tsc 原样搬进
   `.js` 与 `.d.ts`，一句「我们不引用 X」不该被判成引用了 X。
   `__typecheck__` **会**出现在 `dist`，这是有意的（断言必须挂在 build 主路径上）：它 emit 出来是
   `export {}` 的空壳，由 `package.json` 的 `files` 中 `!**/__typecheck__/**` 挡在 tarball 外，
   两点都有测试钉住。
4. 当内核 `SessionEvent` / `LiveEvent` 新增一个**带新 discriminant 的** arm 而镜像未跟上时，
   `typecheck` 失败。限定词是必要的，见不变量 9 第 3 条盲区。
5. 当镜像**多出一个内核没有的 arm** 时，`typecheck` 失败。
6. 当内核闭包内**新增必填字段**而镜像未跟上时，`typecheck` 失败。
7. 当内核闭包内**删除字段**而镜像仍保留同名必填字段时，`typecheck` 失败。
8. 不变量 4-7 的**任何一种失效路径**都必须有测试变红。决定性的守门人是**注入式变异**：
   把 `src/contract/` 复制出去、在副本的镜像上制造真实漂移、连同**真实的**断言文件一起编译，
   断言非零退出且报错落在断言文件上。它证明的是「这个断言此刻真的在约束镜像」，因而一并堵死
   静态检查堵不住的假绿——`// @ts-nocheck`、逐条 `// @ts-ignore`、把 `CoreSessionEvent` 别名
   改指镜像自己。另有更廉价路径各配一条直接检查：断言被整体删除 / 被掏空、脚本退回单段或把
   `&&` 换成 `;`、`tsconfig.browser.json` 的 `types` / `exclude` 被放宽。
   不允许「断言存在但不被检查」这种假绿状态。
9. 以下漂移形态**整个断言体系都抓不住**（双向可赋值 + 键集 + arm 层键集三层），
   每条都经实测确认，必须写进断言文件头，不允许在文档或 AC 中宣称已覆盖：
   （1）内核新增的 arm **复用既有 discriminant** 且结构上是某个既有镜像 arm 的子类型；
   （2）`readonly` 修饰符漂移。
   这份清单是**已实测台账，不是穷举证明**——文档不得据此推断「未列出的形态一定抓得住」。
   台账的**证据形态**是一个期望**零**退出的 fixture（与期望非零退出的漂移反例对称），
   不是注释里的散文；某条盲区哪天变得抓得住，那个 fixture 会变红。

   **这份台账曾经有四条。** 另外两条（「新增可选字段」「镜像多出可选字段」）
   **不是变得抓得住了，是从来就抓得住、只是没写断言**——而台账把漏写记成了限制，
   于是 fixture 06 在**认证一句假话**（一条通过的测试，证明的是错误结论）。
   连续两轮栽在同一件事上，逐条记录见不变量 15。
10. `tsconfig.browser.json` 对 runtime 图编译通过；同时，一个使用 `process` / `Buffer` 的探针在
    **同一份** browser 配置下必须编译失败——fixture 必须 `extends` 真正的 `tsconfig.browser.json`，
    手抄一份 `lib` / `types` 副本只能证明 TypeScript 自身的行为，对本仓配置零判别力。
    `exclude` 那一半探针管不到（探针 program 里只有它自己），由 `--listFiles` 断言
    「browser program 不含 `@types/node` / `vitest` / `__tests__` / `__typecheck__`」钉住。
11. `dist/` 检查在 build **缺失**时必须失败而非跳过，在 build **半成品**（目录存在但无
    `.js` / `.d.ts`）时同样必须失败——否则三条产物断言会一起空集合恒过。
12. 包的**公开出口面**（`src/index.ts` → `src/contract/index.ts` 的 `export type *`）必须有测试
    钉住：本 issue 阶段这个包除了类型出口没有任何运行时行为，出口断链等于交付物归零。
13. import 扫描器的**每条分支**都必须有正向对照标本。runtime 图今天是 4 个纯类型文件、零命中，
    `expect(hits).toEqual([])` 对绝大多数分支恒真——分支写错了也永远发现不了。标本语料的命中
    集合必须**精确匹配**（不是「非空」），并配同名属性不被误报的负向对照。
14. 上面那张「被省略的可选字段」表是**手维护清单**，而本包的整个论点是「手维护的清单必须由机器
    钉住」——同一个包不该有两套标准。因此每一层的键集都必须写成编译期断言：省了哪些
    （`Exclude<keyof Core, keyof Mirror>` 必须精确等于清单）、多了哪些（必须等于 `never`）。
    它关掉的正是不变量 9 的（1）（2）在这些层上的那一半。

    **哪些层必须写**（判据，不是清单）：一个类型只要能用 `Extract` / 索引访问**拎成具体类型**，
    就必须给它写键集断言，不许算进盲区台账。据此当前已钉：7 个具名类型的顶层、
    `Usage["cost"]`、以及 `ToolExecResult.content` 的 text / image 两个变体。

    **覆盖边界必须如实写明，不许升格成「盲区已解决」，也不许把漏写讲成限制**：
    `SessionEvent` / `LiveEvent` 各 arm 里的匿名内联对象**拎不出统一形状**（`keyof` 作用在
    union 上得到各成员键的交集，实测 `keyof MirrorSessionEvent` 只有 `"type"`），这才是真限制；
    `keyof` 看不见 `readonly`，不变量 9 的（4）分毫未动。

    这一层必须有独立的变异验证，且**两个半边各一条**：镜像**删掉**一个可选字段（打
    `CoreOnlyKeys` 半边）、镜像**多出**一个可选字段（打 `MirrorOnlyKeys` 半边），
    两次都必须是键集断言报的错。另外 `SameKeys<A, B>` 在 `B` 为 `any` 且 `A` 非 `never`
    时真空成立（`A` 为 `never` 时 `tsc` 反而会报，别笼统写成「恒真」），因此还需一条静态检查
    逐条枚举每条断言的类型实参。**该检查只匹配字面量 `any`**，经类型别名间接引入的够不着——
    这条边界必须如实写明。

    **断言名单本身也不许手维护**：测试从 `core-mirror.ts` 的 AST 读出所有导出的 `interface`，
    要求每个都有配对的 `_omit*` / `_noExtra*`。否则删掉几条断言不会有任何信号。
15. **声称某一层「钉不住」之前，必须真的试着把它拎出来钉一遍。** 拎得动就是漏写，
    拎不动才是限制。这条不是风格建议——本 issue 连续两轮栽在它上面，两次都是三门 review
    同时实测证伪：
    - **第五轮**：把 `ToolExecResult.content` 这类具名类型内部嵌套的匿名对象，
      漏在「具名类型顶层 vs arm 内」的二分缝里，并归因为「`keyof` 的固有限制」。
    - **第六轮**：判据已经写对了，却转身宣称事件轨 arm「拎不出统一形状」——
      而 `typecheck-fixtures/03`、`04`、`06` 四处**自己就在用**
      `Extract<MirrorSessionEvent, {type:"turn-start"}>`。

    事件轨 arm 现由 `ArmKeyDrift` 这条 mapped type **机器枚举**钉死（不手写 14 条），
    诊断直接点名漂移的 arm。

## 验收标准

- [ ] `pnpm --filter @harness-pi/transcript build` / `typecheck` / `test` 全绿。
- [ ] `pnpm -r build && pnpm -r typecheck && pnpm -r test` 全绿。
- [ ] 四种漂移反例 fixture 各自 `tsc` 非零退出，由测试断言（同时断言**失败方向**，避免因
      无关原因假通过）。
- [ ] node 全局探针 fixture 在 browser 配置下 `tsc` 非零退出，由测试断言。
- [ ] 不变量 8 的所有失效路径逐条做过变异验证：人为制造该失效后，确有测试变红。清单见 `tech.md` 的变异验证记录段（**列表而非计数**——计数是手维护的，前两轮 review 各抓到它漂过一次）。
- [ ] 期望**零**退出的两个 fixture（06 盲区台账 / 07 公开出口面）各自编译干净。
- [ ] 键集断言的判别力经**对照实验**确认：只留双向可赋值断言、镜像删掉一个可选字段 → `tsc` 零退出
      零诊断（证明双向断言确实无感）；加回键集断言 → 变红。两次都实跑，不靠推理。
- [ ] 键集断言两个半边各有一条注入式变异（删可选字段 / 多出可选字段），且各自断言错在键集层。
- [ ] `ToolExecResult.content` 变体新增可选字段 → 变红（这一条修复前实测 `EXIT=0`）。
- [ ] 事件轨某个 arm 新增可选字段 → 变红，且诊断**点名那个 arm**（修复前实测 `EXIT=0`）。
- [ ] 删掉任意一条键集断言 → 完整性检查变红（名单由 AST 推导，不是手维护清单）。
- [ ] 扫描器每条分支都有正向对照标本，含 `bindingSourceIsHostGlobal` 的嵌套 / 数组 / 参数三个出口、
      `unwrap` 的 `NonNullExpression` 分支、元素访问的模板字面量形态。
- [ ] 扫描器标本语料的命中集合精确匹配，且同名属性不被误报。
- [ ] `pnpm-lock.yaml` 含 `packages/transcript` 的 importer 条目。
- [ ] `python3 checks/check_workflow.py --repo . --spec-dir specs/GH153` 通过。

## 边界情况

- **`types: []` 不等于 browser-safe**：它只关闭自动包含 `@types/*`，拦不住 `.d.ts` 里显式的
  `/// <reference types="node" />`。vite 的 `dist/node/index.d.ts` 就带这一行，因此 program 内只要有
  任何 `import ... from "vitest"` 的文件，`process` / `Buffer` 就会解析成功。browser tsconfig 必须
  `exclude` 掉 `__tests__` 与 `__typecheck__`。
- **`import type` 不会泄漏进 `dist`**。本 spec 早期版本据此反向推论、把 `__typecheck__` 从 build
  `exclude` 掉，又为了让断言仍被编译而加了第三个 tsconfig 与三段 `typecheck` 脚本——四层机械保证
  守一个不存在的问题。实测：带 emit 编译断言文件，产出的 `.d.ts` 字面就是 `export {};`，`.js` 里零
  import（`tsconfig.base.json` 未开 `verbatimModuleSyntax`）。真正需要 `exclude` 的只有 `__tests__`
  （那些文件 value-import `vitest` 与 `node:child_process`）。
- **`ToolCall.arguments` 在内核侧是 `Record<string, any>`**，`any` 让该字段成为断言盲区；镜像侧写
  `Record<string, unknown>` 是为了下游安全，不代表这个字段受断言保护。
- **union → union 的可赋值判定按「可赋值给**某个**目标成员」结算**，所以「新增 arm 一定抓得住」
  是错的：复用既有 discriminant、结构上是既有镜像 arm 子类型的兄弟 arm 会被吞掉（实测两向 `EXIT=0`）。
- **双向断言解析到的是 core 的构建产物 `packages/core/dist/*.d.ts`，不是源码**。因此严格讲防线是
  「内核漂移 → **core 重建之后**构建失败」。CI 里 `build` 先于 `typecheck` 所以成立；本地只跑
  `pnpm --filter @harness-pi/transcript typecheck` 会对着陈旧 dist 假绿。

## 发布说明

包 day-1 设 `"private": true`，不进 npm。GH-168 / GH-154 让 `apps/coding-agent` 或 host 依赖本包**之前**，
必须先摘掉 `private`——否则 `pnpm -r publish` 后下游装不上。`LICENSE` 与 `README.md` 已随本 issue 落地。
tarball 内容由 `npm pack --dry-run --json` 实测钉住（断言不含 `__typecheck__` / `__tests__` /
`typecheck-fixtures`，且含 `dist/index.d.ts`）。
