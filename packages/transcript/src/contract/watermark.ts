/**
 * durable 水位——**本包只透传，不定义语义**。
 *
 * `seq` 的发号权、`epoch` 的翻转条件、`since_seq` 补帧协议、journal 保留策略，
 * 全部归 **#154**（host 常驻多会话服务）。本包不自行分配 `seq`，也不定义补帧协议。
 *
 * 特别注意：`packages/adapters/src/event-pump.ts` 的 seq 是 **pump 实例级**的，
 * 只能做跳号检测、无法重新投递，任何一侧都不得拿它当补帧基础。
 */
export interface Watermark {
  /** 单调递增的 durable 序号。发号权归 #154。 */
  readonly seq: number;
  /** 发号者的世代标识；变化意味着 `seq` 不再可比、消费者需重取快照。语义归 #154。 */
  readonly epoch: string;
}

/**
 * 快照根形状：任何快照都必须带上它所源自的水位。
 *
 * 刻意做成对 `TState` 泛型的信封——本 issue **不设计** transcript 状态本身
 * （L1 store 与 L2 op 归 #166，双轨投影器归 #167）。这里唯一钉死的不变量是
 * 「快照与水位不可分离」：拿到快照就一定知道它落在哪个水位上，否则补帧无从对齐。
 */
export interface SnapshotEnvelope<TState> {
  readonly watermark: Watermark;
  readonly state: TState;
}
