import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeModel } from "@harness-pi/core/testing";
import { makeReadOnlySubAgentSpawner } from "../cli.js";

const dirs: string[] = [];
async function repo(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "hpi-cli-multi-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe("makeReadOnlySubAgentSpawner (/multi 的真子代理执行器)", () => {
  it("clean stop → ok:true, extracts the assistant text", async () => {
    const cwd = await repo();
    const fake = createFakeModel([
      { content: [{ type: "text", text: "this file looks fine" }], stopReason: "stop" },
    ]);
    const spawn = makeReadOnlySubAgentSpawner(cwd, fake, undefined);
    const r = await spawn("analyze it", new AbortController().signal);
    expect(r).toEqual({ ok: true, text: "this file looks fine" });
    fake.teardown();
  });

  it("provider stream-error (reason stays 'done' but stopReason 'error') → ok:false", async () => {
    // 这正是只看 reason 会漏的坑：限流/报错被当流事件，run 仍 reason:done，但 lastMessage.stopReason=error。
    const cwd = await repo();
    const fake = createFakeModel([{ content: [], throwError: new Error("rate limited") }]);
    const spawn = makeReadOnlySubAgentSpawner(cwd, fake, undefined);
    const r = await spawn("analyze it", new AbortController().signal);
    expect(r.ok).toBe(false);
    fake.teardown();
  });

  it("empty-but-clean output falls back to '(no output)'", async () => {
    const cwd = await repo();
    const fake = createFakeModel([{ content: [], stopReason: "stop" }]);
    const spawn = makeReadOnlySubAgentSpawner(cwd, fake, undefined);
    const r = await spawn("analyze it", new AbortController().signal);
    expect(r.text).toBe("(no output)");
    fake.teardown();
  });
});
