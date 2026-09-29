import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Node 層（単体・プロパティ・契約・リプレイ・スナップショット）。ブラウザ層は Playwright（e2e/）。
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "tools/**/*.test.ts"],
    environment: "node",
  },
});
