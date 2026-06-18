/**
 * prefix-shape —— prompt-cache 前缀诊断（#106 后续：给「为什么 cache 这一 turn 可能 miss」装上实时归因）。
 *
 * provider 在 durable prefix（model/provider 标识 + system + tools schema）边界做 KV-cache：前缀逐字节
 * 不变才可能命中。本插件每次 LLM call 前 canonicalize 出这段 durable prefix、算稳定 hash、与上一 turn 比，
 * 变了就分类原因（model / system / tool_schema / provider_options）并经 `ctx.log` 暴露；可选在 `onLlmEnd`
 * 用真实 `usage.cacheRead` 做「预测 vs 实测」对账，把诊断从「猜」变成「证伪」。
 *
 * 零内核改动、纯观测：`transformToolsBeforeLlm` 里 fail-open passthrough（返回 void 不改写 tools），
 * `onLlmEnd` 只读 usage。移植自 maka `request-shape.ts`，砍到 durable-prefix-only（不做 history projection /
 * tool-source-economy / zod 转换）。详见 docs/05-plugins.md §5.x。
 *
 * 两条已知局限（与 autoCompaction 同档，文档化、不修——修就破坏「零内核改动」）：
 *  1. system 指纹取 `ctx.config.systemPrompt` = 构造期 **pre-pipe base**。若挂了
 *     `transformSystemPromptBeforeLlm` 每 turn 改写 system，本插件看不到那个增量、会漏报
 *     `system_prompt_changed`（当前无 first-party hook 这么干）。
 *  2. provider options 内核不经 hook 暴露；`provider_options_changed` 仅在调用方主动通过
 *     `opts.providerOptions` 喂指纹时才有意义。默认这一维是盲区。
 *
 * ⚠️ prefix 稳定只是 cache 命中的**必要非充分**条件：history 增长本身会让超出公共前缀的后缀 miss（那是
 * cost/trim 那条线的事）。`reason === "stable"` 不等于该 100% 命中；`onCacheReconcile` 给的是关联信号、
 * 非因果证明。
 */

import { createHash } from "node:crypto";
import type { Hook, HookContext, Tool } from "@harness-pi/core";

/* ── 在 core 的 HookStateRegistry 上 augment 本 plugin 用到的 key ── */
declare module "@harness-pi/core" {
  interface HookStateRegistry {
    "prefix-shape.last": PrefixShapeDiagnostic;
  }
}

export type PrefixChangeReason =
  | "first_turn"
  | "model_or_provider_changed"
  | "system_prompt_changed"
  | "tool_schema_changed"
  | "provider_options_changed"
  | "stable";

export interface DurablePrefixComponents {
  modelProviderHash: string;
  systemPromptHash: string;
  toolSchemaHash: string;
  /** 仅当 `opts.providerOptions` 提供时为非空对象 hash；否则恒为空对象 hash（这一维不参与分类）。 */
  providerOptionsHash: string;
}

export interface PrefixShapeDiagnostic {
  /** 整段 durable prefix 的稳定 hash（`sha256:<hex>`）。 */
  prefixHash: string;
  changeReason: PrefixChangeReason;
  components: DurablePrefixComponents;
  turnIdx: number;
  /** 本 turn 真正上线（active）的工具数，便于人读「tools 12→13」。 */
  toolCount: number;
}

export interface CacheReconcileInfo {
  changeReason: PrefixChangeReason;
  cacheReadTokens: number;
  inputTokens: number;
  /**
   * `cacheRead / (input + cacheRead)`；0 表示全 miss。假设 `input` 不含已缓存 token（Anthropic /
   * OpenAI-completions 系约定）；若某 provider 把 `input` 报成「含缓存的总 prompt token」，分母会
   * 重复计数、该比值偏低——故这是同 provider 内的趋势信号，不是跨 provider 可比的硬指标。
   */
  cacheHitRatio: number;
}

export interface PrefixShapeOptions {
  /**
   * provider options 指纹源（默认不参与：多数 provider options 每 turn 稳定，且内核不经 hook 暴露）。
   * 给了就纳入 hash —— 调用方知道自己每 turn 在改 temperature / thinking budget 时才需要。
   */
  providerOptions?: (ctx: HookContext) => Record<string, unknown> | undefined;
  /** 每次 prefix 变化（`changeReason` 既非 `"stable"` 也非 `"first_turn"`）时回调，典型：emit metric。 */
  onPrefixChange?: (ctx: HookContext, diag: PrefixShapeDiagnostic) => void;
  /** `onLlmEnd` 对账：把「本 turn 预测的 changeReason」与「真实 usage.cacheRead」配对回调（默认不挂）。 */
  onCacheReconcile?: (ctx: HookContext, info: CacheReconcileInfo) => void;
  /** `changeReason` 非 stable/first_turn 时自动 `ctx.log.info` 一行（默认 true）。 */
  log?: boolean;
}

// `as const` 保留字面类型，让 TypedStateMap 走 typed overload 而非 string fallback。
const KEY = "prefix-shape.last" as const;

export function prefixShape(opts: PrefixShapeOptions = {}): Hook {
  return {
    name: "prefix-shape",
    internal: true,
    timeout: 50,

    // 观测式 passthrough：入参 tools 即「本 turn 真正上线的 active 子集」（已过 deferred-tools 过滤，
    // 若有）。返回 void 不改写 —— 纯观测。注册顺序应在 deferred-tools 之后才能看到过滤后子集；
    // 即便反了，结论也只是「按全集算 hash」而非崩溃（退化不致命）。
    transformToolsBeforeLlm(tools, ctx) {
      const components = computeDurablePrefix({
        model: ctx.config.model,
        systemPrompt: ctx.config.systemPrompt,
        activeTools: tools,
        providerOptions: opts.providerOptions?.(ctx),
      });
      const prior = ctx.state.get(KEY);
      const changeReason = classifyPrefixChange(components, prior?.components);
      const diag: PrefixShapeDiagnostic = {
        prefixHash: stableHash(components),
        changeReason,
        components,
        turnIdx: ctx.turnIdx,
        toolCount: tools.length,
      };
      ctx.state.set(KEY, diag);

      if (changeReason !== "stable" && changeReason !== "first_turn") {
        if (opts.log !== false) {
          ctx.log.info("prefix changed (cache prefix likely cold this turn)", {
            hook: "prefix-shape",
            reason: changeReason,
            turnIdx: ctx.turnIdx,
            toolCount: tools.length,
          });
        }
        opts.onPrefixChange?.(ctx, diag);
      }
      // 返回 void：不改写 tools listing
    },

    onLlmEnd(input, ctx) {
      if (!opts.onCacheReconcile) return;
      const diag = ctx.state.get(KEY);
      if (!diag) return;
      const usage = input.msg.usage;
      const cacheReadTokens = usage?.cacheRead ?? 0;
      const inputTokens = usage?.input ?? 0;
      const denom = inputTokens + cacheReadTokens;
      opts.onCacheReconcile(ctx, {
        changeReason: diag.changeReason,
        cacheReadTokens,
        inputTokens,
        cacheHitRatio: denom > 0 ? cacheReadTokens / denom : 0,
      });
    },
  };
}

/** 读取本 session 最近一次的 prefix-shape 诊断（跨 turn 留存在 `ctx.state`）。 */
export function getPrefixShapeState(
  ctx: HookContext,
): PrefixShapeDiagnostic | undefined {
  return ctx.state.get(KEY);
}

/* ────────────── 纯函数（移植自 maka request-shape.ts，砍到 durable-prefix-only）────────────── */

export interface DurablePrefixInput {
  model: { id: string; provider: string };
  systemPrompt: string;
  activeTools: ReadonlyArray<Tool>;
  providerOptions?: Record<string, unknown> | undefined;
}

export function computeDurablePrefix(
  input: DurablePrefixInput,
): DurablePrefixComponents {
  return {
    modelProviderHash: stableHash({
      provider: input.model.provider,
      modelId: input.model.id,
    }),
    systemPromptHash: stableHash(input.systemPrompt ?? ""),
    // 保留 active 子集的**线上顺序**（canonicalize 不排顶层数组）—— 工具重排会真正破坏 cache 前缀，
    // 应被如实标成 tool_schema_changed，不能 pre-sort 掩盖。schema 内部 required/enum 才排序。
    toolSchemaHash: stableHash(input.activeTools.map(toolShapeForDiagnostics)),
    providerOptionsHash: stableHash(input.providerOptions ?? {}),
  };
}

export function classifyPrefixChange(
  current: DurablePrefixComponents,
  prior: DurablePrefixComponents | undefined,
): PrefixChangeReason {
  if (!prior) return "first_turn";
  if (current.modelProviderHash !== prior.modelProviderHash)
    return "model_or_provider_changed";
  if (current.systemPromptHash !== prior.systemPromptHash)
    return "system_prompt_changed";
  if (current.toolSchemaHash !== prior.toolSchemaHash)
    return "tool_schema_changed";
  if (current.providerOptionsHash !== prior.providerOptionsHash)
    return "provider_options_changed";
  return "stable";
}

export function stableHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/**
 * harness/pi-ai 的 `Tool.parameters` 已是纯 JSON-schema 对象（TypeBox `TSchema`：keys = type/required/
 * properties，零 symbol key、`JSON.stringify` 确定性）——直接 canonicalize，无需 maka 的 zod `toJSONSchema` /
 * strip 包装层。
 */
function toolShapeForDiagnostics(tool: Tool): unknown {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

function canonicalize(value: unknown, parentKey?: string): unknown {
  if (value === null) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (
    typeof value === "undefined" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    return `[${typeof value}]`;
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalize(item));
    return shouldSortArray(parentKey)
      ? items
          .slice()
          .sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)))
      : items;
  }
  if (value instanceof Date) return value.toISOString();
  if (!isObjectLike(value)) return String(value);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = canonicalize(value[key], key);
  }
  return out;
}

/** 只排 JSON-schema 里语义无序的 `required` / `enum` 两个数组；其余数组顺序敏感（含 tools 线上顺序）。 */
function shouldSortArray(parentKey: string | undefined): boolean {
  return parentKey === "required" || parentKey === "enum";
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
