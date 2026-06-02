import { describe, expect, it } from "vitest";
import {
  parseMultiCommand,
  orchestrateMulti,
  subTaskFor,
  formatMultiSummary,
  type MultiProgress,
} from "../multi.js";

describe("parseMultiCommand", () => {
  it("extracts @targets as the work-list and the rest as the instruction", () => {
    expect(parseMultiCommand("find bugs in @a.ts @b.ts")).toEqual({
      instruction: "find bugs in",
      targets: ["a.ts", "b.ts"],
    });
  });

  it("returns null when there are no @targets (no work-list)", () => {
    expect(parseMultiCommand("just some text")).toBeNull();
    expect(parseMultiCommand("")).toBeNull();
  });

  it("handles targets with paths and an empty instruction", () => {
    expect(parseMultiCommand("@src/a.ts @src/b.ts")).toEqual({
      instruction: "",
      targets: ["src/a.ts", "src/b.ts"],
    });
  });

  it("does NOT treat an email/handle @ as a target (only word-initial @)", () => {
    expect(parseMultiCommand("notify user@example.com about @a.ts")).toEqual({
      instruction: "notify user@example.com about",
      targets: ["a.ts"],
    });
  });

  it("strips trailing punctuation from targets", () => {
    expect(parseMultiCommand("check @a.ts, @b.ts.")).toEqual({
      instruction: "check",
      targets: ["a.ts", "b.ts"],
    });
  });

  it("dedups repeated @files (one sub-agent per file)", () => {
    expect(parseMultiCommand("review @a.ts @a.ts @b.ts")).toEqual({
      instruction: "review",
      targets: ["a.ts", "b.ts"],
    });
  });
});

describe("orchestrateMulti", () => {
  it("runs every target and preserves input order regardless of completion order", async () => {
    const targets = ["a", "b", "c"];
    const outcomes = await orchestrateMulti(
      targets,
      async (t) => {
        // 让 'a' 慢于 'c'，验证保序与完成先后无关。
        await new Promise((r) => setTimeout(r, t === "a" ? 10 : 0));
        return { ok: true, text: `done ${t}` };
      },
      { concurrency: 3 },
    );
    expect(outcomes.map((o) => o.target)).toEqual(["a", "b", "c"]);
    expect(outcomes.map((o) => o.text)).toEqual(["done a", "done b", "done c"]);
  });

  it("isolates errors: one throwing target does not fail the batch", async () => {
    const outcomes = await orchestrateMulti(["ok1", "boom", "ok2"], async (t) => {
      if (t === "boom") throw new Error("kaboom");
      return { ok: true, text: t };
    });
    expect(outcomes.find((o) => o.target === "boom")).toEqual({
      target: "boom",
      ok: false,
      text: "kaboom",
    });
    expect(outcomes.filter((o) => o.ok).map((o) => o.target)).toEqual(["ok1", "ok2"]);
  });

  it("actually runs in parallel up to the cap (a serial impl would deadlock this)", async () => {
    let concurrent = 0;
    let peak = 0;
    let release!: () => void;
    const allThreeStarted = new Promise<void>((r) => {
      release = r;
    });
    await orchestrateMulti(
      ["a", "b", "c"],
      async () => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        if (concurrent === 3) release(); // 三个都并发到位才放行
        await allThreeStarted; // 串行实现永远到不了 3 → 卡死（证明确有并行）
        concurrent--;
        return { ok: true, text: "x" };
      },
      { concurrency: 3 },
    );
    expect(peak).toBe(3);
  });

  it("mid-run abort: items not yet started become 'aborted', no new launches", async () => {
    const ac = new AbortController();
    const ran: string[] = [];
    const outcomes = await orchestrateMulti(
      ["a", "b", "c", "d"],
      async (t) => {
        ran.push(t);
        if (t === "a") ac.abort(); // 跑第一个时就 abort
        return { ok: true, text: t };
      },
      { concurrency: 1, signal: ac.signal },
    );
    expect(ran).toEqual(["a"]); // 只有 a 真跑了，b/c/d 在迭代顶部被短路
    expect(outcomes[0]).toMatchObject({ target: "a", ok: true });
    expect(outcomes.slice(1).every((o) => o.text === "aborted")).toBe(true);
  });

  it("respects the concurrency cap (never more than N in flight)", async () => {
    let inFlight = 0;
    let peak = 0;
    await orchestrateMulti(
      ["1", "2", "3", "4", "5"],
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { ok: true, text: "x" };
      },
      { concurrency: 2 },
    );
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("emits start/done progress per target", async () => {
    const events: MultiProgress[] = [];
    await orchestrateMulti(["a"], async () => ({ ok: true, text: "x" }), {
      onProgress: (e) => events.push(e),
    });
    expect(events).toEqual([
      { target: "a", phase: "start" },
      { target: "a", phase: "done", ok: true },
    ]);
  });

  it("stops launching new work once the signal is aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const ran: string[] = [];
    const outcomes = await orchestrateMulti(
      ["a", "b"],
      async (t) => {
        ran.push(t);
        return { ok: true, text: t };
      },
      { signal: ac.signal },
    );
    expect(ran).toEqual([]); // 全被 abort 挡下，没真跑
    expect(outcomes.every((o) => !o.ok && o.text === "aborted")).toBe(true);
  });
});

describe("subTaskFor / formatMultiSummary", () => {
  it("scopes the instruction to a single file", () => {
    const task = subTaskFor("find bugs", "a.ts");
    expect(task).toContain("find bugs");
    expect(task).toContain("a.ts");
  });

  it("falls back to a default instruction when empty", () => {
    expect(subTaskFor("", "a.ts")).toContain("Review this file");
  });

  it("summary reports the success count and lists each target", () => {
    const md = formatMultiSummary([
      { target: "a.ts", ok: true, text: "looks good" },
      { target: "b.ts", ok: false, text: "failed to read" },
    ]);
    expect(md).toContain("1/2 succeeded");
    expect(md).toContain("✓ a.ts");
    expect(md).toContain("✗ b.ts");
  });
});
