import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@heirloom/dsl": path.resolve(import.meta.dirname, "../dsl/src/index.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
