/**
 * `/multi` 编排（纯逻辑，P6）：对一个**显式 work-list**（命令里 @ 提到的文件）做**有界并行扇出**——
 * 每个文件派一个 bounded 子代理跑同一条指令，按界并发、错误隔离、聚合回来。
 *
 * 这是 harness-pi「受控编排」的体现：扇出由 harness（而非模型）驱动、并发有上限、单项失败不拖垮整批。
 * 刻意只放纯逻辑（解析 + 并发池）；真正怎么跑一个子代理由 app/cli 注入 `runOne`（生产里是只读子代理）。
 */

/**
 * 解析 `/multi` 的参数串：@token 视作 work-list 目标，其余文字为指令。无目标返回 null。
 *
 * 只认**词首**的 @（前面是行首或空白）——这样 `user@example.com` 这类 email/handle 里的 @ 不会被
 * 误当文件目标。目标尾部的标点（逗号/句号/括号等）会被剥掉（`@a.ts,` → `a.ts`），并按文件去重。
 */
export function parseMultiCommand(
  rest: string,
): { instruction: string; targets: string[] } | null {
  const TOKEN = /(?:^|\s)@(\S+)/g;
  const raw = Array.from(rest.matchAll(TOKEN), (m) =>
    m[1]!.replace(/[),.;:]+$/, ""),
  ).filter((t) => t.length > 0);
  const targets = [...new Set(raw)]; // 去重：同一文件只派一个子代理
  if (targets.length === 0) return null;
  const instruction = rest.replace(TOKEN, " ").replace(/\s+/g, " ").trim();
  return { instruction, targets };
}

export interface MultiOutcome {
  target: string;
  ok: boolean;
  /** 子代理产出文本；失败时为错误信息。 */
  text: string;
}

export interface MultiProgress {
  target: string;
  phase: "start" | "done";
  ok?: boolean;
}

/**
 * 有界并行跑：对每个 target 调 `runOne`，最多 `concurrency` 个同时在跑。
 * - **错误隔离**：runOne 抛错 → 该项 {ok:false, text:错误信息}，不拖垮其余。
 * - **保序**：结果数组与 targets 同序（与完成先后无关）。
 * - **可取消**：signal 已 abort 时不再启新项（在跑的让其自然收尾）。
 */
export async function orchestrateMulti(
  targets: string[],
  runOne: (target: string, signal: AbortSignal) => Promise<{ ok: boolean; text: string }>,
  opts: {
    concurrency?: number;
    onProgress?: (ev: MultiProgress) => void;
    signal?: AbortSignal;
  } = {},
): Promise<MultiOutcome[]> {
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  const signal = opts.signal ?? new AbortController().signal;
  const results = new Array<MultiOutcome>(targets.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= targets.length) return;
      const target = targets[i]!;
      if (signal.aborted) {
        // 仅**尚未启动**的项打 "aborted" 哨兵；已在飞的项保留 runOne 自己的返回（取消靠 runOne 收到的
        // signal，是其职责），故被取消的整批摘要可能混着 "aborted" 与在飞项的部分文本——都 ok:false。
        results[i] = { target, ok: false, text: "aborted" };
        continue;
      }
      opts.onProgress?.({ target, phase: "start" });
      try {
        const r = await runOne(target, signal);
        results[i] = { target, ok: r.ok, text: r.text };
      } catch (err) {
        results[i] = {
          target,
          ok: false,
          text: err instanceof Error ? err.message : String(err),
        };
      }
      opts.onProgress?.({ target, phase: "done", ok: results[i]!.ok });
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, targets.length) }, () => worker()),
  );
  return results;
}

/** 单个子任务的指令：原指令 + 把范围锁到这一个文件，并明确这是只读分析（子代理无写权限）。 */
export function subTaskFor(instruction: string, target: string): string {
  const what = instruction.length > 0 ? instruction : "Review this file";
  return `${what}\n\nScope: read and analyze ONLY the file \`${target}\`. You are read-only and cannot edit; report findings/answer rather than attempting changes. Be concise.`;
}

/** 把一批结果折成一段 markdown 摘要（回灌进对话）。 */
export function formatMultiSummary(outcomes: ReadonlyArray<MultiOutcome>): string {
  const okN = outcomes.filter((o) => o.ok).length;
  const head = `**/multi** — ${okN}/${outcomes.length} succeeded`;
  const body = outcomes
    .map((o) => `\n\n### ${o.ok ? "✓" : "✗"} ${o.target}\n${o.text.trim()}`)
    .join("");
  return head + body;
}
