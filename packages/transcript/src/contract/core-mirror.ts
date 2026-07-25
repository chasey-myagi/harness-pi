/**
 * 内核事件的**必填闭包镜像**。
 *
 * 本包要能原样跑在浏览器与 Electron renderer 里，因此不能 import `@harness-pi/core`
 * 或 `@earendil-works/pi-ai`。做法是在这里自持一套结构等价的类型，投影器（#166 / #167）
 * 只吃这套镜像；镜像与内核之间由 `__typecheck__/core-mirror.assert.ts` 的**双向**
 * assignability 断言绑住。
 *
 * ## 为什么是「必填闭包」而不是「可渲染子集」
 *
 * 双向可赋值 ≈ 结构等价。窄到只剩「UI 想要的字段」会让 `Mirror → Core` 方向失败
 * （缺必填属性）。**能省的只有可选字段**：`AssistantMessage` 的 8 个必填与 `Usage`
 * 的 10 个数字一个都跑不掉。
 *
 * ## 被省略的可选字段（供 review 逐条对表）
 *
 * | 省略字段 | 内核出处 | 省略理由 |
 * | --- | --- | --- |
 * | `RunSummary.error?: Error` | `core/src/session.ts:253` | `Error` 是宿主类，不可结构化克隆 |
 * | `RunSummary.abortReason?: string` | `core/src/session.ts:254` | M0 无消费者 |
 * | `RunSummary.persistenceErrors?: string[]` | `core/src/session.ts:256` | 属 host 侧诊断，非渲染信息 |
 * | `ToolExecResult.details?: unknown` | `core/src/hook.ts:45` | `unknown` 是断言盲区，留着等于自欺 |
 * | `ToolExecResult.newMessages?: Message[]` | `core/src/hook.ts:54` | 会把整条 `Message` union 拖进浏览器契约 |
 * | `AssistantMessage.responseModel?` | pi-ai `types.d.ts` | provider 元数据，M0 无消费者 |
 * | `AssistantMessage.responseId?` | pi-ai `types.d.ts` | 同上 |
 * | `AssistantMessage.diagnostics?` | pi-ai `types.d.ts` | 定义在 pi-ai 的独立模块，闭包外扩 |
 * | `AssistantMessage.errorMessage?` | pi-ai `types.d.ts` | 与 `stopReason: "error"` 重复，M0 用后者判失败 |
 * | `TextContent.textSignature?` | pi-ai `types.d.ts` | 不透明 provider 续话 blob |
 * | `ThinkingContent.thinkingSignature?` | pi-ai `types.d.ts` | 同上 |
 * | `ToolCall.thoughtSignature?` | pi-ai `types.d.ts` | 同上 |
 *
 * 省略**可选**字段不会让任一方向的断言失败——这正是上面那张表能成立的原因，也正是
 * `core-mirror.assert.ts` 文件头里记录的两种盲区的来源。新增省略项时**必须同步这张表**。
 *
 * ## 已知的非省略盲区
 *
 * `MirrorToolCall.arguments` 在内核侧是 `Record<string, any>`（pi-ai `ToolCall`）。`any`
 * 与任何类型双向可赋值，因此**该字段的形状不受断言保护**。这里写 `Record<string, unknown>`
 * 是为了下游消费者的类型安全，不代表它被绑住了。
 *
 * @see `packages/core/src/session.ts:56-64`（`SessionEvent`）
 * @see `packages/core/src/session.ts:77-103`（`LiveEvent`）
 */

/* ──────────────────── pi-ai 叶子类型的镜像 ──────────────────── */

/** 镜像 pi-ai `StopReason`。 */
export type MirrorStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

/** 镜像 pi-ai `TextContent`（省略 `textSignature?`）。 */
export interface MirrorTextContent {
  type: "text";
  text: string;
}

/** 镜像 pi-ai `ThinkingContent`（省略 `thinkingSignature?`；保留 `redacted?`，UI 要显示「已被安全过滤」）。 */
export interface MirrorThinkingContent {
  type: "thinking";
  thinking: string;
  redacted?: boolean;
}

/** 镜像 pi-ai `ToolCall`（省略 `thoughtSignature?`）。`arguments` 见文件头「已知的非省略盲区」。 */
export interface MirrorToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** 镜像 pi-ai `Usage`。10 个数字全必填，一个都省不掉。 */
export interface MirrorUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

/**
 * 镜像 pi-ai `AssistantMessage`。
 *
 * `api` / `provider` 在内核侧分别是 `KnownApi | (string & {})` 与 `KnownProvider | string`，
 * 两者都塌缩成 `string`；这里写裸 `string`，双向都过。写成枚举反而会在 provider 名单变化时
 * 制造假失败。
 */
export interface MirrorAssistantMessage {
  role: "assistant";
  content: Array<MirrorTextContent | MirrorThinkingContent | MirrorToolCall>;
  api: string;
  provider: string;
  model: string;
  usage: MirrorUsage;
  stopReason: MirrorStopReason;
  timestamp: number;
}

/* ──────────────────── core 类型的镜像 ──────────────────── */

/** 镜像 `core/src/hook.ts` 的 `ToolExecResult`（省略 `details?` 与 `newMessages?`）。 */
export interface MirrorToolExecResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
}

/** 镜像 `core/src/session.ts` 的 `RunSummary`（省略 `error?` / `abortReason?` / `persistenceErrors?`）。 */
export interface MirrorRunSummary {
  turns: number;
  continuations: number;
  reason: "done" | "max_turns" | "aborted" | "error" | "max_continuations";
  usage: MirrorUsage;
  lastMessage?: MirrorAssistantMessage;
  stopReason?: MirrorStopReason;
}

/* ──────────────────── 两条事件轨的镜像 ──────────────────── */

/**
 * 镜像 `SessionEvent`（coarse / recorded 轨，经 `runStreaming()` 暴露）。8 个 arm。
 *
 * 内核那侧的注释提醒：`tool-end.result.newMessages` 是 tool 想注入的原始 message，
 * 不等于内核实际接受的。本镜像**省略了 `newMessages`**，因此这个歧义在投影层不存在。
 */
export type MirrorSessionEvent =
  | { type: "session-start"; sessionId: string; source: "run" | "continue"; initialPrompt?: string }
  | { type: "turn-start"; turnIdx: number }
  | { type: "llm-end"; msg: MirrorAssistantMessage; durationMs: number }
  | { type: "tool-end"; call: MirrorToolCall; result: MirrorToolExecResult; durationMs: number }
  | { type: "turn-end"; turnIdx: number; toolResultsCount: number; stopReason: MirrorStopReason }
  | { type: "continuation-check"; turns: number; continuations: number }
  | { type: "session-end"; summary: MirrorRunSummary }
  | { type: "error"; phase: "llm" | "tool" | "hook"; message: string; hookName?: string };

/**
 * 镜像 `LiveEvent`（fine / live 轨，经 `session.on()` 订阅）。6 个 arm。
 *
 * 内核契约（务必随镜像一起传达给消费者）：`message_update` 是**回合进行中的中间快照**，
 * 不是终态；要终态必须用 `message_end.message`。`message_end.message` 可缺省——只有
 * `stream()` 同步抛时才缺省，判失败应看 `message.stopReason` 而非「message 是否存在」。
 */
export type MirrorLiveEvent =
  | { type: "message_start" }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "message_update"; message: MirrorAssistantMessage }
  | { type: "message_end"; message?: MirrorAssistantMessage };
