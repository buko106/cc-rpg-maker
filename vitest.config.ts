import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Node 層（単体・プロパティ・契約・リプレイ・スナップショット）。ブラウザ層は Playwright（e2e/）。
    include: ["packages/*/src/**/*.test.{ts,tsx}", "apps/*/src/**/*.test.{ts,tsx}", "tools/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      // text: ログ表示、lcov: Codecov への送信用（coverage/lcov.info）
      reporter: ["text", "lcov"],
      // 実装コードのみ。テスト・テストユーティリティ・型だけのファイルは除く。
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "packages/test-utils/**", "**/index.ts", "**/*.d.ts"],
      // docs/00-principles.md §4 / docs/16-testing.md: schema・core は 90%、その他は 70%
      thresholds: {
        "packages/schema/src/**": { statements: 90, branches: 85, functions: 90, lines: 90 },
        "packages/core/src/**": { statements: 90, branches: 85, functions: 90, lines: 90 },
        // それ以外の実装済みパッケージは 70%（未実装のパッケージは対象外。実装したマイルストーンで追加する）
        ...Object.fromEntries(
          ["runtime", "assets", "render-null", "render-canvas2d", "audio-null", "input-script", "input-browser", "save-store", "audio-webaudio", "project-store", "editor-core", "exporter", "plugin-api", "plugin-samples", "plugin-dungeon", "plugin-fishing", "render-webgl"].map((name) => [
            `packages/${name}/src/**`,
            { statements: 70, branches: 70, functions: 70, lines: 70 },
          ]),
        ),
      },
    },
  },
});
