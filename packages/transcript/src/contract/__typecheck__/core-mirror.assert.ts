/**
 * 镜像 ↔ 内核的**双向** assignability 断言。
 *
 * 这个目录被 `tsconfig.json` 的 `exclude` 排除（否则 devDep `@harness-pi/core` 会泄漏进
 * `dist`，违反 browser-safe），因此它**只在 `tsconfig.typecheck.json` 下被编译**。
 * `package.json` 的 `typecheck` 脚本必须串联那份配置——CI 只跑 `pnpm -r typecheck`，
 * 断言若不被编译，整条契约就是一纸空文。
 *
 * ## 四种能抓住的漂移
 *
 * | 漂移形态 | 哪个方向抓得住 | 反例 fixture |
 * | --- | --- | --- |
 * | core 新增一个 arm，**且它的 discriminant 是新的** | `Core → Mirror`（宽赋窄失败） | `01-mirror-missing-arm` |
 * | 镜像多出一个 core 没有的 arm | `Mirror → Core` | `02-mirror-extra-arm` |
 * | core 闭包内某处新增**必填**字段 | `Mirror → Core`（缺必填属性） | `03-mirror-missing-required-field` |
 * | core 闭包内某处删除字段 | `Core → Mirror` | `04-mirror-extra-required-field` |
 *
 * 第一行的限定词是必要的，不是保守措辞：union→union 的可赋值判定是「每个源成员可赋值给
 * **某个**目标成员」，新 arm 只要在结构上是某个既有镜像 arm 的子类型，就会被那个 arm 吞掉。
 *
 * ## 抓不住的盲区（每条都实测过，不许假装覆盖了）
 *
 * 1. **闭包内任意层级新增可选字段** —— 镜像不跟上，两个方向都过。注意是「任意层级」而不是
 *    「某个 arm」：`Usage.cost` 加一个可选字段同样隐形（实测 `EXIT=0`）。
 * 2. **镜像多出一个 core 没有的可选字段** —— 同样两个方向都过（实测 `EXIT=0`）。
 * 3. **core 新增的 arm 复用既有 discriminant，且结构上是某个既有镜像 arm 的子类型** ——
 *    典型形态是「同 `type` 值、多几个必填字段」的兄弟 arm。实测：给 core 并上
 *    `{ type: "error"; phase: ...; message: string; code: number }` 后两个方向都 `EXIT=0`。
 *    这是上表第一行那个限定词的来源。
 * 4. **`readonly` 修饰符漂移** —— `{ readonly x: number }` 与 `{ x: number }` 互相可赋值，
 *    整层加/去 `readonly` 两个方向都过（实测 `EXIT=0`）。
 *
 * 前两条是 `core-mirror.ts` 能大方省略一串可选字段的原因，也正因如此它们无法同时被当成防线。
 * 四条都只能靠 `session.ts:49-50` 与 `:74-75` 已有的 exhaustive-switch 纪律 + code review 兜住。
 *
 * **这份清单是「已实测确认」的，不是穷举证明**——不要据此推断「未列出的形态一定抓得住」。
 * 已实测**能**抓住的反面样本：新 discriminant 的新 arm、必填↔可选翻转、index signature 增删。
 *
 * 附带一条**字段级**盲区：`ToolCall.arguments` 在内核侧是 `Record<string, any>`，`any`
 * 与任何类型双向可赋值，该字段的形状不受本断言保护。详见 `core-mirror.ts` 文件头。
 *
 * ## 一条解析层面的前提
 *
 * `@harness-pi/core` 在这里解析到的是 **core 的构建产物** `packages/core/dist/*.d.ts`，
 * 不是 core 的源码。所以严格讲这条防线是「内核漂移 → **core 重建之后**构建失败」。
 * CI 里 `build` 先于 `typecheck`（`ci.yml:51,54`）所以没问题；本地只跑
 * `pnpm --filter @harness-pi/transcript typecheck` 会对着陈旧 dist 假绿。这是仓库
 * 「build 先于 typecheck/test」铁律的既有代价。
 */
import type { SessionEvent as CoreSessionEvent, LiveEvent as CoreLiveEvent } from "@harness-pi/core";

import type { MirrorSessionEvent, MirrorLiveEvent } from "../core-mirror.js";

/* SessionEvent：两个方向 */
const _sessionEventCoreToMirror: MirrorSessionEvent = null as unknown as CoreSessionEvent;
const _sessionEventMirrorToCore: CoreSessionEvent = null as unknown as MirrorSessionEvent;

/* LiveEvent：两个方向 */
const _liveEventCoreToMirror: MirrorLiveEvent = null as unknown as CoreLiveEvent;
const _liveEventMirrorToCore: CoreLiveEvent = null as unknown as MirrorLiveEvent;

void _sessionEventCoreToMirror;
void _sessionEventMirrorToCore;
void _liveEventCoreToMirror;
void _liveEventMirrorToCore;
