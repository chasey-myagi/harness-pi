/**
 * 反例 02：**镜像多出一个 core 没有的 arm**。
 *
 * 期望：`Mirror → Core` 方向失败。`tsc -p .` 必须非零退出。
 *
 * 这里**故意不写** `@ts-expect-error`：本 fixture 靠 `tsc` 的非零退出码判定，
 * 抑制注释会把错误吞掉、让 fixture 恒绿。
 */
import type { SessionEvent as CoreSessionEvent } from "@harness-pi/core";

import type { MirrorSessionEvent } from "../../src/contract/core-mirror.js";

type MirrorWithGhostArm = MirrorSessionEvent | { type: "ghost-arm"; whatever: string };

const _mirrorToCore: CoreSessionEvent = null as unknown as MirrorWithGhostArm;

void _mirrorToCore;
