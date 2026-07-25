/**
 * 镜像 ↔ 内核的**双向** assignability 断言。
 *
 * 这个文件**在主路径上**：`tsconfig.json` 只 `exclude` 掉 `__tests__`，所以每次
 * `pnpm build`（`tsc -p .`）与每次 `pnpm typecheck`（`tsc -p . --noEmit`）都会编译它。
 * 代价是 `dist/contract/__typecheck__/core-mirror.assert.js` 这个死文件，已由
 * `package.json` 的 `files` 挡在 tarball 外。
 *
 * > **一条曾经写错、必须留个记号的事**：本文件早期版本（及 README、两份 spec、两个
 * > tsconfig 注释）都声称「不 exclude `__typecheck__` 的话 devDep `@harness-pi/core`
 * > 会泄漏进 `dist`」。**这是错的**——`import type` 会被完全擦除，实测 emit 出来的
 * > `.d.ts` 字面就是 `export {};`，`.js` 里零 import（`tsconfig.base.json` 也没开
 * > `verbatimModuleSyntax`）。那句假前提曾撑起一个额外的 `tsconfig.typecheck.json`、
 * > 一段三段串联的 `typecheck` 脚本、以及两条只为守它们而存在的测试——四层机械保证
 * > 守一个不存在的问题。现已全部删除。真正需要 `exclude` 的只有 `__tests__`。
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
 * 下面说的「抓不住」指的是**双向可赋值断言**这一层。文件末尾的**键集断言**补上了其中两条的
 * 一部分，边界写在那一节的注释里——这里逐条标明现状：
 *
 * 1. **arm 内匿名对象新增可选字段** —— 两个方向都过。
 *    具名类型（8 个）的顶层键集已被键集断言钉死，那一层**不再是盲区**；
 *    但 `SessionEvent` / `LiveEvent` 各 arm 里的匿名内联对象钉不住——`keyof` 作用在 union 上
 *    得到的是各成员键的**交集**（实测 `keyof MirrorSessionEvent` 只有 `"type"`）。
 * 2. **镜像多出 core 没有的可选字段** —— 双向断言两个方向都过；具名类型那一层已由
 *    `ExtraKeys<..., never>` 钉死，arm 内匿名对象同样钉不住。
 * 3. **core 新增的 arm 复用既有 discriminant，且结构上是某个既有镜像 arm 的子类型** ——
 *    典型形态是「同 `type` 值、多几个必填字段」的兄弟 arm。实测：给 core 并上
 *    `{ type: "error"; phase: ...; message: string; code: number }` 后两个方向都 `EXIT=0`。
 *    这是上表第一行那个限定词的来源。**键集断言帮不上忙**（arm 层）。
 * 4. **`readonly` 修饰符漂移** —— `{ readonly x: number }` 与 `{ x: number }` 互相可赋值，
 *    整层加/去 `readonly` 两个方向都过（实测 `EXIT=0`）。`keyof` 看不见修饰符，键集断言也帮不上忙。
 *
 * 剩下的这些只能靠 `session.ts:49-50` 与 `:74-75` 已有的 exhaustive-switch 纪律 + code review 兜住。
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
import type {
  AssistantMessage as PiAssistantMessage,
  TextContent as PiTextContent,
  ThinkingContent as PiThinkingContent,
  ToolCall as PiToolCall,
  Usage as PiUsage,
} from "@earendil-works/pi-ai";
import type {
  LiveEvent as CoreLiveEvent,
  RunSummary as CoreRunSummary,
  SessionEvent as CoreSessionEvent,
  ToolExecResult as CoreToolExecResult,
} from "@harness-pi/core";

import type {
  MirrorAssistantMessage,
  MirrorLiveEvent,
  MirrorRunSummary,
  MirrorSessionEvent,
  MirrorTextContent,
  MirrorThinkingContent,
  MirrorToolCall,
  MirrorToolExecResult,
  MirrorUsage,
} from "../core-mirror.js";

/* SessionEvent：两个方向 */
const _sessionEventCoreToMirror: MirrorSessionEvent = null as unknown as CoreSessionEvent;
const _sessionEventMirrorToCore: CoreSessionEvent = null as unknown as MirrorSessionEvent;

/* LiveEvent：两个方向 */
const _liveEventCoreToMirror: MirrorLiveEvent = null as unknown as CoreLiveEvent;
const _liveEventMirrorToCore: CoreLiveEvent = null as unknown as MirrorLiveEvent;

/*
 * pi-ai 叶子类型：三个直接双向断言。
 *
 * 这三条在拓扑上是冗余的——叶子类型经 `AssistantMessage` 被上面两条间接绑住了。留着是为了
 * 把 pi-ai 的版本漂移**直接**暴露在这里，而不是让它伪装成一条 `SessionEvent` 的错。
 * 顺带让 `@earendil-works/pi-ai` 这条 devDependency 名副其实：在此之前它从未被 import 过，
 * 对 typecheck 零作用。
 */
const _assistantMessageCoreToMirror: MirrorAssistantMessage = null as unknown as PiAssistantMessage;
const _assistantMessageMirrorToCore: PiAssistantMessage = null as unknown as MirrorAssistantMessage;
const _usageCoreToMirror: MirrorUsage = null as unknown as PiUsage;
const _usageMirrorToCore: PiUsage = null as unknown as MirrorUsage;
const _toolCallCoreToMirror: MirrorToolCall = null as unknown as PiToolCall;
const _toolCallMirrorToCore: PiToolCall = null as unknown as MirrorToolCall;

/* ──────────────────── 键集钉死：把省略清单从散文变成断言 ──────────────────── */

/**
 * `core-mirror.ts` 文件头那张「被省略的可选字段」表原本是**手维护清单**——而本包的整个
 * 论点是「手维护的清单必须由机器钉住」，同一个包不该有两套标准。
 *
 * 这几条把每个具名类型的**顶层键集**钉死：镜像省了哪些、多了哪些，都写成类型。
 * 附带收益：它**关掉了盲区 1 与盲区 2 在这些类型顶层的那一半**——core 新增一个可选字段时
 * `Exclude<keyof Core, keyof Mirror>` 会多出一项，编译失败；双向可赋值断言对此完全无感。
 *
 * **覆盖边界（不要过度声称）**：`keyof` 只看顶层。
 *   - 已钉：下列 8 个具名类型（含 `Usage["cost"]` 这一层）。
 *   - 未钉：`SessionEvent` / `LiveEvent` 各 arm 里的**匿名内联对象**——`keyof` 作用在 union 上
 *     得到的是各成员键的**交集**，钉不住。所以「某个 arm 新增可选字段」仍是盲区，
 *     `typecheck-fixtures/06-blind-spots/` 里记的就是这一层。
 */
type OmittedKeys<Core, Mirror> = Exclude<keyof Core, keyof Mirror>;
type ExtraKeys<Core, Mirror> = Exclude<keyof Mirror, keyof Core>;
/** 双向 extends：`A` 与 `B` 必须是同一个键集，多一个少一个都不行。 */
type SameKeys<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/* 省略清单——与 core-mirror.ts 文件头那张表逐条对应，改一处必须两处一起改。 */
const _omitRunSummary: SameKeys<
  OmittedKeys<CoreRunSummary, MirrorRunSummary>,
  "error" | "abortReason" | "persistenceErrors"
> = true;
const _omitToolExecResult: SameKeys<
  OmittedKeys<CoreToolExecResult, MirrorToolExecResult>,
  "details" | "newMessages"
> = true;
const _omitAssistantMessage: SameKeys<
  OmittedKeys<PiAssistantMessage, MirrorAssistantMessage>,
  "responseModel" | "responseId" | "diagnostics" | "errorMessage"
> = true;
const _omitTextContent: SameKeys<OmittedKeys<PiTextContent, MirrorTextContent>, "textSignature"> = true;
const _omitThinkingContent: SameKeys<
  OmittedKeys<PiThinkingContent, MirrorThinkingContent>,
  "thinkingSignature"
> = true;
const _omitToolCall: SameKeys<OmittedKeys<PiToolCall, MirrorToolCall>, "thoughtSignature"> = true;
const _omitUsage: SameKeys<OmittedKeys<PiUsage, MirrorUsage>, never> = true;
const _omitUsageCost: SameKeys<OmittedKeys<PiUsage["cost"], MirrorUsage["cost"]>, never> = true;

/* 镜像不得多出 core 没有的键——含可选，这是双向可赋值断言的另一半盲区。 */
const _noExtraRunSummary: SameKeys<ExtraKeys<CoreRunSummary, MirrorRunSummary>, never> = true;
const _noExtraToolExecResult: SameKeys<ExtraKeys<CoreToolExecResult, MirrorToolExecResult>, never> = true;
const _noExtraAssistantMessage: SameKeys<ExtraKeys<PiAssistantMessage, MirrorAssistantMessage>, never> = true;
const _noExtraTextContent: SameKeys<ExtraKeys<PiTextContent, MirrorTextContent>, never> = true;
const _noExtraThinkingContent: SameKeys<ExtraKeys<PiThinkingContent, MirrorThinkingContent>, never> = true;
const _noExtraToolCall: SameKeys<ExtraKeys<PiToolCall, MirrorToolCall>, never> = true;
const _noExtraUsage: SameKeys<ExtraKeys<PiUsage, MirrorUsage>, never> = true;
const _noExtraUsageCost: SameKeys<ExtraKeys<PiUsage["cost"], MirrorUsage["cost"]>, never> = true;

void _sessionEventCoreToMirror;
void _sessionEventMirrorToCore;
void _liveEventCoreToMirror;
void _liveEventMirrorToCore;
void _omitRunSummary;
void _omitToolExecResult;
void _omitAssistantMessage;
void _omitTextContent;
void _omitThinkingContent;
void _omitToolCall;
void _omitUsage;
void _omitUsageCost;
void _noExtraRunSummary;
void _noExtraToolExecResult;
void _noExtraAssistantMessage;
void _noExtraTextContent;
void _noExtraThinkingContent;
void _noExtraToolCall;
void _noExtraUsage;
void _noExtraUsageCost;
void _assistantMessageCoreToMirror;
void _assistantMessageMirrorToCore;
void _usageCoreToMirror;
void _usageMirrorToCore;
void _toolCallCoreToMirror;
void _toolCallMirrorToCore;
