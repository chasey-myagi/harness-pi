/**
 * coding-agent 的默认 tool 审批规则（P2）。读类工具直接放行，改动类工具（bash/write/edit）走 ask
 * → 经 permissionGate.onAsk 弹审批框。规则是 domain-free 的 `name → decision`，首条命中胜出。
 */

import type { PermissionRule } from "@harness-pi/plugins";

export const READ_TOOLS = ["read", "grep", "find", "ls"] as const;
export const MUTATING_TOOLS = ["bash", "write", "edit"] as const;

/** 默认规则：read/grep/find/ls = allow；bash/write/edit = ask；（未命中由 permissionGate 的 fallback=deny 兜底）。 */
export function defaultPermissionRules(): PermissionRule[] {
  return [
    ...READ_TOOLS.map((name) => ({ match: name, decision: "allow" as const })),
    ...MUTATING_TOOLS.map((name) => ({ match: name, decision: "ask" as const })),
  ];
}
