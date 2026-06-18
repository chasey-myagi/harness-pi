import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { dirname, join } from "node:path";

/** 候选文件名，按优先级排列：CLAUDE.md 优先，其次 AGENTS.md。 */
const CANDIDATE_NAMES = ["CLAUDE.md", "AGENTS.md"] as const;
export const PROJECT_INSTRUCTIONS_MAX_BYTES = 64 * 1024;

export interface ProjectInstructions {
  content: string;
  sourcePath: string;
}

function readInstructionFile(path: string): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(PROJECT_INSTRUCTIONS_MAX_BYTES + 1);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    const truncated = bytesRead > PROJECT_INSTRUCTIONS_MAX_BYTES;
    const content = buffer
      .subarray(0, Math.min(bytesRead, PROJECT_INSTRUCTIONS_MAX_BYTES))
      .toString("utf8");
    if (!truncated) return content;
    return [
      content,
      "",
      `[Project instructions truncated to ${PROJECT_INSTRUCTIONS_MAX_BYTES} bytes.]`,
      "",
    ].join("\n");
  } finally {
    closeSync(fd);
  }
}

/**
 * 从 `startDir` 向上查找 CLAUDE.md 或 AGENTS.md，找到第一个即返回内容与路径。
 * 找不到返回 null（静默回落，不报错）。
 */
export function loadProjectInstructions(startDir: string): ProjectInstructions | null {
  const homeDir = process.env.HOME;
  let dir = startDir;
  while (true) {
    if (homeDir && dir === homeDir) break;

    for (const name of CANDIDATE_NAMES) {
      const candidate = join(dir, name);
      try {
        const content = readInstructionFile(candidate);
        if (content.trim().length === 0) continue;
        return { content, sourcePath: candidate };
      } catch {
        // 文件不存在或不可读，继续尝试
      }
    }
    if (existsSync(join(dir, ".git"))) break;
    const parent = dirname(dir);
    if (parent === dir) break; // 已到文件系统根
    dir = parent;
  }
  return null;
}
