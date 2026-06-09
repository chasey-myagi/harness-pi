/**
 * skills —— 渐进式技能加载（issue #68 / O2）。
 *
 * 把一组 "skill"（一段命名的 prompt 全文 + 可选要激活的工具）做成 catalog + 加载工具：
 * - **发现**：`hook` 在 system prompt 末尾追加一段简洁 catalog（仅 name + description，
 *   **绝不含 body**），随 system prompt 每 turn 已发、无额外注入成本。模型据此挑技能。
 * - **加载**：`skill` 工具按名取回该 skill 的 body 全文作 toolResult 注入；若 skill 声明了
 *   `tools`，把它们写进 O1 的 `"deferred.activated"` 激活集，**下一 turn** 才在 listing 里出现
 *   （仅当也挂了 {@link deferredTools} 且这些工具被 deferred 时才有视觉效果——O1/O2 共享同一 seam）。
 *
 * domain-free：`SkillSpec` 不绑任何具体领域，纯 name/description/body/tools。
 * opt-in：不挂 skills 时行为与 0.2.x 一致（system prompt 不含 "Available skills"）。
 */

import { Type } from "@harness-pi/core";
import type {
  HarnessTool,
  Hook,
  HookContext,
  ToolExecResult,
} from "@harness-pi/core";
import { KEY_ACTIVATED } from "./deferred-tools.js";

export interface SkillSpec {
  /** 技能名，调 `skill` 工具时按此名取回。catalog 内唯一。 */
  name: string;
  /** 进 catalog 给模型选用的简短描述（whenToUse 性质）。 */
  description: string;
  /** invoke 时注入的全文 prompt —— 只在被调用时进 toolResult，**绝不进 catalog**。 */
  body: string;
  /** 可选：invoke 时激活的工具名（复用 O1 的 deferred.activated 激活集）。 */
  tools?: string[];
}

export interface SkillsOptions {
  /** `skill` 工具名 —— 默认 `"skill"`。 */
  toolName?: string;
}

export function skills(
  specs: SkillSpec[],
  opts: SkillsOptions = {},
): { hook: Hook; tool: HarnessTool } {
  // 构造期 fail-loud：空集 / 重名直接抛，别等运行时静默退化。
  if (specs.length === 0) {
    throw new Error("skills(): specs must be non-empty");
  }
  const byName = new Map<string, SkillSpec>();
  for (const spec of specs) {
    if (byName.has(spec.name)) {
      throw new Error(`skills(): duplicate skill name "${spec.name}"`);
    }
    byName.set(spec.name, spec);
  }

  const toolName = opts.toolName ?? "skill";

  const catalog =
    `\n\n## Available skills\n` +
    `Invoke the \`${toolName}\` tool with a skill name to load its full instructions.\n` +
    specs.map((s) => `- ${s.name}: ${s.description}`).join("\n");

  const hook: Hook = {
    name: "skills",
    transformSystemPromptBeforeLlm(systemPrompt) {
      // catalog 只含 name + description，绝不含 body。
      return systemPrompt + catalog;
    },
  };

  const tool: HarnessTool = {
    name: toolName,
    description:
      "Load a skill's full instructions by name. " +
      "Available skill names are listed under '## Available skills' in the system prompt.",
    parameters: Type.Object({
      name: Type.String({ description: "Name of the skill to load." }),
    }),
    // 可能写 ctx.state（激活集），且注入语义应顺序化 —— 屏障型。
    isConcurrencySafe: () => false,
    async execute(args, ctx: HookContext): Promise<ToolExecResult> {
      const name = args.name as string;
      const spec = byName.get(name);
      if (!spec) {
        const available = [...byName.keys()].join(", ");
        throw new Error(`unknown skill "${name}" (available: ${available})`);
      }

      if (spec.tools?.length) {
        const cur = ctx.state.get(KEY_ACTIVATED) ?? new Set<string>();
        ctx.state.set(KEY_ACTIVATED, new Set([...cur, ...spec.tools]));
      }

      const note = spec.tools?.length
        ? `\n\n(activated tools: ${spec.tools.join(", ")} — available next turn.)`
        : "";
      return { content: [{ type: "text", text: spec.body + note }] };
    },
  };

  return { hook, tool };
}
