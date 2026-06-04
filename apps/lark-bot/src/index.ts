#!/usr/bin/env node
/**
 * lark-bot 入口：装配配置 → 起 bot → 常驻。SIGINT/SIGTERM 优雅退出。
 */

import { loadConfig } from "./config.js";
import { LarkBot } from "./bot.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const bot = new LarkBot(cfg); // resolveModel 可能在此 throw（缺 key/未知 model）

  const ac = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      console.error(`[lark-bot] ${sig} received, shutting down…`);
      ac.abort();
    });
  }

  await bot.start(ac.signal);
}

main().catch((err: unknown) => {
  console.error(`[lark-bot] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
