/**
 * 反例 04：**core 某 arm 删除字段，镜像仍保留同名必填字段**。
 *
 * 用交叉类型给镜像 `turn-start` arm 加一个 core 没有的必填字段，等价于「镜像有、core 没有」。
 *
 * 期望：`Core → Mirror` 方向失败。`tsc -p .` 必须非零退出。
 *
 * 这里**故意不写** `@ts-expect-error`：本 fixture 靠 `tsc` 的非零退出码判定，
 * 抑制注释会把错误吞掉、让 fixture 恒绿。
 */
import type { SessionEvent as CoreSessionEvent } from "@harness-pi/core";

import type { MirrorSessionEvent } from "../../src/contract/core-mirror.js";

type TurnStartArm = Extract<MirrorSessionEvent, { type: "turn-start" }>;

type MirrorWithExtraRequiredField =
  | Exclude<MirrorSessionEvent, { type: "turn-start" }>
  | (TurnStartArm & { ghostField: string });

const _coreToMirror: MirrorWithExtraRequiredField = null as unknown as CoreSessionEvent;

void _coreToMirror;
