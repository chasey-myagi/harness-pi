# `@harness-pi/transcript`

双轨事件的 **browser-safe** 投影层。把内核的 coarse `SessionEvent`（经 `runStreaming()`）与
fine `LiveEvent`（经 `session.on()`）两条轨归一成可渲染状态，让终端之外的界面
（Electron renderer / web / 未来的 iOS surface）复用同一份投影，而不是各写一遍。

> **当前状态（#153，M0 第一环）**：包内**只有类型**，没有运行时逻辑。
> L1 store 与 L2 幂等 op 随 #166、双轨投影器与 web 重放 demo 随 #167、
> TUI 影子对拍随 #168。

## 三条不变量

1. **不 import 内核**。`dependencies` 为空；`@harness-pi/core` 与 `@earendil-works/pi-ai`
   只出现在 `devDependencies`，且只被断言目录使用。包要能原样跑在浏览器里。
2. **镜像与内核靠编译期绑住**。`src/contract/core-mirror.ts` 是内核事件的**必填闭包镜像**，
   由 `src/contract/__typecheck__/core-mirror.assert.ts` 的**双向** assignability 断言钉住。
   形状漂移 → 构建失败，而不是运行时的空白区域。
3. **水位只透传**。`{seq, epoch}` 的语义、发号权、补帧协议全部归 #154；本包不自造 `seq`。

## 为什么 `typecheck` 是三段

```
tsc -p . --noEmit && tsc -p tsconfig.typecheck.json && tsc -p tsconfig.browser.json
```

其余 4 个包 build 与 typecheck 共用同一个 tsconfig。本包的 build tsconfig 必须
`exclude` 掉 `__typecheck__`（否则 devDep `@harness-pi/core` 会泄漏进 `dist`），
于是 `tsc -p . --noEmit` 也跳过断言目录——而 CI 只跑 `pnpm -r typecheck`。
不串联，双向断言永不被编译。

变异验证：删掉镜像的 `continuation-check` arm 后，三段脚本 `exit=2`，单段脚本 `exit=0`。

## 防线与守门人

每条保证都配一条证明「它被绕过时会红」的测试，见 `src/__tests__/contract-drift.test.ts`
文件头的对照表。`typecheck-fixtures/` 下 5 个 fixture 各自期望 `tsc` **非零退出**：
01-04 是四种漂移反例（用 `Exclude` / `Omit` / 交叉类型在真实镜像上做类型手术，镜像演化时
无需同步修改），05 是 browser 门的 node 全局探针。

**已实测的盲区台账**在 `core-mirror.assert.ts` 文件头——包括「复用既有 discriminant 的
兄弟 arm 两个方向都抓不住」这一条，它是上表第一行必须带限定词的原因。那份清单是实测台账，
不是穷举证明。

## 发布前置

包 day-1 是 `private`。#168 / #154 让 `apps/coding-agent` 或 host 依赖本包**之前**，
必须先摘掉 `private` 并补 `LICENSE`。
