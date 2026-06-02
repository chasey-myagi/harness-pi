import { describe, it, expect } from "vitest";
import type { Terminal } from "@mariozechner/pi-tui";
import type { AssistantMessage, LiveEvent, RunSummary, SessionEvent, ToolCall } from "@harness-pi/core";
import { createTuiApp, type TuiAgentLike, type TuiSession } from "../app.js";

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

class FakeTerminal implements Terminal {
  private onInput?: (data: string) => void;
  get columns(): number {
    return 80;
  }
  get rows(): number {
    return 24;
  }
  get kittyProtocolActive(): boolean {
    return false;
  }
  start(onInput: (data: string) => void): void {
    this.onInput = onInput;
  }
  feed(data: string): void {
    this.onInput?.(data);
  }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(): void {}
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return { role: "assistant", content, api: "", provider: "", model: "qwen-turbo", usage: ZERO, stopReason: "stop", timestamp: 0 };
}

type Step = { live: LiveEvent } | { coarse: SessionEvent } | { throw: Error };

/** 同时驱动 fine 轨（session.on）+ coarse 轨（runStreaming）的脚本化 session——贴近真实内核双轨。 */
function scriptedSession(steps: Step[], summary: RunSummary, abort?: () => void): TuiSession {
  const listeners = new Map<string, Set<(e: LiveEvent) => void>>();
  const session: TuiSession = {
    on<T extends LiveEvent["type"]>(type: T, handler: (e: Extract<LiveEvent, { type: T }>) => void): () => void {
      const set = listeners.get(type) ?? new Set<(e: LiveEvent) => void>();
      set.add(handler as (e: LiveEvent) => void);
      listeners.set(type, set);
      return () => set.delete(handler as (e: LiveEvent) => void);
    },
    runStreaming() {
      const gen = (async function* (): AsyncGenerator<SessionEvent> {
        for (const s of steps) {
          if ("live" in s) {
            for (const cb of listeners.get(s.live.type) ?? []) cb(s.live);
          } else if ("throw" in s) {
            throw s.throw; // 模拟流中途抛错
          } else {
            yield s.coarse;
          }
          await Promise.resolve(); // 让两轨交错
        }
      })();
      return Object.assign(gen, { finalSummary: Promise.resolve(summary) });
    },
  };
  if (abort) session.abort = abort;
  return session;
}

const NOOP_ON: TuiSession["on"] = () => () => {};

describe("TUI app smoke (headless, dual-track via fake terminal)", () => {
  const summary: RunSummary = { turns: 2, continuations: 0, reason: "done", usage: { ...ZERO, input: 123, output: 45 } };
  const readCall = { type: "toolCall" as const, id: "1", name: "read", arguments: { path: "a.ts" } };

  const steps: Step[] = [
    { coarse: { type: "session-start", sessionId: "s", source: "run" } },
    { coarse: { type: "turn-start", turnIdx: 0 } },
    // turn 0：助手经 fine 轨流式 "let me check" + 一个 toolCall
    { live: { type: "message_start" } },
    { live: { type: "text_delta", contentIndex: 0, delta: "let me " } },
    { live: { type: "text_delta", contentIndex: 0, delta: "check" } },
    { live: { type: "message_end", message: assistant([{ type: "text", text: "let me check" }, readCall]) } },
    { coarse: { type: "llm-end", msg: assistant([{ type: "text", text: "let me check" }, readCall]), durationMs: 5 } }, // 被 suppress
    {
      coarse: {
        type: "tool-end",
        call: readCall,
        result: { content: [{ type: "text", text: "file body here" }], isError: false },
        durationMs: 12,
      },
    },
    { coarse: { type: "turn-start", turnIdx: 1 } },
    // turn 1：最终答案流式；故意只流 "All "，message_end 权威纠正成 "All good."
    { live: { type: "message_start" } },
    { live: { type: "text_delta", contentIndex: 0, delta: "# Done\n" } },
    { live: { type: "text_delta", contentIndex: 0, delta: "All " } },
    { live: { type: "message_end", message: assistant([{ type: "text", text: "# Done\nAll good." }]) } },
    { coarse: { type: "llm-end", msg: assistant([{ type: "text", text: "# Done\nAll good." }]), durationMs: 4 } }, // 被 suppress
    { coarse: { type: "turn-end", turnIdx: 1, toolResultsCount: 0, stopReason: "stop" } },
    { coarse: { type: "session-end", summary } },
  ];

  function makeApp(session: TuiSession): ReturnType<typeof createTuiApp> {
    const agent: TuiAgentLike = { model: { id: "qwen-turbo" }, session, getCostEstimate: () => ({ amount: 0.0012, currency: "CNY" }) };
    return createTuiApp({ agent, terminal: new FakeTerminal() });
  }

  it("dual-track round: streams assistant via fine track, tool result via coarse, status bar from summary", async () => {
    const app = makeApp(scriptedSession(steps, summary));
    await app.submit("hi there");

    expect(app.isRunning()).toBe(false);
    const out = strip(app.tui.render(80).join("\n"));
    expect(out).toContain("hi there"); // 用户消息
    expect(out).toContain("let me check"); // 第一条助手（fine 轨流式）
    expect(out).toContain("read(path: a.ts)"); // toolCall（fine 轨 message_end）
    expect(out).toContain("file body here"); // 工具结果（coarse tool-end）
    expect(out).toContain("All good."); // 末条助手（message_end 权威纠正自 "All "）
    expect(out).toContain("qwen-turbo"); // 状态栏
    expect(out).toContain("↑123 ↓45");
    expect(out).toContain("¥0.0012");
  });

  it("suppresses coarse llm-end so the assistant message is rendered exactly once (no double)", async () => {
    const app = makeApp(scriptedSession(steps, summary));
    await app.submit("hi");
    const out = strip(app.tui.render(80).join("\n"));
    expect(out.split("All good.").length - 1).toBe(1); // 只出现一次
  });

  it("ignores empty submits (no user bubble added)", async () => {
    const app = makeApp(scriptedSession([{ coarse: { type: "session-end", summary } }], summary));
    const before = app.tui.render(80).join("\n");
    await app.submit("   ");
    expect(app.tui.render(80).join("\n")).toBe(before);
  });

  it("surfaces a stream error as an error line, not a throw", async () => {
    const boom: TuiAgentLike = {
      model: { id: "qwen-turbo" },
      session: {
        on: NOOP_ON,
        runStreaming: () => {
          const gen = (async function* (): AsyncGenerator<SessionEvent> {
            throw new Error("provider exploded");
          })();
          return Object.assign(gen, { finalSummary: Promise.resolve(summary) });
        },
      },
    };
    const app = createTuiApp({ agent: boom, terminal: new FakeTerminal() });
    await expect(app.submit("hi")).resolves.toBeUndefined();
    expect(app.isRunning()).toBe(false);
    expect(strip(app.tui.render(80).join("\n"))).toContain("provider exploded");
  });

  it("fine-track thinking streams ABOVE the answer", async () => {
    const app = makeApp(
      scriptedSession(
        [
          { coarse: { type: "turn-start", turnIdx: 0 } },
          { live: { type: "message_start" } },
          { live: { type: "thinking_delta", contentIndex: 0, delta: "reasoning " } },
          { live: { type: "thinking_delta", contentIndex: 0, delta: "step" } },
          { live: { type: "text_delta", contentIndex: 0, delta: "the answer" } },
          {
            live: {
              type: "message_end",
              message: assistant([{ type: "thinking", thinking: "reasoning step" }, { type: "text", text: "the answer" }]),
            },
          },
          { coarse: { type: "session-end", summary } },
        ],
        summary,
      ),
    );
    await app.submit("q");
    const out = strip(app.tui.render(80).join("\n"));
    expect(out).toContain("reasoning step"); // thinking 渲出
    expect(out).toContain("the answer");
    expect(out.indexOf("reasoning step")).toBeLessThan(out.indexOf("the answer")); // thinking 在答案之上
  });

  it("error mid-stream: shows the partial streamed text AND an error line", async () => {
    const app = makeApp(
      scriptedSession(
        [
          { live: { type: "message_start" } },
          { live: { type: "text_delta", contentIndex: 0, delta: "partial bit" } },
          { throw: new Error("mid-stream boom") },
        ],
        summary,
      ),
    );
    await expect(app.submit("go")).resolves.toBeUndefined();
    const out = strip(app.tui.render(80).join("\n"));
    expect(out).toContain("partial bit"); // 已流式的部分文本保留
    expect(out).toContain("mid-stream boom"); // 错误行
    expect(app.isRunning()).toBe(false);
  });

  function gatedSession(extra: Partial<TuiSession> = {}): { session: TuiSession; release: () => void } {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const session: TuiSession = {
      on: NOOP_ON,
      runStreaming: () => {
        const gen = (async function* (): AsyncGenerator<SessionEvent> {
          yield { type: "turn-start", turnIdx: 0 };
          await gate;
        })();
        return Object.assign(gen, { finalSummary: gate.then(() => summary) });
      },
      ...extra,
    };
    return { session, release };
  }

  it("steering: submitting while a run is in flight calls session.steer (not ignored)", async () => {
    const steered: string[] = [];
    const { session, release } = gatedSession({
      steer: (m) => steered.push(typeof m.content === "string" ? m.content : JSON.stringify(m.content)),
    });
    const app = createTuiApp({ agent: { model: { id: "qwen-turbo" }, session }, terminal: new FakeTerminal() });

    const first = app.submit("first");
    await new Promise((r) => setTimeout(r, 0));
    expect(app.isRunning()).toBe(true);

    await app.submit("interject me"); // 运行中 → steer
    expect(steered.some((s) => s.includes("interject me"))).toBe(true);
    expect(strip(app.tui.render(80).join("\n"))).toContain("queued: interject me");

    release();
    await first;
  });

  it("Esc during a run aborts the current run (not quit)", async () => {
    let aborted = false;
    const { session, release } = gatedSession({
      abort: () => {
        aborted = true;
        release(); // abort 让 gate 放开，run 收尾
      },
    });
    const term = new FakeTerminal();
    const app = createTuiApp({ agent: { model: { id: "qwen-turbo" }, session }, terminal: term });
    app.start();
    const first = app.submit("go");
    await new Promise((r) => setTimeout(r, 0));
    expect(app.isRunning()).toBe(true);

    term.feed("\x1b"); // Esc：运行中且无 overlay → 中断
    expect(aborted).toBe(true);
    await first;
    expect(app.isRunning()).toBe(false);
  });

  it("approval overlay: onAsk shows a SelectList; selecting Allow resolves true and closes it", async () => {
    let captured: ((call: ToolCall) => Promise<boolean>) | undefined;
    const agent: TuiAgentLike = {
      model: { id: "qwen-turbo" },
      session: scriptedSession([{ coarse: { type: "session-end", summary } }], summary),
      setApprovalHandler: (h) => {
        captured = h;
      },
    };
    const term = new FakeTerminal();
    const app = createTuiApp({ agent, terminal: term });
    app.start(); // 经 setApprovalHandler 注入 requestApproval

    const decision = captured!({ type: "toolCall", id: "1", name: "bash", arguments: { command: "ls" } });
    expect(app.tui.hasOverlay()).toBe(true); // 弹窗已起（capturing overlay）
    // 注：overlay 内容在 TUI 私有 doRender 里合成、公共 render() 读不到，故只断行为不断文本。

    term.feed("\r"); // Enter → 选中第一项 "Allow once"
    await expect(decision).resolves.toBe(true);
    expect(app.tui.hasOverlay()).toBe(false); // 选完关闭
    app.stop();
  });

  it("approval overlay: Esc cancels as deny (resolves false, closes)", async () => {
    let captured: ((call: ToolCall) => Promise<boolean>) | undefined;
    const agent: TuiAgentLike = {
      model: { id: "qwen-turbo" },
      session: scriptedSession([{ coarse: { type: "session-end", summary } }], summary),
      setApprovalHandler: (h) => {
        captured = h;
      },
    };
    const term = new FakeTerminal();
    const app = createTuiApp({ agent, terminal: term });
    app.start();

    const decision = captured!({ type: "toolCall", id: "1", name: "bash", arguments: { command: "rm -rf x" } });
    expect(app.tui.hasOverlay()).toBe(true);

    term.feed("\x1b"); // Esc → SelectList.onCancel → deny（overlay 在，app 的 Esc 守卫不触发，转发给 overlay）
    await expect(decision).resolves.toBe(false);
    expect(app.tui.hasOverlay()).toBe(false);
    app.stop();
  });

  it("Ctrl-C: run() resolves and quit aborts the session (no request leak)", async () => {
    let aborted = false;
    const app = makeApp(scriptedSession([{ coarse: { type: "session-end", summary } }], summary, () => {
      aborted = true;
    }));
    const done = app.run();
    (app.tui.terminal as FakeTerminal).feed("\x03"); // 模拟 Ctrl-C
    await done;
    expect(aborted).toBe(true);
  });
});
