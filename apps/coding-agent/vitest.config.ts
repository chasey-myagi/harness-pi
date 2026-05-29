import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@harness-pi\/core$/,
        replacement: resolve(repoRoot, "packages/core/src/index.ts"),
      },
      {
        find: /^@harness-pi\/core\/testing$/,
        replacement: resolve(repoRoot, "packages/core/src/testing.ts"),
      },
      {
        find: /^@harness-pi\/plugins$/,
        replacement: resolve(repoRoot, "packages/plugins/src/index.ts"),
      },
      {
        find: /^@harness-pi\/tools$/,
        replacement: resolve(repoRoot, "packages/tools/src/index.ts"),
      },
    ],
  },
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    environment: "node",
    testTimeout: 10_000,
  },
});
