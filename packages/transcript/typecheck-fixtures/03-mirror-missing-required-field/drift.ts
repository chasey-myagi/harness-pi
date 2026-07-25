/**
 * 反例 03：**core 某 arm 新增必填字段，镜像未跟上**。
 *
 * 用 `Omit` 把镜像 `turn-end` arm 的必填字段 `toolResultsCount` 摘掉，等价于「core 有、镜像没有」。
 *
 * 期望：`Mirror → Core` 方向失败（缺必填属性）。`tsc -p .` 必须非零退出。
 *
 * 这里**故意不写** `@ts-expect-error`：本 fixture 靠 `tsc` 的非零退出码判定，
 * 抑制注释会把错误吞掉、让 fixture 恒绿。
 */
import type { SessionEvent as CoreSessionEvent } from "@harness-pi/core";

import type { MirrorSessionEvent } from "../../src/contract/core-mirror.js";

type TurnEndArm = Extract<MirrorSessionEvent, { type: "turn-end" }>;

type MirrorMissingRequiredField =
  | Exclude<MirrorSessionEvent, { type: "turn-end" }>
  | Omit<TurnEndArm, "toolResultsCount">;

const _mirrorToCore: CoreSessionEvent = null as unknown as MirrorMissingRequiredField;

void _mirrorToCore;
