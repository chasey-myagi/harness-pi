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
  type Component,
  SelectList,
  type SelectItem,
  type Terminal,
  Text,
  TUI,
} from "@mariozechner/pi-tui";
import { createUserMessage, type LiveEvent, type Message, type RunSummary, type SessionEvent, type ToolCall } from "@harness-pi/core";
import { coarseEventToActions, type TuiAction } from "./event-bridge.js";
import { LiveStreamAccumulator, type StreamOp } from "./live-stream.js";
import { formatStatusBar, formatToolCall, formatToolCalls, formatToolResult } from "./format.js";
import { routeSubmit } from "./submit-router.js";
import { parseSlashCommand, SLASH_HELP, type SlashCommand } from "./slash.js";
import { color, editorTheme, markdownTheme, selectListTheme } from "./theme.js";

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
}

export interface TuiAppOptions {
  agent: TuiAgentLike;
  /** 注入 Terminal（默认 ProcessTerminal）；测试传 fake。 */
  terminal: Terminal;
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
}

interface StatsView {
  input?: number;
  output?: number;
  costText?: string | undefined;
}

export function createTuiApp(opts: TuiAppOptions): TuiApp {
  const tui = new TUI(opts.terminal);
  const messages = new Container();
  const status = new Loader(tui, color.cyan, color.dim, "");
  const editor = new Editor(tui, editorTheme, {});
  const statusBar = new Text("");

  // 顺序即从上到下：历史消息 → 思考中 → 输入框 → 状态栏（状态栏固定在底）。
  tui.addChild(messages);
  tui.addChild(status);
  tui.addChild(editor);
  tui.addChild(statusBar);

  let running = false;
  const stats: StatsView = {};
  // 当前正在流式的助手组件（懒创建：谁先流先 append → thinking 在答案上方）。
  let current: { assistant?: Markdown; thinking?: Text } = {};
  renderStatusBar();

  function renderStatusBar(state?: string): void {
    const toolStats = opts.agent.getToolStats?.();
    statusBar.setText(
      formatStatusBar({
        model: opts.agent.model.id,
        input: stats.input,
        output: stats.output,
        // 上下文占用：用最近一次 LLM 调用的 input tokens 近似当前上下文大小（含整段历史）。
        contextTokens: stats.input,
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
    const est = opts.agent.getCostEstimate?.();
    if (est) {
      stats.costText =
        est.currency === "CNY" ? `¥${est.amount.toFixed(4)}` : `$${est.amount.toFixed(4)}`;
    }
  }

  /**
   * tool 审批弹窗：返回 true=allow once / false=deny。permissionGate.onAsk 经 setApprovalHandler 委托到它。
   * 单弹窗不叠的不变量：当前唯三走 ask 的工具（bash/write/edit）都 isConcurrencySafe:false、被内核串行执行，
   * 故 onAsk 一次只来一个；若将来给某个 concurrency-safe 工具配 ask 规则，需在此加串行队列防叠窗抢焦点。
   */
  function requestApproval(call: ToolCall): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const items: SelectItem[] = [
        { value: "allow", label: `Allow once · ${call.name}`, description: formatToolCall(call) },
        { value: "deny", label: "Deny", description: "block this tool call" },
      ];
      const list = new SelectList(items, 6, selectListTheme);
      const handle = tui.showOverlay(list, { anchor: "center", width: "70%" });
      const settle = (allowed: boolean): void => {
        handle.hide();
        tui.setFocus(editor);
        resolve(allowed);
        tui.requestRender();
      };
      list.onSelect = (item: SelectItem): void => settle(item.value === "allow");
      list.onCancel = (): void => settle(false); // Esc = deny（安全默认）——否则审批 Promise 会挂到 600s 超时
      tui.requestRender();
    });
  }

  /** 处理斜杠命令（/compact、/help…）。这些是本地动作，不发起 LLM turn，运行中也能用。 */
  function handleSlash(cmd: SlashCommand): void {
    switch (cmd.kind) {
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
      handleSlash(slash);
      return;
    }
    const route = routeSubmit(text, running);
    if (route.kind === "ignore") return;
    if (route.kind === "steer") {
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
      if (data === "\x03") {
        // Ctrl-C：退出（先 abort 在飞 session 防泄漏）。consume 防止泄漏给父 shell。
        quit();
        return { consume: true };
      }
      if (data === "\x1b" && running && !tui.hasOverlay()) {
        // 裸 Esc 且正在跑、且无 overlay：中断当前 run（不退出）。有 overlay 时 Esc 交给 overlay。
        opts.agent.session.abort?.("user interrupt");
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

  return { tui, submit, start, stop, run, isRunning: () => running };
}
