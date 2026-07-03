import { describe, expect, it } from "vitest";
import {
  calculateCost,
  completeText,
  createUserMessage,
  getEnvApiKey,
  getModels,
  getProviders,
} from "../index.js";
import { createFakeModel } from "../testing.js";

describe("LLM seam exports", () => {
  it("runs an out-of-band text completion through a fake model", async () => {
    const model = createFakeModel([
      { content: [{ type: "text", text: "compressed context" }] },
    ]);

    try {
      const prompt = createUserMessage("summarize this");
      const text = await completeText(
        model,
        [prompt],
        { temperature: 0.2, providerExtras: { customOption: "kept" } },
      );

      expect(text).toBe("compressed context");
      expect(model.getCalls()).toHaveLength(1);
      expect(model.getCalls()[0]?.messages).toEqual([prompt]);
      expect(model.getCalls()[0]?.tools).toEqual([]);
    } finally {
      model.teardown();
    }
  });

  it("re-exports pi-ai catalog helpers from core", () => {
    const catalogHelpers = [
      getModels,
      getProviders,
      getEnvApiKey,
      calculateCost,
    ];

    for (const helper of catalogHelpers) {
      expect(typeof helper).toBe("function");
    }
  });
});
