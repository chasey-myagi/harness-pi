/**
 * NdjsonFileSink —— 把 events 批写到本地 NDJSON 文件。
 * 零外部依赖；适合本地开发 / 容器化挂载 volume。
 */

import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import { BatchingSink, type BatchingSinkOptions } from "../batching-sink.js";
import type { MetricEvent } from "../types.js";

export interface NdjsonFileSinkOptions extends BatchingSinkOptions {
  path: string;
}

export class NdjsonFileSink extends BatchingSink {
  private stream: WriteStream;

  constructor(opts: NdjsonFileSinkOptions) {
    super(opts);
    try {
      mkdirSync(dirname(opts.path), { recursive: true });
    } catch {
      /* ignore */
    }
    this.stream = createWriteStream(opts.path, { flags: "a" });
    this.stream.on("error", (err) => {
      this._stats.lastError = err.message;
    });
  }

  protected async write(batch: MetricEvent[]): Promise<void> {
    if (batch.length === 0) return;
    const lines = batch.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await new Promise<void>((resolve, reject) => {
      this.stream.write(lines, (err) => (err ? reject(err) : resolve()));
    });
  }

  protected override async cleanup(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.stream.end(() => resolve());
    });
  }
}
