/**
 * 反例 01：**core 新增一个 arm，镜像未跟上**。
 *
 * 用 `Exclude` 在真实镜像上做类型手术模拟「镜像少一个 arm」，而不是复制一份镜像——
 * 镜像演化时本 fixture 无需跟着改。
 *
 * 期望：`Core → Mirror` 方向失败（宽赋窄）。`tsc -p .` 必须非零退出。
 */
import type { SessionEvent as CoreSessionEvent } from "@harness-pi/core";

import type { MirrorSessionEvent } from "../../src/contract/core-mirror.js";

type MirrorMissingOneArm = Exclude<MirrorSessionEvent, { type: "continuation-check" }>;

// 这里**故意不写** `@ts-expect-error`：本 fixture 靠 `tsc` 的非零退出码判定，
// 抑制注释会把错误吞掉、让 fixture 恒绿。
const _coreToMirror: MirrorMissingOneArm = null as unknown as CoreSessionEvent;

void _coreToMirror;
