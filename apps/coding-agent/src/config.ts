import { existsSync, readFileSync } from "node:fs";
import { getModels, getProviders } from "@earendil-works/pi-ai";
import { dashScopeModelIds, isDashScopeProviderAlias } from "./providers/dashscope.js";

type Env = Record<string, string | undefined>;

export interface ProviderOnboarding {
  provider: string;
  envVar: string;
  defaultModel: string;
}

/**
 * Curated onboarding table for the common providers: the canonical API-key env var (mirrors
 * pi-ai's internal `getApiKeyEnvVars`, which is not exported) plus a sane default model. The
 * default model is validated against the live pi-ai catalog at detect time, so a stale id
 * (e.g. after a pi-ai bump) degrades gracefully instead of producing an unrunnable spec.
 */
export const PROVIDER_ONBOARDING: ProviderOnboarding[] = [
  { provider: "anthropic", envVar: "ANTHROPIC_API_KEY", defaultModel: "claude-sonnet-4-0" },
  { provider: "openai", envVar: "OPENAI_API_KEY", defaultModel: "gpt-4.1" },
  { provider: "google", envVar: "GEMINI_API_KEY", defaultModel: "gemini-flash-latest" },
  { provider: "xai", envVar: "XAI_API_KEY", defaultModel: "grok-3" },
  { provider: "groq", envVar: "GROQ_API_KEY", defaultModel: "llama-3.3-70b-versatile" },
  { provider: "deepseek", envVar: "DEEPSEEK_API_KEY", defaultModel: "deepseek-v4-flash" },
  { provider: "moonshotai", envVar: "MOONSHOT_API_KEY", defaultModel: "kimi-k2-0905-preview" },
];

/** Canonical env var to set for a provider, for actionable "set X" errors. Covers the curated
 *  providers + the DashScope alias; undefined for exotic providers we don't document by name. */
export function envVarForProvider(provider: string): string | undefined {
  if (isDashScopeProviderAlias(provider)) return "DASHSCOPE_API_KEY";
  return PROVIDER_ONBOARDING.find((p) => p.provider === provider)?.envVar;
}

function safeModelIds(provider: string): string[] {
  try {
    return getModels(provider as never).map((m) => m.id);
  } catch {
    return [];
  }
}

export interface DetectedModel {
  spec: string;
  envVar: string;
}

/**
 * When no `--model`/`HARNESS_PI_MODEL` is given, pick the first provider — in PROVIDER_ONBOARDING
 * priority order, then the DashScope alias — whose API key is present in `env`, and return a
 * runnable `provider:modelId` spec. The curated default model is validated against the catalog;
 * if it rotted out of this pi-ai version, falls back to the newest catalog id. Returns undefined
 * when no known provider key is configured.
 */
export function detectDefaultModel(env: Env = process.env): DetectedModel | undefined {
  for (const entry of PROVIDER_ONBOARDING) {
    if (!env[entry.envVar]) continue;
    const ids = safeModelIds(entry.provider);
    const model = ids.includes(entry.defaultModel) ? entry.defaultModel : ids[ids.length - 1];
    if (model) return { spec: `${entry.provider}:${model}`, envVar: entry.envVar };
  }
  if (env.DASHSCOPE_API_KEY || env.QWEN_API_KEY) {
    return {
      spec: "qwen:qwen-plus",
      envVar: env.DASHSCOPE_API_KEY ? "DASHSCOPE_API_KEY" : "QWEN_API_KEY",
    };
  }
  return undefined;
}

/**
 * Parse a `.env` file into `env`: one `KEY=VALUE` per line, `#` comments and blanks skipped,
 * surrounding single/double quotes stripped. Does NOT override already-set variables — the real
 * process environment always wins. Returns the names it actually set (for an optional log line).
 */
export function loadDotEnv(path: string, env: Env = process.env): string[] {
  if (!existsSync(path)) return [];
  const set: string[] = [];
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      val.length >= 2 &&
      ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
    ) {
      val = val.slice(1, -1);
    }
    if (env[key] === undefined) {
      env[key] = val;
      set.push(key);
    }
  }
  return set;
}

/** Human-readable provider catalog for `--list-providers`, marking which keys are detected. */
export function formatProviderList(env: Env = process.env): string {
  const lines = ["Providers (★ = API key detected in your environment):", ""];
  const curated = new Set(PROVIDER_ONBOARDING.map((p) => p.provider));
  for (const p of PROVIDER_ONBOARDING) {
    lines.push(`  ${env[p.envVar] ? "★" : " "} ${p.provider.padEnd(12)} ${p.envVar}`);
  }
  const rest = (getProviders() as string[]).filter((p) => !curated.has(p));
  if (rest.length > 0) {
    lines.push("", "  Other pi-ai providers (set that provider's own API key env var):");
    lines.push("    " + rest.join(", "));
  }
  lines.push(
    "",
    "  DashScope/Qwen: use `qwen:<model>` or `dashscope:<model>` with DASHSCOPE_API_KEY (or QWEN_API_KEY).",
    "",
    "Run `hpi --list-models <provider>` for model ids, then pick one with `--model <provider>:<id>`.",
  );
  return lines.join("\n");
}

/** Model-id list for `--list-models <provider>`. */
export function formatModelList(provider: string): string {
  if (isDashScopeProviderAlias(provider)) {
    return `Models for ${provider} (DashScope):\n  ` + dashScopeModelIds().join("\n  ");
  }
  const ids = safeModelIds(provider);
  if (ids.length === 0) {
    return `Unknown provider "${provider}". Run \`hpi --list-providers\` to see the catalog.`;
  }
  return `Models for ${provider} (${ids.length}):\n  ` + ids.join("\n  ");
}
