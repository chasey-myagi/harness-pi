/**
 * 反例 05：**browser 门的判别力探针**。
 *
 * 这个文件用了两个 node 全局（`process` / `Buffer`）。在 `tsconfig.browser.json` 的同款配置
 * （`lib: ["ES2022","DOM"]` + `types: []`）下，它**必须**编译失败。
 *
 * 为什么需要它：`types: []` 只关闭「自动包含 `@types/*`」，**拦不住 `.d.ts` 里显式的**
 * `/// <reference types="node" />`。vite 的 `dist/node/index.d.ts` 就带这一行，因此只要
 * program 里混进任何 `import ... from "vitest"` 的文件，`process` / `Buffer` 就会解析成功、
 * 整道 browser 门恒真、失去判别力。本 fixture 就是那道门的守门人：它一旦变成零退出，说明
 * `tsconfig.browser.json` 的 `types` / `exclude` 被改坏了。
 *
 * 这里**故意不写** `@ts-expect-error`：本 fixture 靠 `tsc` 的非零退出码判定，
 * 抑制注释会把错误吞掉、让 fixture 恒绿。
 */
export const envValue = process.env["HARNESS_PI_BROWSER_PROBE"];

export const encoded = Buffer.from("harness-pi").toString("base64");
