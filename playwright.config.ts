import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;
const EDITOR_PORT = 4174;
const DUNGEON_PORT = 4176;
const FISHING_PORT = 4177;
const HOKORA_PORT = 4178;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  retries: 0,
  reporter: process.env["CI"] ? [["github"], ["html", { open: "never" }]] : "list",
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  // プレイヤーを demo プロジェクト付きでビルドし、静的サーバで配信する（フォルダ形式）。
  webServer: [
    {
      command: `node apps/player/scripts/build-web.mjs --project fixtures/projects/v1/demo && node tools/serve-static.mjs apps/player/dist-web ${PORT}`,
      url: `http://127.0.0.1:${PORT}/`,
      reuseExistingServer: !process.env["CI"],
      timeout: 60_000,
    },
    // ダンジョンのデモ（プラグイン @rpg/plugin-dungeon を使う v2 のプロジェクト付きのプレイヤー）
    {
      command: `node apps/player/scripts/build-web.mjs --project fixtures/projects/v2/dungeon --out apps/player/dist-dungeon && node tools/serve-static.mjs apps/player/dist-dungeon ${DUNGEON_PORT}`,
      url: `http://127.0.0.1:${DUNGEON_PORT}/`,
      reuseExistingServer: !process.env["CI"],
      timeout: 60_000,
    },
    // 釣りのデモ（プラグイン @rpg/plugin-fishing を使う v2 のプロジェクト付きのプレイヤー）
    {
      command: `node apps/player/scripts/build-web.mjs --project fixtures/projects/v2/fishing --out apps/player/dist-fishing && node tools/serve-static.mjs apps/player/dist-fishing ${FISHING_PORT}`,
      url: `http://127.0.0.1:${FISHING_PORT}/`,
      reuseExistingServer: !process.env["CI"],
      timeout: 60_000,
    },
    // 走る機能（system.dash）のあるゲーム：デモ「ほこらの冒険」（操作パッドに走るボタンが出る）
    {
      command: `node apps/player/scripts/build-web.mjs --project fixtures/projects/v1/hokora --out apps/player/dist-hokora && node tools/serve-static.mjs apps/player/dist-hokora ${HOKORA_PORT}`,
      url: `http://127.0.0.1:${HOKORA_PORT}/`,
      reuseExistingServer: !process.env["CI"],
      timeout: 60_000,
    },
    // エディタ（プロジェクトはブラウザの IndexedDB に保存されるので、サーバ側は静的配信だけ）
    {
      command: `node apps/editor-ui/scripts/build-web.mjs && node tools/serve-static.mjs apps/editor-ui/dist-web ${EDITOR_PORT}`,
      url: `http://127.0.0.1:${EDITOR_PORT}/`,
      reuseExistingServer: !process.env["CI"],
      timeout: 60_000,
    },
  ],
  // PR 必須は Chromium のみ（docs/16-testing.md）。Firefox/WebKit は nightly で追加する。
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
