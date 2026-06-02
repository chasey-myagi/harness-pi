import { describe, it, expect } from "vitest";
import type { Terminal } from "@mariozechner/pi-tui";
import type { AssistantMessage, LiveEvent, RunSummary, SessionEvent } from "@harness-pi/core";
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

  it("ignores a submit while a run is in flight (P0 concurrency guard)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const agent: TuiAgentLike = {
      model: { id: "qwen-turbo" },
      session: {
        on: NOOP_ON,
        runStreaming: () => {
          const gen = (async function* (): AsyncGenerator<SessionEvent> {
            yield { type: "turn-start", turnIdx: 0 };
            await gate;
          })();
          return Object.assign(gen, { finalSummary: gate.then(() => summary) });
        },
      },
    };
    const app = createTuiApp({ agent, terminal: new FakeTerminal() });

    const first = app.submit("first prompt");
    await new Promise((r) => setTimeout(r, 0));
    expect(app.isRunning()).toBe(true);

    await app.submit("second prompt");
    const out = strip(app.tui.render(80).join("\n"));
    expect(out).toContain("first prompt");
    expect(out).not.toContain("second prompt");

    release();
    await first;
    expect(app.isRunning()).toBe(false);
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
