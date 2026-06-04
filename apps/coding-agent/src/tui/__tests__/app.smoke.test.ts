import { describe, it, expect } from "vitest";
import type { Terminal } from "@earendil-works/pi-tui";
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

function assistant(content: AssistantMessage["content"], usageInput = 0): AssistantMessage {
  return { role: "assistant", content, api: "", provider: "", model: "qwen-turbo", usage: { ...ZERO, input: usageInput }, stopReason: "stop", timestamp: 0 };
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
    { coarse: { type: "llm-end", msg: assistant([{ type: "text", text: "# Done\nAll good." }], 123), durationMs: 4 } }, // 被 suppress；input=123 喂 ctx-gauge
    { coarse: { type: "turn-end", turnIdx: 1, toolResultsCount: 0, stopReason: "stop" } },
    { coarse: { type: "session-end", summary } },
  ];

  function makeApp(session: TuiSession): ReturnType<typeof createTuiApp> {
    const agent: TuiAgentLike = {
      model: { id: "qwen-turbo", contextWindow: 200_000 },
      session,
      getCostEstimate: () => ({ amount: 0.0012, currency: "CNY" }),
      getToolStats: () => ({ totalCalls: 1, error: 0 }),
    };
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
    expect(out).toContain("ctx 123/200k"); // 上下文占用读数（input=123 / window=200k）
    expect(out).toContain("¥0.0012");
    expect(out).toContain("🔧 1/0"); // 工具统计
  });

  it("suppresses coarse llm-end so the assistant message is rendered exactly once (no double)", async () => {
    const app = makeApp(scriptedSession(steps, summary));
    await app.submit("hi");
    const out = strip(app.tui.render(80).join("\n"));
    expect(out.split("All good.").length - 1).toBe(1); // 只出现一次
  });

  const failSummary: RunSummary = {
    turns: 1,
    continuations: 0,
    reason: "error",
    usage: { ...ZERO },
    persistenceErrors: ["appendEntry(message): boom"],
  };

  it("finalize: summary.persistenceErrors → 渲染醒目告警 + persistenceErrorRuns()===1", async () => {
    const app = makeApp(scriptedSession([{ coarse: { type: "session-end", summary: failSummary } }], failSummary));
    await app.submit("go");
    const out = strip(app.tui.render(80).join("\n"));
    expect(out).toContain("持久化失败"); // 落盘失败当场可见(崩溃恢复路径)
    expect(out).toContain("appendEntry(message): boom"); // 具体错误
    expect(app.persistenceErrorRuns()).toBe(1);
  });

  it("persistenceErrorRuns 跨多轮累积:两轮都失败 → 2", async () => {
    const app = makeApp(scriptedSession([{ coarse: { type: "session-end", summary: failSummary } }], failSummary));
    await app.submit("a");
    await app.submit("b");
    expect(app.persistenceErrorRuns()).toBe(2);
  });

  it("干净 run 不自增 persistenceErrorRuns(无假阳性)", async () => {
    const app = makeApp(scriptedSession([{ coarse: { type: "session-end", summary } }], summary));
    await app.submit("go");
    expect(app.persistenceErrorRuns()).toBe(0);
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

  it("approval (inline): onAsk renders a visible prompt; Enter allows → resolves true", async () => {
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
    // 行内提示在公共 render 里可见（不像旧 overlay 只能断布尔）。
    const out = strip(app.tui.render(80).join("\n"));
    expect(out).toContain("Approve tool call");
    expect(out).toContain("bash(command: ls)");

    term.feed("\r"); // Enter → allow once
    await expect(decision).resolves.toBe(true);
    expect(strip(app.tui.render(80).join("\n"))).toContain("allowed");
    app.stop();
  });

  it("approval (inline): Esc denies → resolves false", async () => {
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
    expect(strip(app.tui.render(80).join("\n"))).toContain("Approve tool call");

    term.feed("\x1b"); // Esc → deny（审批进行中,输入监听优先把 Esc 当"拒绝"而非中断）
    await expect(decision).resolves.toBe(false);
    expect(strip(app.tui.render(80).join("\n"))).toContain("denied");
    app.stop();
  });

  it("approval (inline): 'n' denies, 'y' allows", async () => {
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

    const denied = captured!({ type: "toolCall", id: "1", name: "bash", arguments: { command: "ls" } });
    term.feed("n");
    await expect(denied).resolves.toBe(false);

    const allowed = captured!({ type: "toolCall", id: "2", name: "bash", arguments: { command: "ls" } });
    term.feed("y");
    await expect(allowed).resolves.toBe(true);
    app.stop();
  });

  const idleSession: TuiSession = {
    on: NOOP_ON,
    runStreaming: () => {
      throw new Error("runStreaming should not be called for a slash command");
    },
  };

  it("/compact when dormant: calls requestCompaction and shows session-scoped feedback (no LLM turn)", async () => {
    let requested = 0;
    const agent: TuiAgentLike = {
      model: { id: "qwen-turbo" },
      session: idleSession,
      getCompactionState: () => ({ enabled: false }), // 挂着但休眠 → /compact 启用它
      requestCompaction: () => {
        requested++;
      },
    };
    const app = createTuiApp({ agent, terminal: new FakeTerminal() });
    await app.submit("/compact");
    expect(requested).toBe(1);
    expect(app.isRunning()).toBe(false);
    const out = strip(app.tui.render(80).join("\n"));
    expect(out).toContain("compaction on for this session"); // 诚实:持续整个会话
  });

  it("/compact when already on (--compact): does NOT re-trigger, says already on", async () => {
    let requested = 0;
    const agent: TuiAgentLike = {
      model: { id: "qwen-turbo" },
      session: idleSession,
      getCompactionState: () => ({ enabled: true }), // 已自动开
      requestCompaction: () => {
        requested++;
      },
    };
    const app = createTuiApp({ agent, terminal: new FakeTerminal() });
    await app.submit("/compact");
    expect(requested).toBe(0); // 已开 → 不重复触发
    expect(strip(app.tui.render(80).join("\n"))).toContain("already on");
  });

  it("/compact when compaction is NOT wired: no-op with a clear message", async () => {
    let requested = 0;
    const agent: TuiAgentLike = {
      model: { id: "qwen-turbo" },
      session: idleSession,
      getCompactionState: () => undefined, // 未挂 compaction
      requestCompaction: () => {
        requested++;
      },
    };
    const app = createTuiApp({ agent, terminal: new FakeTerminal() });
    await app.submit("/compact");
    expect(requested).toBe(0); // 没挂 → 不调
    expect(strip(app.tui.render(80).join("\n"))).toContain("not available");
  });

  it("command palette: passing cwd wires the autocomplete provider without breaking submit", async () => {
    // cwd 启用 pi-tui 原生 `/`+`@` 补全。补全是 Editor 内部行为（真实终端才跑），这里只确认
    // 挂上 provider 不影响正常提交流程。
    const agent: TuiAgentLike = {
      model: { id: "qwen-turbo", contextWindow: 200_000 },
      session: scriptedSession([{ coarse: { type: "session-end", summary } }], summary),
    };
    const app = createTuiApp({ agent, terminal: new FakeTerminal(), cwd: process.cwd() });
    await app.submit("normal prompt");
    expect(app.isRunning()).toBe(false);
    expect(strip(app.tui.render(80).join("\n"))).toContain("normal prompt"); // 普通提交照常工作
  });

  it("auto-compaction feedback: the app's compaction listener renders a '✦ compacted N' line", async () => {
    let listener: ((n: number) => void) | undefined;
    const agent: TuiAgentLike = {
      model: { id: "qwen-turbo" },
      session: idleSession,
      setCompactionListener: (fn) => {
        listener = fn;
      },
    };
    const app = createTuiApp({ agent, terminal: new FakeTerminal() });
    app.start(); // start() 里注册 listener
    expect(listener).toBeDefined();
    listener!(3); // 模拟内核在某 turn 实际跑了压缩
    expect(strip(app.tui.render(80).join("\n"))).toContain("compacted 3 earlier messages");
    app.stop();
  });

  const idleAgent: TuiAgentLike = { model: { id: "qwen-turbo", contextWindow: 200_000 }, session: idleSession };

  it("/multi: fans out one read-only sub-agent per @file, renders per-file results + summary", async () => {
    const tasks: string[] = [];
    const app = createTuiApp({
      agent: idleAgent,
      terminal: new FakeTerminal(),
      cwd: process.cwd(),
      spawnReadOnlySubAgent: async (task: string) => {
        tasks.push(task);
        return { ok: true, text: `analysis of the file` };
      },
    });
    await app.submit("/multi find bugs @a.ts @b.ts");
    expect(tasks).toHaveLength(2); // 两个 @file → 两个子代理
    expect(tasks.every((t) => t.includes("find bugs"))).toBe(true);
    const out = strip(app.tui.render(80).join("\n"));
    expect(out).toContain("⇉ /multi (read-only) over 2 files");
    expect(out).toContain("2/2 succeeded"); // 聚合摘要
    expect(out).toContain("a.ts");
    expect(out).toContain("b.ts");
    expect(app.isRunning()).toBe(false);
  });

  it("/multi without @files: shows usage, spawns nothing", async () => {
    let spawned = 0;
    const app = createTuiApp({
      agent: idleAgent,
      terminal: new FakeTerminal(),
      cwd: process.cwd(),
      spawnReadOnlySubAgent: async () => {
        spawned++;
        return { ok: true, text: "x" };
      },
    });
    await app.submit("/multi just some text without files");
    expect(spawned).toBe(0);
    expect(strip(app.tui.render(80).join("\n"))).toContain("usage: /multi");
  });

  it("/multi when not wired (no spawnReadOnlySubAgent): clear message, no-op", async () => {
    const app = createTuiApp({ agent: idleAgent, terminal: new FakeTerminal(), cwd: process.cwd() });
    await app.submit("/multi find bugs @a.ts");
    expect(strip(app.tui.render(80).join("\n"))).toContain("/multi not available");
  });

  it("/multi while a normal run is in flight: busy guard, spawns nothing", async () => {
    let spawned = 0;
    const { session, release } = gatedSession();
    const app = createTuiApp({
      agent: { model: { id: "qwen-turbo" }, session },
      terminal: new FakeTerminal(),
      cwd: process.cwd(),
      spawnReadOnlySubAgent: async () => {
        spawned++;
        return { ok: true, text: "x" };
      },
    });
    const first = app.submit("go"); // 普通 run 占住 running
    await new Promise((r) => setTimeout(r, 0));
    expect(app.isRunning()).toBe(true);

    await app.submit("/multi check @a.ts"); // 运行中的 /multi → busy 守卫
    expect(spawned).toBe(0);
    expect(strip(app.tui.render(80).join("\n"))).toContain("busy");

    release();
    await first;
  });

  it("Esc during /multi cancels the whole batch (in-flight sub-agents get the aborted signal)", async () => {
    let sawAbort = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const term = new FakeTerminal();
    const app = createTuiApp({
      agent: { model: { id: "qwen-turbo" }, session: idleSession },
      terminal: term,
      cwd: process.cwd(),
      spawnReadOnlySubAgent: (_task, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            sawAbort = true;
            resolve({ ok: false, text: "aborted" });
          });
          void gate.then(() => resolve({ ok: true, text: "done" }));
        }),
    });
    app.start();
    const run = app.submit("/multi check @a.ts @b.ts");
    await new Promise((r) => setTimeout(r, 0));
    expect(app.isRunning()).toBe(true);

    term.feed("\x1b"); // Esc → 取消整批
    await run;
    expect(sawAbort).toBe(true); // 在飞子代理确实收到了 abort signal
    expect(app.isRunning()).toBe(false);
    release();
    app.stop();
  });

  it("/multi isolates a failing sub-agent (one ✗, batch still summarized)", async () => {
    const app = createTuiApp({
      agent: idleAgent,
      terminal: new FakeTerminal(),
      cwd: process.cwd(),
      spawnReadOnlySubAgent: async (task: string) => {
        if (task.includes("bad.ts")) throw new Error("read failed");
        return { ok: true, text: "ok" };
      },
    });
    await app.submit("/multi check @good.ts @bad.ts");
    const out = strip(app.tui.render(80).join("\n"));
    expect(out).toContain("1/2 succeeded"); // 一个失败被隔离
    expect(out).toContain("✓ good.ts");
    expect(out).toContain("✗ bad.ts");
  });

  it("resume: initialMessages seed the visible history (not a blank chat) + a resumed banner", async () => {
    const history: import("@harness-pi/core").Message[] = [
      { role: "user", content: "remember marker-77", timestamp: 0 },
      assistant([{ type: "text", text: "Noted marker-77." }], 456),
    ];
    const app = createTuiApp({
      agent: { model: { id: "qwen-turbo", contextWindow: 200_000 }, session: idleSession },
      terminal: new FakeTerminal(),
      initialMessages: history,
    });
    const out = strip(app.tui.render(80).join("\n"));
    expect(out).toContain("remember marker-77"); // 用户历史可见
    expect(out).toContain("Noted marker-77."); // 助手历史可见
    expect(out).toContain("resumed 2 earlier messages"); // 恢复横幅
    expect(out).toContain("ctx 456/200k"); // ctx-gauge 用历史最后一条 assistant 的 input 初始化
  });

  it("/exit quits the TUI", async () => {
    const app = makeApp(scriptedSession([{ coarse: { type: "session-end", summary } }], summary));
    const done = app.run();
    await app.submit("/exit");
    await done; // /exit → quit() → run() resolves
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
