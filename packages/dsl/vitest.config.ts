import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      // 统一模块实例：夹具经 dist 解析会得到第二份 registry
      "@heirloom/dsl": path.resolve(import.meta.dirname, "src/index.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
