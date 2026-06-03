import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModels } from "@mariozechner/pi-ai";
import {
  detectDefaultModel,
  envVarForProvider,
  formatModelList,
  formatProviderList,
  loadDotEnv,
  PROVIDER_ONBOARDING,
} from "../config.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "hpi-config-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("envVarForProvider", () => {
  it("maps curated providers to their canonical env var", () => {
    expect(envVarForProvider("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(envVarForProvider("google")).toBe("GEMINI_API_KEY"); // not GOOGLE_API_KEY
    expect(envVarForProvider("moonshotai")).toBe("MOONSHOT_API_KEY"); // not MOONSHOTAI_API_KEY
  });
  it("maps the DashScope alias to DASHSCOPE_API_KEY", () => {
    expect(envVarForProvider("qwen")).toBe("DASHSCOPE_API_KEY");
    expect(envVarForProvider("dashscope")).toBe("DASHSCOPE_API_KEY");
  });
  it("returns undefined for providers we do not curate", () => {
    expect(envVarForProvider("totally-unknown")).toBeUndefined();
  });
});

describe("detectDefaultModel", () => {
  it("returns undefined when no known key is set", () => {
    expect(detectDefaultModel({})).toBeUndefined();
  });
  it("picks the provider whose key is present and a real catalog model", () => {
    const d = detectDefaultModel({ ANTHROPIC_API_KEY: "x" });
    expect(d?.envVar).toBe("ANTHROPIC_API_KEY");
    const [provider, modelId] = d!.spec.split(":");
    expect(provider).toBe("anthropic");
    // the chosen model must actually exist in this pi-ai version (no rotted ids)
    expect(getModels("anthropic").map((m) => m.id)).toContain(modelId);
  });
  it("every curated default model exists in the live catalog", () => {
    for (const p of PROVIDER_ONBOARDING) {
      const ids = getModels(p.provider as never).map((m) => m.id);
      expect(ids, `${p.provider} default ${p.defaultModel}`).toContain(p.defaultModel);
    }
  });
  it("honors PROVIDER_ONBOARDING priority when several keys are set", () => {
    const d = detectDefaultModel({ OPENAI_API_KEY: "x", ANTHROPIC_API_KEY: "y" });
    expect(d!.spec.startsWith("anthropic:")).toBe(true); // anthropic is listed first
  });
  it("falls back to the DashScope alias when only a DashScope key is set", () => {
    expect(detectDefaultModel({ DASHSCOPE_API_KEY: "x" })).toEqual({
      spec: "qwen:qwen-plus",
      envVar: "DASHSCOPE_API_KEY",
    });
    expect(detectDefaultModel({ QWEN_API_KEY: "x" })?.envVar).toBe("QWEN_API_KEY");
  });
});

describe("loadDotEnv", () => {
  it("loads KEY=VALUE lines, skips comments/blanks, strips quotes", () => {
    const dir = tmp();
    const path = join(dir, ".env");
    writeFileSync(path, ['# comment', '', 'FOO=bar', 'QUOTED="q v"', "SQ='sq'"].join("\n"));
    const env: Record<string, string | undefined> = {};
    const set = loadDotEnv(path, env);
    expect(env.FOO).toBe("bar");
    expect(env.QUOTED).toBe("q v");
    expect(env.SQ).toBe("sq");
    expect(set.sort()).toEqual(["FOO", "QUOTED", "SQ"]);
  });
  it("does NOT override already-set variables (real env wins)", () => {
    const dir = tmp();
    const path = join(dir, ".env");
    writeFileSync(path, "FOO=fromfile");
    const env: Record<string, string | undefined> = { FOO: "fromenv" };
    const set = loadDotEnv(path, env);
    expect(env.FOO).toBe("fromenv");
    expect(set).toEqual([]);
  });
  it("returns [] for a missing file", () => {
    expect(loadDotEnv(join(tmp(), "nope.env"), {})).toEqual([]);
  });
});

describe("formatProviderList", () => {
  it("lists curated providers with env vars and marks detected keys", () => {
    const out = formatProviderList({ ANTHROPIC_API_KEY: "x" });
    expect(out).toContain("ANTHROPIC_API_KEY");
    expect(out).toContain("★ anthropic"); // detected
    expect(out).toMatch(/openai/); // listed even when not detected
    expect(out).toContain("--list-models");
  });
});

describe("formatModelList", () => {
  it("lists real model ids for a pi-ai provider", () => {
    const out = formatModelList("anthropic");
    expect(out).toContain("claude-sonnet-4-0");
  });
  it("lists DashScope/Qwen models for the alias", () => {
    expect(formatModelList("qwen")).toContain("qwen-plus");
  });
  it("explains how to recover from an unknown provider", () => {
    expect(formatModelList("nope")).toContain("--list-providers");
  });
});
