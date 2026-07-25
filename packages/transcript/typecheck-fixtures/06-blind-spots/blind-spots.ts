/**
 * **盲区台账的可执行形态**——与 01-04 对称：那四个期望 `tsc` **非零**退出（漂移被抓住），
 * 这一个期望 `tsc` **零**退出（漂移**没**被抓住）。
 *
 * 为什么要这么写：把「这几种形态抓不住」写成注释，只是散文；写成一个期望编译通过的
 * fixture，它就是证据。任何一天 TypeScript 或镜像结构变化让其中某条**变得**抓得住，
 * 这个 fixture 会变红——那时该做的是更新台账（把它挪进 01-04 那一侧），而不是删掉它。
 *
 * 反过来说：本文件编译通过 **不是**好事，是在如实记录防线的边界。
 *
 * ## 这份台账曾经有四条，现在只剩两条
 *
 * 删掉的两条（「新增可选字段」「镜像多出可选字段」）**不是变得抓得住了，是从来就抓得住、
 * 只是没写断言**——而台账把漏写记成了限制，于是这个 fixture 在**认证一句假话**。
 * 那是真正意义上的假绿：一条通过的测试，证明的是一个错误结论。
 *
 * - 第五轮：`ToolExecResult.content` 的变体被漏在「具名类型顶层 vs arm 内」的缝里。
 * - 第六轮：事件轨各 arm 被说成「拎不出统一形状」，而本文件自己下面就在用 `Extract` 拎。
 *
 * 两条都已在 `core-mirror.assert.ts` 补上断言（arm 层用 `ArmKeyDrift` 机器枚举全部 arm）。
 *
 * **给后来者的判据**：想往这份台账加一条之前，先**真的试着把它拎出来钉一遍**。
 * 拎得动就是漏写，拎不动才是限制。下面剩的两条都做过这个动作。
 */
import type { SessionEvent as CoreSessionEvent } from "@harness-pi/core";

import type { MirrorSessionEvent, MirrorUsage } from "../../src/contract/core-mirror.js";

/* ── 盲区 1：core 新增的 arm 复用既有 discriminant，且是既有镜像 arm 的子类型 ── */
// 这条是「四种能抓住的漂移」表第一行必须带「且 discriminant 是新的」这个限定词的原因：
// union 可赋值按「可赋值给**某个**目标成员」结算，兄弟 arm 会被既有 arm 吞掉。
//
// **为什么 `ArmKeyDrift` 也帮不上忙**（试过了，这是「拎不动」的实证）：
// `Extract<C, {type:"error"}>` 拿到的是两个 error arm 的 union，`keyof` 作用在 union 上
// 得到的是**交集**，恰好等于原 arm 的键集，`Exclude` 为空。
//
// 从真实内核类型推导，不手抄形状——手抄件会在内核那个 arm 一动时静默偏离。
type CoreWithSiblingArm =
  | CoreSessionEvent
  | (Extract<CoreSessionEvent, { type: "error" }> & { code: number });
const _siblingCoreToMirror: MirrorSessionEvent = null as unknown as CoreWithSiblingArm;
const _siblingMirrorToCore: CoreWithSiblingArm = null as unknown as MirrorSessionEvent;

/* ── 盲区 2：readonly 修饰符漂移 ── */
// `keyof` 看不见修饰符，所以三层键集断言（具名类型顶层 / 嵌套匿名对象 / arm）全都无感；
// 双向可赋值也无感，因为 `{ readonly x: T }` 与 `{ x: T }` 互相可赋值。
type ReadonlyDrift = { readonly [K in keyof MirrorUsage]: MirrorUsage[K] };
const _readonlyCoreToMirror: ReadonlyDrift = null as unknown as MirrorUsage;
const _readonlyMirrorToCore: MirrorUsage = null as unknown as ReadonlyDrift;

void _siblingCoreToMirror;
void _siblingMirrorToCore;
void _readonlyCoreToMirror;
void _readonlyMirrorToCore;
