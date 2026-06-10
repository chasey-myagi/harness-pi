/**
 * postCompactFileReread —— 压缩后文件重读（C4，docs/09 §4.2）。**opt-in、默认关**。
 *
 * **问题**：compactSummarize / autoCompaction 把早期消息（含 `read` 的完整文件输出）压成一条 summary
 * 后，模型 view 里只剩对文件的**摘要描述**，丢了**逐字内容**；若文件在此期间又被 edit/write 改过，summary
 * 还可能**过时**。下一轮模型据此推理就是看着陈旧/有损的文件状态。
 *
 * **做法**：压缩发生的**下一个 turn 开始**时，从最近消息里收集被 read/edit/write 引用过的文件路径，用调用方
 * 注入的 `fileContentProvider` 取**当前**内容，经 `additionalContext`（transient attachment）注入——让模型在
 * 压缩后立刻重新看到关键文件的现状。**bounded**：`maxFiles` + 每文件 `maxBytes`，避免把刚省下的 token 又灌回去。
 *
 * **与压缩插件的协作（顺序契约）**：
 *   - 压缩插件在 `transformMessagesBeforeLlm` 里产生 compacted view 时，会 `ctx.state.set` 一个待重读标记
 *     （`post-compact-file-reread.pending` = 压缩发生的 turnIdx）。本插件在**下一个** `onTurnStart` 读到该标记 →
 *     注入一次 → 清标记。故**每次压缩只重读一次**，不会每 turn 重复注入。
 *   - core 不知道 `read` 工具长什么样 → 路径解析（`fileContentProvider`）由调用方注入；返回 `null` = 跳过该文件
 *     （已删除 / 越权 / 不该重读）。
 *   - 与压缩插件**搭配使用**：单挂本插件而不挂任何压缩插件时，标记永不被 set，本插件**零注入**（纯 no-op）。
 */

import type { Hook, HookContext, Message } from "@harness-pi/core";

/* ── 在 core 的 HookStateRegistry 上 augment 压缩↔重读之间的协作 key ── */
declare module "@harness-pi/core" {
  interface HookStateRegistry {
    /** 压缩插件 set = 「本 turn 发生了压缩」的 turnIdx；postCompactFileReread 在下一 turn 消费并清除。 */
    "post-compact-file-reread.pending": number;
  }
}

/** 压缩↔重读协作 state key（导出供压缩插件 set、测试断言）。 */
export const POST_COMPACT_PENDING_KEY = "post-compact-file-reread.pending";

export interface PostCompactFileRereadOptions {
  /**
   * 路径 → 当前内容解析器（调用方注入；core 不知道 `read` 的实现）。返回 `null` = 跳过该文件
   * （已删除 / 越权 / 不重读）。可 async。
   */
  fileContentProvider: (path: string) => Promise<string | null>;
  /** 最多重读几个文件（取最近被引用的）。默认 5，须 ≥ 1。 */
  maxFiles?: number;
  /** 每个文件最多注入多少字节（超出截断并标注）。默认 8192，须 ≥ 1。 */
  maxBytes?: number;
  /**
   * 视为「文件操作」、其 `path` 参数要被收集的工具名。默认 `["read", "edit", "write"]`（first-party tools）。
   * 自定义工具集时覆盖。
   */
  toolNames?: string[];
  /** tool 参数里承载文件路径的字段名。默认 `"path"`（first-party tools 用 `path`）。 */
  pathArg?: string;
}

/**
 * 从消息序列里收集被文件工具引用过的路径，**保留最近引用优先**、去重。
 * 扫 assistant 消息里的 toolCall（`name ∈ toolNames` 且 `arguments[pathArg]` 是非空 string）。
 * 倒序遍历 → 最近引用的文件排前面，配合 `maxFiles` 截断时保留「最相关」的那批。
 */
function collectPaths(
  messages: ReadonlyArray<Message>,
  toolNames: ReadonlySet<string>,
  pathArg: string,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m === undefined || m.role !== "assistant" || typeof m.content === "string")
      continue;
    for (const b of m.content) {
      if (b.type !== "toolCall" || !toolNames.has(b.name)) continue;
      const p = b.arguments[pathArg];
      if (typeof p !== "string" || p.length === 0 || seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

export function postCompactFileReread(
  opts: PostCompactFileRereadOptions,
): Hook {
  const maxFiles = opts.maxFiles ?? 5;
  if (maxFiles < 1) {
    throw new Error("postCompactFileReread: maxFiles must be >= 1");
  }
  const maxBytes = opts.maxBytes ?? 8192;
  if (maxBytes < 1) {
    throw new Error("postCompactFileReread: maxBytes must be >= 1");
  }
  const toolNames = new Set(opts.toolNames ?? ["read", "edit", "write"]);
  const pathArg = opts.pathArg ?? "path";

  return {
    name: "postCompactFileReread",

    async onTurnStart(_input, ctx: HookContext) {
      // 仅在「上一 turn 发生了压缩」时重读一次。无标记（没挂压缩插件 / 本 turn 没压缩）→ 纯 no-op。
      if (!ctx.state.has(POST_COMPACT_PENDING_KEY)) return;
      ctx.state.delete(POST_COMPACT_PENDING_KEY); // 消费即清，避免每 turn 重复注入

      const paths = collectPaths(ctx.messages, toolNames, pathArg).slice(0, maxFiles);
      if (paths.length === 0) return;

      const blocks: string[] = [];
      for (const p of paths) {
        // provider 抛错不该拖垮整个 turn——记一笔、跳过该文件（其余文件照常重读）。
        let content: string | null;
        try {
          content = await opts.fileContentProvider(p);
        } catch (err) {
          ctx.log.warn("postCompactFileReread: provider failed", {
            path: p,
            err: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        if (content === null) continue; // null = 跳过该文件
        let body = content;
        let truncated = "";
        if (Buffer.byteLength(body, "utf8") > maxBytes) {
          // 按字节上界截断到 maxBytes。注意：在多字节 UTF-8 字符中间切会让末尾出现一个替换字符
          // （U+FFFD）——注入内容是给模型看的 advisory，可接受；故不保证截断点落在码点边界。
          body = Buffer.from(body, "utf8").subarray(0, maxBytes).toString("utf8");
          truncated = `\n[truncated to ${maxBytes} bytes]`;
        }
        blocks.push(`<file path="${p}">\n${body}${truncated}\n</file>`);
      }
      if (blocks.length === 0) return;

      return {
        additionalContext: `Current contents of files referenced before compaction (re-read so you see their up-to-date state):\n${blocks.join(
          "\n",
        )}`,
      };
    },
  };
}
