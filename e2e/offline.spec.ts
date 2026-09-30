import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { exportAs, serve, unzip } from "./helpers.js";

// M7：フォルダ形式の Service Worker によるオフライン化（docs/15-player-export.md）。
// エディタで「オフラインでも遊べるようにする」を付けて書き出し、別オリジンで一度開いたあと、サーバを止めて（ネットワークも切って）
// 開き直しても遊べることを確かめる。
const EDITOR = "http://127.0.0.1:4174/";

test("オフライン対応で書き出したゲームは、一度開けば、サーバを止めても開き直して遊べる", async ({ page, browser }, testInfo) => {
  test.setTimeout(90_000);
  await page.goto(EDITOR);
  await page.evaluate(() => new Promise<void>((resolve) => Object.assign(indexedDB.deleteDatabase("rpg-projects"), { onsuccess: () => resolve(), onerror: () => resolve(), onblocked: () => resolve() })));
  await page.reload();
  await page.getByLabel("新しいプロジェクトの名前").fill("オフラインのゲーム");
  await page.getByRole("button", { name: "新規作成" }).click();
  await expect(page.getByRole("application")).toBeVisible();

  const zipPath = testInfo.outputPath("offline.zip");
  await exportAs(page, /フォルダ形式/, zipPath, { offline: true });
  const files = unzip(readFileSync(zipPath));
  expect(files.has("sw.js")).toBe(true);
  expect(files.get("index.html")!.toString("utf8")).toContain("serviceWorker");

  const server = await serve(files);
  const context = await browser.newContext();
  const game = await context.newPage();
  const errors: string[] = [];
  game.on("pageerror", (e) => errors.push(e.message));
  try {
    // 1 回目：オンライン。Service Worker が全ファイルをキャッシュして有効になるまで待つ
    await game.goto(`${server.origin}/`);
    await game.waitForFunction("window.__rpg !== undefined && window.__rpg.getState().scene.kind === 'title'");
    await game.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    const cached = await game.evaluate(async () => {
      const names = await caches.keys();
      const cache = await caches.open(names.find((n) => n.startsWith("rpg-"))!);
      return (await cache.keys()).map((r) => new URL(r.url).pathname);
    });
    expect(cached).toEqual(expect.arrayContaining(["/", "/index.html", "/player.js", "/project/project.json", "/project/maps/map_001.json"]));
    expect(cached.some((p) => /^\/assets\/[0-9a-f]{16}\.png$/.test(p))).toBe(true);
  } finally {
    await server.close(); // 以降、サーバは無い
  }

  // 2 回目：サーバは止まっていて、ネットワークも切る → Service Worker のキャッシュから起動する
  await context.setOffline(true);
  await game.reload();
  await game.waitForFunction("window.__rpg !== undefined && window.__rpg.getState().scene.kind === 'title'");
  await game.keyboard.press("Enter");
  await game.waitForFunction("window.__rpg.getState().scene.kind === 'map'");
  expect(errors).toEqual([]);
  await context.close();
});
