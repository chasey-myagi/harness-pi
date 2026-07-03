import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  Type,
  getModels,
  getProviders,
  validateToolArguments,
  type Static,
  type Tool,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { dashScopeModelIds, isDashScopeProviderAlias } from "./providers/dashscope.js";

type Env = Record<string, string | undefined>;

const AgentFeaturesSchema = Type.Object(
  {
    permission: Type.Union([Type.Literal("ask"), Type.Literal("off")]),
    persistence: Type.Boolean(),
    strictPersistence: Type.Boolean(),
    compaction: Type.Union([
      Type.Literal("summarize"),
      Type.Literal("auto"),
      Type.Literal("off"),
    ]),
    sessionLog: Type.Boolean(),
    metrics: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type AgentFeatures = Static<typeof AgentFeaturesSchema>;

export const DEFAULT_AGENT_FEATURES: AgentFeatures = {
  permission: "ask",
  persistence: true,
  strictPersistence: true,
  compaction: "summarize",
  sessionLog: true,
  metrics: false,
};

export interface ConfigDiagnostic {
  source: "project" | "env" | "validation";
  path?: string | undefined;
  key?: string | undefined;
  message: string;
}

export interface ResolvedAgentFeatures {
  features: AgentFeatures;
  diagnostics: ConfigDiagnostic[];
  projectConfigPath: string;
}

export interface ResolveAgentFeaturesOptions {
  cwd: string;
  cli?: Partial<AgentFeatures> | undefined;
  env?: Env | undefined;
}

const featureKeys = new Set([
  "permission",
  "persistence",
  "strictPersistence",
  "compaction",
  "sessionLog",
  "metrics",
]);

const agentFeaturesValidatorTool: Tool = {
  name: "agentFeatures",
  description: "Validate hpi AgentFeatures config.",
  parameters: AgentFeaturesSchema,
};

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

export function resolveAgentFeatures(
  opts: ResolveAgentFeaturesOptions,
): ResolvedAgentFeatures {
  const diagnostics: ConfigDiagnostic[] = [];
  const projectConfigPath = join(resolve(opts.cwd), ".hpi.json");
  const project = readProjectAgentFeatures(projectConfigPath, diagnostics);
  const env = agentFeaturesFromEnv(opts.env ?? process.env, diagnostics);
  const merged = {
    ...DEFAULT_AGENT_FEATURES,
    ...project,
    ...(opts.cli ?? {}),
    ...env,
  };
  const validation = validateAgentFeatures(merged);
  if (validation.ok) {
    return {
      features: validation.features,
      diagnostics,
      projectConfigPath,
    };
  }
  return {
    features: DEFAULT_AGENT_FEATURES,
    diagnostics: [...diagnostics, ...validation.diagnostics],
    projectConfigPath,
  };
}

export function formatConfigDiagnostics(diagnostics: ConfigDiagnostic[]): string[] {
  return diagnostics.map((diagnostic) => {
    const where = diagnostic.path ?? diagnostic.key ?? diagnostic.source;
    return `[config:${diagnostic.source}:${where}] ${diagnostic.message}`;
  });
}

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

function validateAgentFeatures(value: unknown):
  | { ok: true; features: AgentFeatures }
  | { ok: false; diagnostics: ConfigDiagnostic[] } {
  try {
    const toolCall: ToolCall = {
      type: "toolCall",
      id: "agentFeatures",
      name: "agentFeatures",
      arguments: value as ToolCall["arguments"],
    };
    const features = validateToolArguments(
      agentFeaturesValidatorTool,
      toolCall,
    ) as AgentFeatures;
    return { ok: true, features };
  } catch (err) {
    return {
      ok: false,
      diagnostics: [
        {
          source: "validation",
          message: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }
}

function readProjectAgentFeatures(
  path: string,
  diagnostics: ConfigDiagnostic[],
): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    diagnostics.push({
      source: "project",
      path,
      message: `could not read .hpi.json: ${err instanceof Error ? err.message : String(err)}`,
    });
    return {};
  }
  if (!isRecord(raw)) {
    diagnostics.push({
      source: "project",
      path,
      message: ".hpi.json must contain a JSON object",
    });
    return {};
  }
  const candidate = "features" in raw ? raw.features : directFeatureObject(raw);
  if (candidate === undefined) return {};
  if (!isRecord(candidate)) {
    return { features: candidate };
  }
  return candidate;
}

function directFeatureObject(value: Record<string, unknown>): Record<string, unknown> | undefined {
  return Object.keys(value).some((key) => featureKeys.has(key)) ? value : undefined;
}

function agentFeaturesFromEnv(
  env: Env,
  diagnostics: ConfigDiagnostic[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  setEnvEnum(out, env, "permission", "HARNESS_PI_FEATURE_PERMISSION");
  setEnvEnum(out, env, "compaction", "HARNESS_PI_FEATURE_COMPACTION");
  setEnvBoolean(out, env, diagnostics, "persistence", "HARNESS_PI_FEATURE_PERSISTENCE");
  setEnvBoolean(
    out,
    env,
    diagnostics,
    "strictPersistence",
    "HARNESS_PI_FEATURE_STRICT_PERSISTENCE",
  );
  setEnvBoolean(out, env, diagnostics, "sessionLog", "HARNESS_PI_FEATURE_SESSION_LOG");
  setEnvBoolean(out, env, diagnostics, "metrics", "HARNESS_PI_FEATURE_METRICS");
  return out;
}

function setEnvEnum(
  out: Record<string, unknown>,
  env: Env,
  key: keyof AgentFeatures,
  envName: string,
): void {
  const value = env[envName];
  if (value !== undefined) out[key] = value;
}

function setEnvBoolean(
  out: Record<string, unknown>,
  env: Env,
  diagnostics: ConfigDiagnostic[],
  key: keyof AgentFeatures,
  envName: string,
): void {
  const value = env[envName];
  if (value === undefined) return;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    out[key] = true;
    return;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    out[key] = false;
    return;
  }
  diagnostics.push({
    source: "env",
    key: envName,
    message: `expected boolean env value, got "${value}"`,
  });
  out[key] = value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
