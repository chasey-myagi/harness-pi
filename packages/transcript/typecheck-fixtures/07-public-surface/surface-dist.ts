/**
 * 与 `surface.ts` 同一批类型，但走**消费者真正解析的路径**：`dist/`。
 *
 * `surface.ts` import 的是 `src/index.js`，只能证明源码层的出口是通的；`package.json` 的
 * `exports.types` 指向 `./dist/index.d.ts`，build 配置若把类型面 emit 断链（比如 `include`
 * 收窄、`declaration` 被关掉），源码那条路径照样绿。dist 本来就是整个测试套件的硬前置。
 */
import type { MirrorLiveEvent, MirrorSessionEvent, SnapshotEnvelope, Watermark } from "../../dist/index.js";

const _a: MirrorSessionEvent = { type: "continuation-check", turns: 1, continuations: 0 };
const _b: MirrorLiveEvent = { type: "text_delta", contentIndex: 0, delta: "" };
const _c: Watermark = { seq: 1, epoch: "e" };
const _d: SnapshotEnvelope<null> = { watermark: _c, state: null };

void _a; void _b; void _c; void _d;
