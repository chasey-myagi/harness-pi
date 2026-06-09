/**
 * toolSearch —— 激活 deferred 工具的普通 first-party 工具（issue #66 / O1）。
 *
 * 配合 {@link deferredTools} 用：deferred 工具默认不在 LLM 看到的 listing 里，模型调
 * toolSearch（按名 `select` 或 `keyword` 本地模糊匹配）把命中的工具写进 `ctx.state` 的
 * `"deferred.activated"` 激活集，**下一 turn** 它们才出现在 listing 里。
 *
 * 全本地、零 provider 依赖：数据源是 `ctx.config.tools`（session.tools 全集的冻结视图），
 * keyword 在工具 name + description 上做最简包含匹配。
 *
 * 屏障型（`isConcurrencySafe: () => false`）：写 `ctx.state` 同一 key，绝不与同 turn 其他工具并行。
 */

import { Type } from "@harness-pi/core";
import type { HarnessTool, HookContext, ToolExecResult } from "@harness-pi/core";

const KEY_ACTIVATED = "deferred.activated" as const;

export interface ToolSearchOptions {
  /**
   * 工具名 —— 默认 `"toolSearch"`。挂 deferredTools 时把这个名字放进 `alwaysListed`，
   * 保证它首 turn 就可见。
   */
  name?: string;
}

export function toolSearch(opts: ToolSearchOptions = {}): HarnessTool {
  const name = opts.name ?? "toolSearch";
  return {
    name,
    description:
      "Activate deferred tools so they become available next turn. " +
      "Pass `select` (exact tool names) and/or `keyword` (fuzzy match against tool name + description). " +
      "Returns the activated tools' schemas. Activation = visibility, not authorization.",
    parameters: Type.Object({
      select: Type.Optional(
        Type.Array(Type.String(), {
          description: "Exact tool names to activate.",
        }),
      ),
      keyword: Type.Optional(
        Type.String({
          description:
            "Keyword to fuzzy-match against tool name + description; matched tools are activated.",
        }),
      ),
    }),
    // 写 ctx.state 同一激活集 key —— 屏障型，绝不与同 turn 其他工具并行。
    isConcurrencySafe: () => false,
    async execute(args, ctx: HookContext): Promise<ToolExecResult> {
      const select = (args.select as string[] | undefined) ?? [];
      const keyword = (args.keyword as string | undefined)?.trim();

      const catalog = ctx.config.tools;
      const hits = new Set<string>();

      // select：按名精确命中（仅命中确实存在的工具）。
      const names = new Set(catalog.map((t) => t.name));
      for (const s of select) {
        if (names.has(s)) hits.add(s);
      }

      // keyword：在 name + description 上做最简本地包含匹配（大小写不敏感）。
      if (keyword) {
        const kw = keyword.toLowerCase();
        for (const t of catalog) {
          const hay = `${t.name} ${t.description}`.toLowerCase();
          if (hay.includes(kw)) hits.add(t.name);
        }
      }

      if (hits.size === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No tools matched select=${JSON.stringify(
                select,
              )} keyword=${JSON.stringify(keyword ?? null)}.`,
            },
          ],
        };
      }

      const cur = ctx.state.get(KEY_ACTIVATED) ?? new Set<string>();
      ctx.state.set(KEY_ACTIVATED, new Set([...cur, ...hits]));

      const activatedNames = [...hits];
      const schemas = catalog
        .filter((t) => hits.has(t.name))
        .map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        }));

      return {
        content: [
          {
            type: "text",
            text:
              `activated: ${activatedNames.join(", ")} — available next turn.\n` +
              JSON.stringify(schemas, null, 2),
          },
        ],
      };
    },
  };
}
