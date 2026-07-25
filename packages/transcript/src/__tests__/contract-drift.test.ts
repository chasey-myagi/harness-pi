import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * 验证**守门人本身有效**——不是验证它们存在。
 *
 * 最强的一条是「注入式变异」：把 `src/contract/` 整树复制出去、在副本的镜像上制造真实漂移、
 * 连同**真实的**断言文件一起编译，断言非零退出。它证明的是「这个断言文件此刻真的在约束镜像」，
 * 因而一并堵死所有静态检查堵不住的假绿——`// @ts-nocheck`、给每条声明加 `// @ts-ignore`、
 * 把 `CoreSessionEvent` 别名改指镜像自己……这些都会让变异不再被抓，于是测试变红。
 *
 * 其余守门测试各自挡一条更廉价的失效路径：
 *
 * | 保证 | 绕过方式 | 挡它的测试 |
 * | --- | --- | --- |
 * | 双向断言 | 抑制注释 / 别名改指自己 / 声明被删 | 注入式变异（决定性） |
 * | 双向断言 | 抑制指令（更早、更清楚的报错） | 「断言文件无抑制指令」 |
 * | 双向断言 | import 改指别处 | 「断言确实从内核 import」 |
 * | browser 门 | `types` / `lib` 放宽 | fixture 05（`extends` 真配置） |
 * | browser 门 | `exclude` 放空，测试文件带进 `@types/node` | 「browser program 不含 node 类型」 |
 * | browser 门 | `typecheck` 脚本吞掉中段失败 | 「typecheck 脚本以 && 串联两段」 |
 */

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSC = join(PKG_ROOT, "node_modules", ".bin", "tsc");
const CONTRACT_DIR = join(PKG_ROOT, "src", "contract");
const ASSERT_REL = join("contract", "__typecheck__", "core-mirror.assert.ts");
const ASSERT_FILE = join(PKG_ROOT, "src", ASSERT_REL);
/** 注入式变异的临时目录。落在包根、已进 .gitignore；每条测试自建，afterAll 兜底清理。 */
const MUT_DIR = join(PKG_ROOT, ".mutation-tmp");

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

/* ──────────────────── 注入式变异：决定性的一条 ──────────────────── */

/** 把 `src/contract/` 整树复制到 `.mutation-tmp/`，可选地改写镜像源码，然后编译副本。 */
function compileContractCopy(mutate?: (mirrorSource: string) => string): TscRun {
  rmSync(MUT_DIR, { recursive: true, force: true });
  cpSync(CONTRACT_DIR, join(MUT_DIR, "contract"), { recursive: true });
  if (mutate) {
    const mirrorPath = join(MUT_DIR, "contract", "core-mirror.ts");
    const before = readFileSync(mirrorPath, "utf8");
    const after = mutate(before);
    // 替换串没匹配上时必须炸，否则「变异未生效」会伪装成「守门人有效」。
    // 这个坑真踩过：模式写成 `; }` 而实际是 `; number }`，一次假通过。
    if (after === before) throw new Error("变异未生效：替换串没匹配上，测试会假通过");
    writeFileSync(mirrorPath, after);
  }
  writeFileSync(
    join(MUT_DIR, "tsconfig.json"),
    JSON.stringify(
      {
        extends: "../../../tsconfig.base.json",
        compilerOptions: { noEmit: true },
        include: ["contract/**/*"],
      },
      null,
      2,
    ),
  );
  return runTsc(".mutation-tmp");
}

afterAll(() => {
  rmSync(MUT_DIR, { recursive: true, force: true });
});

describe("注入式变异：断言此刻真的在约束镜像", () => {
  it("对照组：未变异的副本编译干净", () => {
    // 少了这条，下面两条全失败也可能只是因为复制/tsconfig 搭错了。
    expectCleanCompile(compileContractCopy(), "未变异的 contract 副本应当编译干净");
  });

  it("镜像删掉一个 arm → 断言文件报错", () => {
    // 这一条同时堵死所有静态检查堵不住的假绿：`@ts-nocheck`、逐条 `@ts-ignore`、
    // 把 CoreSessionEvent 别名改指镜像自己——任何一种都会让这次变异不再被抓。
    const r = compileContractCopy((src) =>
      src.replace('  | { type: "continuation-check"; turns: number; continuations: number }\n', ""),
    );
    expectExitedWithDiagnostics(r, "删 arm 后断言应当失败");
    expect(r.output, "报错必须落在断言文件上，而不是别处").toContain(ASSERT_REL);
  });

  it("镜像删掉闭包深处一个必填字段 → 断言文件报错", () => {
    // 证明被绑住的是整个类型闭包，不只是顶层 union。落点是 Usage（第三层）。
    const r = compileContractCopy((src) => src.replace("  totalTokens: number;\n", ""));
    expectExitedWithDiagnostics(r, "删深层必填字段后断言应当失败");
    expect(r.output).toContain(ASSERT_REL);
  });
});

/* ──────────────────── 正向对照 ──────────────────── */

describe("正向对照", () => {
  it("runtime 图 + 断言在 build 配置下编译通过", () => {
    expectCleanCompile(runTsc(".", ["--noEmit"]), "主 tsconfig 应当编译干净");
  });

  it("runtime 图在 browser 配置下编译通过", () => {
    expectCleanCompile(runTsc("tsconfig.browser.json"), "runtime 图应当是 browser-safe 的");
  });
});

/* ──────────────────── fixture ──────────────────── */

interface FixtureCase {
  dir: string;
  what: string;
  /**
   * `tsc` 输出里必须出现的片段。只钉错误码与类型名，不钉 TypeScript 诊断的整句措辞——
   * typescript 是 `^5.6.0` caret 区间，某个 5.x 微调 elaboration 会让这些因无关原因假红。
   */
  expects: string[];
}

const FAILING_FIXTURES: FixtureCase[] = [
  {
    dir: "01-mirror-missing-arm",
    what: "core 新增一个带新 discriminant 的 arm，镜像未跟上 → Core → Mirror 失败",
    expects: ["TS2322", "'SessionEvent'", "'MirrorMissingOneArm'"],
  },
  {
    dir: "02-mirror-extra-arm",
    what: "镜像多出一个 core 没有的 arm → Mirror → Core 失败",
    expects: ["TS2322", "'MirrorWithGhostArm'", "'SessionEvent'"],
  },
  {
    dir: "03-mirror-missing-required-field",
    what: "core 闭包内新增必填字段，镜像未跟上 → Mirror → Core 失败",
    expects: ["TS2322", "'MirrorMissingRequiredField'", "'SessionEvent'"],
  },
  {
    dir: "04-mirror-extra-required-field",
    what: "core 闭包内删除字段，镜像仍保留 → Core → Mirror 失败",
    expects: ["TS2322", "'SessionEvent'", "'MirrorWithExtraRequiredField'"],
  },
  {
    dir: "05-node-global-probe",
    what: "node 全局在真正的 browser 配置下必须被拒绝",
    expects: ["TS2591", "'process'", "'Buffer'"],
  },
];

/** 期望**零**退出的 fixture：它们记录的是「防线抓不住什么」与「出口面是通的」。 */
const CLEAN_FIXTURES: Array<{ dir: string; what: string }> = [
  { dir: "06-blind-spots", what: "四种已实测盲区确实抓不住（台账的可执行形态）" },
  { dir: "07-public-surface", what: "公开类型面能从包入口拿到" },
];

describe.each(FAILING_FIXTURES)("反例 fixture $dir", ({ dir, what, expects }) => {
  it(`${what}：tsc 必须非零退出`, () => {
    const r = runTsc(join("typecheck-fixtures", dir));
    expectExitedWithDiagnostics(r, dir);
    for (const fragment of expects) {
      expect(r.output, `期望输出含 ${JSON.stringify(fragment)}`).toContain(fragment);
    }
  });
});

describe.each(CLEAN_FIXTURES)("正例 fixture $dir", ({ dir, what }) => {
  it(`${what}：tsc 必须零退出`, () => {
    expectCleanCompile(runTsc(join("typecheck-fixtures", dir)), dir);
  });
});

it("fixture 05 继承真正的 tsconfig.browser.json，而不是手抄一份副本", () => {
  // 抄一份副本的话，改坏真配置时探针纹丝不动——守门人就守的是它自己。
  const cfg = JSON.parse(
    readFileSync(join(PKG_ROOT, "typecheck-fixtures", "05-node-global-probe", "tsconfig.json"), "utf8"),
  ) as { extends?: string; compilerOptions?: Record<string, unknown> };
  expect(cfg.extends).toBe("../../tsconfig.browser.json");
  const overridden = Object.keys(cfg.compilerOptions ?? {});
  expect(overridden, "lib / types 必须继承而非覆写").not.toContain("types");
  expect(overridden).not.toContain("lib");
});

/* ──────────────────── 断言不可被绕过（廉价路径） ──────────────────── */

describe("断言的静态完整性", () => {
  const source = readFileSync(ASSERT_FILE, "utf8");

  it("没有 @ts-ignore / @ts-nocheck 抑制指令", () => {
    // 注入式变异已经能抓住这类抑制，但那条测试的报错是「变异没被抓住」，指向不明确。
    // 这条给出直接、可读的失败信息。
    // （`@ts-expect-error` 不必禁：断言成立时它自己会触发 TS2578「Unused directive」。）
    expect(source).not.toMatch(/@ts-(ignore|nocheck)/);
  });

  it("确实从 @harness-pi/core import 了两条事件轨", () => {
    // 挡「把 CoreSessionEvent 别名改指镜像自己」这一手的**局部**信号。
    const sf = ts.createSourceFile(ASSERT_FILE, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const bindings: string[] = [];
    sf.forEachChild((node) => {
      if (
        !ts.isImportDeclaration(node) ||
        !ts.isStringLiteral(node.moduleSpecifier) ||
        node.moduleSpecifier.text !== "@harness-pi/core"
      ) {
        return;
      }
      const named = node.importClause?.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const el of named.elements) {
          bindings.push(`${el.propertyName?.text ?? el.name.text} as ${el.name.text}`);
        }
      }
    });
    expect(bindings).toEqual(
      expect.arrayContaining([
        "SessionEvent as CoreSessionEvent",
        "LiveEvent as CoreLiveEvent",
      ]),
    );
  });

  it("四条事件轨断言覆盖 {SessionEvent, LiveEvent} × {Core→Mirror, Mirror→Core}", () => {
    const sf = ts.createSourceFile(ASSERT_FILE, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const pairs: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        node.type &&
        node.initializer &&
        ts.isAsExpression(node.initializer)
      ) {
        pairs.push(`${node.initializer.type.getText(sf)} → ${node.type.getText(sf)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
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

/* ──────────────────── browser 门与脚本形态 ──────────────────── */

describe("browser 门真的关着", () => {
  it("typecheck 脚本以 && 串联两段", () => {
    // `toContain` 不够：把 `&&` 换成 `;` 或给中段挂 `|| true`，脚本仍含两个文件名，
    // 而中段失败不再向 CI 传播。
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const segments = (pkg.scripts?.["typecheck"] ?? "").split("&&").map((s) => s.trim());
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatch(/^tsc -p \. --noEmit$/);
    expect(segments[1]).toMatch(/^tsc -p tsconfig\.browser\.json$/);
  });

  it("browser program 含 runtime 图、不含 node 类型 / 测试 / 断言文件", () => {
    // 这条挡的是「tsconfig.browser.json 的 exclude 被放空」：__tests__ 里的
    // `import ... from "vitest"` 会经 vite 的 /// <reference types="node" /> 把
    // @types/node 隐式拉进 program，browser 门从此对 process / Buffer 放行。
    const r = runTsc("tsconfig.browser.json", ["--listFiles", "--noEmit"]);
    expect(r.status).toBe(0);
    const files = r.output.split("\n").filter((l) => l.trim().length > 0);
    // 正向锚点：光断言 files 非空的话，只靠 lib.d.ts 就能满足。
    expect(files.some((f) => f.endsWith(join("src", "contract", "core-mirror.ts")))).toBe(true);
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

/* ──────────────────── 盲区台账 ──────────────────── */

describe("盲区台账关键词未丢失", () => {
  // 台账的**证据**是 fixture 06（期望零退出的可执行形态），不是这几条 `toContain`。
  // 这里只挡「整段被删掉」，挡不住任何形式的过度声称——describe 名字如实反映这一点。
  const source = readFileSync(ASSERT_FILE, "utf8");

  it.each([
    ["闭包内任意层级新增可选字段"],
    ["镜像多出一个 core 没有的可选字段"],
    ["复用既有 discriminant"],
    ["`readonly` 修饰符漂移"],
    ["Record<string, any>"],
    ["且它的 discriminant 是新的"],
    ["不是穷举证明"],
  ])("台账仍含关键词：%s", (fragment) => {
    expect(source).toContain(fragment);
  });
});
