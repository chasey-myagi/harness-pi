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
 * 默认脱敏器：注入给 `sessionLog({ redactToolArgs })`。
 *
 * 行为：`args` 是非空对象时浅拷贝，只替换高危字符串字段，其余一律保留：
 * - `write.content` → `[redacted content, N chars]`
 * - `edit.oldText` / `edit.newText` → `[redacted text, N chars]`
 * - `bash.command` → `[redacted command, N chars]`
 *
 * 其它工具、非字符串字段、以及非对象 args 一律原样返回。
 */
export function redactCodingToolArgs(toolName: string, args: unknown): unknown {
  if (typeof args !== "object" || args === null) return args;
  const clone: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  if (toolName === "write" && typeof clone["content"] === "string") {
    clone["content"] = `[redacted content, ${clone["content"].length} chars]`;
  } else if (toolName === "edit") {
    if (typeof clone["oldText"] === "string") {
      clone["oldText"] = `[redacted text, ${clone["oldText"].length} chars]`;
    }
    if (typeof clone["newText"] === "string") {
      clone["newText"] = `[redacted text, ${clone["newText"].length} chars]`;
    }
  } else if (toolName === "bash" && typeof clone["command"] === "string") {
    clone["command"] = `[redacted command, ${clone["command"].length} chars]`;
  }
  return clone;
}
