import { describe, it, expect } from "vitest";
import type { Terminal } from "@mariozechner/pi-tui";
import type { AssistantMessage, RunSummary, SessionEvent } from "@harness-pi/core";
import { createTuiApp, type TuiAgentLike } from "../app.js";

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

class FakeTerminal implements Terminal {
  output = "";
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
  /** 模拟终端把按键喂给 TUI（供 Ctrl-C 等键位测试）。 */
  feed(data: string): void {
    this.onInput?.(data);
  }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.output += data;
  }
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

function fakeStream(
  events: SessionEvent[],
  summary: RunSummary,
): AsyncIterable<SessionEvent> & { finalSummary: Promise<RunSummary> } {
  const gen = (async function* () {
    for (const e of events) yield e;
  })();
  return Object.assign(gen, { finalSummary: Promise.resolve(summary) });
}

function makeAgent(events: SessionEvent[], summary: RunSummary): TuiAgentLike {
  return {
    model: { id: "qwen-turbo" },
    session: { runStreaming: () => fakeStream(events, summary) },
    getCostEstimate: () => ({ amount: 0.0012, currency: "CNY" }),
  };
}

describe("TUI app smoke (headless via fake terminal)", () => {
  const summary: RunSummary = { turns: 2, continuations: 0, reason: "done", usage: { ...ZERO, input: 123, output: 45 } };
  const events: SessionEvent[] = [
    { type: "session-start", sessionId: "s", source: "run", initialPrompt: "hi" },
    { type: "turn-start", turnIdx: 0 },
    {
      type: "llm-end",
      msg: assistant([
        { type: "text", text: "let me check" },
        { type: "toolCall", id: "1", name: "read", arguments: { path: "a.ts" } },
      ]),
      durationMs: 5,
    },
    {
      type: "tool-end",
      call: { type: "toolCall", id: "1", name: "read", arguments: { path: "a.ts" } },
      result: { content: [{ type: "text", text: "file body here" }], isError: false },
      durationMs: 12,
    },
    { type: "turn-start", turnIdx: 1 },
    { type: "llm-end", msg: assistant([{ type: "text", text: "# Done\nAll good." }]), durationMs: 4 },
    { type: "turn-end", turnIdx: 1, toolResultsCount: 0, stopReason: "stop" },
    { type: "session-end", summary },
  ];

  it("runs a full coarse-track round and renders user/toolCall/toolResult/assistant/statusbar", async () => {
    const term = new FakeTerminal();
    const app = createTuiApp({ agent: makeAgent(events, summary), terminal: term });

    await app.submit("hi there");

    expect(app.isRunning()).toBe(false);
    const out = strip(app.tui.render(80).join("\n"));
    expect(out).toContain("hi there"); // 用户消息
    expect(out).toContain("read(path: a.ts)"); // 工具调用摘要
    expect(out).toContain("file body here"); // 工具结果
    expect(out).toContain("All good."); // 末条助手消息（Markdown 渲染）
    expect(out).toContain("qwen-turbo"); // 状态栏 model
    expect(out).toContain("↑123 ↓45"); // 状态栏 tokens（来自 session-end 事件的 summary → finalize 读 usage）
    expect(out).toContain("¥0.0012"); // 状态栏 cost
  });

  it("ignores empty submits (no user bubble added)", async () => {
    const term = new FakeTerminal();
    const app = createTuiApp({ agent: makeAgent([{ type: "session-end", summary }], summary), terminal: term });
    const before = app.tui.render(80).join("\n");
    await app.submit("   ");
    const after = app.tui.render(80).join("\n");
    expect(after).toBe(before);
  });

  it("surfaces a stream error as an error line, not a throw", async () => {
    const term = new FakeTerminal();
    const boom: TuiAgentLike = {
      model: { id: "qwen-turbo" },
      session: {
        runStreaming: () => {
          const gen = (async function* (): AsyncGenerator<SessionEvent> {
            throw new Error("provider exploded");
          })();
          // 真实内核即便出错也 resolve 一个 reason:"error" 的 RunSummary（不 reject）；这里 resolve 避免悬空 rejection。
          return Object.assign(gen, { finalSummary: Promise.resolve(summary) });
        },
      },
    };
    const app = createTuiApp({ agent: boom, terminal: term });
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
        runStreaming: () => {
          const gen = (async function* (): AsyncGenerator<SessionEvent> {
            yield { type: "turn-start", turnIdx: 0 };
            await gate; // 卡住，模拟在飞的 run
          })();
          return Object.assign(gen, { finalSummary: gate.then(() => summary) });
        },
      },
    };
    const term = new FakeTerminal();
    const app = createTuiApp({ agent, terminal: term });

    const first = app.submit("first prompt"); // 启动并卡在 gate 上
    await new Promise((r) => setTimeout(r, 0)); // 让它跑到 running=true
    expect(app.isRunning()).toBe(true);

    await app.submit("second prompt"); // 运行中：守卫直接 return（no-op）
    const out = strip(app.tui.render(80).join("\n"));
    expect(out).toContain("first prompt");
    expect(out).not.toContain("second prompt"); // 第二条没被加成用户气泡

    release();
    await first;
    expect(app.isRunning()).toBe(false);
  });

  it("Ctrl-C: run() resolves, quit aborts the session (no request leak)", async () => {
    let aborted = false;
    const agent: TuiAgentLike = {
      model: { id: "qwen-turbo" },
      session: {
        runStreaming: () => fakeStream([{ type: "session-end", summary }], summary),
        abort: () => {
          aborted = true;
        },
      },
    };
    const term = new FakeTerminal();
    const app = createTuiApp({ agent, terminal: term });
    const done = app.run(); // 接管终端、返回 exit promise
    term.feed("\x03"); // 模拟 Ctrl-C
    await done; // run() 在 quit() 后 resolve
    expect(aborted).toBe(true); // quit 接线了 session.abort
  });
});
