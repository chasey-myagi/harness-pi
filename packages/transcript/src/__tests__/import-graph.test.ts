import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * browser-safe 的机械保证。
 *
 * `tsconfig.browser.json` 挡的是「类型层面用了 node 全局」；这里挡的是「说明符层面引到了
 * 包外的东西」。两者互补：前者靠 `lib` / `types`，后者靠源码扫描。
 *
 * 说明符判定用 **allowlist**（只准相对路径）而不是 denylist。denylist 挡不住的东西太多，
 * 且失效方式是静默的：`fs/promises` 这类内置子路径不在裸名单里；`import ts from "typescript"`
 * 甚至能同时溜过 denylist 和 browser 门（typescript 自带 `.d.ts`、不需要 `@types/node`）。
 * allowlist 反过来：将来 #166 / #167 真要引一个 browser-safe 的第三方库，必须显式改这里，
 * 顺带被迫把它加进 `dependencies`——这正是我们想要的那次决策。
 *
 * 扫描走 TypeScript 自己的 parser 而不是正则——注释里出现 `Buffer` 字样、字符串里出现
 * `node:fs` 都不该算数据点，正则分不清，AST 分得清。
 */

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC_ROOT = join(PKG_ROOT, "src");

/** runtime 图 = `src/**`，排除断言目录与测试目录（两者都不进 `dist`、也不进浏览器）。 */
const EXCLUDED_DIRS = new Set(["__typecheck__", "__tests__"]);

/** `.ts` 之外还要覆盖 `.mts` / `.cts` / `.tsx`——漏掉它们时失效方式是静默无视整个文件。 */
const TS_SOURCE = /\.(m|c)?tsx?$/;

const FORBIDDEN_GLOBALS = new Set(["process", "Buffer", "__dirname", "__filename", "global"]);

/** 宿主全局对象：`globalThis.process` 里的 `process` 是属性名，但它仍然是一次 node 全局访问。 */
const GLOBAL_OBJECTS = new Set(["globalThis", "global", "window", "self"]);

function collectFiles(dir: string, opts: { excludeDirs: boolean }): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (opts.excludeDirs && EXCLUDED_DIRS.has(entry.name)) continue;
      out.push(...collectFiles(join(dir, entry.name), opts));
    } else if (TS_SOURCE.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out.sort();
}

interface Hit {
  file: string;
  line: number;
  what: string;
}

interface ScanResult {
  specifiers: Hit[];
  globals: Hit[];
  referenceDirectives: Hit[];
}

function scan(file: string, kind: ts.ScriptKind = ts.ScriptKind.TS): ScanResult {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, kind);
  const rel = relative(PKG_ROOT, file);
  const specifiers: Hit[] = [];
  const globals: Hit[] = [];

  const at = (node: ts.Node): number =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  const noteSpecifier = (node: ts.Node, spec: string): void => {
    specifiers.push({ file: rel, line: at(node), what: spec });
  };

  /** `import(`node:fs`)` 用的是 NoSubstitutionTemplateLiteral，`isStringLiteral` 对它为假。 */
  const literalText = (node: ts.Node): string | undefined =>
    ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      const spec = literalText(node.moduleSpecifier);
      if (spec !== undefined) noteSpecifier(node, spec);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const spec = literalText(node.argument.literal);
      if (spec !== undefined) noteSpecifier(node, spec);
    } else if (
      // `import fs = require("node:fs")`
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const spec = literalText(node.moduleReference.expression);
      if (spec !== undefined) noteSpecifier(node, spec);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      const [first] = node.arguments;
      if (isDynamicImport || isRequire) {
        const spec = first ? literalText(first) : undefined;
        if (spec !== undefined) noteSpecifier(node, spec);
      }
    }

    /** 剥掉 `(x)` / `x as T` / `x!` —— `(globalThis as any).process` 是绕过的经典写法。 */
    const unwrap = (expr: ts.Expression): ts.Expression => {
      let cur = expr;
      while (
        ts.isParenthesizedExpression(cur) ||
        ts.isAsExpression(cur) ||
        ts.isNonNullExpression(cur)
      ) {
        cur = cur.expression;
      }
      return cur;
    };

    /** `globalThis.process` / `globalThis["process"]`：宿主对象上的属性名，仍是一次全局访问。 */
    const isHostGlobalObject = (expr: ts.Expression): boolean => {
      const inner = unwrap(expr);
      return ts.isIdentifier(inner) && GLOBAL_OBJECTS.has(inner.text);
    };

    if (ts.isIdentifier(node) && FORBIDDEN_GLOBALS.has(node.text)) {
      const parent = node.parent;
      const viaHostGlobal =
        ts.isPropertyAccessExpression(parent) &&
        parent.name === node &&
        isHostGlobalObject(parent.expression);
      // `foo.process` / `{ process: 1 }` / `interface X { process: string }` 里的
      // `process` 只是同名属性，不算引用了全局——除非那个 `foo` 是宿主全局对象。
      // 「这个标识符处在**某个声明的名字位**上吗」——结构性判据，不是 kind 清单。
      // 早先版本枚举了 PropertyAccess / PropertyAssignment / PropertySignature /
      // QualifiedName 四种，随手就漏了 TypeAlias / Method / EnumMember / BindingElement…
      // 而每漏一种就是一次假红（把无辜的同名属性报成 node 全局）。
      // 名字位的判据统一成「parent.name / parent.propertyName / QualifiedName.right 指向自己」，
      // 覆盖所有带名字的声明，将来 TS 加新 kind 也不用跟。
      const named = parent as ts.Node & {
        name?: ts.Node;
        propertyName?: ts.Node;
      };
      const isInertPropertyName =
        !viaHostGlobal &&
        (named.name === node ||
          named.propertyName === node ||
          (ts.isQualifiedName(parent) && parent.right === node));
      if (!isInertPropertyName) {
        globals.push({ file: rel, line: at(node), what: node.text });
      }
    }

    // 元素访问形式：`globalThis["process"]` 的 `"process"` 是 StringLiteral 不是
    // Identifier，上面那条永远不触发。
    if (
      ts.isElementAccessExpression(node) &&
      isHostGlobalObject(node.expression) &&
      ts.isStringLiteral(node.argumentExpression) &&
      FORBIDDEN_GLOBALS.has(node.argumentExpression.text)
    ) {
      globals.push({ file: rel, line: at(node), what: node.argumentExpression.text });
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);

  const referenceDirectives: Hit[] = [
    ...sf.typeReferenceDirectives.map((d) => ({ file: rel, line: 0, what: `types="${d.fileName}"` })),
    ...sf.referencedFiles.map((d) => ({ file: rel, line: 0, what: `path="${d.fileName}"` })),
  ];

  return { specifiers, globals, referenceDirectives };
}

/** allowlist：runtime 图只准相对说明符。 */
function isAllowedSpecifier(spec: string): boolean {
  return spec.startsWith("./") || spec.startsWith("../");
}

const RUNTIME_FILES = collectFiles(SRC_ROOT, { excludeDirs: true });

const fmt = (hits: Hit[]): string[] => hits.map((h) => `${h.file}:${h.line} → ${h.what}`);

describe("runtime 图 browser-safe", () => {
  it("扫描到了 runtime 文件，且断言/测试目录确实被排除", () => {
    // 防止 glob 写错导致空集合恒过。
    expect(RUNTIME_FILES.length).toBeGreaterThan(0);
    for (const f of RUNTIME_FILES) {
      expect(f).not.toContain("__typecheck__");
      expect(f).not.toContain("__tests__");
    }
  });

  it("只使用相对说明符（allowlist）", () => {
    const hits = RUNTIME_FILES.flatMap((f) => scan(f).specifiers).filter(
      (h) => !isAllowedSpecifier(h.what),
    );
    expect(
      fmt(hits),
      "runtime 图只准相对 import。要引第三方 browser-safe 库，请显式放开 allowlist 并加进 dependencies。",
    ).toEqual([]);
  });

  it("0 处 process / Buffer / __dirname / __filename / global 标识符", () => {
    expect(fmt(RUNTIME_FILES.flatMap((f) => scan(f).globals)), "runtime 图不得使用 node 全局").toEqual([]);
  });

  it("0 处三斜线 reference 指令", () => {
    // 与 dist 侧同款检查：`/// <reference types="node" />` 不是 import，说明符扫描看不见它。
    expect(fmt(RUNTIME_FILES.flatMap((f) => scan(f).referenceDirectives))).toEqual([]);
  });
});

/**
 * 扫描器的十来条分支，对着「4 个纯类型文件、零命中」的 runtime 图全都恒真——写错了也永远
 * 发现不了。`typecheck-fixtures/scanner-corpus/` 是给它们准备的标本，断言命中集合**精确等于**
 * 预期集合（不是「非空」）。新增扫描分支时必须同时加标本。
 */
describe("扫描器本身有判别力", () => {
  const CORPUS = join(PKG_ROOT, "typecheck-fixtures", "scanner-corpus");
  const corpusScan = (name: string): ScanResult => scan(join(CORPUS, name));

  it("收集器认得 .ts / .mts / .cts / .tsx", () => {
    const names = collectFiles(CORPUS, { excludeDirs: false }).map((f) => f.split("/").pop());
    expect(names).toEqual(
      expect.arrayContaining([
        "ext-probe.cts",
        "ext-probe.mts",
        "ext-probe.tsx",
        "globals.ts",
        "negative-control.ts",
        "specifiers.ts",
      ]),
    );
  });

  it("说明符扫描：八种形态一个不漏，命中集合精确匹配", () => {
    const expected = [
      "node:fs", //          import * as ... from
      "node:os", //          export * from
      "node:child_process", // import x = require(...)
      "node:crypto", //      import("...").T 类型位置
      "node:stream", //      import(`...`) 模板字面量
      "node:path", //        require(...)
      "fs/promises", //      内置子路径——正是裸名单 denylist 漏掉的那类
      "./negative-control.js", // 相对说明符：allowlist 放行，但扫描器必须看得见
    ];
    const found = corpusScan("specifiers.ts").specifiers.map((h) => h.what).sort();
    expect(found).toEqual([...expected].sort());
    // allowlist 判据把上面除相对路径外的全部拦下。数量从同一份清单推导，不写魔数——
    // 往清单加标本时这条不会莫名其妙地红。
    const blocked = corpusScan("specifiers.ts").specifiers.filter((h) => !isAllowedSpecifier(h.what));
    expect(blocked).toHaveLength(expected.filter((sp) => !isAllowedSpecifier(sp)).length);
  });

  it("扩展名标本的载荷也被扫到，不是只数文件名", () => {
    // 光断言 collectFiles 认得 .mts/.cts/.tsx，只证明「文件被收集」，不证明「内容被扫」。
    for (const [file, spec] of [
      ["ext-probe.mts", "node:vm"],
      ["ext-probe.cts", "node:tls"],
      ["ext-probe.tsx", "node:zlib"],
    ] as const) {
      expect(corpusScan(file).specifiers.map((h) => h.what), file).toContain(spec);
    }
  });

  it("三斜线 reference 指令：types 与 path 两种都看得见", () => {
    expect(corpusScan("specifiers.ts").referenceDirectives.map((h) => h.what).sort()).toEqual([
      'path="./phantom.d.ts"',
      'types="node"',
    ]);
  });

  it("标识符扫描：裸全局、globalThis.x、globalThis[\"x\"]、经 cast / 括号包裹 都看得见", () => {
    const found = corpusScan("globals.ts").globals.map((h) => h.what).sort();
    // 裸 ×2、globalThis.x ×1、globalThis["x"] ×1、(globalThis as T).x ×1、(globalThis).x ×1、
    // __dirname、__filename
    expect(found).toEqual(["Buffer", "Buffer", "Buffer", "__dirname", "__filename", "process", "process", "process"].sort());
  });

  it("负向对照：同名属性 / 字段 / 索引类型不被误报", () => {
    // 少了这条，把 isInertPropertyName 写成恒 false 也能让上一条通过。
    expect(corpusScan("negative-control.ts").globals).toEqual([]);
  });

  it("真实断言目录里扫得出 @harness-pi/core", () => {
    const hits = scan(join(SRC_ROOT, "contract", "__typecheck__", "core-mirror.assert.ts")).specifiers;
    expect(hits.map((h) => h.what)).toEqual(
      expect.arrayContaining(["@harness-pi/core", "@earendil-works/pi-ai"]),
    );
  });
});

describe("包元数据", () => {
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    private?: boolean;
    files?: string[];
  };

  it("dependencies 为空——内核与 pi-ai 只能是 devDependencies", () => {
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
    expect(Object.keys(pkg.devDependencies ?? {})).toContain("@harness-pi/core");
  });

  it("day-1 是 private（npm 发布押后；见 specs/GH153/product.md 发布说明）", () => {
    expect(pkg.private).toBe(true);
  });

  it("files 里列的文件都真实存在", () => {
    const missing = (pkg.files ?? [])
      .filter((f) => !f.startsWith("!") && !f.includes("*"))
      .filter((f) => !existsSync(join(PKG_ROOT, f)));
    expect(missing, "package.json 的 files 列了不存在的文件").toEqual([]);
  });
});

describe("构建产物", () => {
  const DIST = join(PKG_ROOT, "dist");

  function collectDistFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...collectDistFiles(p));
      else out.push(p);
    }
    return out;
  }

  it("dist/ 存在且不为空（本仓铁律：build 先于 test）", () => {
    // 刻意**不** skip。静默跳过会让下面几条检查在 CI 之外永远不执行。
    // 非空守卫同样不能省：dist 存在但为空（build 中断、tsc 半写、手动 mkdir）时，
    // 下面三条 `.filter(...).toEqual([])` 会一起空集合恒过。
    expect(
      existsSync(DIST),
      "dist/ 不存在。先跑 `pnpm --filter @harness-pi/transcript build`——本仓 build 必须先于 typecheck/test。",
    ).toBe(true);
    const files = collectDistFiles(DIST);
    expect(files.filter((f) => f.endsWith(".js")).length, "dist/ 里没有 .js——build 是半成品").toBeGreaterThan(0);
    expect(files.filter((f) => f.endsWith(".d.ts")).length, "dist/ 里没有 .d.ts——build 是半成品").toBeGreaterThan(0);
    // 新鲜度不在本条覆盖范围内：dist 陈旧时以上断言仍然通过。这是仓库
    // 「build 先于 typecheck/test」铁律的既有代价，CI 里每次都重新 build。
  });

  it("产物中 0 处非相对说明符", () => {
    // 判定走 AST 而不是文本包含：`core-mirror.ts` 的文件头写着「不能 import
    // `@harness-pi/core`」，tsc 会把这段 JSDoc 原样搬进 .js 与 .d.ts。一句
    // 「我们不引用 X」不该被判成引用了 X。
    const hits = collectDistFiles(DIST)
      .filter((f) => f.endsWith(".js") || f.endsWith(".d.ts"))
      .flatMap((f) => scan(f, f.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS).specifiers)
      .filter((h) => !isAllowedSpecifier(h.what));
    expect(
      fmt(hits),
      "dist 产物引到了包外——检查 tsconfig.json 的 include/exclude 与 runtime 图 allowlist",
    ).toEqual([]);
  });

  it("产物 .d.ts 中 0 处三斜线 reference 指令", () => {
    // 另一条泄漏通道：`/// <reference types="node" />` 会让消费者的 program 隐式拉进
    // @types/node——正是 tsconfig.browser.json 失效的同款成因。
    const hits = collectDistFiles(DIST)
      .filter((f) => f.endsWith(".d.ts"))
      .flatMap((f) => scan(f).referenceDirectives);
    expect(fmt(hits)).toEqual([]);
  });

  it("产物中 0 处 __tests__ 落点", () => {
    // `__typecheck__` **会**出现在 dist，这是有意的：断言必须挂在 build 主路径上。
    // `import type` 被完全擦除，所以 `.d.ts` 字面就是 `export {};`，`.js` 是注释加 10 个
    // 死变量（两条事件轨各两向 + pi-ai 三个叶子类型各两向）。两者都由 files 挡在 tarball 外。
    const leaked = collectDistFiles(DIST)
      .map((f) => relative(PKG_ROOT, f))
      .filter((f) => f.includes("__tests__"));
    expect(leaked).toEqual([]);
  });

  it("断言产物确实是空壳", () => {
    const assertJs = join(DIST, "contract", "__typecheck__", "core-mirror.assert.js");
    expect(existsSync(assertJs), "断言应当随 build 一起 emit——它挂在主路径上").toBe(true);
    const declared = readFileSync(join(DIST, "contract", "__typecheck__", "core-mirror.assert.d.ts"), "utf8");
    expect(declared).not.toMatch(/import|require/);
  });

  it("断言产物与测试确实被挡在 tarball 外（`npm pack --dry-run` 实测）", () => {
    // 早先这条断的是 `expect(pkg.files).toContain("!**/__typecheck__/**")`——对一个 JSON
    // 数组做字符串匹配，一个字也没验 npm 的 files 取反语义是否真的生效。真证据只有
    // 让 npm 自己算一遍。`private: true` 不阻止 `npm pack`。
    const r = spawnSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: PKG_ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    if (r.error) throw r.error;
    expect(r.status, r.stderr).toBe(0);
    const [tarball] = JSON.parse(r.stdout) as Array<{ files: Array<{ path: string }> }>;
    const paths = (tarball?.files ?? []).map((f) => f.path);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.filter((f) => f.includes("__typecheck__"))).toEqual([]);
    expect(paths.filter((f) => f.includes("__tests__"))).toEqual([]);
    expect(paths.filter((f) => f.includes("typecheck-fixtures"))).toEqual([]);
    expect(paths, "出口面必须在 tarball 里").toContain("dist/index.d.ts");
  });
});
