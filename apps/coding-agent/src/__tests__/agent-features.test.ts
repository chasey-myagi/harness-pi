import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeModel } from "@harness-pi/core/testing";
import { createOptions, parseArgs } from "../cli.js";
import {
  DEFAULT_AGENT_FEATURES,
  resolveAgentFeatures,
  type AgentFeatures,
} from "../config.js";

const dirs: string[] = [];

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "hpi-features-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("AgentFeatures config chain", () => {
  it("merges defaults < .hpi.json < CLI flags < env vars", () => {
    const cwd = tmp();
    expect(resolveAgentFeatures({ cwd, env: {} }).features.permission).toBe(
      DEFAULT_AGENT_FEATURES.permission,
    );

    writeFileSync(
      join(cwd, ".hpi.json"),
      JSON.stringify({ features: { permission: "off" } }),
    );
    expect(resolveAgentFeatures({ cwd, env: {} }).features.permission).toBe("off");

    expect(
      resolveAgentFeatures({
        cwd,
        cli: { permission: "ask" },
        env: {},
      }).features.permission,
    ).toBe("ask");

    expect(
      resolveAgentFeatures({
        cwd,
        cli: { permission: "ask" },
        env: { HARNESS_PI_FEATURE_PERMISSION: "off" },
      }).features.permission,
    ).toBe("off");
  });

  it("reports TypeBox validation diagnostics and falls back to safe defaults", () => {
    const cwd = tmp();
    writeFileSync(
      join(cwd, ".hpi.json"),
      JSON.stringify({ features: { permission: "off", persistence: "definitely" } }),
    );

    const resolved = resolveAgentFeatures({ cwd, env: {} });

    expect(resolved.features).toEqual(DEFAULT_AGENT_FEATURES);
    expect(resolved.diagnostics.some((d) => d.source === "validation")).toBe(true);
    expect(resolved.diagnostics.map((d) => d.message).join("\n")).toContain("persistence");
  });
});

describe("AgentFeatures capability wiring", () => {
  it("drives persistence independently from args.tui", () => {
    const cwd = tmp();
    const model = createFakeModel([]);
    const runtime = { model };

    const headlessArgs = parseArgs(["--cwd", cwd, "do work"]);
    const headlessFeatures: AgentFeatures = {
      ...DEFAULT_AGENT_FEATURES,
      persistence: true,
      strictPersistence: true,
    };
    const headless = createOptions(
      headlessArgs,
      runtime,
      headlessFeatures,
      "headless-session",
    );
    expect(headlessArgs.tui).toBe(false);
    expect(headless.persistence?.sessionId).toBe("headless-session");
    expect(headless.strictPersistence).toBe(true);

    const tuiArgs = parseArgs(["--cwd", cwd, "--tui"]);
    const tuiFeatures: AgentFeatures = {
      ...DEFAULT_AGENT_FEATURES,
      persistence: false,
      strictPersistence: false,
    };
    const tui = createOptions(tuiArgs, runtime, tuiFeatures, "tui-session");
    expect(tuiArgs.tui).toBe(true);
    expect(tui.persistence).toBeUndefined();
    expect(tui.strictPersistence).toBeUndefined();

    model.teardown();
  });
});
