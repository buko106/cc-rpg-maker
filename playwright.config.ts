import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  retries: 0,
  reporter: process.env["CI"] ? [["github"], ["html", { open: "never" }]] : "list",
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  // プレイヤーを demo プロジェクト付きでビルドし、静的サーバで配信する（フォルダ形式）。
  webServer: {
    command: `node apps/player/scripts/build-web.mjs --project fixtures/projects/v1/demo && node tools/serve-static.mjs apps/player/dist-web ${PORT}`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env["CI"],
    timeout: 60_000,
  },
  // PR 必須は Chromium のみ（docs/16-testing.md）。Firefox/WebKit は nightly で追加する。
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
