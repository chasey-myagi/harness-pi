// 刻意用 `export type *` 而非手工列名单：本包整个主题就是「手维护的清单必须由机器钉住」，
// 自己留一份漏了不报错的 re-export 清单说不过去。#166 / #167 往 core-mirror.ts 加类型时
// 无需同步本文件。
export type * from "./core-mirror.js";
export type * from "./watermark.js";
