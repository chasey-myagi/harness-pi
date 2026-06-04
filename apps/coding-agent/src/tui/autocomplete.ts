/**
 * 输入框补全 provider。pi-tui 的 CombinedAutocompleteProvider 的 `@` 文件补全**只走 fd**——没装 fd
 * 就完全没补全。这里包一层：探测到 fd 就直接用原生（快、含 .gitignore）；没 fd 时给 `@` 加一个
 * readdir 回退，让 `@` 在任何机器上都能补全文件路径。`/` 命令补全是纯内存的，一直可用。
 *
 * 回退项的形状严格对齐 pi-tui 的契约：`@` 补全里 applyCompletion 用 `beforePrefix + item.value`
 * 重建该行，且 value 必须**自带 `@`**（见 pi-tui autocomplete.js buildCompletionValue / applyCompletion）。
 */

import { readdirSync, type Dirent } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import {
  CombinedAutocompleteProvider,
  fuzzyFilter,
  type AutocompleteItem,
  type AutocompleteProvider,
} from "@earendil-works/pi-tui";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  ".harness-pi",
  ".next",
  "coverage",
  ".turbo",
]);

/** 探测 fd 二进制路径（fd 或 fdfind）；没有返回 null。which 可注入便于测试。 */
export function resolveFdPath(which: (bin: string) => string | null = whichSync): string | null {
  for (const bin of ["fd", "fdfind"]) {
    const p = which(bin);
    if (p) return p;
  }
  return null;
}

function whichSync(bin: string): string | null {
  try {
    const p = execFileSync("which", [bin], { encoding: "utf8" }).trim();
    return p.length > 0 ? p : null;
  } catch {
    return null;
  }
}

/** 有界递归列出 cwd 下的文件相对路径（跳过重目录与点目录），给 `@` 补全的 readdir 回退用。 */
export function listFilesUnder(
  cwd: string,
  opts: { maxFiles?: number; maxDepth?: number } = {},
): string[] {
  const maxFiles = opts.maxFiles ?? 4000;
  const maxDepth = opts.maxDepth ?? 8;
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (out.length >= maxFiles || depth > maxDepth) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 读不了的目录跳过
    }
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        walk(join(dir, e.name), depth + 1);
      } else if (e.isFile()) {
        out.push(relative(cwd, join(dir, e.name)));
      }
    }
  };
  walk(cwd, 0);
  return out;
}

/** 把候选文件按 query 模糊排序，折成 pi-tui AutocompleteItem（value 自带 `@`，对齐 applyCompletion）。 */
export function atFileSuggestions(query: string, files: string[], max = 30): AutocompleteItem[] {
  const ranked = query.length > 0 ? fuzzyFilter(files, query, (f) => f) : files;
  return ranked.slice(0, max).map((f) => ({
    value: f.includes(" ") ? `@"${f}"` : `@${f}`,
    label: f.split("/").pop() ?? f,
    description: f,
  }));
}

/**
 * 造输入框补全 provider。有 fd → 直接用原生 CombinedAutocompleteProvider；没 fd → 包一层给 `@` 加
 * readdir 回退。`detectFd` 可注入便于测试。
 */
export function createAutocompleteProvider(
  commands: ReadonlyArray<{ name: string; description: string; argumentHint?: string }>,
  cwd: string,
  detectFd: () => string | null = resolveFdPath,
): AutocompleteProvider {
  const fdPath = detectFd();
  const inner = new CombinedAutocompleteProvider([...commands], cwd, fdPath);
  if (fdPath) return inner; // 有 fd：原生 `@` 补全直接可用

  let cache: string[] | null = null;
  const files = (): string[] => (cache ??= listFilesUnder(cwd));
  return {
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      // 先让原生处理（/ 命令、裸路径等都照常）；只有它对 `@` 返回 null 时才用 readdir 回退。
      const native = await inner.getSuggestions(lines, cursorLine, cursorCol, options);
      if (native) return native;
      const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
      const m = /(?:^|\s)(@\S*)$/.exec(before);
      if (!m) return null;
      const atPrefix = m[1]!;
      const items = atFileSuggestions(atPrefix.slice(1), files());
      return items.length > 0 ? { items, prefix: atPrefix } : null;
    },
    // 文本重建/光标逻辑全交回原生（最易错的部分），回退项形状已对齐其契约。
    applyCompletion: (lines, cl, cc, item, prefix) =>
      inner.applyCompletion(lines, cl, cc, item, prefix),
    shouldTriggerFileCompletion: (lines, cl, cc) =>
      inner.shouldTriggerFileCompletion(lines, cl, cc),
  };
}
