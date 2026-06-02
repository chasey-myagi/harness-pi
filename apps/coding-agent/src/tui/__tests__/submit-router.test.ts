import { describe, it, expect } from "vitest";
import { routeSubmit } from "../submit-router.js";
import { defaultPermissionRules, READ_TOOLS, MUTATING_TOOLS } from "../permissions.js";

describe("routeSubmit (steering decision)", () => {
  it("empty / whitespace → ignore", () => {
    expect(routeSubmit("", false)).toEqual({ kind: "ignore" });
    expect(routeSubmit("   \n ", true)).toEqual({ kind: "ignore" });
  });

  it("non-empty while idle → run (trimmed)", () => {
    expect(routeSubmit("  do X  ", false)).toEqual({ kind: "run", text: "do X" });
  });

  it("non-empty while running → steer (trimmed)", () => {
    expect(routeSubmit("  also Y  ", true)).toEqual({ kind: "steer", text: "also Y" });
  });
});

describe("defaultPermissionRules", () => {
  it("read tools allow, mutating tools ask (first-match order)", () => {
    const rules = defaultPermissionRules();
    const decisionFor = (name: string): string | undefined =>
      rules.find((r) => r.match === name)?.decision;
    for (const t of READ_TOOLS) expect(decisionFor(t)).toBe("allow");
    for (const t of MUTATING_TOOLS) expect(decisionFor(t)).toBe("ask");
  });

  it("every rule is a plain string match (no surprise predicates in the default set)", () => {
    for (const r of defaultPermissionRules()) expect(typeof r.match).toBe("string");
  });
});
