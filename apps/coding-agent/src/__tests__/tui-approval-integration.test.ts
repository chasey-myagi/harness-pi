import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Terminal } from "@mariozechner/pi-tui";
import { createFakeModel } from "@harness-pi/core/testing";
import { createCodingAgent } from "../agent.js";
import { createTuiApp } from "../tui/app.js";

const dirs: string[] = [];
async function repo(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "hpi-approval-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

/** 记录所有写入的真终端替身（14 个成员），用来断言 overlay 真的被渲染出来。 */
class RecordingTerminal implements Terminal {
  written = "";
  private onInput?: (data: string) => void;
  get columns(): number {
    return 100;
  }
  get rows(): number {
    return 30;
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
  write(data: string): void {
    this.written += data;
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

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("TUI approval overlay — real agent + real TUI + recording terminal", () => {
  it("a bash call pops a visible approval overlay; Enter allows and the run continues", async () => {
    const cwd = await repo();
    const fake = createFakeModel([
      { content: [{ type: "toolCall", name: "bash", arguments: { command: "echo hi" } }] },
      { content: [{ type: "text", text: "done" }], stopReason: "stop" },
    ]);
    const agent = createCodingAgent({ cwd, model: fake, permission: {} });
    const term = new RecordingTerminal();
    const app = createTuiApp({ agent, terminal: term, cwd });
    app.start();

    const run = app.submit("run echo hi"); // 会停在 bash 审批,先不 await
    // 等内核走到 tool 阶段(行内审批提示出现在公共 render 里)
    const seen = (): boolean => strip(app.tui.render(100).join("\n")).includes("Approve tool call");
    for (let i = 0; i < 20 && !seen(); i++) await tick();

    expect(seen()).toBe(true); // 行内审批提示真的渲染出来了(不是只有一个布尔)
    expect(strip(app.tui.render(100).join("\n"))).toMatch(/bash\(command: echo hi\)/);

    term.feed("\r"); // Enter → allow once
    await run; // 放行后 run 跑完
    expect(app.isRunning()).toBe(false);
    expect(strip(app.tui.render(100).join("\n"))).toContain("allowed");
    app.stop();
    fake.teardown();
    await agent.close();
  });
});
