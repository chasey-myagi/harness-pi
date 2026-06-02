/**
 * 最小 TUI 配色（自建，不引 pi-coding-agent 运行时）。纯 ANSI 颜色函数 + pi-tui 三个 theme 对象。
 * 故意精简：够 dogfood 用、可读即可，不做主题切换（pi-coding-agent 那套留作参考）。
 */

import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@mariozechner/pi-tui";

/** ANSI CSI 前缀（ESC + '['）。用 fromCharCode(27) 而非源码里塞不可见 ESC 字节，避免编辑时被破坏。 */
const CSI = `${String.fromCharCode(27)}[`;
const wrap =
  (open: string) =>
  (s: string): string =>
    `${CSI}${open}m${s}${CSI}0m`;

/** 基础 ANSI 颜色/样式函数。 */
export const color = {
  reset: (s: string): string => s,
  dim: wrap("2"),
  bold: wrap("1"),
  italic: wrap("3"),
  underline: wrap("4"),
  strike: wrap("9"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  magenta: wrap("35"),
  cyan: wrap("36"),
  gray: wrap("90"),
} as const;

export const selectListTheme: SelectListTheme = {
  selectedPrefix: color.cyan,
  selectedText: color.cyan,
  description: color.dim,
  scrollInfo: color.dim,
  noMatch: color.dim,
};

export const editorTheme: EditorTheme = {
  borderColor: color.gray,
  selectList: selectListTheme,
};

export const markdownTheme: MarkdownTheme = {
  heading: (t) => color.bold(color.cyan(t)),
  link: color.blue,
  linkUrl: color.dim,
  code: color.yellow,
  codeBlock: color.reset,
  codeBlockBorder: color.gray,
  quote: color.dim,
  quoteBorder: color.gray,
  hr: color.gray,
  listBullet: color.cyan,
  bold: color.bold,
  italic: color.italic,
  strikethrough: color.strike,
  underline: color.underline,
  codeBlockIndent: "  ",
};
