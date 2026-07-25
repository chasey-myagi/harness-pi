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
 * | core 新增一个 arm（镜像未跟上） | `Core → Mirror`（宽赋窄失败） | `01-mirror-missing-arm` |
 * | 镜像多出一个 core 没有的 arm | `Mirror → Core` | `02-mirror-extra-arm` |
 * | core 某 arm 新增**必填**字段 | `Mirror → Core`（缺必填属性） | `03-mirror-missing-required-field` |
 * | core 某 arm 删除字段 | `Core → Mirror` | `04-mirror-extra-required-field` |
 *
 * ## 两种抓不住的盲区（不许假装覆盖了）
 *
 * 1. **core 某 arm 新增可选字段** —— 镜像不跟上，两个方向都通过。
 * 2. **镜像多出一个 core 没有的可选字段** —— 同样两个方向都通过。
 *
 * 换句话说：可选字段的增删在这里**完全不可见**。这既是 `core-mirror.ts` 能大方省略一串
 * 可选字段的原因，也是这条防线的边界。这两类只能靠 `session.ts:49-50` 与 `:74-75` 已有的
 * exhaustive-switch 纪律 + code review 兜住。
 *
 * 附带一条**字段级**盲区：`ToolCall.arguments` 在内核侧是 `Record<string, any>`，`any`
 * 与任何类型双向可赋值，该字段的形状不受本断言保护。详见 `core-mirror.ts` 文件头。
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
