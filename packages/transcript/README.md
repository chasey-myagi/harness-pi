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
   由 `src/contract/__typecheck__/core-mirror.assert.ts` 钉住，**两层**：
   **双向 assignability 断言**管结构，**键集断言**（`SameKeys<Exclude<keyof Core, keyof Mirror>, …>`）
   管「省了哪些、多了哪些」。形状漂移 → 构建失败，而不是运行时的空白区域。
3. **水位只透传**。`{seq, epoch}` 的语义、发号权、补帧协议全部归 #154；本包不自造 `seq`。

## 为什么 `typecheck` 多一段

```
tsc -p . --noEmit && tsc -p tsconfig.browser.json
```

第一段与其余 4 包一致，双向断言就挂在里面——`tsconfig.json` 只 `exclude` 掉 `__tests__`，
所以每次 `build` 与每次 `typecheck` 都会编译断言。第二段是 browser 门。

> **一处曾经写错的地方，留个记号。** 早期版本声称「不 `exclude` `__typecheck__` 的话 devDep
> `@harness-pi/core` 会泄漏进 `dist`」，并据此加了第三个 tsconfig、三段脚本和两条守它们的测试。
> **那句话是错的**：`import type` 会被完全擦除，实测 emit 出来的 `.d.ts` 字面就是 `export {};`。
> 四层机械保证守着一个不存在的问题，现已全部删除。代价换成了 `dist/` 里一个死文件
> （`.d.ts` 字面是 `export {};`，`.js` 是注释加一批死变量，每条断言一个），由 `files` 的
> `!**/__typecheck__/**` 挡在 tarball 外——用 `npm pack --dry-run` 实测钉住，不是对 `files`
> 数组做字符串匹配。

## 防线与守门人

每条保证都配一条证明「它被绕过时会红」的测试，见 `src/__tests__/contract-drift.test.ts`
文件头的对照表。最强的一条是**注入式变异**：把 `src/contract/` 整树复制出去、在副本的镜像上
制造真实漂移、连同**真实的**断言文件一起编译，断言非零退出且报错落在断言文件上。它证明的不是
「断言长得对」，而是「断言此刻真的在约束镜像」——因而一并堵死 `// @ts-nocheck`、逐条
`// @ts-ignore`、把 `CoreSessionEvent` 别名改指镜像自己这些静态检查堵不住的绕过。

`typecheck-fixtures/` 下 7 个 fixture 分两类：

- **期望 `tsc` 非零退出**：01-04 是四种漂移反例（用 `Exclude` / `Omit` / `Extract` 在真实镜像与
  真实内核类型上做类型手术，镜像演化时无需同步修改），05 是 browser 门的 node 全局探针
  （`extends` 真正的 `tsconfig.browser.json`，不是手抄副本）。
- **期望 `tsc` 零退出**：06 是盲区台账的可执行形态（编译通过**不是**好事，是在如实记录防线边界），
  07 验证公开类型面能从包入口拿到——源码与 `dist` 两条路径各一份。

另有 `typecheck-fixtures/scanner-corpus/`：给 import 扫描器的标本语料，不被编译。测试断言扫描器
在它上面的命中集合**精确等于**预期，并配同名属性不被误报的负向对照。

**为什么要第二层（键集断言）**：双向可赋值断言对**可选**字段完全无感——core 新增一个可选字段、
或镜像多出一个，两个方向都过（实测 `EXIT=0`、零诊断）。而 `core-mirror.ts` 文件头那张「被省略的
可选字段」表原本是**手维护清单**，与本包「手维护的清单必须由机器钉住」的整个论点自相矛盾。
键集断言把那张表写成了类型。

**覆盖边界的判据**：一个类型只要能用 `Extract` / 索引访问**拎成具体类型**，就必须写键集断言，
不许算进盲区台账。据此已钉：具名类型顶层、`Usage["cost"]`、`ToolExecResult.content` 的
text / image 两变体，以及**事件轨的每一个 arm**——最后这层用一条 mapped type（`ArmKeyDrift`）
让 TypeScript 自己枚举 `C["type"] | M["type"]`，加 arm 删 arm 都自动跟上，不是手写清单。
诊断会直接点名漂移的 arm：`Type '"turn-start"' is not assignable to type 'never'`。

> **同一个失败模式连续栽了两轮，记在这里。** 第五轮：写「只到具名类型顶层」，
> 把 `ToolExecResult.content` 漏在缝里。第六轮：判据改对了，却转身宣称事件轨 arm
> 「拎不出统一形状」——而 fixture 03/04/06 自己就在用 `Extract<MirrorSessionEvent, {type:"turn-start"}>`。
> 两次都是三门 review 同时实测证伪。
> **教训不是「再仔细一点」，是：声称某处钉不住之前，先真的试着把它拎出来钉一遍。**

**已实测的盲区台账**在 `core-mirror.assert.ts` 文件头，**只剩两条**：复用既有 discriminant 的
兄弟 arm、`readonly` 修饰符漂移。台账曾经有四条，另外两条经实测证明是「漏写」不是「限制」，
已补上断言——那两条曾让 fixture 06 变成一条**认证假话的通过测试**。
那份清单是实测台账，不是穷举证明。

## 发布前置

包 day-1 是 `private`（npm 发布押后）。#168 / #154 让 `apps/coding-agent` 或 host 依赖本包
**之前**，必须先摘掉 `private`。`LICENSE` 与 `README.md` 已随本 issue 落地。
