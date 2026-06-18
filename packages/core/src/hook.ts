/**
 * Hook protocol —— harness-pi 的核心扩展面。
 *
 * 四种形态（按 method 前缀 / 返回 envelope 区分）：
 *   - Event       (on*)        并行；返回 HookResult 中只 additionalContext/systemMessage 等"输出型"字段生效
 *   - Decision    (onPreToolUse/onUserPromptSubmit) 顺序短路；首个 decision/updatedInput/continue=false 拿决策权
 *   - Transform   (transform*) 顺序 pipe；前者输出 = 后者输入
 *   - Around      (wrap*)      洋葱嵌套；早注册在外层
 *
 * 详细执行模型 / 合并规则 / 性能契约见 docs/03-hook-system.md。
 */

import type {
  AssistantMessage,
  Message,
  Tool,
  ToolCall,
  Usage,
} from "@earendil-works/pi-ai";
import type { HarnessTool } from "./types.js";
// type-only import：编译期擦除，不构成与 session.ts 的运行时循环依赖。
import type { RunSummary } from "./session.js";

/* ──────────────────── Tool 执行结果 ──────────────────── */

/**
 * Tool 执行结果 —— 跟 pi-ai 的 toolResult message content 结构一致，外加 isError + （可选）
 * newMessages 字段。
 *
 * kernel 收到后会：
 *   1. 包成一条 toolResult message 追加进 session.messages
 *   2. 如果 newMessages 非空，**逐条追加进 session.messages**（在 toolResult 之后）
 */
export interface ToolExecResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;

  /**
   * 非模型文本元数据。用于 truncation、diff、fullOutputPath 等 UI / trace 需要但不应混入
   * LLM-visible content 的结构化信息。
   */
  details?: unknown;

  /**
   * 【高级用法】Tool 主动追加的额外 message。详见 docs/04-context-injection.md §6。
   * 大多数 plugin 应优先用 hook `additionalContext` 注入；只有"附加 message 是
   * tool 输出语义的一部分"才用 newMessages。
   *
   * 这些 message 是 persistent（进 session.messages、序列化时带）。
   */
  newMessages?: Message[];
}

/* ──────────────────── Hook event input 类型 ──────────────────── */

export interface SessionStartInput {
  /** 是 `run()` 还是 `continue()` 触发的 session start。 */
  source: "run" | "continue";
  /** 仅 source="run" 时存在，是 caller 给的 prompt。 */
  initialPrompt?: string;
}

export interface SessionEndInput {
  turns: number;
  reason: "done" | "max_turns" | "aborted" | "error" | "max_continuations";
  /** session 内同 run 触发的续跑次数（从 onContinuationCheck → continue=true 累计）。 */
  continuations: number;
}

/**
 * Continuation check —— `reason === "done"` 且还有续跑预算时，kernel 询问 hook 是否要续跑。
 * Hook 返回 `{ continue: true }` 让 session 在同一个 `run()` 内再跑一轮。
 *
 * **跟 `onSessionEnd` 严格区分**：
 *   - `onContinuationCheck` 可能 fire 0..maxContinuations 次（reason 永远是 "done"）
 *   - `onSessionEnd` 每次 run() 保证 fire **恰好一次**，在所有 turn loop + continuation 结束之后
 *
 * 这种分离让 session-log / cost-tracker 等 plugin 在 onSessionEnd 里安全做"终结"动作（关流、调
 * onSessionFinalized 回调）—— 不会被中间询问触发多次。
 */
export interface ContinuationCheckInput {
  turns: number;
  /** 本次询问之前已发生的续跑次数。 */
  continuations: number;
}

export interface TurnStartInput {
  turnIdx: number;
}

export interface TurnEndInput {
  turnIdx: number;
  assistantMessage: AssistantMessage;
  toolResults: ToolExecResult[];
}

/**
 * Steering 注入信号（设计依据 docs/09 §3.5）。`session.steer(msg)` 把消息 park 进 inbox，loop 在
 * **turn 开始的安全点** drain，对每条被注入的消息 fire 一次。这是「park 不 suspend」：消息不打断
 * 进行中的 turn，而是排到下一个安全点注入下一次 buildMessages，保证 turn 原子性 / cache 前缀不被破坏。
 *
 * 这是**观测点**：内核只提供「park + 安全点恢复」的机制；「何时该 park、谁能回复」是 policy（插件/app）。
 */
export interface SteerInput {
  /** 被注入进对话的消息（fire 时已 push 进 session.messages）。 */
  message: Message;
  /** drain 发生时的 turn 序号。 */
  turnIdx: number;
}

export interface LlmEndInput {
  msg: AssistantMessage;
  durationMs: number;
}

/**
 * Context overflow 信号（设计依据 docs/09 §3.6）。pi-ai 把「越界」表达成两种 **resolve 出**
 * 的终态（不是 sync throw —— sync throw 只发生在 provider 未注册这类配置错，不是 overflow）：
 *   - `stopReason==="length"`：输出/上下文窗口被模型截断（无歧义，必是 overflow）。
 *   - `stopReason==="error"`：provider 把 context-overflow 当 API error 报回，pi-ai 转成 error
 *     流事件 → `result()` resolve 出 `stopReason==="error"` 的 assistant，且 `errorMessage` 命中
 *     overflow 文案（默认启发式见 `defaultIsContextOverflow`，可经 `isContextOverflow` 选项覆盖）。
 *
 * 这是**观测点**：内核只负责把"越界"发出来，不再当普通 done 静默吞掉；**压缩/重启策略**由插件实现
 * （transformMessagesBeforeLlm 改写消息，或 `ctx.abort("compaction:...")` 让 compactRestartFresh 重启
 * fresh —— 前缀必须是 `compaction:`，isCompactionRestart 据此识别）。
 *
 * ⚠️ **锋利边**：fire 本身**不改变控制流**。若没有策略 abort 或改写消息，一次 `stopReason==="length"`
 * 截断仍会照常走完 turn loop、以 `reason:"done"` 收尾（被截断的 assistant 进 messages）；
 * `stopReason==="error"` 同理以 `reason:"done"` 收尾。光监听不够——要恢复必须挂会 abort/改写的策略。
 */
export interface ContextOverflowInput {
  turnIdx: number;
  /** 越界判别来源（即触发时 assistant 的 stopReason）：`"length"`=截断，`"error"`=被分类器判定的 overflow API 错误。 */
  stopReason: "length" | "error";
  /** `stopReason==="error"` 时携带 provider 错误文案，供策略记录 / 二次判定。 */
  errorMessage?: string;
  /** 当前 session.messages 条数（给策略一个粗粒度规模信号）。 */
  messageCount: number;
}

/**
 * After-flush 信号（C1，docs/09 §4.2「写 compaction 边界进 store」的内核 seam）。每个 turn 在
 * `_flushToStore()` 之后 fire（仅当 session 有 store）。
 *
 * **collect-return 语义（区别于普通 event）**：hook 可**返回** `{ compactionBoundary }` 让**内核**在
 * in-band、awaited、串行的路径上把它当作一条 `compaction_boundary` entry append 进 store——hook 自己
 * **没有**任何「可调用的写能力」。这是上一版设计（给 hook 一个 detached `appendCompactionBoundary`）
 * 被 review 三轮抓出 data-loss / store-corruption 后的重做：detached 写在 hook 超时时仍在飞，会乱序落在
 * 后续 turn / terminal 之后（resume 当成「丢弃之前一切」→ 静默删已完成 turn），且与下一轮 flush 的
 * appendEntry 并发打同一 sessionId（违反串行契约）。改成「hook 返回、内核串行写」后，**超时的 hook 其
 * 返回被 dispatcher 的 race 丢弃 → 内核拿不到 boundary → 不写 → 干净跳过，绝不产生 detached 写**。
 *
 * boundary 是 store 侧的额外 entry，**绝不动** `_persistedCount` / `_messages`：live session 继续用全量
 * `_messages`；只有 `resume()` 重建时才用 boundary 把前缀裁成 summary。与 view-only 压缩
 * （compactSummarize / autoCompaction 改的是「模型 view」、保 tail）是不同层、正交：那些省 token，
 * 这里省 resume 重放。
 */
export interface OnAfterFlushInput {
  turnIdx: number;
  /** 本次 flush 后已持久化的 message 数（= `_persistedCount`）。 */
  persistedCount: number;
}

/**
 * `onAfterFlush` 的返回 envelope。返回 `void` = 本 turn 不落 boundary；返回 `{ compactionBoundary }`
 * = 请内核在 store 末尾串行 append 一条覆盖全部已持久化前缀的 `compaction_boundary`。
 */
export interface OnAfterFlushResult {
  /** 内核据此 append 一条 `compaction_boundary{summary}`（in-band、awaited、串行）。 */
  compactionBoundary?: Message;
}

/**
 * Live 境界状態（カーネルが `_activeBoundary` として保持）。
 * autoCompaction が `transformMessagesBeforeLlm` 内で `ctx.state` にセット、
 * カーネルが各 turn 後に読み取り、次 turn の `baseMessages` 投影に使う。
 *
 * **summary を同一オブジェクトとして使い回す**ことで、prefix bytes が安定し、
 * provider の prompt-cache 命中率を最大化する（`createUserMessage` の timestamp が
 * 毎 turn 変わる問題を解消）。
 */
export interface ActiveBoundary {
  /** LLM に送る projected messages の先頭に置く summary message。同一オブジェクト再利用 = bytes 安定。 */
  summary: Message;
  /**
   * `_messages` の先頭から何条を summary に要約済みか（`_messages` インデックス基準）。
   * カーネルは `[summary, ..._messages.slice(coveredCount), ...pendingAttachments]` と投影する。
   */
  coveredCount: number;
}

export interface PreToolUseInput {
  call: ToolCall;
  tool: HarnessTool;
}

export interface PostToolUseInput {
  call: ToolCall;
  result: ToolExecResult;
  durationMs: number;
}

export interface UserPromptSubmitInput {
  userMessage: Message;
}

export interface ErrorInput {
  phase: "llm" | "tool" | "hook";
  err: Error;
  call?: ToolCall;
  hookName?: string;
}

/**
 * 子 agent **spawn 前**的观测信号（O5）。只有经 subAgentTool / routedSubAgentTool 造的子才会 fire——
 * 它们在 tool 内调 `ctx.fireSubagentStart(...)` 把事件派发到**父** session 的 hook。让 metrics / sessionLog
 * 等现有 plugin 统一观测子 agent 生命周期，无需各自插桩 sessionFactory。
 */
export interface OnSubagentStartInput {
  /** 子 session 的 id（= `AgentSession.id`）。 */
  agentId: string;
  /** 派给子 agent 的任务文本。 */
  task: string;
  /** 子 agent 的递归深度（父深度 + 1，与 subAgent.depth 透传一致）。 */
  depth: number;
}

/**
 * 子 agent **跑完后**的观测信号（O5），带终态。配对 `OnSubagentStartInput`：start 先于 end。
 * 字段取自子 session 的 `RunSummary` 终态 + 回灌父模型的文本。
 */
export interface OnSubagentEndInput {
  agentId: string;
  task: string;
  depth: number;
  /** 子 session 的终态判别（与 `RunSummary.reason` 同一枚举）。 */
  reason: RunSummary["reason"];
  /** 子 session 跑过的 turn 数。 */
  turns: number;
  /** 子 session 累计 token usage（含 cost）。 */
  usage: Usage;
  /** 子最后一条 assistant 的纯文本（回灌父模型的内容）；无文本输出则缺省。 */
  summaryText?: string;
}

/* ──────────────────── 统一返回 envelope ──────────────────── */

/**
 * 所有 hook 方法的统一返回 shape。每个方法只用其中一部分字段，无效字段被 dispatcher 忽略。
 * 借鉴 Claude Code `syncHookResponseSchema`。
 */
export interface HookResult {
  // ── Control flow ──
  /** false → 结束 session。默认 true。 */
  continue?: boolean;
  /** continue=false 时给 user / log 的解释。 */
  stopReason?: string;

  // ── Decision (PreToolUse / UserPromptSubmit) ──
  decision?: "allow" | "deny";
  reason?: string;
  /** 改 tool args（仅 PreToolUse）。 */
  updatedInput?: Record<string, unknown>;
  /** 改 tool result（仅 PostToolUse）。 */
  updatedToolOutput?: ToolExecResult;

  // ── Context injection ──
  /** Transient：包成 attachment 拼到下次 LLM call。多 hook 拼数组按注册顺序。 */
  additionalContext?: string;
  /** Persistent：仅 SessionStart 用，作为初始 user message 入 session.messages。 */
  initialUserMessage?: string;

  // ── UX ──
  /** 给 user console 看的，永不进 LLM context。 */
  systemMessage?: string;
}

/**
 * Dispatcher 把多 hook 的结果合并后的产物。详见 docs/03-hook-system.md §5 合并规则。
 */
export interface MergedHookResult {
  continue?: boolean;
  stopReason?: string;
  decision?: "allow" | "deny";
  reason?: string;
  updatedInput?: Record<string, unknown>;
  updatedToolOutput?: ToolExecResult;
  additionalContexts: string[];
  systemMessages: string[];
  initialUserMessage?: string;
}

/* ──────────────────── HookContext ──────────────────── */

/**
 * Plugin 在 `ctx.state` 里写入的 key → 值类型映射表。Plugin 用 module augmentation 注册自己的 key：
 *
 * @example
 *   // 在你的 plugin 文件顶部：
 *   declare module "@harness-pi/core" {
 *     interface HookStateRegistry {
 *       "cost-tracker.stats": CostStats;
 *       "cost-tracker.startTs": number;
 *     }
 *   }
 *
 * 之后 `ctx.state.get("cost-tracker.stats")` 直接拿到 `CostStats | undefined`，无需 `as` 强转。
 *
 * 未注册的 key 走 fallback：`get/set` 接受 `string` 并退回 `unknown`，跟当前调用点行为一致。
 */
export interface HookStateRegistry {
  /** カーネルが管理する live 境界。autoCompaction が書き込み、カーネルが投影に使う。 */
  "harness-pi.activeBoundary": ActiveBoundary;
}

type RegistryKey = keyof HookStateRegistry & string;

/**
 * 已注册 key K 对应的值类型；未注册 key 回退 `unknown`。用单个 conditional type 而不是
 * overload，避免 TS 在字面类型匹配时退到 string fallback。
 *
 * 内部 implementor (`StateMapImpl`) 也用这个类型。
 */
export type StateValueFor<K extends string> = K extends RegistryKey
  ? HookStateRegistry[K]
  : unknown;

/**
 * 类型化 state map。已注册 key 自动推断值类型，未注册 key 仍可用 string 但值是 `unknown`。
 *
 * 物理上是同一个 Map<string, unknown>，TypedStateMap 是它的 typed view。
 */
export interface TypedStateMap {
  get<K extends string>(key: K): StateValueFor<K> | undefined;
  set<K extends string>(key: K, value: StateValueFor<K>): void;
  has<K extends string>(key: K): boolean;
  delete<K extends string>(key: K): boolean;

  readonly size: number;
  clear(): void;
}

/**
 * 结构化 logger —— plugin 用 `ctx.log.info(...)` 替代 `console.log`。
 * sessionId / turnIdx 由 kernel 自动注入到每条 log 的 fields。
 *
 * 默认实现走 `console`（带 `[harness-pi sessionId turn=N]` 前缀）；
 * `AgentSessionOptions.logSink` 可换成结构化 sink（pino / winston / 业务自管）。
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface HookLogger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/**
 * Session 级 config 的只读视图。Plugin 想问"当前 model 是什么 / 有哪些 tool / maxTurns 多少"
 * 时通过 `ctx.config` 拿，不要从 closure 里捕获——后者一旦 `session.use()` 改了 hooks
 * 就过期。
 *
 * 借鉴 Claude Code QueryConfig（[08-claude-code-lessons](docs/08-claude-code-lessons.md) §2.1）。
 */
export interface SessionConfigView {
  readonly sessionId: string;
  /**
   * 当前 model 的标识 + 有效窗口（X2 / #57）。`contextWindow` / `maxTokens` 取自 pi-ai `Model` 同名字段
   * （`makeOpenAICompatibleModel` / registry 都填）——**值来自调用方 Model，内核不硬编 per-model 表、不解析 id**。
   * autoCompaction 据此算「按有效窗口触发」的绝对阈值（`contextWindow − reserveForOutput − safetyBuffer`）。
   */
  readonly model: {
    id: string;
    provider: string;
    contextWindow: number;
    maxTokens: number;
  };
  readonly toolNames: ReadonlyArray<string>;
  /**
   * 发给 LLM 的 tool schema（pi-ai `Tool` 形态 `{name, description, parameters}`，与每次请求随发的
   * piTools 同形且内容一致——tools 不经 pipe 改写）。token 估算插件（X1）需要它把「每请求随发的 tool
   * schema 体积」计进 context 估算——只数 `toolNames` 会**严重低估**真实 usage（D0 实测低估 ~7x）。
   * 只读:数组与每个元素冻结;但 `parameters` 是 schema 对象引用、未深冻（估算只读不写）。
   */
  readonly tools: ReadonlyArray<Tool>;
  /**
   * **base** system prompt（构造期传入的原值；无则空串）。token 估算据此计入「每请求随发的 system 开销」。
   * 注意:若挂了 `transformSystemPromptBeforeLlm` pipe hook 改写 system prompt,实际随发的是 **pipe 后**的值,
   * 本视图给的是 **pre-pipe base**——估算可能略低估被 hook 注入的增量（目前无 first-party hook 这么做）。只读。
   */
  readonly systemPrompt: string;
  readonly maxTurns: number;
  readonly maxContinuations: number;
}

/**
 * 整个 session 共享一个 HookContext 实例。turnIdx 等运行时字段由 kernel 在 turn 切换时更新。
 *
 * 详见 docs/02-kernel.md §7。
 */
export interface HookContext {
  readonly sessionId: string;
  /** 当前 turn 序号（0-based）。kernel 在 onTurnStart 之前更新。 */
  readonly turnIdx: number;
  /** session 级 abort signal。任何 hook / tool 应该尊重它。 */
  readonly signal: AbortSignal;
  /** Plugin 之间协作的共享 map。约定 key 带 plugin 前缀防撞名。已注册 key 自动类型推断（见 `HookStateRegistry`）。 */
  readonly state: TypedStateMap;
  /** 当前 session.messages 的只读引用。 */
  readonly messages: ReadonlyArray<Message>;
  /** Session 级 config 只读视图。Plugin 用它代替闭包捕获 model / tools / maxTurns 等。 */
  readonly config: SessionConfigView;
  /** 结构化 logger。所有 log 自动带 sessionId / turnIdx；plugin 自己的 name 在 `hook` 字段里手动加。 */
  readonly log: HookLogger;

  /** Persistent message 注入：push 到 session.messages，下次 LLM call 看见。 */
  appendMessage(msg: Message): void;

  /** 主动结束 session。当前 turn 走完后退出。 */
  abort(reason: string): void;

  /** 内部 emit（用于 kernel ↔ plugin 互通；极少用）。 */
  emit(event: { type: string; [k: string]: unknown }): void;

  /**
   * 把 `onSubagentStart` 事件派发到**本（父）session** 的 hook（O5）。供 controller 在 tool 内、spawn
   * 子 agent 前调用——子在 `depth + 1`。**只有经 subAgentTool / routedSubAgentTool 造的子才会 fire**；
   * forkSession / workPool / 直接 `new AgentSession` 的子不 fire（无父 ctx 在 scope）。
   */
  fireSubagentStart(input: OnSubagentStartInput): Promise<void>;

  /**
   * 把 `onSubagentEnd` 事件派发到**本（父）session** 的 hook（O5）。供 controller 在子 agent 跑完、
   * 拿到终态后调用。作用域边界同 `fireSubagentStart`。
   */
  fireSubagentEnd(input: OnSubagentEndInput): Promise<void>;
}

/* ──────────────────── Hook 接口 ──────────────────── */

/**
 * Hook = 一个对象，按 method 名声明它要 hook 的事件 / 阶段。
 * 所有方法可选；plugin 只实现自己关心的。
 *
 * @example
 *   export function watchdog(opts: { turnTimeoutMs: number }): Hook {
 *     return {
 *       name: "watchdog",
 *       async wrapTurn(ctx, next) {
 *         const timer = setTimeout(() => ctx.abort("watchdog timeout"), opts.turnTimeoutMs);
 *         try { await next(); } finally { clearTimeout(timer); }
 *       },
 *     };
 *   }
 */
export interface Hook {
  /** 调试 / metrics / log 归因用。必须唯一（重名不报错但混淆 log）。 */
  name: string;

  /** Per-hook timeout (ms)。默认按 method 类型走：event 100 / decision 200 / pipe 500。 */
  timeout?: number;

  /** Internal hook 不上报 hook 自身的 metric。 */
  internal?: boolean;

  /**
   * 硬依赖声明：缺了或顺序错就 warn。**没有 fallback 路径的依赖**用这个。
   *
   * 例子：一个 plugin 必须读 cost-tracker 的累计 token 才能工作（没 fallback），就用
   * `requires: ["cost-tracker"]`。
   */
  requires?: string[];

  /**
   * 软依赖声明：有 fallback 路径，但有对方会更好。**不发出 warning**——只用于文档/
   * tooling 视化依赖图。
   *
   * 例子：`tokenBudget` 优先读 cost-tracker，但缺了也能自累 token；用 `prefers`。
   */
  prefers?: string[];

  /**
   * 软冲突声明：构造 session 时如果同时存在 `conflictsWith` 里的 hook name，warn。
   * 适合标记"语义重叠不该一起用"的 plugin（例如两个不同策略的 token budget）。
   */
  conflictsWith?: string[];

  /**
   * 仅对 **decision** hook（onPreToolUse / onUserPromptSubmit）有效。
   *
   * - `false`（默认）：hook throw / timeout → fail-open（视为没发表意见，继续问下一个 hook）。
   *   适合"软策略"：通知 / 注 context / 软建议。
   * - `true`：hook throw / timeout → fail-closed（视为 deny，工具被拒绝执行）。
   *   适合"硬策略"：权限检查 / lease / 鉴权——宁可错杀，不可放过。
   *
   * 对 event / pipe / around hook 不生效（这些形态 fail-open 是合理默认）。
   */
  failClosed?: boolean;

  /**
   * 标记「安全关键」decision hook（权限 / lease / 鉴权），docs/09 §3.7。
   *
   * `critical:true` 的 decision hook **必须显式声明 `failClosed`**（true 或 false 都行，但不能不写）——
   * 否则在 **session 构造期直接抛错**（fail-loud）。目的：让最该表态的那类 hook 无法靠"忘了设 →
   * 静默 fail-open"放过本该拒绝的调用。`critical` 只对 decision hook（onPreToolUse / onUserPromptSubmit）
   * 有意义；标在非 decision hook 上同样构造期报错（属作者的类别误用）。
   */
  critical?: boolean;

  // ─────────── Event (parallel) ───────────
  onSessionStart?(
    input: SessionStartInput,
    ctx: HookContext,
  ): HookResult | void | Promise<HookResult | void>;
  onSessionEnd?(
    input: SessionEndInput,
    ctx: HookContext,
  ): HookResult | void | Promise<HookResult | void>;
  onTurnStart?(
    input: TurnStartInput,
    ctx: HookContext,
  ): HookResult | void | Promise<HookResult | void>;
  onTurnEnd?(
    input: TurnEndInput,
    ctx: HookContext,
  ): HookResult | void | Promise<HookResult | void>;
  /** Steering 观测点：loop 在 turn 开始的安全点 drain inbox、对每条被注入的消息 fire 一次（docs/09 §3.5）。 */
  onSteer?(
    input: SteerInput,
    ctx: HookContext,
  ): HookResult | void | Promise<HookResult | void>;
  onLlmEnd?(
    input: LlmEndInput,
    ctx: HookContext,
  ): HookResult | void | Promise<HookResult | void>;
  /** Context overflow 观测点（stopReason==="length" 截断，或被分类的 overflow API error）。compaction 策略插件挂这里。 */
  onContextOverflow?(
    input: ContextOverflowInput,
    ctx: HookContext,
  ): HookResult | void | Promise<HookResult | void>;
  /**
   * After-flush 观测点：每 turn flush 到 store 后 fire（仅有 store 时）。**collect-return**：返回
   * `{ compactionBoundary }` 让内核在 store 末尾串行落一条 boundary（无「可调用写能力」，超时即被丢弃，
   * 见 `OnAfterFlushInput` / `OnAfterFlushResult`）。`summarize` 可调 LLM，故应设较长 `timeout`。
   */
  onAfterFlush?(
    input: OnAfterFlushInput,
    ctx: HookContext,
  ): OnAfterFlushResult | void | Promise<OnAfterFlushResult | void>;
  onPostToolUse?(
    input: PostToolUseInput,
    ctx: HookContext,
  ): HookResult | void | Promise<HookResult | void>;
  /**
   * 询问续跑的事件——只在 reason === "done" 且 continuations < maxContinuations 时 fire。
   * 返回 `{ continue: true, additionalContext: "..." }` 触发同 session 续跑。
   * 不要在这里关流、调 finalize ——那是 onSessionEnd 的事。
   */
  onContinuationCheck?(
    input: ContinuationCheckInput,
    ctx: HookContext,
  ): HookResult | void | Promise<HookResult | void>;
  onError?(input: ErrorInput, ctx: HookContext): void | Promise<void>;
  /**
   * 子 agent **spawn 前**观测点（O5）。fire-and-observe（像 onError，**返回被忽略**，无控制流）。
   * 只对经 subAgentTool / routedSubAgentTool 造的子 fire；其它来源的子 session 不触发。
   */
  onSubagentStart?(
    input: OnSubagentStartInput,
    ctx: HookContext,
  ): void | Promise<void>;
  /**
   * 子 agent **跑完后**观测点（O5），带终态。fire-and-observe（**返回被忽略**）。
   * 与 onSubagentStart 配对、作用域相同。
   */
  onSubagentEnd?(
    input: OnSubagentEndInput,
    ctx: HookContext,
  ): void | Promise<void>;

  // ─────────── Decision (sequential short-circuit) ───────────
  onPreToolUse?(
    input: PreToolUseInput,
    ctx: HookContext,
  ): HookResult | void | Promise<HookResult | void>;
  onUserPromptSubmit?(
    input: UserPromptSubmitInput,
    ctx: HookContext,
  ): HookResult | void | Promise<HookResult | void>;

  // ─────────── Transform (sequential pipe) ───────────
  transformSystemPromptBeforeLlm?(
    systemPrompt: string,
    ctx: HookContext,
  ): string | void | Promise<string | void>;
  transformMessagesBeforeLlm?(
    messages: Message[],
    ctx: HookContext,
  ): Message[] | void | Promise<Message[] | void>;
  /**
   * listing-only：transform LLM call 这一帧随发的 tool listing（裸 pi-ai `Tool`，仅
   * name/description/parameters）。返回 `Tool[]` 收窄/重排可见工具，`void` 保持不变。
   * **不影响 execution**：执行/校验始终走 `session.tools` 全集，filter 掉的工具仍可被调用。
   * 值类型刻意用裸 `Tool` 而非 `HarnessTool`，从类型层堵死在 listing 里塞 `execute`。
   */
  transformToolsBeforeLlm?(
    tools: Tool[],
    ctx: HookContext,
  ): Tool[] | void | Promise<Tool[] | void>;

  // ─────────── Around (nested) ───────────
  wrapTurn?(ctx: HookContext, next: () => Promise<void>): Promise<void>;
  wrapToolExec?(
    call: ToolCall,
    ctx: HookContext,
    next: () => Promise<ToolExecResult>,
  ): Promise<ToolExecResult>;
}

/* ──────────────────── ToolDecision (legacy 兼容名) ──────────────────── */

/**
 * 历史名字，等同于 HookResult 中 decision/updatedInput 字段的子集。
 * 新代码请直接返回 HookResult。
 */
export interface ToolDecision {
  deny?: string;
  modifyArgs?: Record<string, unknown>;
}
