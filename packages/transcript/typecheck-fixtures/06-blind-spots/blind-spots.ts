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

/* ── 盲区 1：**事件轨 arm 内**匿名对象新增可选字段 ── */
// 落点必须写准，第五轮 review 三门同时抓过这里：能用 `Extract` / 索引访问**拎成具体类型**的
// 层，一律已被 core-mirror.assert.ts 的键集断言钉死（具名类型顶层、`Usage["cost"]`、
// `ToolExecResult.content` 的 text / image 两变体），**不属于盲区**。
//
// 真正钉不住的只有这一层：`SessionEvent` / `LiveEvent` 各 arm 里的匿名内联对象——
// `keyof` 作用在 union 上得到的是各成员键的**交集**（实测 `keyof MirrorSessionEvent`
// 只有 `"type"`），拎不出统一形状。这才是 `keyof` 的固有限制。
//
// 早先这里写的是「具名类型 8 个已钉、arm 内未钉」，那个二分把 `ToolExecResult.content`
// 这类**具名类型内部嵌套的匿名对象**漏在缝里，且把「漏写断言」讲成了「固有限制」。
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
