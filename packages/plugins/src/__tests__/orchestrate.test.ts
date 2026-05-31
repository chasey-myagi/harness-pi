import { describe, it, expect } from "vitest";
import { parallel } from "../controllers/orchestrate.js";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("parallel orchestration", () => {
  it("runs every item and returns outcomes in item order", async () => {
    const outcomes = await parallel([1, 2, 3], {
      concurrency: 2,
      run: async (n) => n * 10,
    });
    expect(outcomes.map((o) => o.index)).toEqual([0, 1, 2]);
    expect(outcomes.map((o) => o.status)).toEqual(["ok", "ok", "ok"]);
    expect(outcomes.map((o) => (o.status === "ok" ? o.value : null))).toEqual([10, 20, 30]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let maxSeen = 0;
    await parallel([1, 2, 3, 4, 5, 6], {
      concurrency: 2,
      run: async () => {
        inFlight++;
        maxSeen = Math.max(maxSeen, inFlight);
        await delay(5);
        inFlight--;
        return 0;
      },
    });
    expect(maxSeen).toBe(2); // uses the full budget but never exceeds it
  });

  it("returns outcomes ordered by index even when completion order differs", async () => {
    const completion: number[] = [];
    const outcomes = await parallel([0, 1, 2], {
      concurrency: 3,
      run: async (n) => {
        await delay((3 - n) * 8); // item 2 finishes first, item 0 last
        completion.push(n);
        return n;
      },
    });
    expect(completion).toEqual([2, 1, 0]); // completed in reverse
    expect(outcomes.map((o) => (o.status === "ok" ? o.value : null))).toEqual([0, 1, 2]); // still by index
  });

  it("isolates a failing item as status='failed' without dropping the others", async () => {
    const outcomes = await parallel([1, 2, 3], {
      concurrency: 3,
      run: async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      },
    });
    expect(outcomes.map((o) => o.status)).toEqual(["ok", "failed", "ok"]);
    const failed = outcomes[1]!;
    expect(failed.status).toBe("failed");
    if (failed.status === "failed") expect((failed.error as Error).message).toBe("boom");
  });

  it("MUST-SETTLE: every item gets exactly one outcome, no holes, no duplicates", async () => {
    const outcomes = await parallel([0, 1, 2, 3, 4], {
      concurrency: 3,
      run: async (n) => {
        if (n % 2 === 0) throw new Error(`fail ${n}`);
        return n;
      },
    });
    expect(outcomes).toHaveLength(5);
    expect(outcomes.every((o) => o !== undefined)).toBe(true);
    expect(outcomes.map((o) => o.index)).toEqual([0, 1, 2, 3, 4]);
    expect(outcomes.map((o) => o.status)).toEqual(["failed", "ok", "failed", "ok", "failed"]);
  });

  it("stops dispatching once the budget is reached; remaining are skipped:'budget'", async () => {
    const outcomes = await parallel([1, 2, 3, 4], {
      concurrency: 1,
      budget: { total: 2, cost: () => 1 }, // each ok result costs 1
      run: async (n) => n,
    });
    expect(outcomes.map((o) => o.status)).toEqual(["ok", "ok", "skipped", "skipped"]);
    const skipped = outcomes[2]!;
    expect(skipped.status).toBe("skipped");
    if (skipped.status === "skipped") expect(skipped.reason).toBe("budget");
  });

  it("stops dispatching new items once aborted; in-flight finish, rest skipped:'aborted'", async () => {
    const ac = new AbortController();
    const outcomes = await parallel([1, 2, 3, 4], {
      concurrency: 1,
      signal: ac.signal,
      run: async (n) => {
        if (n === 2) ac.abort();
        return n;
      },
    });
    expect(outcomes.map((o) => o.status)).toEqual(["ok", "ok", "skipped", "skipped"]);
    const skipped = outcomes[3]!;
    expect(skipped.status).toBe("skipped");
    if (skipped.status === "skipped") expect(skipped.reason).toBe("aborted");
  });

  it("reports progress per settled item, ending at done===total", async () => {
    const seen: Array<{ done: number; total: number }> = [];
    await parallel([1, 2, 3], {
      concurrency: 1,
      run: async (n) => n,
      onProgress: (p) => seen.push({ done: p.done, total: p.total }),
    });
    expect(seen).toHaveLength(3);
    expect(seen.map((s) => s.done)).toEqual([1, 2, 3]);
    expect(seen.every((s) => s.total === 3)).toBe(true);
  });

  it("handles an empty work-list", async () => {
    const outcomes = await parallel([], { concurrency: 4, run: async () => 0 });
    expect(outcomes).toEqual([]);
  });

  it("clamps concurrency to [1, items.length]", async () => {
    // concurrency 0 -> 1 (still runs everything)
    const a = await parallel([1, 2], { concurrency: 0, run: async (n) => n });
    expect(a.map((o) => o.status)).toEqual(["ok", "ok"]);
    // concurrency > n -> n (runs everything, doesn't spin extra idle workers forever)
    let maxSeen = 0;
    let inFlight = 0;
    const b = await parallel([1, 2, 3], {
      concurrency: 100,
      run: async (n) => {
        inFlight++;
        maxSeen = Math.max(maxSeen, inFlight);
        await delay(3);
        inFlight--;
        return n;
      },
    });
    expect(b.map((o) => o.status)).toEqual(["ok", "ok", "ok"]);
    expect(maxSeen).toBe(3); // clamped to item count
  });

  it("preserves a non-Error throw verbatim (error: unknown is not wrapped)", async () => {
    const outcomes = await parallel([1, 2], {
      concurrency: 2,
      run: async (n) => {
        if (n === 1) throw "string-thrown"; // eslint-disable-line no-throw-literal
        return n;
      },
    });
    const f = outcomes[0]!;
    expect(f.status).toBe("failed");
    if (f.status === "failed") expect(f.error).toBe("string-thrown"); // not wrapped in Error
  });

  it("budget total=0 skips everything (>= boundary triggers immediately)", async () => {
    const outcomes = await parallel([1, 2, 3], {
      concurrency: 1,
      budget: { total: 0, cost: () => 1 },
      run: async (n) => n,
    });
    expect(outcomes.map((o) => o.status)).toEqual(["skipped", "skipped", "skipped"]);
  });

  it("budget cost can read value+item and a single cost can cross total", async () => {
    const seen: Array<[number, number]> = [];
    const outcomes = await parallel<number, number>([10, 20, 30, 40], {
      concurrency: 1,
      budget: {
        total: 3,
        cost: (value, item) => {
          seen.push([value, item]);
          return 2; // each ok costs 2: after item0 spent=2(<3 run item1) spent=4 -> stop
        },
      },
      run: async (n) => n,
    });
    expect(outcomes.map((o) => o.status)).toEqual(["ok", "ok", "skipped", "skipped"]);
    expect(seen).toEqual([[10, 10], [20, 20]]); // cost received (value, item) for the two that ran
  });

  it("budget is a dispatch threshold, not a hard cap: concurrency>1 may overshoot", async () => {
    const outcomes = await parallel([1, 2, 3, 4, 5], {
      concurrency: 3,
      budget: { total: 1, cost: () => 1 },
      run: async (n) => {
        await delay(3);
        return n;
      },
    });
    const ok = outcomes.filter((o) => o.status === "ok").length;
    expect(ok).toBeGreaterThan(1); // 3 in-flight dispatched before budget enforced -> overshoot
    expect(outcomes).toHaveLength(5); // still settles every item, no holes
    expect(outcomes.filter((o) => o.status === "skipped").length).toBe(5 - ok);
  });

  it("failed items do NOT consume budget", async () => {
    const outcomes = await parallel([0, 1, 2, 3, 4], {
      concurrency: 1,
      budget: { total: 2, cost: () => 1 },
      run: async (n) => {
        if (n < 2) throw new Error("fail"); // first two fail, cost nothing
        return n;
      },
    });
    // 0,1 fail (no spend); 2 ok(spent1) 3 ok(spent2) 4 skipped(spent>=2)
    expect(outcomes.map((o) => o.status)).toEqual(["failed", "failed", "ok", "ok", "skipped"]);
  });

  it("a pre-aborted signal dispatches nothing — all skipped:'aborted'", async () => {
    const ac = new AbortController();
    ac.abort();
    let ran = 0;
    const outcomes = await parallel([1, 2, 3], {
      concurrency: 2,
      signal: ac.signal,
      run: async (n) => {
        ran++;
        return n;
      },
    });
    expect(ran).toBe(0);
    expect(outcomes.map((o) => o.status)).toEqual(["skipped", "skipped", "skipped"]);
  });

  it("on abort under concurrency>1, in-flight items still finish with real outcomes", async () => {
    const ac = new AbortController();
    const outcomes = await parallel([1, 2, 3, 4], {
      concurrency: 2, // idx0+idx1 dispatched together
      signal: ac.signal,
      run: async (n) => {
        if (n === 2) ac.abort(); // abort while idx0 (n=1) is still in-flight
        await delay(2);
        return n;
      },
    });
    expect(outcomes[0]!.status).toBe("ok"); // in-flight finished, not mis-marked skipped
    expect(outcomes[1]!.status).toBe("ok");
    expect(outcomes[2]!.status).toBe("skipped");
    expect(outcomes[3]!.status).toBe("skipped");
  });

  it("when abort and budget both hold, reason is 'aborted' (abort wins)", async () => {
    const ac = new AbortController();
    ac.abort();
    const outcomes = await parallel([1, 2], {
      concurrency: 1,
      signal: ac.signal,
      budget: { total: 0, cost: () => 1 }, // budget would also stop dispatch
      run: async (n) => n,
    });
    const first = outcomes[0]!;
    expect(first.status).toBe("skipped");
    if (first.status === "skipped") expect(first.reason).toBe("aborted");
  });

  it("progress exposes cumulative spent and fires for skipped items too", async () => {
    const spents: number[] = [];
    const dones: number[] = [];
    await parallel([1, 2, 3], {
      concurrency: 1,
      budget: { total: 1, cost: () => 1 },
      run: async (n) => n,
      onProgress: (p) => {
        spents.push(p.spent);
        dones.push(p.done);
      },
    });
    expect(dones).toEqual([1, 2, 3]); // every item (incl. skipped) reports progress, done++ each
    expect(spents.at(-1)).toBe(1); // one ok billed 1; the rest skipped, spent stays 1
  });

  it("handles a single-element work-list", async () => {
    let maxSeen = 0;
    let inFlight = 0;
    const outcomes = await parallel([42], {
      concurrency: 5,
      run: async (n) => {
        inFlight++;
        maxSeen = Math.max(maxSeen, inFlight);
        await delay(2);
        inFlight--;
        return n;
      },
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.status).toBe("ok");
    expect(maxSeen).toBe(1);
  });

  it("MUST-SETTLE at scale: 100 items, random failures, small concurrency — no holes, strictly ordered", async () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const outcomes = await parallel(items, {
      concurrency: 4,
      run: async (n) => {
        if (n % 7 === 0) throw new Error(`fail ${n}`);
        return n;
      },
    });
    expect(outcomes).toHaveLength(100);
    expect(outcomes.every((o) => o !== undefined)).toBe(true);
    expect(outcomes.map((o) => o.index)).toEqual(items); // strict 0..99 order
    expect(outcomes.every((o) => o.status === "ok" || o.status === "failed")).toBe(true);
  });
});
