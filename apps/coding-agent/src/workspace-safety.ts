/**
 * Workspace 落盘安全守卫（#22）。
 *
 * coding-agent 默认把 **session log**（`.harness-pi/logs/*.ndjson`）与 **resume 存储**
 * （`.harness-pi/sessions/*.jsonl`）写在 cwd 的 `.harness-pi/` 下。前者的 tool args 默认已脱敏
 * （见 log-redaction.ts），但 resume 存储为了能正确**重放续跑**，必须保存**完整原文**消息历史
 * （含 write 文件内容、bash 命令等）——这是无法脱敏的（脱了 resume 就坏了）。
 *
 * 由于 agent 常跑在**任意用户 repo** 里，若该 repo 没把 `.harness-pi/` 加进 .gitignore，这些原文
 * 可能被误 `git add` / 提交进仓库。本模块在启动期做一次轻量检测并给出醒目告警（不改写用户的
 * .gitignore，只提示——是否忽略由用户决定）。
 */

import { execFileSync } from "node:child_process";

/**
 * `.harness-pi/` 是否被 `cwd` 的 git 忽略。
 * - `true`：已忽略（安全）。
 * - `false`：是 git 仓库但**未**忽略（泄漏面）。
 * - `null`：非 git 仓库 / git 不可用 —— 没有「被 git 提交」这条泄漏面，不告警。
 *
 * 探测的是 `.harness-pi/` **下的一个代表性子路径**（而非 `.harness-pi` 本身）：目录型 pattern
 * （`.harness-pi/`）只匹配目录，而 `git check-ignore .harness-pi` 在该目录尚不存在时不会判定为忽略；
 * 改查 `.harness-pi/<probe>` 则 `.harness-pi/`、`.harness-pi`、`/.harness-pi/` 等写法都能正确命中
 * （目录被忽略 ⇒ 其全部内容被忽略，正是 log/sessions 的实际落点）。
 * `git check-ignore -q`：exit 0=忽略、exit 1=未忽略、exit 128=非 git 仓库
 * （execFileSync 在非 0 退出时抛错，错误对象的 `status` 即退出码）。
 */
export function isHarnessPiGitIgnored(cwd: string): boolean | null {
  try {
    execFileSync("git", ["check-ignore", "-q", ".harness-pi/probe"], {
      cwd,
      stdio: "ignore",
    });
    return true; // exit 0 → 已忽略
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 1) return false; // 明确未忽略
    return null; // 128（非 git 仓库）/ ENOENT（无 git）等 → 无 git 泄漏面，不告警
  }
}

/**
 * 若 `cwd` 是 git 仓库且**未**忽略 `.harness-pi/`，返回一条醒目告警文案；否则返回 `null`。
 * 仅在 agent 确实会往 `.harness-pi/` 落盘（session log 或 resume 存储）时由调用方触发。
 */
export function harnessPiGitignoreWarning(cwd: string): string | null {
  if (isHarnessPiGitIgnored(cwd) !== false) return null;
  return (
    "'.harness-pi/' 未被 .gitignore 忽略：session log 与 resume 存储会在此保存完整对话历史" +
    "（resume 存储含 write 文件内容、bash 命令等**原文**，无法脱敏）。请把 '.harness-pi/' 加入 " +
    ".gitignore，以免敏感内容被误提交进仓库。"
  );
}
