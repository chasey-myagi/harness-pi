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
3. 构建产物 `dist/` 中 0 处非相对说明符、0 处三斜线 `reference` 指令、0 处 `__typecheck__` /
   `__tests__` 落点。判定走 AST，不走文本包含——文件头那句「不能 import `@harness-pi/core`」
   会被 tsc 原样搬进 `.js` 与 `.d.ts`，一句「我们不引用 X」不该被判成引用了 X。
4. 当内核 `SessionEvent` / `LiveEvent` 新增一个**带新 discriminant 的** arm 而镜像未跟上时，
   `typecheck` 失败。限定词是必要的，见不变量 9 第 3 条盲区。
5. 当镜像**多出一个内核没有的 arm** 时，`typecheck` 失败。
6. 当内核闭包内**新增必填字段**而镜像未跟上时，`typecheck` 失败。
7. 当内核闭包内**删除字段**而镜像仍保留同名必填字段时，`typecheck` 失败。
8. 不变量 4-7 的**任何一种失效路径**都必须有测试变红。已实测覆盖的失效路径共五条：
   断言文件被整体删除、断言被**掏空**（留注释删声明）、`typecheck` 脚本退回单段形式、
   `tsconfig.typecheck.json` 的 `exclude: []` 被删、`tsconfig.browser.json` 的 `types` / `exclude`
   被放宽。不允许「断言存在但不被编译」这种假绿状态。
9. 以下漂移形态**两个方向都抓不住**，每条都经实测确认，必须写进断言文件头，不允许在文档或
   AC 中宣称已覆盖：
   （1）闭包内**任意层级**新增可选字段（注意是任意层级，`Usage.cost` 加可选字段同样隐形）；
   （2）镜像多出内核没有的可选字段；
   （3）内核新增的 arm **复用既有 discriminant** 且结构上是某个既有镜像 arm 的子类型；
   （4）`readonly` 修饰符漂移。
   这份清单是**已实测台账，不是穷举证明**——文档不得据此推断「未列出的形态一定抓得住」。
10. `tsconfig.browser.json` 对 runtime 图编译通过；同时，一个使用 `process` / `Buffer` 的探针在
    **同一份** browser 配置下必须编译失败——fixture 必须 `extends` 真正的 `tsconfig.browser.json`，
    手抄一份 `lib` / `types` 副本只能证明 TypeScript 自身的行为，对本仓配置零判别力。
    `exclude` 那一半探针管不到（探针 program 里只有它自己），由 `--listFiles` 断言
    「browser program 不含 `@types/node` / `vitest` / `__tests__` / `__typecheck__`」钉住。
11. `dist/` 检查在 build **缺失**时必须失败而非跳过，在 build **半成品**（目录存在但无
    `.js` / `.d.ts`）时同样必须失败——否则三条产物断言会一起空集合恒过。

## 验收标准

- [ ] `pnpm --filter @harness-pi/transcript build` / `typecheck` / `test` 全绿。
- [ ] `pnpm -r build && pnpm -r typecheck && pnpm -r test` 全绿。
- [ ] 四种漂移反例 fixture 各自 `tsc` 非零退出，由测试断言（同时断言**失败方向**，避免因
      无关原因假通过）。
- [ ] node 全局探针 fixture 在 browser 配置下 `tsc` 非零退出，由测试断言。
- [ ] 不变量 8 列的五条失效路径逐条做过变异验证：人为制造该失效后，确有测试变红。
- [ ] `pnpm-lock.yaml` 含 `packages/transcript` 的 importer 条目。
- [ ] `python3 checks/check_workflow.py --repo . --spec-dir specs/GH153` 通过。

## 边界情况

- **`types: []` 不等于 browser-safe**：它只关闭自动包含 `@types/*`，拦不住 `.d.ts` 里显式的
  `/// <reference types="node" />`。vite 的 `dist/node/index.d.ts` 就带这一行，因此 program 内只要有
  任何 `import ... from "vitest"` 的文件，`process` / `Buffer` 就会解析成功。browser tsconfig 必须
  `exclude` 掉 `__tests__` 与 `__typecheck__`。
- **断言目录被 build tsconfig `exclude` 后，`tsc -p . --noEmit` 同样跳过它**。若 `typecheck` 脚本照抄
  其余 4 包的单段形式，断言在 CI 里根本不会被编译。
- **`ToolCall.arguments` 在内核侧是 `Record<string, any>`**，`any` 让该字段成为断言盲区；镜像侧写
  `Record<string, unknown>` 是为了下游安全，不代表这个字段受断言保护。
- **union → union 的可赋值判定按「可赋值给**某个**目标成员」结算**，所以「新增 arm 一定抓得住」
  是错的：复用既有 discriminant、结构上是既有镜像 arm 子类型的兄弟 arm 会被吞掉（实测两向 `EXIT=0`）。
- **双向断言解析到的是 core 的构建产物 `packages/core/dist/*.d.ts`，不是源码**。因此严格讲防线是
  「内核漂移 → **core 重建之后**构建失败」。CI 里 `build` 先于 `typecheck` 所以成立；本地只跑
  `pnpm --filter @harness-pi/transcript typecheck` 会对着陈旧 dist 假绿。

## 发布说明

包 day-1 设 `"private": true`，不进 npm。GH-168 / GH-154 让 `apps/coding-agent` 或 host 依赖本包**之前**，
必须先摘掉 `private` 并补 `LICENSE` 与 `README.md`——否则 `pnpm -r publish` 后下游装不上。
