import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** 候选文件名，按优先级排列：CLAUDE.md 优先，其次 AGENTS.md。 */
const CANDIDATE_NAMES = ["CLAUDE.md", "AGENTS.md"] as const;

export interface ProjectInstructions {
  content: string;
  sourcePath: string;
}

/**
 * 从 `startDir` 向上查找 CLAUDE.md 或 AGENTS.md，找到第一个即返回内容与路径。
 * 找不到返回 null（静默回落，不报错）。
 */
export function loadProjectInstructions(startDir: string): ProjectInstructions | null {
  let dir = startDir;
  while (true) {
    for (const name of CANDIDATE_NAMES) {
      const candidate = join(dir, name);
      try {
        const content = readFileSync(candidate, "utf8");
        return { content, sourcePath: candidate };
      } catch {
        // 文件不存在或不可读，继续尝试
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break; // 已到文件系统根
    dir = parent;
  }
  return null;
}
