import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  retries: 0,
  reporter: process.env["CI"] ? [["github"], ["html", { open: "never" }]] : "list",
  // PR 必須は Chromium のみ（docs/16-testing.md）。Firefox/WebKit は nightly で追加する。
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
