/**
 * System reminder —— 按条件向 LLM 注入 `<system-reminder>` transient 提示。
 *
 * 用 hook event 的 `additionalContext` 字段注入；kernel 会包成 attachment message
 * 拼到下次 LLM call 的 messages 末尾。
 *
 * 详见 docs/05-plugins.md §5.6。
 */

import type {
  Hook,
  HookContext,
  HookResult,
  TurnStartInput,
  TurnEndInput,
  PostToolUseInput,
} from "@harness-pi/core";

export type ReminderEvent = "turnStart" | "turnEnd" | "postToolUse";

export interface SystemReminderOptions {
  /** 触发时机。 */
  on: ReminderEvent;
  /** 返回 reminder 文本或 null（null = 不注入）。 */
  trigger: (
    ctx: HookContext,
    input: TurnStartInput | TurnEndInput | PostToolUseInput,
  ) => string | null | undefined;
  /** 是否包 `<system-reminder>` tag，默认 true。 */
  wrap?: boolean;
}

export function systemReminder(opts: SystemReminderOptions): Hook {
  const wrap = opts.wrap ?? true;

  const buildResult = (text: string | null | undefined): HookResult | void => {
    if (!text) return;
    const body = wrap ? `<system-reminder>${text}</system-reminder>` : text;
    return { additionalContext: body };
  };

  const hook: Hook = { name: `system-reminder(${opts.on})`, timeout: 50 };
  if (opts.on === "turnStart") {
    hook.onTurnStart = (input, ctx) => buildResult(opts.trigger(ctx, input));
  } else if (opts.on === "turnEnd") {
    hook.onTurnEnd = (input, ctx) => buildResult(opts.trigger(ctx, input));
  } else if (opts.on === "postToolUse") {
    hook.onPostToolUse = (input, ctx) => buildResult(opts.trigger(ctx, input));
  }
  return hook;
}
