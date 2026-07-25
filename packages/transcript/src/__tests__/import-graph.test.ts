import { describe, expect, it } from "vitest";
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

    if (ts.isIdentifier(node) && FORBIDDEN_GLOBALS.has(node.text)) {
      const parent = node.parent;
      // `foo.process` 里的 `process` 是属性名，不算引用了全局……
      let isInertPropertyName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isPropertySignature(parent) && parent.name === node) ||
        (ts.isQualifiedName(parent) && parent.right === node);
      // ……但 `globalThis.process` / `window.process` 例外：那正是一次 node 全局访问。
      if (
        isInertPropertyName &&
        ts.isPropertyAccessExpression(parent) &&
        ts.isIdentifier(parent.expression) &&
        GLOBAL_OBJECTS.has(parent.expression.text)
      ) {
        isInertPropertyName = false;
      }
      if (!isInertPropertyName) {
        globals.push({ file: rel, line: at(node), what: node.text });
      }
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

describe("扫描器本身有判别力", () => {
  it("说明符扫描：能在断言目录里扫出 @harness-pi/core", () => {
    const assertFile = join(SRC_ROOT, "contract", "__typecheck__", "core-mirror.assert.ts");
    const hits = scan(assertFile).specifiers.filter((h) => !isAllowedSpecifier(h.what));
    expect(hits.map((h) => h.what)).toContain("@harness-pi/core");
  });

  it("标识符扫描：能在 node 全局探针里扫出 process 与 Buffer", () => {
    // 反向对照。runtime 图现在是 4 个纯类型文件、0 个标识符命中——正是最容易掩盖
    // 「isInertPropertyName 写错到把所有命中都吞掉」这类 bug 的状态。
    const probe = join(PKG_ROOT, "typecheck-fixtures", "05-node-global-probe", "probe.ts");
    const found = new Set(scan(probe).globals.map((h) => h.what));
    expect([...found].sort()).toEqual(["Buffer", "process"]);
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
      .filter((f) => f !== "dist" && !existsSync(join(PKG_ROOT, f)));
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
      "devDep 从 __typecheck__ 泄漏进了 dist——检查 tsconfig.json 的 exclude",
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

  it("产物中 0 处 __typecheck__ / __tests__ 落点", () => {
    const leaked = collectDistFiles(DIST)
      .map((f) => relative(PKG_ROOT, f))
      .filter((f) => f.includes("__typecheck__") || f.includes("__tests__"));
    expect(leaked).toEqual([]);
  });
});
