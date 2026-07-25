import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * browser-safe 的机械保证。
 *
 * `tsconfig.browser.json` 挡的是「类型层面用了 node 全局」；这里挡的是「说明符层面
 * 引到了 node 内置或跨包依赖」。两者互补：前者靠 `lib` / `types`，后者靠源码扫描。
 *
 * 扫描走 TypeScript 自己的 parser 而不是正则——注释里出现 `Buffer` 字样、字符串里出现
 * `node:fs` 都不该算数据点，正则分不清，AST 分得清。
 */

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC_ROOT = join(PKG_ROOT, "src");

/** runtime 图 = `src/**`，排除断言目录与测试目录（两者都不进 `dist`、也不进浏览器）。 */
const EXCLUDED_DIRS = new Set(["__typecheck__", "__tests__"]);

const NODE_BUILTINS = new Set([
  "assert", "buffer", "child_process", "cluster", "console", "constants", "crypto",
  "dgram", "dns", "domain", "events", "fs", "http", "http2", "https", "inspector",
  "module", "net", "os", "path", "perf_hooks", "process", "punycode", "querystring",
  "readline", "repl", "stream", "string_decoder", "timers", "tls", "trace_events",
  "tty", "url", "util", "v8", "vm", "worker_threads", "zlib",
]);

const FORBIDDEN_GLOBALS = new Set(["process", "Buffer", "__dirname", "__filename"]);

function collectRuntimeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      out.push(...collectRuntimeFiles(join(dir, entry.name)));
    } else if (entry.name.endsWith(".ts")) {
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

function scan(file: string, kind: ts.ScriptKind = ts.ScriptKind.TS): {
  specifiers: Hit[];
  globals: Hit[];
} {
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

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      noteSpecifier(node, node.moduleSpecifier.text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      noteSpecifier(node, node.argument.literal.text);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      const [first] = node.arguments;
      if ((isDynamicImport || isRequire) && first && ts.isStringLiteral(first)) {
        noteSpecifier(node, first.text);
      }
    }

    if (ts.isIdentifier(node) && FORBIDDEN_GLOBALS.has(node.text)) {
      // 只有「被当作值/类型引用」才算；`foo.process` 里的属性名不算。
      const parent = node.parent;
      const isPropertyName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isPropertySignature(parent) && parent.name === node) ||
        (ts.isQualifiedName(parent) && parent.right === node);
      if (!isPropertyName) {
        globals.push({ file: rel, line: at(node), what: node.text });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
  return { specifiers, globals };
}

function isForbiddenSpecifier(spec: string): boolean {
  if (spec.startsWith("node:")) return true;
  if (NODE_BUILTINS.has(spec)) return true;
  if (spec.startsWith("@harness-pi/")) return true;
  if (spec.startsWith("@earendil-works/")) return true;
  return false;
}

const RUNTIME_FILES = collectRuntimeFiles(SRC_ROOT);

describe("runtime 图 browser-safe", () => {
  it("扫描到了 runtime 文件（防止 glob 写错导致空集合恒过）", () => {
    expect(RUNTIME_FILES.length).toBeGreaterThan(0);
    // 断言目录与测试目录确实被排除掉了，否则下面的检查等于没做。
    for (const f of RUNTIME_FILES) {
      expect(f).not.toContain("__typecheck__");
      expect(f).not.toContain("__tests__");
    }
  });

  it("0 处 node 内置 / 跨包说明符", () => {
    const hits = RUNTIME_FILES.flatMap((f) => scan(f).specifiers).filter((h) =>
      isForbiddenSpecifier(h.what),
    );
    expect(
      hits.map((h) => `${h.file}:${h.line} → ${h.what}`),
      "runtime 图不得引用 node 内置或 @harness-pi/* / @earendil-works/*",
    ).toEqual([]);
  });

  it("0 处 process / Buffer / __dirname / __filename 标识符", () => {
    const hits = RUNTIME_FILES.flatMap((f) => scan(f).globals);
    expect(
      hits.map((h) => `${h.file}:${h.line} → ${h.what}`),
      "runtime 图不得使用 node 全局",
    ).toEqual([]);
  });

  it("扫描器本身有判别力（对照：断言目录确实含被禁说明符）", () => {
    // 反向对照。少了这条，扫描器写错（比如 visit 没递归）也会得到空结果、假通过。
    const assertFile = join(SRC_ROOT, "contract", "__typecheck__", "core-mirror.assert.ts");
    const hits = scan(assertFile).specifiers.filter((h) => isForbiddenSpecifier(h.what));
    expect(hits.map((h) => h.what)).toContain("@harness-pi/core");
  });
});

describe("包元数据", () => {
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    private?: boolean;
  };

  it("dependencies 为空——内核与 pi-ai 只能是 devDependencies", () => {
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
    expect(Object.keys(pkg.devDependencies ?? {})).toContain("@harness-pi/core");
  });

  it("day-1 是 private（npm 发布押后；见 specs/GH153/product.md 发布说明）", () => {
    expect(pkg.private).toBe(true);
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

  it("dist/ 存在（本仓铁律：build 先于 test）", () => {
    // 刻意**不** skip。静默跳过会让「产物无跨包引用」这条检查在 CI 之外永远不执行。
    expect(
      existsSync(DIST),
      "dist/ 不存在。先跑 `pnpm --filter @harness-pi/transcript build`——本仓 build 必须先于 typecheck/test。",
    ).toBe(true);
  });

  it("产物中 0 处 node 内置 / 跨包说明符", () => {
    // 判定走 AST 而不是文本包含：`core-mirror.ts` 的文件头写着「不能 import
    // `@harness-pi/core`」，tsc 会把这段 JSDoc 原样搬进 .js 与 .d.ts。一句
    // 「我们不引用 X」的说明不该被判成引用了 X。
    const hits = collectDistFiles(DIST)
      .filter((f) => f.endsWith(".js") || f.endsWith(".d.ts"))
      .flatMap((f) =>
        scan(f, f.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS).specifiers,
      )
      .filter((h) => isForbiddenSpecifier(h.what));
    expect(
      hits.map((h) => `${h.file}:${h.line} → ${h.what}`),
      "devDep 从 __typecheck__ 泄漏进了 dist——检查 tsconfig.json 的 exclude",
    ).toEqual([]);
  });

  it("产物 .d.ts 中 0 处三斜线 reference 指令", () => {
    // 另一条泄漏通道：`/// <reference types="node" />` 不是 import，AST 的说明符扫描看不见它，
    // 但它会让消费者的 program 隐式拉进 @types/node——正是 tsconfig.browser.json 失效的同款成因。
    const hits = collectDistFiles(DIST)
      .filter((f) => f.endsWith(".d.ts"))
      .flatMap((f) => {
        const sf = ts.createSourceFile(
          f,
          readFileSync(f, "utf8"),
          ts.ScriptTarget.ES2022,
          true,
          ts.ScriptKind.TS,
        );
        return [
          ...sf.typeReferenceDirectives.map((d) => `${relative(PKG_ROOT, f)} → types="${d.fileName}"`),
          ...sf.referencedFiles.map((d) => `${relative(PKG_ROOT, f)} → path="${d.fileName}"`),
        ];
      });
    expect(hits).toEqual([]);
  });

  it("产物中 0 处 __typecheck__ / __tests__ 落点", () => {
    const leaked = collectDistFiles(DIST)
      .map((f) => relative(PKG_ROOT, f))
      .filter((f) => f.includes("__typecheck__") || f.includes("__tests__"));
    expect(leaked).toEqual([]);
  });
});
