/**
 * permissionGate —— 声明式 tool permission 规则引擎（docs/09 §4.3，建在内核 onPreToolUse decision
 * hook + 单 tool chokepoint 上）。
 *
 * 形态：一组 `pattern → allow/ask/deny` 规则，**首条命中者胜出**；无命中走 `fallback`（默认 deny）。
 * 默认 `critical:true` + `failClosed:true`（配合 §3.7）：规则求值抛错 / 超时 → 内核当 deny，宁可错杀。
 *
 * **机制 vs 策略**：本插件只给规则引擎骨架。规则里的 **domain 判定**（「这题是不是当前 lease 的题」「agent
 * 锁没锁」）由调用方以 `match` 谓词提供——permissionGate 不认识任何业务概念（判据 3）。bidding 的 6 处
 * 复制守卫（currentQuestionMismatch + isAgentLocked）就收敛成这里的几条带谓词的规则。
 *
 * `"ask"`：内核 decision 只有 allow/deny，没有 ask。ask 由 `onAsk` 解析器（可 async，比如 RPC 问人）
 * 落成 allow/deny；没给 `onAsk` 时 ask → deny（fail-closed）。
 */

import type { Hook, HookContext } from "@harness-pi/core";
import type { ToolCall } from "@mariozechner/pi-ai";

export type PermissionDecision = "allow" | "ask" | "deny";

/** 规则匹配器：精确 tool name（string）、name 正则（RegExp）、或 domain 谓词（function）。 */
export type PermissionMatch =
  | string
  | RegExp
  | ((call: ToolCall, ctx: HookContext) => boolean);

export interface PermissionRule {
  /** 规则名（log / 调试用，可选）。 */
  name?: string;
  /** 命中条件。 */
  match: PermissionMatch;
  /** 命中后的决策。 */
  decision: PermissionDecision;
  /** deny（或 ask→deny）时给 LLM / log 的理由。 */
  reason?: string;
}

export interface PermissionGateOptions {
  /** 规则表，按顺序求值，首条命中者胜出。 */
  rules: PermissionRule[];
  /** 无规则命中时的兜底。默认 `"deny"`（fail-closed 默认：没写规则的工具不许跑）。 */
  fallback?: PermissionDecision;
  /** `"ask"` 的解析器：返回 true=放行 / false=拒绝。可 async。缺省时 ask → deny。 */
  onAsk?: (call: ToolCall, ctx: HookContext) => boolean | Promise<boolean>;
  /**
   * hook 失败（抛错 / 超时）语义，默认 `true`（配合 §3.7：权限 hook 挂了宁可 deny）。
   * 显式传 false 可选 fail-open，但内核会要求 critical hook 表态——这里总是显式设值，故不会触发构造期报错。
   */
  failClosed?: boolean;
  /** decision 超时（ms）。`onAsk` 可能 RPC，按需放宽；缺省走内核 decision 默认（200ms）。 */
  timeout?: number;
}

function matches(
  match: PermissionMatch,
  call: ToolCall,
  ctx: HookContext,
): boolean {
  if (typeof match === "string") return match === call.name;
  if (match instanceof RegExp) return match.test(call.name);
  return match(call, ctx);
}

export function permissionGate(opts: PermissionGateOptions): Hook {
  const fallback = opts.fallback ?? "deny";

  return {
    name: "permissionGate",
    critical: true,
    failClosed: opts.failClosed ?? true,
    ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),

    async onPreToolUse(input, ctx) {
      const rule = opts.rules.find((r) => matches(r.match, input.call, ctx));
      const decision = rule ? rule.decision : fallback;
      const reason = rule?.reason;
      const toolName = input.call.name;

      if (decision === "allow") return { decision: "allow" };
      if (decision === "deny") {
        return {
          decision: "deny",
          reason: reason ?? `permissionGate denied "${toolName}"`,
        };
      }

      // decision === "ask"：没解析器就 fail-closed deny。
      if (!opts.onAsk) {
        return {
          decision: "deny",
          reason:
            reason ??
            `permissionGate: "${toolName}" requires approval but no onAsk resolver is configured (fail-closed)`,
        };
      }
      const approved = await opts.onAsk(input.call, ctx);
      return approved
        ? { decision: "allow" }
        : {
            decision: "deny",
            reason: reason ?? `approval denied for "${toolName}"`,
          };
    },
  };
}
