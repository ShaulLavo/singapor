import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    browser: {
      headless: true,
      provider: "playwright",
      instances: [{ browser: "chromium" }],
    },
    environmentMatchGlobs: [["test/treeSitter-worker.test.ts", "happy-dom"]],
  },
});
