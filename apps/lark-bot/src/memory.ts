/**
 * 自生长记忆：极简的 append-only markdown。bot 用 `remember` 工具往里沉淀（探到的资源位置、
 * 有效命令配方、主人偏好、被纠正后的正确做法…），每轮 LLM 调用前把全文注入 prompt。
 *
 * 刻意不做相关性检索 / 自动裁剪——先 load 全量，量真的大了再上 Engram 那套。文件是 markdown，
 * 人也能直接读和编辑。这是 bot「越用越聪明」的载体，不是我写死的地图。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const HEADER = [
  "# lark-bot 记忆",
  "",
  "bot 自己沉淀的：资源在哪、命令怎么拼、主人偏好。也可手动编辑。",
  "",
  "",
].join("\n");

export class MemoryStore {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  get path(): string {
    return this.file;
  }

  /** 当前记忆全文（无 / 读失败则空串）。 */
  load(): string {
    try {
      return existsSync(this.file) ? readFileSync(this.file, "utf8").trim() : "";
    } catch {
      return "";
    }
  }

  /** 追加一条沉淀（带 ISO 时间戳 + 可选 tag 的 markdown 项）。返回写入的那行（供工具回执）。 */
  append(note: string, tags: string[] = []): string {
    const clean = note.trim();
    if (clean.length === 0) return "";
    mkdirSync(dirname(this.file), { recursive: true });
    const tagStr = tags.length > 0 ? ` ${tags.map((t) => `#${t.trim()}`).join(" ")}` : "";
    const line = `- [${new Date().toISOString()}]${tagStr} ${clean}`;
    appendFileSync(this.file, `${existsSync(this.file) ? "" : HEADER}${line}\n`, "utf8");
    return line;
  }
}
