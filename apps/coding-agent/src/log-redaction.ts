/**
 * Session log 的 tool-arg 脱敏策略（coding-agent 专用）。
 *
 * session-log 库层默认把 `call.arguments` 原样落盘；coding-agent 默认每会话挂它，会把第一方 mutating
 * 工具的高危内容（write 的整文件内容、edit 的源码片段/密钥、bash 含凭据的命令）静默写进
 * `.harness-pi/logs/<sessionId>.ndjson`——而目标 repo 未必把 `.harness-pi/` 加进 .gitignore。
 *
 * 本模块只对**已知的高危字符串字段**仅记长度、不落原文；其余字段（path/pattern/glob 等低危）原样透传。
 */

/**
 * 把 `clone` 里一个**存在的**高危字段就地脱敏：字符串记长度，非字符串只记一个无值标记。
 *
 * 为何非字符串也脱敏：tool schema 虽声明这些字段是 string，但模型可能发来错误类型（如对象/数组），
 * 内核不保证落盘前已 schema 校验。若只对 string 脱敏，一个 `content: { secret: ... }` 会原文落盘——
 * 这正是泄密点。故只要 key 存在就脱敏，类型不对也不放过（堵住对象/数组内容泄漏）。
 * 字段不存在则不动（不引入 undefined 字段，例如 edit 只给单边）。
 */
function redactField(
  clone: Record<string, unknown>,
  key: string,
  label: string,
): void {
  if (!(key in clone)) return;
  const v = clone[key];
  clone[key] =
    typeof v === "string"
      ? `[redacted ${label}, ${v.length} chars]`
      : `[redacted ${label}]`;
}

/**
 * 默认脱敏器：注入给 `sessionLog({ redactToolArgs })`。
 *
 * 行为：`args` 是非数组的非空对象时浅拷贝，只替换高危字段（存在即脱敏，含非字符串），其余一律保留：
 * - `write.content` → `[redacted content, N chars]`（非字符串 → `[redacted content]`）
 * - `edit.oldText` / `edit.newText` → `[redacted text, N chars]`
 * - `bash.command` → `[redacted command, N chars]`
 *
 * 其它工具、低危字段（path/pattern/glob…）、数组与非对象 args 一律原样返回。**无副作用**：浅拷贝后改副本，
 * 不原地 mutate 传入的 `args`（避免脱敏污染下游 tool 执行）。
 */
export function redactCodingToolArgs(toolName: string, args: unknown): unknown {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return args;
  }
  const clone: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  if (toolName === "write") {
    redactField(clone, "content", "content");
  } else if (toolName === "edit") {
    redactField(clone, "oldText", "text");
    redactField(clone, "newText", "text");
  } else if (toolName === "bash") {
    redactField(clone, "command", "command");
  }
  return clone;
}
