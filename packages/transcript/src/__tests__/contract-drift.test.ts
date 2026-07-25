import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

/**
 * tsc 挂死的兜底**必须靠 `spawnSync` 自己的 `timeout`**，vitest 的超时接不住它。
 *
 * 第五轮 review 实测证伪了原先的说法：`spawnSync` 是同步的，事件循环被它占住，
 * 任何 vitest 超时（`testTimeout` / `hookTimeout`）都无法打断——用 `--hookTimeout=1`
 * 跑整个文件仍然全部通过。所以真正的兜底只有这一个参数。
 *
 * 超时值给得比 `testTimeout` 小：这样挂死会表现为「这条测试失败并说明是 tsc 超时」，
 * 而不是 vitest 报一句无信息量的整体超时。超时被杀时 `status` 是 `null`，
 * `expectExitedWithDiagnostics` 会把它判成失败而不是「漂移被抓住」。
 */
const TSC_TIMEOUT_MS = 45_000;

function runTsc(project: string, extraArgs: string[] = []): TscRun {
  const r = spawnSync(TSC, ["-p", project, ...extraArgs], {
    cwd: PKG_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024, // --listFiles 会吐出几千行
    timeout: TSC_TIMEOUT_MS,
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

  it("镜像改坏 LiveEvent 的一个 arm → 断言文件报错", () => {
    // 前两条都打在 SessionEvent / Usage 上，LiveEvent 那对断言从没挨过变异——
    // 只有 AST 形状测试证明它「在语法上存在」，不证明它有约束力。把 MirrorLiveEvent
    // 换成 any 曾经不会让任何一条测试变红。
    const r = compileContractCopy((src) =>
      src.replace(
        '  | { type: "text_delta"; contentIndex: number; delta: string }\n',
        '  | { type: "text_delta"; delta: string }\n',
      ),
    );
    expectExitedWithDiagnostics(r, "改坏 LiveEvent arm 后断言应当失败");
    expect(r.output).toContain(ASSERT_REL);
    expect(r.output).toContain("LiveEvent");
  });

  it("镜像删掉一个**可选**字段 → 键集断言报错（双向断言看不见这种）", () => {
    // 这条专门证明键集断言的增量价值：`isError?: boolean` 是可选字段，删掉它之后
    // 双向可赋值断言两个方向都仍然通过（它对可选字段完全无感）；只有
    // `CoreOnlyKeys<CoreToolExecResult, MirrorToolExecResult>` 会多出一项而失败。
    const r = compileContractCopy((src) => src.replace("  isError?: boolean;\n", ""));
    expectExitedWithDiagnostics(r, "删可选字段后键集断言应当失败");
    expect(r.output).toContain(ASSERT_REL);
    // 区分两层断言：可赋值断言失败长成 `Type 'X' is not assignable to type 'Y'`（带类型名），
    // 键集断言失败长成 `Type 'true' is not assignable to type 'never'`。断言后者，
    // 才证明是键集这一层抓住的。
    expect(r.output, "必须是键集断言报的错，不是可赋值断言").toContain(
      "Type 'true' is not assignable to type 'never'",
    );
  });

  it("镜像**多出**一个可选字段 → 键集断言报错（覆盖 MirrorOnlyKeys 那一半）", () => {
    // 上一条打的是 `CoreOnlyKeys` 半边，`MirrorOnlyKeys` 那一半此前**零变异覆盖**、
    // 全靠推理——第五轮 review 抓到。这条补上：给镜像加一个 core 没有的可选字段。
    // （不写条数：这类手维护计数在本包已经漂过四次。）
    const r = compileContractCopy((src) =>
      src.replace("  isError?: boolean;\n", "  isError?: boolean;\n  ghostExtra?: string;\n"),
    );
    expectExitedWithDiagnostics(r, "镜像多出可选字段后键集断言应当失败");
    expect(r.output).toContain(ASSERT_REL);
    expect(r.output, "必须是键集断言报的错").toContain(
      "Type 'true' is not assignable to type 'never'",
    );
  });

  it("`ToolExecResult.content` 变体新增可选字段 → 键集断言报错", () => {
    // 第五轮 review 三门同时抓到的洞：具名类型**内部嵌套**的匿名内联对象，此前
    // 双向断言与键集断言都抓不住（实测 EXIT=0），而文档把它归进了「keyof 的固有限制」。
    // 它其实完全钉得住（`Extract<...[number], {type:"image"}>` 之后 keyof 可用），
    // 所以补的是断言而不是台账。这条守着那 4 条新断言。
    const r = compileContractCopy((src) =>
      src.replace(
        '| { type: "image"; data: string; mimeType: string }',
        '| { type: "image"; data: string; mimeType: string; altText?: string }',
      ),
    );
    expectExitedWithDiagnostics(r, "content 变体多出可选字段后键集断言应当失败");
    expect(r.output).toContain(ASSERT_REL);
    expect(r.output).toContain("Type 'true' is not assignable to type 'never'");
  });

  it("事件轨某个 arm 新增可选字段 → arm 层键集断言报错，且诊断说得出是哪个 arm", () => {
    // 第六轮 review 三门同时抓到：这一层曾被写成「拎不出统一形状、是 keyof 的固有限制」，
    // 实测是假的——每个 arm 都有唯一 discriminant，`Extract` 就是抓手。
    // 补的是 `ArmKeyDrift` 这条 mapped type（机器枚举全部 arm，不手写清单）。
    const r = compileContractCopy((src) =>
      src.replace(
        '  | { type: "turn-start"; turnIdx: number }',
        '  | { type: "turn-start"; turnIdx: number; hostLatencyMs?: number }',
      ),
    );
    expectExitedWithDiagnostics(r, "arm 新增可选字段后 arm 层键集断言应当失败");
    expect(r.output).toContain(ASSERT_REL);
    // 断言诊断**点名了那个 arm**——这是 ArmKeyDrift 把结果做成「漂移 arm 名字的 union」
    // 而不是 boolean 的原因。只断言「报错了」的话，随便哪条断言塌掉都能让这条假通过。
    expect(r.output, "诊断必须点名漂移的 arm，否则定位不了").toContain(
      `Type '"turn-start"' is not assignable to type 'never'`,
    );
  });

  it("LiveEvent 某个 arm 新增可选字段 → `_armDriftLiveEvent` 报错并点名", () => {
    // 上一条只打 SessionEvent 的 turn-start，于是 `_armDriftLiveEvent` **自己零覆盖**——
    // 第七轮 review 实测：把那一行删掉，LiveEvent arm 加可选字段 EXIT=0，44 条测试全绿。
    // 这是「断言存在但不被检查」（product.md 不变量 8 明令禁止）的第三次复现：
    // 第三/四轮是 `MirrorLiveEvent` 换 any，第五轮是 `MirrorOnlyKeys` 半边零变异，这次是它。
    // 两条事件轨各配一条对称的变异，别再只打一条。
    const r = compileContractCopy((src) =>
      src.replace(
        '  | { type: "message_update"; message: MirrorAssistantMessage }',
        '  | { type: "message_update"; message: MirrorAssistantMessage; hostLatencyMs?: number }',
      ),
    );
    expectExitedWithDiagnostics(r, "LiveEvent arm 新增可选字段后 arm 层断言应当失败");
    expect(r.output).toContain(ASSERT_REL);
    expect(r.output, "诊断必须点名漂移的 LiveEvent arm").toContain(
      `Type '"message_update"' is not assignable to type 'never'`,
    );
  });
});

/* ──────────────────── 正向对照 ──────────────────── */

describe("正向对照", () => {
  it("runtime 图 + 断言在 build 配置下编译通过，且断言确实在 program 里", () => {
    // 正向锚点与 browser 门那条对称：光「编译干净」的话，给 tsconfig.json 的 exclude
    // 加上 `src/**/__typecheck__/**` 也照样干净——断言从此不被编译而无人报警。
    const r = runTsc(".", ["--noEmit", "--listFiles"]);
    expectCleanCompile(r, "主 tsconfig 应当编译干净");
    expect(r.output, "断言文件必须在 build program 内").toContain(ASSERT_REL);
  });

  // browser 门的「编译通过」与「program 内容」合并成一次 spawn，见下面
  // 「browser program 含 runtime 图…」那条。
});

/* ──────────────────── fixture ──────────────────── */

/**
 * 01-04 合成**一个** program，锚点是「诊断落在哪个文件上」而不是进程退出码。
 * 后者只要有一条 fixture 报错就满足（靠 `expects` 里的类型名补救）；前者逐条钉死落点，
 * 既省 3 次 spawn，判别力也更强。
 */
const DRIFT_ANCHORS: Array<{ file: string; what: string; types: [string, string] }> = [
  {
    file: join("01-mirror-missing-arm", "drift.ts"),
    what: "core 新增带新 discriminant 的 arm，镜像未跟上 → Core → Mirror 失败",
    types: ["'SessionEvent'", "'MirrorMissingOneArm'"],
  },
  {
    file: join("02-mirror-extra-arm", "drift.ts"),
    what: "镜像多出一个 core 没有的 arm → Mirror → Core 失败",
    types: ["'MirrorWithGhostArm'", "'SessionEvent'"],
  },
  {
    file: join("03-mirror-missing-required-field", "drift.ts"),
    what: "core 闭包内新增必填字段，镜像未跟上 → Mirror → Core 失败",
    types: ["'MirrorMissingRequiredField'", "'SessionEvent'"],
  },
  {
    file: join("04-mirror-extra-required-field", "drift.ts"),
    what: "core 闭包内删除字段，镜像仍保留 → Core → Mirror 失败",
    types: ["'SessionEvent'", "'MirrorWithExtraRequiredField'"],
  },
];

describe("四种漂移反例", () => {
  // 惰性求值：写在 describe 体里会在**收集阶段**执行，那时失败归属不清（报成收集错误
  // 而不是某条测试失败）。挂死的兜底不在这里，在 `runTsc` 的 `spawnSync timeout`——
  // 早先这段注释宣称挪进 beforeAll 能让挂死变成超时失败，第五轮 review 实测证伪了。
  let run: TscRun;
  beforeAll(() => {
    run = runTsc(join("typecheck-fixtures", "tsconfig.drift.json"));
  });

  it("整个 program 因诊断而失败", () => {
    expectExitedWithDiagnostics(run, "四个漂移 fixture 应当报错");
  });

  it.each(DRIFT_ANCHORS)("$what", ({ file, types }) => {
    // 只钉错误码与类型名，不钉 TS 诊断的整句措辞——typescript 是 caret 区间，
    // 某个 5.x 微调 elaboration 会让这些因无关原因假红。
    const line = run.output
      .split("\n")
      .find((l) => l.includes(file) && l.includes("error TS2322"));
    expect(line, `期望 ${file} 上有一条 TS2322\n${run.output}`).toBeDefined();
    // 断言落在**这一行**上，不是合并输出里——否则 fixture 01 要的 'SessionEvent'
    // 会被 fixture 02 的诊断满足，「断言失败方向」这句话就不成立。
    for (const t of types) {
      expect(line).toContain(t);
    }
  });
});

describe("期望零退出的 fixture", () => {
  it("06 盲区台账 + 07 公开出口面（源码与 dist 两条路径）编译干净", () => {
    // 06 是台账的可执行形态：它编译通过**不是**好事，是在如实记录防线的边界。
    // 某条盲区哪天变得抓得住，这里会变红——那时该做的是更新台账，不是删掉它。
    expectCleanCompile(
      runTsc(join("typecheck-fixtures", "tsconfig.clean.json")),
      "06/07 应当编译干净",
    );
  });
});

describe("browser 门的判别力探针", () => {
  it("node 全局在真正的 browser 配置下必须被拒绝", () => {
    const r = runTsc(join("typecheck-fixtures", "05-node-global-probe"));
    expectExitedWithDiagnostics(r, "05-node-global-probe");
    expect(r.output).toContain("TS2591");
    expect(r.output).toContain("'process'");
    expect(r.output).toContain("'Buffer'");
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

/** 从断言文件的 AST 收集键集断言（名字 + 两个类型实参文本）。走 AST，不碰注释。 */
function collectKeySetAssertions(): Array<{ name: string; args: string[] }> {
  const src = readFileSync(ASSERT_FILE, "utf8");
  const sf = ts.createSourceFile(ASSERT_FILE, src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const out: Array<{ name: string; args: string[] }> = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      (node.name.text.startsWith("_omit") || node.name.text.startsWith("_noExtra")) &&
      node.type &&
      ts.isTypeReferenceNode(node.type) &&
      node.type.typeName.getText(sf) === "SameKeys"
    ) {
      out.push({
        name: node.name.text,
        args: (node.type.typeArguments ?? []).map((a) => a.getText(sf)),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

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

  it("键集断言的类型实参不得被架空（`SameKeys<非never, any>` 真空成立）", () => {
    // `SameKeys<A, B>` 是 `[A] extends [B] ? ([B] extends [A] ? true : never) : never`。
    // 把 `B` 写成 `any`，在 **`A` 不是 `never`** 时会让它真空成立——实测 `_omitToolExecResult`
    // （`A` = `"details" | "newMessages"`）改成 `any` 后 `tsc` **EXIT=0**，完全抓不住。
    // （`A` 是 `never` 的那些恰好会被 `tsc` 兜住，因为 `any` 唯一不可赋值的目标就是 `never`；
    // 但那是巧合，不是保证，所以这里把整条通道堵死，不去分辨。）
    //
    // 注入式变异只打得中被变异的那一条，剩下的会静默失效——这是第三/四轮给
    // `MirrorLiveEvent` 修过的同一个洞上移了一层。
    //
    // 这条零 spawn：只做 AST 静态检查，逐条枚举每个键集断言的两个类型实参文本。
    const keySetAssertions = collectKeySetAssertions();

    // 数量不写死（本包规矩：数不清就别数），但必须两边都覆盖到，且非空。
    expect(keySetAssertions.length, "一条键集断言都没找到——AST 判据可能写错了").toBeGreaterThan(0);
    expect(keySetAssertions.some((a) => a.name.startsWith("_omit"))).toBe(true);
    expect(keySetAssertions.some((a) => a.name.startsWith("_noExtra"))).toBe(true);

    for (const a of keySetAssertions) {
      expect(a.args, `${a.name} 必须有两个类型实参`).toHaveLength(2);
      const [lhs, rhs] = a.args as [string, string];
      // 第一个实参必须真的是键集运算，不是随便写个 never 凑数。
      expect(lhs, `${a.name} 的第一个实参必须是 CoreOnlyKeys / MirrorOnlyKeys`).toMatch(
        /^(CoreOnlyKeys|MirrorOnlyKeys)</,
      );
      // 两个实参都不许出现 any——那会让整条断言真空成立。
      for (const [pos, arg] of [["第一", lhs], ["第二", rhs]] as const) {
        // 覆盖边界：只匹配**字面量** `any`。经类型别名间接引入的（`type Sneaky = any`）
        // 纯文本判据够不着，assert 文件头如实记着这一点。
        expect(
          /\bany\b/.test(arg),
          `${a.name} 的${pos}个实参含 any，会让 SameKeys 真空成立：${arg}`,
        ).toBe(false);
      }
    }
  });

  it("每个镜像 interface 都必须配一对键集断言（名单由机器推导，不手维护）", () => {
    // 上一条只枚举**已存在**的断言——删掉 `_omitRunSummary` 之类任意几条，它照样全绿。
    // 这条把名单反过来推：从 `core-mirror.ts` 的 AST 读出所有导出的 interface，
    // 要求每个都有配对的 `_omit*` / `_noExtra*`。新增一个镜像 interface 却忘了写断言，
    // 这条会红——而且不引入任何手维护的数字。
    //
    // 只管 `interface`：`MirrorStopReason` 是字符串 union、`MirrorSessionEvent` /
    // `MirrorLiveEvent` 是 arm union（由 `ArmKeyDrift` 覆盖），对它们做顶层 `keyof` 没有意义。
    const mirrorSource = readFileSync(join(PKG_ROOT, "src", "contract", "core-mirror.ts"), "utf8");
    const mirrorSf = ts.createSourceFile(
      "core-mirror.ts",
      mirrorSource,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );
    const exportedInterfaces: string[] = [];
    mirrorSf.forEachChild((node) => {
      if (
        ts.isInterfaceDeclaration(node) &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        exportedInterfaces.push(node.name.text);
      }
    });
    expect(exportedInterfaces.length, "一个导出的 interface 都没找到——AST 判据可能写错了").toBeGreaterThan(0);

    // **判据必须走 AST，不能对源文本做正则**：`source` 含注释，而注释里就写着
    // 「`_noExtra*` 与 `_omitUsage` 这类」——第七轮 review 实测：删掉 `_omitUsage`
    // 的**声明**后这条检查仍然通过，因为注释里的同名字符串把它兜住了。
    // 那让 product.md 的 AC「删掉任意一条键集断言 → 完整性检查变红」变成一句假话。
    // （我自己验过一次，但挑的是 `_noExtraRunSummary`——那个名字恰好没出现在注释里，
    // 所以碰巧通过了。验证挑样本本身也会骗人。）
    const declaredNames = new Set(collectKeySetAssertions().map((a) => a.name));
    const missing: string[] = [];
    for (const name of exportedInterfaces) {
      // `MirrorToolExecResult` → `_omitToolExecResult` / `_noExtraToolExecResult`
      const bare = name.replace(/^Mirror/, "");
      for (const prefix of ["_omit", "_noExtra"]) {
        if (!declaredNames.has(`${prefix}${bare}`)) {
          missing.push(`${prefix}${bare}（对应 ${name}）`);
        }
      }
    }
    expect(missing, "有镜像 interface 缺键集断言").toEqual([]);
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
    // 只钉「两段、&& 串联、都是 tsc」——钉死整串会让加个 --pretty false 就无缘无故变红。
    expect(segments).toHaveLength(2);
    for (const seg of segments) expect(seg).toMatch(/^tsc -p /);
    expect(segments[1]).toContain("tsconfig.browser.json");
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

/*
 * 盲区台账**没有**文本断言。
 *
 * 台账的证据是 fixture 06（期望零退出的可执行形态）——它被删掉的话，「期望零退出的
 * fixture」那条立刻变红。而 fixture 06 的文件头明确要求「某条盲区哪天变得抓得住就更新台账」：
 * 给一件**要求被修改**的东西装一圈 `toContain` 绊网，只会让每次正常的措辞调整都变红，
 * 且失败信息什么都不告诉人。
 */
