/**
 * persistCompactionBoundary —— C1 控制器（docs/09 §4.2「写 compaction 边界进 store」）。
 *
 * 挂内核 `onAfterFlush`（每 turn flush 到 store 之后 fire）：当 `shouldCompact` 为真且距上次 boundary
 * 足够远时，把**已持久化前缀**总结成一条 summary 并**返回** `{ compactionBoundary: summary }`。**内核**
 * 在 in-band、awaited、串行的路径上把它当作 store 末尾的一条 `compaction_boundary` 写盘。这是一个
 * **durable resume 优化**。
 *
 * ── return-based，不持有写能力（务必看清）──
 * 本控制器**只返回** summary，**不调用任何 store 写**。上一版给 hook 一个 detached
 * `appendCompactionBoundary(summary)`，被 review 三轮抓出 data-loss / store-corruption：hook 超时时
 * detached 的 append 仍在飞、乱序落在后续 turn / terminal 之后（resume 当成「丢弃之前一切」→ 静默删已
 * 完成 turn），且与下一轮 flush 的 appendEntry 并发打同一 sessionId（违反串行契约）。改成「返回 → 内核
 * 串行写」后：**summarize 超时（被 dispatcher 的 race 丢弃）只是返回被忽略，绝不产生 detached 写**。
 *
 * ── boundary 覆盖语义 ──
 * onAfterFlush 在 flush 之后 fire，此刻**全部消息已落盘**，故 boundary 落在 store 末尾、覆盖**全部已
 * 持久化前缀**（不保留 tail）。resume 重建 = `[summary, boundary 之后的新 turn]` —— 比 live session 的
 * 全量 `_messages` 更激进的压缩，是**有意**的：live session 不受影响（继续用全量历史），只有从 store
 * 重建时才省下重放。这与 view-only 压缩（compactSummarize / autoCompaction 改「模型 view」、保 tail）
 * 是不同层、正交：那些省 token，这里省 resume 重放。内核 in-band 串行写保证 boundary 永远在「它之后的
 * 消息 flush」之前落盘，且绝无两个 appendEntry 并发同 session。
 *
 * ── HWM 不变量 ──
 * 内核写 boundary 只往 store 加一条 entry，**不动** `_persistedCount` / `_messages`。所以本控制器不破坏
 * 「逐条推进的高水位」——live session 的全量历史与续跑行为完全不变。
 *
 * `summarize` 由调用方提供（可调 LLM）——domain-free，控制器/内核都不内置 LLM 调用。
 */

import type { Hook, HookContext, OnAfterFlushInput } from "@harness-pi/core";
import type { Message } from "@earendil-works/pi-ai";

declare module "@harness-pi/core" {
  interface HookStateRegistry {
    "persist-compaction-boundary.lastTurnIdx": number;
  }
}

const KEY = "persist-compaction-boundary.lastTurnIdx" as const;

export interface PersistCompactionBoundaryOptions {
  /**
   * 判断此刻是否该落 boundary（如 estimate(messages) > 阈值）。返回 false 则跳过。
   * `messages` 是已持久化前缀（= live history 的前 `persistedCount` 条）。
   */
  shouldCompact: (input: {
    persistedCount: number;
    messages: Message[];
  }) => boolean;
  /**
   * 把「已持久化前缀」总结成一条 summary message —— summary 覆盖**全部已持久化消息**（见覆盖语义）。
   * 可 async（调 LLM）。
   */
  summarize: (flushedMessages: Message[]) => Promise<Message> | Message;
  /**
   * 两次 boundary 之间至少间隔多少次 flush/turn，避免每 turn 都落。默认 1（相邻 turn 不重复落）。
   */
  minTurnsBetween?: number;
  /**
   * 本 hook 的超时(ms)。**默认放宽到 60_000**——`summarize` 可调 LLM(秒级),而 `onAfterFlush` 走 event
   * 类、dispatcher 默认超时仅 100ms,不放宽真 LLM summarize 会**必定超时 → 该 hook 返回被丢弃 → 零
   * boundary 落盘**(但不会数据损坏——内核拿不到返回就不写)。按你的 summarize 后端调整。
   */
  timeout?: number;
}

export function persistCompactionBoundary(
  opts: PersistCompactionBoundaryOptions,
): Hook {
  const minTurnsBetween = opts.minTurnsBetween ?? 1;
  if (minTurnsBetween < 1) {
    throw new Error(
      "persistCompactionBoundary: minTurnsBetween must be >= 1",
    );
  }

  return {
    name: "persist-compaction-boundary",
    // 见 timeout 选项注释：onAfterFlush 走 event 类(默认 100ms),LLM summarize 必须放宽超时,否则零 boundary。
    timeout: opts.timeout ?? 60_000,

    async onAfterFlush(input: OnAfterFlushInput, ctx: HookContext) {
      // 已持久化前缀 = live history 的前 persistedCount 条（boundary 覆盖这整段）。
      const flushed = ctx.messages.slice(0, input.persistedCount);

      if (!opts.shouldCompact({ persistedCount: input.persistedCount, messages: flushed })) {
        return;
      }

      // minTurnsBetween：距上次落 boundary 不够远就跳过。首次（无记录）总是允许。
      const last = ctx.state.get(KEY);
      if (last !== undefined && input.turnIdx - last < minTurnsBetween) {
        return;
      }

      // **先提交节流高水位,再做慢活。** summarize 可能秒级、甚至被 hook 超时中断(此时返回被 dispatcher
      // 的 race 丢弃、内核不写)。若把 set 放在 await 之后,超时让 await reject → set 不执行 → 节流高水位
      // 不前进 → 下一 turn 又触发 summarize,minTurnsBetween 形同虚设、反复调 LLM。先 set:即使本轮
      // summarize 失败/超时,后续 turn 仍正确节流。boundary 是 best-effort 优化,跳过一次无碍。
      ctx.state.set(KEY, input.turnIdx);
      const summary = await opts.summarize(flushed);
      // 只返回 summary —— 由内核 in-band、awaited、串行写进 store。控制器不持有任何写能力。
      return { compactionBoundary: summary };
    },
  };
}
