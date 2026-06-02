import { describe, it, expect } from "vitest";
import { pipeline } from "../controllers/orchestrate.js";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("pipeline orchestration", () => {
  it("runs each item through all stages in order; value is the last stage's output", async () => {
    const outcomes = await pipeline<number, string>(
      [1, 2, 3],
      [
        async (prev) => (prev as number) + 10, // 11, 12, 13
        async (prev) => (prev as number) * 2, // 22, 24, 26
        async (prev) => `v=${prev as number}`, // strings
      ],
      { concurrency: 2 },
    );
    expect(outcomes.map((o) => o.index)).toEqual([0, 1, 2]);
    expect(outcomes.map((o) => o.status)).toEqual(["ok", "ok", "ok"]);
    expect(outcomes.map((o) => (o.status === "ok" ? o.value : null))).toEqual(["v=22", "v=24", "v=26"]);
  });

  it("first stage receives the item as prev; later stages receive the previous stage's output; (prev,item,index)", async () => {
    const seen: Array<{ stage: number; prev: unknown; item: number; index: number }> = [];
    await pipeline(
      [7],
      [
        async (prev, item, index) => {
          seen.push({ stage: 0, prev, item, index });
          return "from-s0";
        },
        async (prev, item, index) => {
          seen.push({ stage: 1, prev, item, index });
          return "from-s1";
        },
      ],
      {},
    );
    expect(seen).toEqual([
      { stage: 0, prev: 7, item: 7, index: 0 }, // first stage: prev === item
      { stage: 1, prev: "from-s0", item: 7, index: 0 }, // second stage: prev === s0 output
    ]);
  });

  it("outcomes stay ordered by index even when items complete out of order", async () => {
    const completion: number[] = [];
    const outcomes = await pipeline<number, number>(
      [0, 1, 2],
      [
        async (_p, item) => {
          await delay((3 - item) * 8); // item 2 finishes first, item 0 last
          completion.push(item);
          return item;
        },
      ],
      { concurrency: 3 },
    );
    expect(completion).toEqual([2, 1, 0]);
    expect(outcomes.map((o) => (o.status === "ok" ? o.value : null))).toEqual([0, 1, 2]);
  });

  it("NO BARRIER: a fast item advances to a later stage while a slow item is still in stage 0", async () => {
    const events: string[] = [];
    await pipeline<number, number>(
      [0, 1],
      [
        async (_p, item) => {
          events.push(`s0:start:${item}`);
          await delay(item === 0 ? 40 : 1); // item 0 slow, item 1 fast
          events.push(`s0:end:${item}`);
          return item;
        },
        async (_p, item) => {
          events.push(`s1:start:${item}`);
          return item;
        },
      ],
      { concurrency: 2 }, // both dispatched together
    );
    // item 1 enters stage 1 BEFORE item 0 finishes stage 0 -> no cross-item barrier between stages.
    expect(events.indexOf("s1:start:1")).toBeLessThan(events.indexOf("s0:end:0"));
  });

  it("a stage that throws: status='failed', error preserved, stage index recorded, remaining stages skipped", async () => {
    const ran: string[] = [];
    const outcomes = await pipeline<number, number>(
      [1, 2, 3],
      [
        async (_p, item) => {
          ran.push(`s0:${item}`);
          return item;
        },
        async (_p, item) => {
          ran.push(`s1:${item}`);
          if (item === 2) throw new Error("boom@s1");
          return item;
        },
        async (_p, item) => {
          ran.push(`s2:${item}`);
          return item;
        },
      ],
      { concurrency: 3 },
    );
    expect(outcomes.map((o) => o.status)).toEqual(["ok", "failed", "ok"]);
    const failed = outcomes[1]!;
    expect(failed.status).toBe("failed");
    if (failed.status === "failed") {
      expect((failed.error as Error).message).toBe("boom@s1");
      expect(failed.stage).toBe(1); // failed at stage index 1
    }
    expect(ran).not.toContain("s2:2"); // stage 2 NOT run for the failed item
    expect(ran).toContain("s2:1"); // but other items run all stages
    expect(ran).toContain("s2:3");
  });

  it("MUST-SETTLE: every item gets exactly one outcome, no holes, no duplicates", async () => {
    const outcomes = await pipeline<number, number>(
      [0, 1, 2, 3, 4],
      [
        async (_p, item) => item,
        async (_p, item) => {
          if (item % 2 === 0) throw new Error(`fail ${item}`);
          return item;
        },
      ],
      { concurrency: 3 },
    );
    expect(outcomes).toHaveLength(5);
    expect(outcomes.every((o) => o !== undefined)).toBe(true);
    expect(outcomes.map((o) => o.index)).toEqual([0, 1, 2, 3, 4]);
    expect(outcomes.map((o) => o.status)).toEqual(["failed", "ok", "failed", "ok", "failed"]);
  });

  it("budget stops dispatching once reached; cost reads the final value; remaining skipped:'budget'", async () => {
    const costSeen: Array<[number, number]> = [];
    const outcomes = await pipeline<number, number>(
      [1, 2, 3, 4],
      [async (_p, item) => item, async (prev) => (prev as number) * 100],
      {
        concurrency: 1,
        budget: {
          total: 2,
          cost: (value, item) => {
            costSeen.push([value, item]);
            return 1; // each ok costs 1
          },
        },
      },
    );
    expect(outcomes.map((o) => o.status)).toEqual(["ok", "ok", "skipped", "skipped"]);
    const skipped = outcomes[2]!;
    if (skipped.status === "skipped") expect(skipped.reason).toBe("budget");
    expect(costSeen).toEqual([
      [100, 1],
      [200, 2],
    ]); // cost gets (final-stage value, original item)
  });

  it("failed items do NOT consume budget", async () => {
    const outcomes = await pipeline<number, number>(
      [0, 1, 2, 3, 4],
      [
        async (_p, item) => {
          if (item < 2) throw new Error("fail"); // first two fail at stage 0
          return item;
        },
      ],
      { concurrency: 1, budget: { total: 2, cost: () => 1 } },
    );
    // 0,1 fail (no spend); 2 ok(spent1) 3 ok(spent2) 4 skipped(spent>=2)
    expect(outcomes.map((o) => o.status)).toEqual(["failed", "failed", "ok", "ok", "skipped"]);
  });

  it("abort stops dispatching NEW items; an already-dispatched item runs ALL its remaining stages", async () => {
    const ac = new AbortController();
    const ran: string[] = [];
    const outcomes = await pipeline<number, number>(
      [1, 2, 3],
      [
        async (_p, item) => {
          if (item === 1) ac.abort(); // abort DURING item 1's first stage
          ran.push(`s0:${item}`);
          return item;
        },
        async (_p, item) => {
          ran.push(`s1:${item}`);
          return item * 10;
        },
      ],
      { concurrency: 1, signal: ac.signal },
    );
    expect(outcomes[0]!.status).toBe("ok"); // item 1 not mis-marked skipped
    if (outcomes[0]!.status === "ok") expect(outcomes[0]!.value).toBe(10);
    expect(ran).toContain("s1:1"); // completed its remaining stage despite abort
    expect(outcomes[1]!.status).toBe("skipped"); // items 2,3 never dispatched
    expect(outcomes[2]!.status).toBe("skipped");
    const s = outcomes[1]!;
    if (s.status === "skipped") expect(s.reason).toBe("aborted");
  });

  it("a pre-aborted signal dispatches nothing — all skipped:'aborted', no stage runs", async () => {
    const ac = new AbortController();
    ac.abort();
    let ran = 0;
    const outcomes = await pipeline<number, number>(
      [1, 2, 3],
      [
        async (_p, item) => {
          ran++;
          return item;
        },
      ],
      { concurrency: 2, signal: ac.signal },
    );
    expect(ran).toBe(0);
    expect(outcomes.map((o) => o.status)).toEqual(["skipped", "skipped", "skipped"]);
  });

  it("reports progress per settled item, ending at done===total with cumulative spent", async () => {
    const dones: number[] = [];
    const spents: number[] = [];
    await pipeline<number, number>([1, 2, 3], [async (_p, item) => item], {
      concurrency: 1,
      budget: { total: 1, cost: () => 1 },
      onProgress: (p) => {
        dones.push(p.done);
        spents.push(p.spent);
      },
    });
    expect(dones).toEqual([1, 2, 3]); // every item (incl. skipped) reports progress
    expect(spents.at(-1)).toBe(1); // one ok billed 1; rest skipped, spent stays 1
  });

  it("never exceeds the concurrency limit (items in flight)", async () => {
    let inFlight = 0;
    let maxSeen = 0;
    await pipeline<number, number>(
      [1, 2, 3, 4, 5, 6],
      [
        async (_p, item) => {
          inFlight++;
          maxSeen = Math.max(maxSeen, inFlight);
          await delay(5);
          return item;
        },
        async (_p, item) => {
          await delay(3);
          inFlight--;
          return item;
        },
      ],
      { concurrency: 2 },
    );
    expect(maxSeen).toBe(2);
  });

  it("clamps concurrency to [1, items.length]", async () => {
    const a = await pipeline<number, number>([1, 2], [async (_p, n) => n], { concurrency: 0 });
    expect(a.map((o) => o.status)).toEqual(["ok", "ok"]);

    let inFlight = 0;
    let maxSeen = 0;
    const b = await pipeline<number, number>(
      [1, 2, 3],
      [
        async (_p, n) => {
          inFlight++;
          maxSeen = Math.max(maxSeen, inFlight);
          await delay(3);
          inFlight--;
          return n;
        },
      ],
      { concurrency: 100 },
    );
    expect(b.map((o) => o.status)).toEqual(["ok", "ok", "ok"]);
    expect(maxSeen).toBe(3); // clamped to item count
  });

  it("handles an empty work-list", async () => {
    const outcomes = await pipeline<number, number>([], [async (_p, n) => n], { concurrency: 4 });
    expect(outcomes).toEqual([]);
  });

  it("empty stages array is an identity passthrough: value === item", async () => {
    const outcomes = await pipeline<number, number>([5, 6], [], { concurrency: 2 });
    expect(outcomes.map((o) => o.status)).toEqual(["ok", "ok"]);
    expect(outcomes.map((o) => (o.status === "ok" ? o.value : null))).toEqual([5, 6]);
  });

  it("preserves a non-Error throw verbatim (error: unknown is not wrapped)", async () => {
    const outcomes = await pipeline<number, number>(
      [1, 2],
      [
        async (_p, item) => {
          if (item === 1) throw "string-thrown"; // eslint-disable-line no-throw-literal
          return item;
        },
      ],
      { concurrency: 2 },
    );
    const f = outcomes[0]!;
    expect(f.status).toBe("failed");
    if (f.status === "failed") {
      expect(f.error).toBe("string-thrown"); // not wrapped
      expect(f.stage).toBe(0);
    }
  });

  it("a single stage behaves like parallel (value === stage output)", async () => {
    const outcomes = await pipeline<number, number>([1, 2, 3], [async (_p, n) => n * 10], {
      concurrency: 2,
    });
    expect(outcomes.map((o) => (o.status === "ok" ? o.value : null))).toEqual([10, 20, 30]);
  });

  it("MUST-SETTLE at scale: 100 items through 3 stages, random failures, small concurrency", async () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const outcomes = await pipeline<number, number>(
      items,
      [
        async (_p, n) => n,
        async (prev, n) => {
          if (n % 7 === 0) throw new Error(`fail@s1 ${n}`);
          return (prev as number) + 1;
        },
        async (prev, n) => {
          if (n % 11 === 0) throw new Error(`fail@s2 ${n}`);
          return (prev as number) + 1;
        },
      ],
      { concurrency: 4 },
    );
    expect(outcomes).toHaveLength(100);
    expect(outcomes.every((o) => o !== undefined)).toBe(true);
    expect(outcomes.map((o) => o.index)).toEqual(items);
    // every multiple of 7 fails at stage 1; multiples of 11 (not already-7-failed) fail at stage 2
    const failedAt1 = outcomes.filter((o) => o.status === "failed" && o.stage === 1);
    expect(failedAt1.every((o) => o.index % 7 === 0)).toBe(true);
    expect(outcomes.every((o) => o.status === "ok" || o.status === "failed")).toBe(true);
  });
});
