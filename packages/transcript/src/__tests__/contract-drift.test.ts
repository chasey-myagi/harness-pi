import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * 验证**两道守门人本身有效**——不是验证它们存在。
 *
 * 本包交付的是「保证机制」，所以每条保证都要有一条测试证明它在被绕过时会红：
 *
 * | 保证 | 绕过方式 | 挡它的测试 |
 * | --- | --- | --- |
 * | 双向断言 | 断言被掏空（留注释、删声明） | 「断言声明齐全」（AST 解析） |
 * | 双向断言 | `typecheck` 脚本退回单段形式 | 「typecheck 脚本串联三个 tsconfig」 |
 * | 双向断言 | `tsconfig.typecheck.json` 的 `exclude: []` 被删 | 「断言文件在 typecheck program 里」（`--listFiles`） |
 * | browser 门 | `types` 放宽 / `lib` 改动 | fixture 05（`extends` 真配置） |
 * | browser 门 | `exclude` 被放空，测试文件带进 `@types/node` | 「browser program 不含 node 类型」（`--listFiles`） |
 */

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSC = join(PKG_ROOT, "node_modules", ".bin", "tsc");
const ASSERT_FILE = join(PKG_ROOT, "src", "contract", "__typecheck__", "core-mirror.assert.ts");

interface TscRun {
  status: number | null;
  output: string;
}

function runTsc(project: string, extraArgs: string[] = []): TscRun {
  const r = spawnSync(TSC, ["-p", project, ...extraArgs], {
    cwd: PKG_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024, // --listFiles 会吐出几千行
  });
  if (r.error) throw r.error;
  return { status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** tsc 因诊断退出时 status 是 1/2；被信号杀掉时是 null——后者不该被当成「漂移被抓住」。 */
function expectExitedWithDiagnostics(r: TscRun, context: string): void {
  expect(typeof r.status, `tsc 未正常退出（可能被信号杀掉）：${context}\n${r.output}`).toBe("number");
  expect(r.status, `期望 tsc 因诊断而失败：${context}\n${r.output}`).not.toBe(0);
}

function expectCleanCompile(r: TscRun, context: string): void {
  // 不用 `toBe("")`：typescript 是 caret 区间，将来某版往 stdout 吐一句 deprecation
  // warning 会让这条假红。真正要断言的是「没有诊断」。
  expect(r.output, context).not.toMatch(/error TS\d+/);
  expect(r.status, `${context}\n${r.output}`).toBe(0);
}

/* ──────────────────── 正向对照 ──────────────────── */

describe("正向对照", () => {
  it("未经改动的镜像在 tsconfig.typecheck.json 下编译通过", () => {
    // 少了这条，四个 fixture 全失败也可能只是因为镜像本身写坏了，
    // 「fixture 失败」就不再是「断言有效」的证据。
    expectCleanCompile(runTsc("tsconfig.typecheck.json"), "断言本身应当编译干净");
  });

  it("runtime 图在 browser 配置下编译通过", () => {
    expectCleanCompile(runTsc("tsconfig.browser.json"), "runtime 图应当是 browser-safe 的");
  });
});

/* ──────────────────── 反例 fixture ──────────────────── */

interface DriftCase {
  dir: string;
  drift: string;
  /**
   * `tsc` 输出里必须出现的片段。光断言「非零退出」不够——import 路径写错也会非零退出。
   * 对 01-04 是失败方向（谁不可赋值给谁），对 05 是被拒绝的两个 node 全局。
   */
  expects: string[];
}

const FIXTURES: DriftCase[] = [
  {
    dir: "01-mirror-missing-arm",
    drift: "core 新增一个带新 discriminant 的 arm，镜像未跟上 → Core → Mirror 失败",
    expects: [
      "TS2322",
      "Type 'SessionEvent' is not assignable to type 'MirrorMissingOneArm'",
    ],
  },
  {
    dir: "02-mirror-extra-arm",
    drift: "镜像多出一个 core 没有的 arm → Mirror → Core 失败",
    expects: [
      "TS2322",
      "Type 'MirrorWithGhostArm' is not assignable to type 'SessionEvent'",
    ],
  },
  {
    dir: "03-mirror-missing-required-field",
    drift: "core 闭包内新增必填字段，镜像未跟上 → Mirror → Core 失败",
    expects: [
      "TS2322",
      "Type 'MirrorMissingRequiredField' is not assignable to type 'SessionEvent'",
    ],
  },
  {
    dir: "04-mirror-extra-required-field",
    drift: "core 闭包内删除字段，镜像仍保留 → Core → Mirror 失败",
    expects: [
      "TS2322",
      "Type 'SessionEvent' is not assignable to type 'MirrorWithExtraRequiredField'",
    ],
  },
  {
    dir: "05-node-global-probe",
    // 这条不是漂移反例，是 browser 门的判别力探针；但它和 01-04 是同一种东西
    // ——「守门人的守门人」——所以留在同一张表里。当初把它特判成单独的 describe，
    // 正是它顺手抄了一份 tsconfig 副本、从而守错门的成因。
    drift: "node 全局在真正的 browser 配置下必须被拒绝",
    expects: ["TS2591", "Cannot find name 'process'", "Cannot find name 'Buffer'"],
  },
];

describe.each(FIXTURES)("反例 fixture $dir", ({ dir, drift, expects }) => {
  it(`${drift}：tsc 必须非零退出`, () => {
    const r = runTsc(join("typecheck-fixtures", dir));
    expectExitedWithDiagnostics(r, dir);
    for (const fragment of expects) {
      expect(r.output, `期望输出含 ${JSON.stringify(fragment)}`).toContain(fragment);
    }
  });
});

it("fixture 05 继承真正的 tsconfig.browser.json，而不是手抄一份副本", () => {
  // 抄一份副本的话，改坏真配置时探针纹丝不动——守门人就守的是它自己。
  const cfg = JSON.parse(
    readFileSync(join(PKG_ROOT, "typecheck-fixtures", "05-node-global-probe", "tsconfig.json"), "utf8"),
  ) as { extends?: string; compilerOptions?: Record<string, unknown> };
  expect(cfg.extends).toBe("../../tsconfig.browser.json");
  expect(Object.keys(cfg.compilerOptions ?? {}), "lib / types 必须继承而非覆写").not.toContain("types");
  expect(Object.keys(cfg.compilerOptions ?? {})).not.toContain("lib");
});

/* ──────────────────── 断言不可被静默停编 ──────────────────── */

describe("双向断言真的挂在 typecheck 上", () => {
  it("断言文件在 tsconfig.typecheck.json 的 program 里", () => {
    // 这条挡的是「tsconfig.typecheck.json 的 exclude: [] 被删」——断言文件从此不被编译，
    // 而 tsc 依旧 exit 0、其余测试依旧全绿。
    const r = runTsc("tsconfig.typecheck.json", ["--listFiles", "--noEmit"]);
    expect(r.status).toBe(0);
    expect(r.output).toContain(join("src", "contract", "__typecheck__", "core-mirror.assert.ts"));
  });

  it("typecheck 脚本串联三个 tsconfig", () => {
    // 这条挡的是「统一风格」式重构把脚本退回其余 4 包的单段形式：
    // 单段的 `tsc -p . --noEmit` 跳过被 exclude 的断言目录，CI 的 pnpm -r typecheck 全绿。
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const script = pkg.scripts?.["typecheck"] ?? "";
    expect(script).toContain("tsconfig.typecheck.json");
    expect(script).toContain("tsconfig.browser.json");
  });

  it("browser program 不含 node 类型、测试文件与断言文件", () => {
    // 这条挡的是「tsconfig.browser.json 的 exclude 被放空」：__tests__ 里的
    // `import ... from "vitest"` 会经 vite 的 /// <reference types="node" /> 把
    // @types/node 隐式拉进 program，browser 门从此对 process / Buffer 放行。
    const r = runTsc("tsconfig.browser.json", ["--listFiles", "--noEmit"]);
    expect(r.status).toBe(0);
    const files = r.output.split("\n").filter((l) => l.trim().length > 0);
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter(
      (f) =>
        f.includes(join("@types", "node")) ||
        f.includes(join("node_modules", "vitest")) ||
        f.includes("__tests__") ||
        f.includes("__typecheck__"),
    );
    expect(offenders, "browser program 被污染——检查 tsconfig.browser.json 的 types / exclude").toEqual([]);
  });
});

/* ──────────────────── 断言不可被掏空 ──────────────────── */

describe("断言声明齐全", () => {
  /** 从断言文件里抽出所有 `const x: A = null as unknown as B` 的 (A, B) 对。 */
  function assertionPairs(): Array<[string, string]> {
    const sf = ts.createSourceFile(
      ASSERT_FILE,
      readFileSync(ASSERT_FILE, "utf8"),
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );
    const pairs: Array<[string, string]> = [];
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.type && node.initializer) {
        let init: ts.Expression = node.initializer;
        // 只取最外层 `as` 的目标类型：`null as unknown as CoreSessionEvent` → CoreSessionEvent
        if (ts.isAsExpression(init)) {
          pairs.push([node.type.getText(sf), init.type.getText(sf)]);
        }
        void init;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return pairs;
  }

  it("四条断言覆盖 {SessionEvent, LiveEvent} × {Core→Mirror, Mirror→Core}", () => {
    // 这条挡的是「断言被掏空」：删掉 4 条 const、保留文件头注释，tsc 照样 exit 0，
    // 5 个 fixture 照样非零退出（它们各自内联声明自己的断言），三条文档测试照样通过。
    // 整套测试全绿，而契约已死。
    const pairs = assertionPairs().map(([lhs, rhs]) => `${rhs} → ${lhs}`);
    expect(pairs).toEqual(
      expect.arrayContaining([
        "CoreSessionEvent → MirrorSessionEvent",
        "MirrorSessionEvent → CoreSessionEvent",
        "CoreLiveEvent → MirrorLiveEvent",
        "MirrorLiveEvent → CoreLiveEvent",
      ]),
    );
  });
});

/* ──────────────────── 盲区台账如实 ──────────────────── */

describe("断言文件如实记录盲区", () => {
  const source = readFileSync(ASSERT_FILE, "utf8");

  it.each([
    ["闭包内任意层级新增可选字段", "闭包内任意层级新增可选字段"],
    ["镜像多出 core 没有的可选字段", "镜像多出一个 core 没有的可选字段"],
    ["复用既有 discriminant 的兄弟 arm", "复用既有 discriminant"],
    ["readonly 修饰符漂移", "readonly"],
    ["arguments 的 any 盲区", "Record<string, any>"],
  ])("记录了盲区：%s", (_label, fragment) => {
    expect(source).toContain(fragment);
  });

  it("「新增 arm 一定抓得住」被收窄为「discriminant 是新的」", () => {
    // 未收窄的措辞是错的：union 可赋值判定按「可赋值给某个目标成员」结算，
    // 复用既有 discriminant 的新 arm 会被既有 arm 吞掉（实测两向 EXIT=0）。
    expect(source).toContain("且它的 discriminant 是新的");
  });

  it("声明这份清单是实测台账而非穷举证明", () => {
    expect(source).toContain("不是穷举证明");
  });
});
