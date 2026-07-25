/**
 * **盲区台账的可执行形态**——与 01-04 对称：那四个期望 `tsc` **非零**退出（漂移被抓住），
 * 这一个期望 `tsc` **零**退出（漂移**没**被抓住）。
 *
 * 为什么要这么写：把「这四种形态抓不住」写成注释，只是散文；写成一个期望编译通过的
 * fixture，它就是证据。任何一天 TypeScript 或镜像结构变化让其中某条**变得**抓得住，
 * 这个 fixture 会变红——那时该做的是更新台账（把它挪进 01-04 那一侧），而不是删掉它。
 *
 * 反过来说：本文件编译通过 **不是**好事，是在如实记录防线的边界。
 */
import type { SessionEvent as CoreSessionEvent } from "@harness-pi/core";

import type { MirrorSessionEvent, MirrorUsage } from "../../src/contract/core-mirror.js";

/* ── 盲区 1：**arm 内匿名对象**新增可选字段 ── */
// 注意落点：`SessionEvent` / `LiveEvent` 各 arm 里的匿名内联对象。具名类型（Usage /
// AssistantMessage / RunSummary / ToolExecResult 等 8 个）的顶层键集**已被 core-mirror.assert.ts
// 的键集断言钉死**，那一层不再是盲区；arm 内匿名对象钉不住，因为 `keyof` 作用在 union 上
// 得到的是各成员键的**交集**（实测 `keyof MirrorSessionEvent` 只有 `"type"`）。
type TurnStartArmOptional = Extract<MirrorSessionEvent, { type: "turn-start" }> & {
  hostLatencyMs?: number;
};
type MirrorWithArmOptional =
  | Exclude<MirrorSessionEvent, { type: "turn-start" }>
  | TurnStartArmOptional;
const _armOptionalCoreToMirror: MirrorWithArmOptional = null as unknown as CoreSessionEvent;
const _armOptionalMirrorToCore: CoreSessionEvent = null as unknown as MirrorWithArmOptional;

/* ── 盲区 2：镜像多出一个 core 没有的可选字段 ── */
type TurnStartArm = Extract<MirrorSessionEvent, { type: "turn-start" }>;
type MirrorExtraOptional =
  | Exclude<MirrorSessionEvent, { type: "turn-start" }>
  | (TurnStartArm & { ghostOptional?: string });
const _extraOptionalCoreToMirror: MirrorExtraOptional = null as unknown as CoreSessionEvent;
const _extraOptionalMirrorToCore: CoreSessionEvent = null as unknown as MirrorExtraOptional;

/* ── 盲区 3：core 新增的 arm 复用既有 discriminant，且是既有镜像 arm 的子类型 ── */
// 这条是上表第一行必须带「且 discriminant 是新的」这个限定词的原因：union 可赋值按
// 「可赋值给**某个**目标成员」结算，兄弟 arm 会被既有 arm 吞掉。
// 从真实内核类型推导，不手抄形状——手抄件会在内核那个 arm 一动时静默偏离，
// 或者因为不相关的原因变红。其余三条盲区本来就是 Omit / Extract / mapped type 推导的。
type CoreWithSiblingArm =
  | CoreSessionEvent
  | (Extract<CoreSessionEvent, { type: "error" }> & { code: number });
const _siblingCoreToMirror: MirrorSessionEvent = null as unknown as CoreWithSiblingArm;
const _siblingMirrorToCore: CoreWithSiblingArm = null as unknown as MirrorSessionEvent;

/* ── 盲区 4：readonly 修饰符漂移 ── */
type ReadonlyDrift = { readonly [K in keyof MirrorUsage]: MirrorUsage[K] };
const _readonlyCoreToMirror: ReadonlyDrift = null as unknown as MirrorUsage;
const _readonlyMirrorToCore: MirrorUsage = null as unknown as ReadonlyDrift;

void _armOptionalCoreToMirror;
void _armOptionalMirrorToCore;
void _extraOptionalCoreToMirror;
void _extraOptionalMirrorToCore;
void _siblingCoreToMirror;
void _siblingMirrorToCore;
void _readonlyCoreToMirror;
void _readonlyMirrorToCore;
