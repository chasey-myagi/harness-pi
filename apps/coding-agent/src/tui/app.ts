/**
 * TUI 壳（薄层，建在 pi-tui 上）。把"事件→动作"（event-bridge）和"动作→显示文本"（format）这两层
 * 纯逻辑接到真实 pi-tui 组件上：消息区(Container) / 思考中(Loader) / 输入框(Editor) / 状态栏(Text)。
 *
 * 刻意保持薄、把可测逻辑都外推到纯函数——pi-tui 需真实终端 raw mode、难自动化测；本层只做组件装配 +
 * 运行循环 + 键位，靠注入 Terminal/session 做 headless smoke test（render 出文本断言），其余手动 smoke。
 *
 * 已实现：coarse+fine 双轨流式渲染（P0/P1）、permissionGate 审批弹窗 + steering 运行中插话 + Esc 中断（P2）。
 * 后续叠加：SessionStore resume（P3）、compaction（P4）、状态栏富化（P5）、pipeline/parallel 编排（P6）。
 */

import {
  Container,
  Editor,
  Loader,
  Markdown,
  matchesKey,
  type Component,
  type Terminal,
  Text,
  TUI,
} from "@earendil-works/pi-tui";
import { createUserMessage, type LiveEvent, type Message, type RunSummary, type SessionEvent, type ToolCall } from "@harness-pi/core";
import { coarseEventToActions, type TuiAction } from "./event-bridge.js";
import { LiveStreamAccumulator, type StreamOp } from "./live-stream.js";
import { formatApprovalPreview, formatStatusBar, formatToolCall, formatToolCalls, formatToolResult } from "./format.js";
import { routeSubmit } from "./submit-router.js";
import { parseSlashCommand, SLASH_COMMANDS, SLASH_HELP, type SlashCommand } from "./slash.js";
import { formatMultiSummary, orchestrateMulti, parseMultiCommand, subTaskFor } from "./multi.js";
import {
  buildGoalPrompt,
  classifyGoalOutcome,
  formatGoalFinalStatus,
  formatGoalRoundBanner,
  goalTextFromMessage,
  parseGoalCommand,
  type GoalOptions,
} from "./goal.js";
import { createAutocompleteProvider } from "./autocomplete.js";
import { color, editorTheme, markdownTheme } from "./theme.js";

const LIVE_TYPES: ReadonlyArray<LiveEvent["type"]> = [
  "message_start",
  "text_delta",
  "thinking_delta",
  "toolcall_delta",
  "message_end",
];

/** 运行循环只需要 session 的这点能力——便于注入 fake 做 headless 测试。 */
export interface TuiSession {
  runStreaming(
    prompt: string,
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<SessionEvent> & { finalSummary: Promise<RunSummary> };
  /** 订阅 fine 轨 LiveEvent（token/thinking delta），返回退订函数。 */
  on<T extends LiveEvent["type"]>(
    type: T,
    handler: (event: Extract<LiveEvent, { type: T }>) => void,
  ): () => void;
  /** 运行中插话：park 一条 user 消息进 steering inbox，下一 turn 安全点 drain。 */
  steer?(message: Message): void;
  abort?(reason?: string): void;
}

export interface TuiAgentLike {
  session: TuiSession;
  /** contextWindow（若已知）用于状态栏的上下文占用读数 `ctx N/W`。 */
  model: { id: string; contextWindow?: number };
  getCostEstimate?(): { amount: number; currency: string } | undefined;
  /** 累计 cost 统计（costTracker 提供）；用于 /goal 预算跟踪。 */
  getCostStats?(): { inputTokens: number; outputTokens: number } | undefined;
  /** 最近一次 run 的工具统计；用于状态栏 `🔧 calls/errors`。 */
  getToolStats?(): { totalCalls: number; error: number } | undefined;
  /** 注入 tool 审批"问人"实现（permissionGate.onAsk 委托到它）。 */
  setApprovalHandler?(handler: (call: ToolCall) => Promise<boolean>): void;
  /** /compact：降低压缩阈值，下一 turn 起把早期消息压成摘要。未启用 compaction 时 no-op。 */
  requestCompaction?(): void;
  /** compaction 状态；未启用时 undefined。 */
  getCompactionState?(): { enabled: boolean } | undefined;
  /** 注册"压缩发生"回调（实际跑 summarize 时以被压缩条数调用）→ TUI 渲染一行反馈。 */
  setCompactionListener?(listener: (coveredCount: number) => void): void;
  /** /goal 专用 session 工厂：把 hook 组合挂在隔离 session 上，避免污染主会话。 */
  createGoalSession?(goal: GoalOptions): TuiSession;
}

export interface TuiAppOptions {
  agent: TuiAgentLike;
  /** 注入 Terminal（默认 ProcessTerminal）；测试传 fake。 */
  terminal: Terminal;
  /** 工作目录；给了则启用输入框的 `/` 命令补全 + `@` 文件路径补全（基于此目录）。 */
  cwd?: string;
  /** resume 时的历史消息：启动时渲进消息区，让用户看到之前的对话（否则 resume 进来是空白屏）。 */
  initialMessages?: Message[];
  /**
   * 跑一个**只读 bounded 子代理**执行一条子任务（供 `/multi` 扇出用）。由 CLI 注入（造一个
   * readOnly + 限轮的 createCodingAgent 跑完即弃）。没给则 `/multi` 不可用。
   */
  spawnReadOnlySubAgent?: (
    task: string,
    signal: AbortSignal,
  ) => Promise<{ ok: boolean; text: string }>;
}

export interface TuiApp {
  tui: TUI;
  /** 提交一条输入：空闲→跑一轮 runStreaming，运行中→steer 插进下一 turn（见 routeSubmit）。 */
  submit(text: string): Promise<void>;
  /** 接管终端、聚焦输入框、绑定键位。 */
  start(): void;
  stop(): void;
  /** start() 并返回一个直到用户退出（Ctrl-C）才 resolve 的 promise——CLI 用它驱动生命周期。 */
  run(): Promise<void>;
  isRunning(): boolean;
  /** 本会话累计出现 persistenceErrors 的 run 次数（>0 ⇒ 落盘有失败，resume 可能不全）。CLI 退出消息据此告警。 */
  persistenceErrorRuns(): number;
}

interface StatsView {
  input?: number;
  output?: number;
  costText?: string | undefined;
}

export function createTuiApp(opts: TuiAppOptions): TuiApp {
  const tui = new TUI(opts.terminal);
  let persistenceErrorRuns = 0; // 累计落盘失败的 run 次数（finalize 据 summary.persistenceErrors 自增）
  const messages = new Container();
  const status = new Loader(tui, color.cyan, color.dim, "");
  status.stop(); // Loader 构造即开始动画；空闲时停掉，避免启动后 ~12fps 空转 churn（run 时再 start）。
  const editor = new Editor(tui, editorTheme, {});
  const statusBar = new Text("");

  // 顺序即从上到下：历史消息 → 思考中 → 输入框 → 状态栏（状态栏固定在底）。
  tui.addChild(messages);
  tui.addChild(status);
  tui.addChild(editor);
  tui.addChild(statusBar);

  // 命令面板（P5b）：给输入框挂上 pi-tui 原生 autocomplete —— `/` 实时补全斜杠命令、`@` 补全文件路径
  // （基于 cwd）。补全只填充文本，回车才提交，最终仍走 parseSlashCommand → handleSlash。
  if (opts.cwd) {
    // 有 fd 用原生 @ 补全，没 fd 走 readdir 回退（见 createAutocompleteProvider）。
    editor.setAutocompleteProvider(createAutocompleteProvider(SLASH_COMMANDS, opts.cwd));
  }

  let running = false;
  // 正在跑的 /multi 编排的 abort（Esc 时取消整批）。
  let multiAbort: AbortController | undefined;
  // 正在跑的 /goal 循环的 abort（Esc 时中断整个循环）。
  let goalAbort: AbortController | undefined;
  // 进行中的 tool 审批：输入监听据此把 y/n/Enter/Esc 当审批答复（而非普通输入/中断）。
  let pendingApproval: { resolve: (allowed: boolean) => void } | undefined;
  // 最近一次 LLM 调用的 input tokens ≈ 当前上下文大小（含整段历史）。状态栏 ctx-gauge 用它——
  // 不能用 summary.usage.input，那是内核跨所有 assistant 消息累加的总量，多轮会高估数倍、虚报红色。
  let lastInputTokens: number | undefined;
  const stats: StatsView = {};
  // 当前正在流式的助手组件（懒创建：谁先流先 append → thinking 在答案上方）。
  let current: { assistant?: Markdown; thinking?: Text } = {};
  // resume：把重建的历史渲进消息区（否则进来是空白屏）；seedHistory 也据此初始化 ctx-gauge。
  // 新会话则给一行上手提示，让斜杠命令 + 退出键可发现（否则启动是空白屏）。
  if (opts.initialMessages && opts.initialMessages.length > 0) {
    seedHistory(opts.initialMessages);
  } else {
    append(
      new Text(color.dim("Type a task, or /help for commands · Esc cancels · Ctrl-C exits"), 0, 0),
    );
  }
  renderStatusBar();

  function renderStatusBar(state?: string): void {
    const toolStats = opts.agent.getToolStats?.();
    statusBar.setText(
      formatStatusBar({
        model: opts.agent.model.id,
        input: stats.input,
        output: stats.output,
        // 上下文占用：用最近一次 LLM 调用的 input tokens（≈当前上下文），不是累加总量。
        contextTokens: lastInputTokens,
        contextWindow: opts.agent.model.contextWindow,
        costText: stats.costText,
        toolCalls: toolStats?.totalCalls,
        toolErrors: toolStats?.error,
        state,
      }),
    );
  }

  function append(c: Component): void {
    messages.addChild(c);
  }

  /** 取一条消息的纯文本（content 可能是 string 或 block 数组）。 */
  function textOfContent(content: Message["content"]): string {
    if (typeof content === "string") return content;
    return content
      .map((b) => ("text" in b && typeof b.text === "string" ? b.text : ""))
      .join("");
  }

  /** resume：把历史消息渲成气泡（user/assistant 文本 + 工具调用摘要），并标一行"已恢复 N 条"。 */
  function seedHistory(msgs: Message[]): void {
    for (const m of msgs) {
      if (m.role === "user") {
        const t = textOfContent(m.content).trim();
        if (t.length > 0) append(new Text(`${color.cyan("›")} ${t}`, 0, 0));
      } else if (m.role === "assistant") {
        const t = textOfContent(m.content).trim();
        if (t.length > 0) append(new Markdown(t, 0, 0, markdownTheme));
        const calls = Array.isArray(m.content)
          ? m.content.filter((b): b is ToolCall => b.type === "toolCall")
          : [];
        if (calls.length > 0) append(new Text(formatToolCalls(calls), 0, 0));
        // 用历史里最后一条 assistant 的 input usage 初始化 ctx-gauge，让 resume 进来就有读数。
        if (m.usage?.input !== undefined) lastInputTokens = m.usage.input;
      }
      // toolResult 等：跳过逐条重渲（可能很大）；下面的 banner 已说明历史已恢复。
    }
    append(
      new Text(color.dim(`↻ resumed ${msgs.length} earlier messages — context restored`), 0, 0),
    );
  }

  function applyAction(a: TuiAction): void {
    switch (a.kind) {
      case "status":
        status.setMessage(a.text);
        break;
      case "assistant":
        if (a.thinking.length > 0) append(new Text(color.dim(`» ${a.thinking}`), 0, 0));
        if (a.text.length > 0) append(new Markdown(a.text, 0, 0, markdownTheme));
        break;
      case "toolCalls":
        append(new Text(formatToolCalls(a.calls), 0, 0));
        break;
      case "toolResult":
        append(new Text(formatToolResult(a.name, a.ok, a.output, a.durationMs), 0, 0));
        break;
      case "error":
        append(new Text(color.red(`✗ ${a.phase}: ${a.message}`), 0, 0));
        break;
      case "done":
        finalize(a.summary);
        break;
      default: {
        const _exhaustive: never = a;
        void _exhaustive;
      }
    }
  }

  function ensureAssistant(): Markdown {
    if (!current.assistant) {
      current.assistant = new Markdown("", 0, 0, markdownTheme);
      append(current.assistant);
    }
    return current.assistant;
  }
  function ensureThinking(): Text {
    if (!current.thinking) {
      current.thinking = new Text("", 0, 0);
      append(current.thinking);
    }
    return current.thinking;
  }

  /** 把 fine 轨累积器产出的 StreamOp 落到"当前流式助手组件"上（懒创建 → 谁先流先 append）。 */
  function applyStreamOp(op: StreamOp): void {
    switch (op.kind) {
      case "begin":
        current = {}; // 新助手消息；组件等首个 delta 再建
        break;
      case "thinking":
        // 守卫 length>0：空 delta（理论上 provider 不发）不凭空 append 空组件。
        if (op.text.length > 0) ensureThinking().setText(color.dim(`» ${op.text}`));
        break;
      case "text":
        if (op.text.length > 0) ensureAssistant().setText(op.text);
        break;
      case "end":
        // 权威定稿：非流式 provider 无 delta，靠这里据 message 建组件。
        if (op.thinking.length > 0) ensureThinking().setText(color.dim(`» ${op.thinking}`));
        if (op.text.length > 0) ensureAssistant().setText(op.text);
        if (op.toolCalls.length > 0) append(new Text(formatToolCalls(op.toolCalls), 0, 0));
        current = {};
        break;
      default: {
        const _exhaustive: never = op;
        void _exhaustive;
      }
    }
  }

  function finalize(summary: RunSummary): void {
    stats.input = summary.usage.input;
    stats.output = summary.usage.output;
    // 落盘失败显著告警（崩溃恢复路径上,「done 但 transcript 不全」必须让用户当场看到,而非静默）。
    if (summary.persistenceErrors?.length) {
      persistenceErrorRuns++;
      append(
        new Text(
          color.red(
            `⚠ 持久化失败（resume 可能不全）: ${summary.persistenceErrors.join("; ")}`,
          ),
          0,
          0,
        ),
      );
    }
    const est = opts.agent.getCostEstimate?.();
    if (est) {
      stats.costText =
        est.currency === "CNY" ? `¥${est.amount.toFixed(4)}` : `$${est.amount.toFixed(4)}`;
    }
  }

  /**
   * tool 审批：**行内**提示（不是 overlay）。permissionGate.onAsk 经 setApprovalHandler 委托到它。
   *
   * 为什么行内而非 center overlay：本 TUI 是 inline scrollback 渲染（非备用屏），center overlay 在真实
   * 终端、长历史下定位脆弱（headless FakeTerminal 测不出）。行内提示就是一条普通 append 消息——必然渲染，
   * 且按键经 matchesKey 走输入监听（Kitty 协议安全）。返回 true=allow once / false=deny。
   *
   * 串行不变量：当前唯三走 ask 的工具（bash/write/edit）都 isConcurrencySafe:false、被内核串行执行，
   * 故 onAsk 一次只来一个，pendingApproval 不会被并发覆盖。
   */
  function requestApproval(call: ToolCall): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      pendingApproval = { resolve };
      append(new Text(color.yellow(`⚠ Approve tool call?  ${formatToolCall(call)}`), 0, 0));
      const preview = formatApprovalPreview(call);
      if (preview.length > 0) append(new Text(preview, 0, 0));
      append(new Text(color.dim("  [y] allow once   ·   [n] deny   (Enter = allow, Esc = deny)"), 0, 0));
      status.setMessage("waiting for approval…");
      tui.requestRender();
    });
  }

  /** 落定一次审批：清状态、渲一行结果、resolve onAsk 的 Promise。 */
  function resolveApproval(allowed: boolean): void {
    const p = pendingApproval;
    if (!p) return;
    pendingApproval = undefined;
    append(new Text(color.dim(`  → ${allowed ? "allowed" : "denied"}`), 0, 0));
    status.setMessage(running ? "thinking…" : "");
    tui.requestRender();
    p.resolve(allowed);
  }

  /** `/multi <指令> @file…`：对 work-list 做只读子代理有界并行扇出，聚合回灌。 */
  async function runMulti(rest: string): Promise<void> {
    if (running) {
      append(new Text(color.dim("busy — wait for the current run to finish"), 0, 0));
      tui.requestRender();
      return;
    }
    const spawn = opts.spawnReadOnlySubAgent;
    if (!spawn) {
      append(new Text(color.dim("/multi not available here"), 0, 0));
      tui.requestRender();
      return;
    }
    const parsed = parseMultiCommand(rest);
    if (!parsed) {
      append(
        new Text(
          color.dim("usage: /multi <instruction> @file @file …  (needs at least one @file)"),
          0,
          0,
        ),
      );
      tui.requestRender();
      return;
    }
    append(
      new Text(
        color.cyan(
          `⇉ /multi (read-only) over ${parsed.targets.length} files: ${parsed.targets.join(", ")}`,
        ),
        0,
        0,
      ),
    );
    running = true;
    const ac = new AbortController();
    multiAbort = ac;
    status.start();
    status.setMessage(`running ${parsed.targets.length} read-only sub-agents…`);
    renderStatusBar("multi");
    tui.requestRender();
    try {
      const outcomes = await orchestrateMulti(
        parsed.targets,
        (target, signal) => spawn(subTaskFor(parsed.instruction, target), signal),
        {
          concurrency: 3,
          signal: ac.signal,
          onProgress: (ev) => {
            if (ev.phase === "done")
              append(new Text(color.dim(`  ${ev.ok ? "✓" : "✗"} ${ev.target}`), 0, 0));
            tui.requestRender();
          },
        },
      );
      append(new Markdown(formatMultiSummary(outcomes), 0, 0, markdownTheme));
    } catch (err) {
      append(
        new Text(
          color.red(`✗ /multi: ${err instanceof Error ? err.message : String(err)}`),
          0,
          0,
        ),
      );
    } finally {
      multiAbort = undefined;
      running = false;
      status.stop();
      status.setMessage("");
      renderStatusBar();
      tui.requestRender();
    }
  }

  /**
   * `/goal <desc>` —— 目标 + verifier + 预算 loop-engineering 循环。
   * TUI 只启动一次专用 goal session；续跑/verifier/预算由 session 上的 hook 组合负责。
   */
  async function runGoal(rest: string): Promise<void> {
    if (running) {
      append(new Text(color.dim("busy — wait for the current run to finish"), 0, 0));
      tui.requestRender();
      return;
    }
    const goalOpts: GoalOptions | null = parseGoalCommand(rest);
    if (!goalOpts) {
      append(
        new Text(
          color.dim(
            "usage: /goal <goal> [--max-turns N] [--budget N] [--success <criteria>]",
          ),
          0,
          0,
        ),
      );
      tui.requestRender();
      return;
    }
    const goalSession = opts.agent.createGoalSession?.(goalOpts);
    if (!goalSession) {
      append(new Text(color.dim("/goal not available here"), 0, 0));
      tui.requestRender();
      return;
    }

    append(
      new Text(
        color.cyan(
          `⟳ /goal start · max ${goalOpts.maxTurns} rounds${goalOpts.budgetTokens ? ` · budget ${goalOpts.budgetTokens.toLocaleString()} tokens` : ""}`,
        ),
        0,
        0,
      ),
    );
    running = true;
    const ac = new AbortController();
    goalAbort = ac;
    status.start();
    renderStatusBar("goal");
    tui.requestRender();

    let round = 0;
    let nextVisibleRound = 1;
    let usedTokens = 0;
    let lastAssistantText = "";
    let finalSummary: RunSummary | undefined;

    try {
      const acc = new LiveStreamAccumulator();
      const onLive = (event: LiveEvent): void => {
        for (const op of acc.onEvent(event)) {
          applyStreamOp(op);
          if (op.kind === "end") lastAssistantText = op.text;
        }
        tui.requestRender();
      };
      const unsubs = LIVE_TYPES.map((type) => goalSession.on(type, onLive));

      try {
        const stream = goalSession.runStreaming(buildGoalPrompt(goalOpts), { signal: ac.signal });
        for await (const ev of stream) {
          if (ev.type === "turn-start") {
            if (round < nextVisibleRound) {
              round = nextVisibleRound;
              append(
                new Text(
                  color.dim(
                    formatGoalRoundBanner({
                      round,
                      maxTurns: goalOpts.maxTurns,
                      ...(goalOpts.budgetTokens !== undefined
                        ? { budgetTokens: goalOpts.budgetTokens, usedTokens }
                        : {}),
                    }),
                  ),
                  0,
                  0,
                ),
              );
              status.setMessage(`/goal 第 ${round} 轮…`);
            }
          }
          if (ev.type === "continuation-check") {
            nextVisibleRound = ev.continuations + 2;
          }
          if (ev.type === "llm-end") {
            lastInputTokens = ev.msg.usage?.input ?? lastInputTokens;
            usedTokens += (ev.msg.usage?.input ?? 0) + (ev.msg.usage?.output ?? 0);
            lastAssistantText = goalTextFromMessage(ev.msg);
          }
          for (const a of coarseEventToActions(ev, { suppressAssistant: true })) applyAction(a);
          tui.requestRender();
        }
        finalSummary = await stream.finalSummary.catch(() => undefined);
      } finally {
        for (const unsub of unsubs) unsub();
        current = {};
      }
    } catch (err) {
      applyAction({
        kind: "error",
        phase: "goal",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      goalAbort = undefined;
      running = false;
      status.stop();
      status.setMessage("");
      renderStatusBar();
    }

    // 终态提示
    const outcome = classifyGoalOutcome(finalSummary, lastAssistantText);
    const finalRounds = finalSummary ? finalSummary.continuations + 1 : Math.max(round, 1);
    const finalText = formatGoalFinalStatus(
      outcome.verdict,
      finalRounds,
      outcome.aborted,
      outcome.budgetExhausted,
    );
    append(
      new Text(
        outcome.verdict === "reached"
          ? color.green(finalText)
          : outcome.aborted
            ? color.dim(finalText)
            : color.red(finalText),
        0,
        0,
      ),
    );
    tui.requestRender();
  }

  /** 处理斜杠命令（/compact、/help、/multi、/goal…）。本地动作，不发起普通 LLM turn。 */
  async function handleSlash(cmd: SlashCommand): Promise<void> {
    switch (cmd.kind) {
      case "goal":
        await runGoal(cmd.rest);
        return;
      case "multi":
        await runMulti(cmd.rest);
        return;
      case "compact": {
        const state = opts.agent.getCompactionState?.();
        if (!state) {
          // compaction hook 没挂（非 TUI / 未来禁用）——/compact 无从作用。
          append(new Text(color.dim("compaction not available here"), 0, 0));
        } else if (state.enabled) {
          // 已在自动压缩（--compact 或之前 /compact 过）——诚实说明它本就开着、会持续整个会话。
          append(new Text(color.dim("✦ compaction is already on for this session"), 0, 0));
        } else {
          opts.agent.requestCompaction?.();
          // 诚实：这不是一次性动作——会持续到会话结束，之后每个长 turn 都会把早期消息压成摘要。
          append(
            new Text(
              color.dim(
                "✦ compaction on for this session — earlier messages summarized for the model from your next turn (full history is kept)",
              ),
              0,
              0,
            ),
          );
        }
        break;
      }
      case "help":
        append(new Text(SLASH_HELP, 0, 0));
        break;
      case "exit":
        quit();
        return;
      case "unknown":
        append(new Text(color.red(`unknown command: /${cmd.name} (try /help)`), 0, 0));
        break;
      default: {
        const _exhaustive: never = cmd;
        void _exhaustive;
      }
    }
    tui.requestRender();
  }

  async function submit(text: string): Promise<void> {
    const slash = parseSlashCommand(text);
    if (slash) {
      await handleSlash(slash);
      return;
    }
    const route = routeSubmit(text, running);
    if (route.kind === "ignore") return;
    if (route.kind === "steer") {
      // /multi 或 /goal 在跑时没有 LLM turn 可插话——steer 会错误地 park 进父 session inbox。明确提示改用 Esc。
      if (multiAbort || goalAbort) {
        append(
          new Text(
            color.dim(
              `a /${multiAbort ? "multi" : "goal"} run is in progress — press Esc to cancel it`,
            ),
            0,
            0,
          ),
        );
        tui.requestRender();
        return;
      }
      // 运行中插话：park 进 steering inbox，下一 turn 安全点被内核注入。
      opts.agent.session.steer?.(createUserMessage(route.text));
      append(new Text(color.dim(`↳ queued: ${route.text}`), 0, 0));
      tui.requestRender();
      return;
    }
    append(new Text(`${color.cyan("›")} ${route.text}`, 0, 0)); // 用户消息
    running = true;
    status.start();
    status.setMessage("thinking…");
    renderStatusBar("running");
    tui.requestRender();

    // fine 轨：先订阅再 runStreaming（否则丢首事件）。assistant 文本/thinking 经此逐 token 流入。
    const acc = new LiveStreamAccumulator();
    const onLive = (event: LiveEvent): void => {
      for (const op of acc.onEvent(event)) applyStreamOp(op);
      tui.requestRender();
    };
    const unsubs = LIVE_TYPES.map((type) => opts.agent.session.on(type, onLive));

    try {
      const stream = opts.agent.session.runStreaming(route.text);
      for await (const ev of stream) {
        // 记录最近一次 LLM 调用的 input tokens（≈当前上下文大小），喂状态栏 ctx-gauge。
        if (ev.type === "llm-end") lastInputTokens = ev.msg.usage?.input ?? lastInputTokens;
        // suppressAssistant：assistant + toolCalls 已由 fine 轨渲染，coarse llm-end 不再重复。
        for (const a of coarseEventToActions(ev, { suppressAssistant: true })) applyAction(a);
        tui.requestRender();
      }
      // 错误已由流内 error 事件渲染过；finalSummary 在内核 reject 路径会再抛同一个 err，
      // 这里吞掉避免同一次失败渲染两行 error。
      await stream.finalSummary.catch(() => undefined);
    } catch (err) {
      applyAction({
        kind: "error",
        phase: "run",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      for (const unsub of unsubs) unsub();
      current = {};
      running = false;
      status.stop();
      status.setMessage("");
      renderStatusBar();
      tui.requestRender();
    }
  }

  let resolveExit: (() => void) | undefined;

  function start(): void {
    tui.start();
    tui.setFocus(editor);
    // 注入审批弹窗作为 permissionGate.onAsk 的"问人"实现（仅当 agent 启用了 permission）。
    opts.agent.setApprovalHandler?.(requestApproval);
    // 压缩实际发生时（自动或 /compact 触发的下一 turn）渲染一行反馈。
    opts.agent.setCompactionListener?.((n) => {
      append(new Text(color.dim(`✦ compacted ${n} earlier messages into a summary`), 0, 0));
      tui.requestRender();
    });
    editor.onSubmit = (value: string): void => {
      void submit(value);
    };
    tui.addInputListener((data: string) => {
      // 用 matchesKey 而非裸字节比较：ProcessTerminal 开了 Kitty 键盘协议（ghostty/kitty/WezTerm…），
      // Esc 会变成 \x1b[27u、Ctrl-C 变成 \x1b[99;5u，裸字节 === "\x1b"/"\x03" 根本不匹配——
      // 那样 Esc 中断失效、且 Ctrl-C（唯一退出路径）失灵会把用户困住。
      if (matchesKey(data, "ctrl+c")) {
        // Ctrl-C：退出（先 abort 在飞 session 防泄漏）。consume 防止泄漏给父 shell。
        quit();
        return { consume: true };
      }
      // 审批进行中：y/Enter=allow，n/Esc=deny；其余键吞掉（别漏进输入框）。优先于 Esc-中断分支。
      if (pendingApproval) {
        if (matchesKey(data, "escape") || data === "n" || data === "N") {
          resolveApproval(false);
        } else if (matchesKey(data, "enter") || data === "y" || data === "Y") {
          resolveApproval(true);
        }
        return { consume: true };
      }
      // Ctrl-D：输入框为空时作为第二退出路径（防 Ctrl-C 在某些终端被吞）。
      if (matchesKey(data, "ctrl+d") && editor.getText().length === 0) {
        quit();
        return { consume: true };
      }
      if (matchesKey(data, "escape") && running) {
        // 裸 Esc 且正在跑、且无 overlay。先让输入框关掉打开的补全下拉，不抢它的 Esc。
        if (editor.isShowingAutocomplete()) return undefined;
        // /multi 在跑则取消整批；/goal 循环同；否则中断在飞的 LLM run。
        if (multiAbort) multiAbort.abort();
        else if (goalAbort) goalAbort.abort();
        else opts.agent.session.abort?.("user interrupt");
        return { consume: true };
      }
      return undefined;
    });
    tui.requestRender();
  }

  function stop(): void {
    status.stop();
    tui.stop();
  }

  function quit(): void {
    // 取消在飞的 LLM 请求再退出，防请求泄漏（接 TuiSession.abort 缝；idle 时是 no-op）。
    opts.agent.session.abort?.("user quit");
    stop();
    resolveExit?.();
    resolveExit = undefined;
  }

  function run(): Promise<void> {
    const done = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    start();
    return done;
  }

  return { tui, submit, start, stop, run, isRunning: () => running, persistenceErrorRuns: () => persistenceErrorRuns };
}
