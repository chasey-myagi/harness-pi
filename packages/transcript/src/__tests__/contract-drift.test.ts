import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 验证**双向断言本身有效**——不是验证断言存在，而是验证它真的会在漂移时构建失败。
 *
 * 每个 fixture 用类型手术在真实镜像上制造一种漂移，然后期望 `tsc` 非零退出。
 * 光断言「非零退出」不够：写错 import 路径也会非零退出。所以每条同时断言错误码与
 * **失败方向**（谁不可赋值给谁），fixture 才不会因为无关原因假通过。
 */

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSC = join(PKG_ROOT, "node_modules", ".bin", "tsc");

interface TscRun {
  status: number | null;
  output: string;
}

function runTsc(project: string): TscRun {
  const r = spawnSync(TSC, ["-p", project], {
    cwd: PKG_ROOT,
    encoding: "utf8",
    // tsc 把诊断写 stdout，但配置层面的错误（找不到 tsconfig 等）走 stderr，两个都要。
  });
  if (r.error) throw r.error;
  return { status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("双向断言的正向对照", () => {
  it("未经改动的镜像在 tsconfig.typecheck.json 下编译通过", () => {
    // 正向对照。少了这条，四个 fixture 全失败也可能只是因为镜像本身写坏了，
    // 「fixture 失败」就不再是「断言有效」的证据。
    const r = runTsc("tsconfig.typecheck.json");
    expect(r.output).toBe("");
    expect(r.status).toBe(0);
  });
});

interface DriftCase {
  /** fixture 目录名 */
  dir: string;
  /** 人类可读的漂移形态 */
  drift: string;
  /** 期望的 TS 错误码 */
  code: string;
  /**
   * 期望失败方向的判据：`tsc` 输出里必须出现的 `Type 'X' is not assignable to type 'Y'` 片段。
   * 用它把「因为漂移而失败」与「因为别的原因而失败」区分开。
   */
  direction: string;
}

const DRIFT_CASES: DriftCase[] = [
  {
    dir: "01-mirror-missing-arm",
    drift: "core 新增一个 arm，镜像未跟上 → Core → Mirror 失败",
    code: "TS2322",
    direction: "Type 'SessionEvent' is not assignable to type 'MirrorMissingOneArm'",
  },
  {
    dir: "02-mirror-extra-arm",
    drift: "镜像多出一个 core 没有的 arm → Mirror → Core 失败",
    code: "TS2322",
    direction: "Type 'MirrorWithGhostArm' is not assignable to type 'SessionEvent'",
  },
  {
    dir: "03-mirror-missing-required-field",
    drift: "core 某 arm 新增必填字段，镜像未跟上 → Mirror → Core 失败",
    code: "TS2322",
    direction: "Type 'MirrorMissingRequiredField' is not assignable to type 'SessionEvent'",
  },
  {
    dir: "04-mirror-extra-required-field",
    drift: "core 某 arm 删除字段，镜像仍保留 → Core → Mirror 失败",
    code: "TS2322",
    direction: "Type 'SessionEvent' is not assignable to type 'MirrorWithExtraRequiredField'",
  },
];

describe.each(DRIFT_CASES)("漂移反例 $dir", ({ dir, drift, code, direction }) => {
  it(`${drift}：tsc 必须非零退出`, () => {
    const r = runTsc(join("typecheck-fixtures", dir));
    expect(r.status, `期望 tsc 因漂移而失败，实际输出：\n${r.output}`).not.toBe(0);
    expect(r.output).toContain(code);
    expect(r.output).toContain(direction);
  });
});

describe("browser 门的判别力", () => {
  it("node 全局探针在 browser 配置下必须编译失败", () => {
    // 这条挡住的是「tsconfig.browser.json 恒真」这种静默失效：`types: []` 拦不住
    // .d.ts 里显式的 /// <reference types="node" />，一旦 exclude 被改坏，
    // browser 门就会对 process / Buffer 放行。
    const r = runTsc(join("typecheck-fixtures", "05-node-global-probe"));
    expect(r.status, `期望 browser 配置拒绝 node 全局，实际输出：\n${r.output}`).not.toBe(0);
    expect(r.output).toContain("TS2591");
    expect(r.output).toContain("Cannot find name 'process'");
    expect(r.output).toContain("Cannot find name 'Buffer'");
  });

  it("runtime 图在 browser 配置下编译通过", () => {
    const r = runTsc("tsconfig.browser.json");
    expect(r.output).toBe("");
    expect(r.status).toBe(0);
  });
});

describe("断言文件如实记录盲区", () => {
  const assertSource = readFileSync(
    join(PKG_ROOT, "src", "contract", "__typecheck__", "core-mirror.assert.ts"),
    "utf8",
  );

  it("记录了「core 新增可选字段」这一盲区", () => {
    expect(assertSource).toContain("core 某 arm 新增可选字段");
  });

  it("记录了「镜像多出可选字段」这一盲区——原 AC 漏掉的那种", () => {
    expect(assertSource).toContain("镜像多出一个 core 没有的可选字段");
  });

  it("记录了 arguments 是 any 造成的字段级盲区", () => {
    expect(assertSource).toContain("Record<string, any>");
  });
});
