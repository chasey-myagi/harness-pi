/**
 * Tool output buffer —— session 级 ring buffer，按白名单 track 工具输出。
 *
 * 业务代码 / 其他 plugin 通过 `getToolOutputBuffer(ctx)` 读 buffer 做证据校验 / 重放等。
 * 三重淘汰：count / bytes / TTL，取最严触发。
 *
 * 详见 docs/05-plugins.md §5.4。
 */

import type { Hook, HookContext } from "@harness-pi/core";

declare module "@harness-pi/core" {
  interface HookStateRegistry {
    "tool-output-buffer.ring": RingBuffer;
  }
}

export interface ToolOutputBufferOptions {
  /** 白名单工具名（其他工具的输出不入 buffer）。 */
  track: string[];
  /** 容量上限。 */
  maxEntries?: number;
  /** 字节上限（所有 entries content 长度加起来）。 */
  maxBytes?: number;
  /** TTL ms。 */
  ttlMs?: number;
}

export interface BufferEntry {
  toolName: string;
  args: Record<string, unknown>;
  output: string;
  ts: number;
}

const KEY = "tool-output-buffer.ring" as const;

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_TTL_MS = 15 * 60 * 1000;

export function toolOutputBuffer(opts: ToolOutputBufferOptions): Hook {
  const trackSet = new Set(opts.track);
  const config: Required<ToolOutputBufferOptions> = {
    track: opts.track,
    maxEntries: opts.maxEntries ?? DEFAULT_MAX_ENTRIES,
    maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES,
    ttlMs: opts.ttlMs ?? DEFAULT_TTL_MS,
  };

  return {
    name: "tool-output-buffer",
    timeout: 50,

    onSessionStart(_input, ctx) {
      ctx.state.set(KEY, new RingBuffer(config));
    },

    onPostToolUse(input, ctx) {
      if (!trackSet.has(input.call.name)) return;
      const buf = ctx.state.get(KEY);
      if (!buf) return;
      const text = input.result.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      buf.push({
        toolName: input.call.name,
        args: input.call.arguments,
        output: text,
        ts: Date.now(),
      });
    },

    onSessionEnd(_input, ctx) {
      const buf = ctx.state.get(KEY);
      buf?.clear();
      ctx.state.delete(KEY);
    },
  };
}

export function getToolOutputBuffer(ctx: HookContext): RingBuffer | undefined {
  return ctx.state.get(KEY);
}

export class RingBuffer {
  private entries: BufferEntry[] = [];
  private totalBytes = 0;
  constructor(private readonly opts: Required<ToolOutputBufferOptions>) {}

  push(e: BufferEntry): void {
    this.entries.push(e);
    this.totalBytes += e.output.length;
    this.evict();
  }

  private evict(): void {
    const now = Date.now();
    while (this.entries.length > 0) {
      const head = this.entries[0];
      if (!head) break;
      if (now - head.ts <= this.opts.ttlMs) break;
      this.entries.shift();
      this.totalBytes -= head.output.length;
    }
    while (
      this.entries.length > this.opts.maxEntries ||
      this.totalBytes > this.opts.maxBytes
    ) {
      const head = this.entries.shift();
      if (!head) break;
      this.totalBytes -= head.output.length;
    }
  }

  clear(): void {
    this.entries = [];
    this.totalBytes = 0;
  }

  snapshot(): ReadonlyArray<BufferEntry> {
    return [...this.entries];
  }

  find(predicate: (e: BufferEntry) => boolean): BufferEntry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e && predicate(e)) return e;
    }
    return undefined;
  }

  size(): number {
    return this.entries.length;
  }

  bytes(): number {
    return this.totalBytes;
  }
}
