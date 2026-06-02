import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveFdPath,
  listFilesUnder,
  atFileSuggestions,
  createAutocompleteProvider,
} from "../autocomplete.js";

const dirs: string[] = [];
async function repo(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "hpi-ac-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe("resolveFdPath", () => {
  it("returns the first found binary, else null", () => {
    expect(resolveFdPath(() => "/usr/bin/fd")).toBe("/usr/bin/fd");
    expect(resolveFdPath((bin) => (bin === "fdfind" ? "/usr/bin/fdfind" : null))).toBe("/usr/bin/fdfind");
    expect(resolveFdPath(() => null)).toBeNull();
  });
});

describe("listFilesUnder", () => {
  it("lists files recursively and skips heavy/dot dirs", async () => {
    const cwd = await repo();
    await writeFile(join(cwd, "a.ts"), "x");
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src", "b.ts"), "x");
    await mkdir(join(cwd, "node_modules"));
    await writeFile(join(cwd, "node_modules", "junk.js"), "x");
    await mkdir(join(cwd, ".git"));
    await writeFile(join(cwd, ".git", "config"), "x");

    const files = listFilesUnder(cwd);
    expect(files).toContain("a.ts");
    expect(files).toContain(join("src", "b.ts"));
    expect(files.some((f) => f.includes("node_modules"))).toBe(false);
    expect(files.some((f) => f.includes(".git"))).toBe(false);
  });

  it("respects maxFiles", async () => {
    const cwd = await repo();
    for (let i = 0; i < 10; i++) await writeFile(join(cwd, `f${i}.ts`), "x");
    expect(listFilesUnder(cwd, { maxFiles: 3 })).toHaveLength(3);
  });
});

describe("atFileSuggestions", () => {
  it("emits @-prefixed values (matches pi-tui applyCompletion contract) + basename label", () => {
    const items = atFileSuggestions("b", ["src/bar.ts", "src/foo.ts"]);
    const bar = items.find((i) => i.description === "src/bar.ts")!;
    expect(bar.value).toBe("@src/bar.ts"); // value 自带 @
    expect(bar.label).toBe("bar.ts"); // label 是 basename
  });

  it("quotes paths containing spaces", () => {
    const items = atFileSuggestions("", ["my file.ts"]);
    expect(items[0]!.value).toBe('@"my file.ts"');
  });
});

describe("createAutocompleteProvider @ fallback (no fd)", () => {
  it("completes @ via readdir when fd is absent", async () => {
    const cwd = await repo();
    await writeFile(join(cwd, "calc.ts"), "x");
    const provider = createAutocompleteProvider([], cwd, () => null); // force no-fd fallback
    const res = await provider.getSuggestions(["@cal"], 0, 4, {
      signal: new AbortController().signal,
    });
    expect(res).not.toBeNull();
    expect(res!.prefix).toBe("@cal");
    expect(res!.items.some((i) => i.value === "@calc.ts")).toBe(true);
  });

  it("returns null when there is no @-token at the cursor", async () => {
    const cwd = await repo();
    const provider = createAutocompleteProvider([], cwd, () => null);
    const res = await provider.getSuggestions(["hello world"], 0, 11, {
      signal: new AbortController().signal,
    });
    expect(res).toBeNull();
  });
});
