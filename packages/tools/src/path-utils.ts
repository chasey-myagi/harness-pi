import path from "node:path";
import { homedir } from "node:os";
import { existsSync, realpathSync } from "node:fs";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

export interface ResolveToolPathOptions {
  allowOutsideCwd?: boolean | undefined;
}

export function resolveToolPath(
  cwd: string,
  input: string | undefined,
  options: ResolveToolPathOptions = {},
): string {
  const rawInput = input && input.trim().length > 0 ? input : ".";
  const raw = rawInput.startsWith("@")
    ? rawInput.slice(1).replace(UNICODE_SPACES, " ")
    : rawInput.replace(UNICODE_SPACES, " ");
  const resolved =
    raw === "~"
      ? homedir()
      : raw.startsWith("~/")
        ? path.resolve(homedir(), raw.slice(2))
        : path.isAbsolute(raw)
          ? path.normalize(raw)
          : path.resolve(cwd, raw);
  if (!options.allowOutsideCwd && !isPathInsideReal(cwd, resolved)) {
    throw new Error(`Path escapes cwd: ${rawInput}`);
  }
  return resolved;
}

export function toDisplayPath(cwd: string, absolutePath: string): string {
  const rel = path.relative(cwd, absolutePath);
  if (!rel) return ".";
  if (rel.startsWith("..")) return absolutePath;
  return rel.split(path.sep).join("/");
}

export function normalizeDisplayPath(input: string): string {
  return input.split(path.sep).join("/");
}

export function hasGlobMagic(pattern: string): boolean {
  return /[*?[\]{}]/.test(pattern);
}

export function globToRegExp(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] ?? "";
    const next = pattern[i + 1];
    const next2 = pattern[i + 2];
    if (ch === "*" && next === "*" && next2 === "/") {
      out += "(?:.*/)?";
      i += 2;
      continue;
    }
    if (ch === "*" && next === "*") {
      out += ".*";
      i++;
      continue;
    }
    if (ch === "*") {
      out += "[^/]*";
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    if (ch === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end > i) {
        out += pattern.slice(i, end + 1);
        i = end;
        continue;
      }
    }
    if (ch === "{") {
      const end = pattern.indexOf("}", i + 1);
      if (end > i) {
        const alternatives = pattern
          .slice(i + 1, end)
          .split(",")
          .map((part) => escapeRegExp(part))
          .join("|");
        out += `(?:${alternatives})`;
        i = end;
        continue;
      }
    }
    out += escapeRegExp(ch);
  }
  out += "$";
  return new RegExp(out);
}

export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isPathInside(cwd: string, target: string): boolean {
  const base = path.resolve(cwd);
  const resolved = path.resolve(target);
  const rel = path.relative(base, resolved);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function isPathInsideReal(cwd: string, target: string): boolean {
  const baseReal = realpathSync.native(cwd);
  const targetResolved = path.resolve(target);
  const existing = nearestExistingPath(targetResolved);
  const existingReal = realpathSync.native(existing);
  const remainder = path.relative(existing, targetResolved);
  const finalRealPath = path.resolve(existingReal, remainder);
  return isPathInside(baseReal, existingReal) && isPathInside(baseReal, finalRealPath);
}

function nearestExistingPath(target: string): string {
  let current = target;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return parent;
    current = parent;
  }
  return current;
}
