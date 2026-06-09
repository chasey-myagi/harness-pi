/**
 * deferredTools —— listing-only 的工具延迟暴露（issue #66 / O1）。
 *
 * 把一部分工具标成 "deferred"：默认**不进 LLM 看到的 tool listing**，直到被激活
 * （典型由 {@link toolSearch} 工具命中后写入激活集）才在**下一 turn** 出现在 listing 里。
 * 纯 listing 收窄 —— **不碰 execution**：deferred 工具始终在 `session.tools` 全集里，
 * 一旦被调用，executor 照常 findToolByName / validateToolCall / 过权限闸。
 *
 * 激活集载体：`ctx.state` 的 `"deferred.activated"`（`Set<string>`），由 onSessionStart
 * seed 成 `alwaysListed`。当前 turn 实际 listing 的子集顺手写进 `"deferred.activeListing"`，
 * 给 autoCompaction 的 token 估算读（有 deferred 就估激活子集，没有退回全集）。
 *
 * **估算联动有结构性的一 turn 滞后，与 hook 注册顺序无关**：autoCompaction 在
 * `transformMessagesBeforeLlm` 读 `deferred.activeListing`，本 hook 在 `transformToolsBeforeLlm`
 * 写它——内核固定 messages-pipe 先于 tools-pipe（且二者不同 method，重排注册顺序也改不了），
 * 故 autoCompaction 读到的是**上一 turn**写入的激活子集；turn-0 读到 undefined → 退回全集
 * （保守高估，安全侧：宁早压勿晚）。对压缩阈值无害，无需也无法靠排序消除。
 */

import type { Hook, Tool } from "@harness-pi/core";

/* ── 在 core 的 HookStateRegistry 上 augment 本 plugin 用到的 key ── */
declare module "@harness-pi/core" {
  interface HookStateRegistry {
    "deferred.activated": Set<string>;
    "deferred.activeListing": Tool[];
  }
}

// `as const` 保留字面类型，让 TypedStateMap 走 typed overload 而不是 string fallback
const KEY_ACTIVATED = "deferred.activated" as const;
const KEY_LISTING = "deferred.activeListing" as const;

export interface DeferredToolsOptions {
  /**
   * 哪些工具是 deferred：字符串数组（按名命中）或谓词（`(name) => boolean`）。
   * deferred 工具默认不进 listing，激活后才可见。
   */
  deferred: string[] | ((name: string) => boolean);
  /**
   * 即便是 deferred 也**始终列出**的工具名（seed 进激活集）。典型：toolSearch 自己，
   * 以及希望首 turn 就可见的常用工具。
   */
  alwaysListed?: string[];
}

export function deferredTools(opts: DeferredToolsOptions): Hook {
  const isDeferred = (name: string): boolean =>
    typeof opts.deferred === "function"
      ? opts.deferred(name)
      : opts.deferred.includes(name);

  return {
    name: "deferredTools",
    // 不声明对 autoCompaction 的依赖：二者在不同 pipe method（tools vs messages），注册顺序对其
    // 交互无影响（见文件头「结构性一 turn 滞后」）。autoCompaction 缺席时也独立工作（opt-in）。

    onSessionStart(_input, ctx) {
      ctx.state.set(KEY_ACTIVATED, new Set(opts.alwaysListed ?? []));
    },

    transformToolsBeforeLlm(tools, ctx) {
      const activated = ctx.state.get(KEY_ACTIVATED) ?? new Set<string>();
      const result = tools.filter(
        (t) => !isDeferred(t.name) || activated.has(t.name),
      );
      // 当前 turn 实际 listing 的子集 —— 给 autoCompaction 估算读（激活子集而非全集）。
      ctx.state.set(KEY_LISTING, result);
      return result;
    },
  };
}
