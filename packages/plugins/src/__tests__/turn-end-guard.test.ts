/**
 * turnEndGuard 单测 —— 跑真实 AgentSession + fake LLM，验证 stopHook 式质量闸。
 *
 * 覆盖：
 *   1. 校验失败 → 持久阻断消息进 session.messages + 强制再跑一轮 → 修好后通过 → 正常停止
 *   2. maxRetries 到上限后放行停止，不无限空转
 *   3. 回归：不挂 turnEndGuard 时续跑行为与基线一致（无续跑、continuations=0）
 *   4. 多个 onContinuationCheck hook 共存时合并语义正确（continue:true 不被沉默 hook 覆盖）
 */

import { describe, it, expect, vi } from "vitest";
import {
  AgentSession,
  type Hook,
  type HookContext,
  type Message,
} from "@harness-pi/core";
import { createFakeModel } from "@harness-pi/core/testing";
import { turnEndGuard } from "../index.js";

function userText(m: Message): string {
  if (m.role !== "user") return "";
  if (typeof m.content === "string") return m.content;
  return m.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");
}

describe("turnEndGuard", () => {
  it("throws if maxRetries <= 0", () => {
    expect(() =>
      turnEndGuard({ check: () => ({ ok: true }), maxRetries: 0 }),
    ).toThrow();
  });

  it("sets a generous default hook timeout (event-class 100ms is too short for I/O checks)", () => {
    // onContinuationCheck 是 event 类、dispatcher 默认仅 100ms；check 做 I/O 必然超时被静默丢弃 → 闸失效。
    // 故返回 Hook 自设宽 timeout（默认 30s），可经 timeoutMs 覆盖。
    expect(turnEndGuard({ check: () => ({ ok: true }) }).timeout).toBe(30_000);
    expect(
      turnEndGuard({ check: () => ({ ok: true }), timeoutMs: 5_000 }).timeout,
    ).toBe(5_000);
  });

  it("throws if timeoutMs <= 0", () => {
    expect(() =>
      turnEndGuard({ check: () => ({ ok: true }), timeoutMs: 0 }),
    ).toThrow();
  });

  it("blocks stop: persists blocking message + forces a retry, then passes", async () => {
    // 两条 assistant 回复：第一条「以为做完了」，第二条是看到阻断消息后的「修好了」。
    const model = createFakeModel([
      { content: [{ type: "text", text: "done (attempt 1)" }] },
      { content: [{ type: "text", text: "fixed (attempt 2)" }] },
    ]);

    // check 第一次 fail、第二次 pass。
    let calls = 0;
    const check = vi.fn((_ctx: HookContext) => {
      calls++;
      return calls === 1
        ? { ok: false, message: "tests failed: 1 red. fix before stopping." }
        : { ok: true };
    });

    const session = new AgentSession({
      model,
      tools: [],
      hooks: [turnEndGuard({ check })],
    });
    const summary = await session.run("go");

    // 校验跑了两次（fail → 续跑 → pass）。
    expect(check).toHaveBeenCalledTimes(2);
    // session 正常停止（不是 max_continuations）。
    expect(summary.reason).toBe("done");
    // 续跑恰好 1 次。
    expect(summary.continuations).toBe(1);

    // 阻断消息**持久**注入 session.messages（user role），下次 LLM call 可见。
    const injected = session.messages.filter((m) =>
      userText(m).includes("tests failed: 1 red"),
    );
    expect(injected).toHaveLength(1);

    // 模型在第二轮确实看到了阻断消息（fake provider 记录的 context）。
    const lastCtx = model.getCalls().at(-1)!;
    const sawBlock = lastCtx.messages.some((m) =>
      userText(m as Message).includes("tests failed: 1 red"),
    );
    expect(sawBlock).toBe(true);
  });

  it("uses fallback blocking message when check omits message", async () => {
    const model = createFakeModel([
      { content: [{ type: "text", text: "a" }] },
      { content: [{ type: "text", text: "b" }] },
    ]);
    let calls = 0;
    const session = new AgentSession({
      model,
      tools: [],
      hooks: [
        turnEndGuard({
          check: () => {
            calls++;
            return calls === 1 ? { ok: false } : { ok: true };
          },
        }),
      ],
    });
    await session.run("go");
    const injected = session.messages.filter((m) =>
      userText(m).includes("turn-end-guard:"),
    );
    expect(injected).toHaveLength(1);
  });

  it("stops forcing after maxRetries exhausted (allows stop, no infinite spin)", async () => {
    // check 永远 fail。
    const model = createFakeModel([]); // fake 自动补 "[no more scripted responses]"
    const check = vi.fn(() => ({ ok: false, message: "still red" }));

    const session = new AgentSession({
      model,
      tools: [],
      // maxRetries=2 远小于内核 maxContinuations，确保是插件侧兜底先生效。
      hooks: [turnEndGuard({ check, maxRetries: 2 })],
      maxContinuations: 10,
    });
    const summary = await session.run("go");

    // check 被调 maxRetries+1 次：2 次强制续跑 + 第 3 次发现预算用尽放行。
    expect(check).toHaveBeenCalledTimes(3);
    // 插件放行停止（done），不是内核 max_continuations 兜底。
    expect(summary.reason).toBe("done");
    expect(summary.continuations).toBe(2);

    // 注入了 2 条阻断消息（每次强制各一条）。
    const injected = session.messages.filter((m) =>
      userText(m).includes("still red"),
    );
    expect(injected).toHaveLength(2);
  });

  it("regression: without turnEndGuard, no continuation happens", async () => {
    const model = createFakeModel([
      { content: [{ type: "text", text: "done" }] },
    ]);
    const session = new AgentSession({
      model,
      tools: [],
      hooks: [],
    });
    const summary = await session.run("go");
    expect(summary.reason).toBe("done");
    expect(summary.continuations).toBe(0);
  });

  it("coexists with another onContinuationCheck hook (continue:true not masked)", async () => {
    const model = createFakeModel([
      { content: [{ type: "text", text: "done 1" }] },
      { content: [{ type: "text", text: "fixed 2" }] },
    ]);

    // 一个沉默的 onContinuationCheck hook（不返回 continue），不应屏蔽 turnEndGuard 的强制续跑。
    const silent: Hook = {
      name: "silent-cc",
      onContinuationCheck() {
        return { additionalContext: "fyi" };
      },
    };

    let calls = 0;
    const session = new AgentSession({
      model,
      tools: [],
      hooks: [
        silent,
        turnEndGuard({
          check: () => {
            calls++;
            return calls === 1 ? { ok: false, message: "blocked" } : { ok: true };
          },
        }),
      ],
    });
    const summary = await session.run("go");

    // mergeResults：沉默 hook 的 additionalContext 不算决断，turnEndGuard 的 continue:true 仍生效。
    expect(summary.continuations).toBe(1);
    expect(summary.reason).toBe("done");
    const injected = session.messages.filter((m) =>
      userText(m).includes("blocked"),
    );
    expect(injected).toHaveLength(1);
  });

  it("passes cleanly when check is satisfied on the retry (single fail→force→pass cycle)", async () => {
    // 序列：done → check fail（强制一轮）→ fixed → check pass（放行）。maxRetries=1 下走完一个
    // fail→force→pass 周期后干净停止。（注：一次 pass 即终止本 run，故「pass 后预算回满」无法在单 run 内
    // 再触发一次 fail 来观测——那条 reset 分支与 onSessionStart 的重置在 continue() 场景才各自有意义。）
    const model = createFakeModel([
      { content: [{ type: "text", text: "v1" }] },
      { content: [{ type: "text", text: "v2" }] },
    ]);
    let calls = 0;
    const session = new AgentSession({
      model,
      tools: [],
      hooks: [
        turnEndGuard({
          check: () => {
            calls++;
            return calls === 1 ? { ok: false, message: "x" } : { ok: true };
          },
          maxRetries: 1,
        }),
      ],
    });
    const summary = await session.run("go");
    // maxRetries=1：第一次 fail 强制一轮（用尽预算前还差），第二次 pass 放行。
    expect(summary.reason).toBe("done");
    expect(summary.continuations).toBe(1);
  });
});
