/**
 * TUI 壳（薄层，建在 pi-tui 上）。把"事件→动作"（event-bridge）和"动作→显示文本"（format）这两层
 * 纯逻辑接到真实 pi-tui 组件上：消息区(Container) / 思考中(Loader) / 输入框(Editor) / 状态栏(Text)。
 *
 * 刻意保持薄、把可测逻辑都外推到纯函数——pi-tui 需真实终端 raw mode、难自动化测；本层只做组件装配 +
 * 运行循环 + 键位，靠注入 Terminal/session 做 headless smoke test（render 出文本断言），其余手动 smoke。
 *
 * P0 范围：coarse 轨单轮闭环（输入→runStreaming→逐 SessionEvent 建组件→渲染），Ctrl-C 退出。
 * 流式 token(P1)、审批/插话(P2)、resume(P3)、compaction(P4)、状态栏富化(P5)、编排(P6) 后续叠加。
 */

import {
  Container,
  Editor,
  Loader,
  Markdown,
  type Component,
  type Terminal,
  Text,
  TUI,
} from "@mariozechner/pi-tui";
import type { RunSummary, SessionEvent } from "@harness-pi/core";
import { coarseEventToActions, type TuiAction } from "./event-bridge.js";
import { formatStatusBar, formatToolCalls, formatToolResult } from "./format.js";
import { color, editorTheme, markdownTheme } from "./theme.js";

/** 运行循环只需要 session 的这点能力——便于注入 fake 做 headless 测试。 */
export interface TuiSession {
  runStreaming(
    prompt: string,
  ): AsyncIterable<SessionEvent> & { finalSummary: Promise<RunSummary> };
  abort?(reason?: string): void;
}

export interface TuiAgentLike {
  session: TuiSession;
  model: { id: string };
  getCostEstimate?(): { amount: number; currency: string } | undefined;
}

export interface TuiAppOptions {
  agent: TuiAgentLike;
  /** 注入 Terminal（默认 ProcessTerminal）；测试传 fake。 */
  terminal: Terminal;
}

export interface TuiApp {
  tui: TUI;
  /** 提交一条输入并跑完一轮（P0：运行中再提交会被忽略，steering 在 P2）。 */
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
  renderStatusBar();

  function renderStatusBar(state?: string): void {
    statusBar.setText(
      formatStatusBar({
        model: opts.agent.model.id,
        input: stats.input,
        output: stats.output,
        costText: stats.costText,
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

  function finalize(summary: RunSummary): void {
    stats.input = summary.usage.input;
    stats.output = summary.usage.output;
    const est = opts.agent.getCostEstimate?.();
    if (est) {
      stats.costText =
        est.currency === "CNY" ? `¥${est.amount.toFixed(4)}` : `$${est.amount.toFixed(4)}`;
    }
  }

  async function submit(text: string): Promise<void> {
    const t = text.trim();
    if (running || t.length === 0) return; // P0：运行中忽略；steering 在 P2
    append(new Text(`${color.cyan("›")} ${t}`, 0, 0)); // 用户消息
    running = true;
    status.start();
    status.setMessage("thinking…");
    renderStatusBar("running");
    tui.requestRender();
    try {
      const stream = opts.agent.session.runStreaming(t);
      for await (const ev of stream) {
        for (const a of coarseEventToActions(ev)) applyAction(a);
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
    editor.onSubmit = (value: string): void => {
      void submit(value);
    };
    tui.addInputListener((data: string) => {
      if (data === "\x03") {
        // Ctrl-C：退出（P0 不区分"中断运行" vs "退出"，取消在 P2）。consume 防止泄漏给父 shell。
        quit();
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
