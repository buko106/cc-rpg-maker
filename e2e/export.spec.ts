import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { exportAs, serve, unzip } from "./helpers.js";

// M6 の完了条件（docs/17-milestones.md）：エディタで作ったゲームを配布物にして、別オリジンで遊べる。
// エディタ（:4174）で作って書き出し、(1) フォルダ形式の ZIP を別のオリジンの静的サーバで配信、(2) 単一 HTML を file:// で開く。
// どちらも、タイトル → 開始 → 話しかける → セーブ → リロード → コンティニュー。単一 HTML は外部への通信が 0 件であることも確かめる。
const EDITOR = "http://127.0.0.1:4174/";
const TITLE = "配布のゲーム";
const LINE = "配布物からこんにちは。";

interface State {
  tick: number;
  scene: { kind: string; screen?: string };
  map: { mapId: string; player: { x: number; y: number; moving: boolean } };
  message: { open: boolean; text: string };
}
// player.spec.ts / editor.spec.ts が `Window` に別々の型を宣言しているので、ここでは型を宣言せず、ページ内の式は文字列で評価する。
const state = (page: Page): Promise<State> => page.evaluate("window.__rpg.getState()") as Promise<State>;
const rpg = (expr: string): string => `(() => { const s = window.__rpg.getState(); return ${expr}; })()`;

async function press(page: Page, key: string): Promise<void> {
  const tick = (await state(page)).tick;
  await page.keyboard.press(key);
  await page.waitForFunction(`window.__rpg.getState().tick >= ${tick + 3}`);
}

async function hold(page: Page, key: string, until: string): Promise<void> {
  await page.keyboard.down(key);
  await page.waitForFunction(rpg(until));
  await page.keyboard.up(key);
  await page.waitForFunction(rpg("!s.map.player.moving"));
}

/** 配布物を開いて遊ぶ：タイトル → 開始 → 話しかける → 左へ歩く → セーブ → リロード → コンティニュー。 */
async function play(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForFunction(`window.__rpg !== undefined && ${rpg('s.scene.kind === "title" && s.tick > 2')}`);
  await page.keyboard.press("Enter");
  await page.waitForFunction(rpg('s.scene.kind === "map" && s.tick > 5'));

  // 開始位置 (5,5) で下向き：真下 (5,6) のイベントに話しかける
  await press(page, "Enter");
  await page.waitForFunction(rpg("s.message.open"));
  expect((await state(page)).message.text).toBe(LINE);
  await press(page, "Enter");
  await page.waitForFunction(rpg("!s.message.open"));

  await hold(page, "ArrowLeft", "s.map.player.x === 3");
  await press(page, "m");
  await page.waitForFunction(rpg('s.scene.kind === "menu"'));
  await press(page, "ArrowDown");
  await press(page, "ArrowDown");
  await press(page, "Enter");
  await page.waitForFunction(rpg('s.scene.screen === "save"'));
  await press(page, "Enter");
  await page.evaluate("window.__rpg.settled()");

  await page.reload();
  await page.waitForFunction(`window.__rpg !== undefined && ${rpg('s.scene.kind === "title"')}`);
  await press(page, "ArrowDown");
  await press(page, "Enter");
  await page.waitForFunction(rpg('s.scene.screen === "continue"'));
  await press(page, "Enter");
  await page.waitForFunction(rpg('s.scene.kind === "map"'));
  await page.evaluate("window.__rpg.settled()");
  expect((await state(page)).map.player).toMatchObject({ x: 3, y: 5 });
  // 再開後も歩ける
  await hold(page, "ArrowRight", "s.map.player.x === 4");
}

test("エディタで作ったゲームを書き出し、別オリジンの静的サーバと file:// の単一 HTML で遊べる", async ({ page, browser }, testInfo) => {
  test.setTimeout(120_000);

  // ---- エディタで作る：新規作成 → イベント（話しかけると LINE が出る）を開始位置の真下に置く ----
  await page.goto(EDITOR);
  await page.evaluate(() => new Promise<void>((resolve) => Object.assign(indexedDB.deleteDatabase("rpg-projects"), { onsuccess: () => resolve(), onerror: () => resolve(), onblocked: () => resolve() })));
  await page.reload();
  await page.getByLabel("新しいプロジェクトの名前").fill(TITLE);
  await page.getByRole("button", { name: "新規作成" }).click();
  await expect(page.getByRole("application")).toBeVisible();

  await page.getByRole("radio", { name: "イベント" }).click();
  const box = (await page.getByRole("application").boundingBox())!;
  const map = (await page.evaluate("(() => { const m = Object.values(window.__editor.doc.maps)[0]; return { width: m.width, tiles: m.layers[0].tiles.length }; })()")) as { width: number; tiles: number };
  const rows = map.tiles / map.width;
  await page.mouse.click(box.x + ((5 + 0.5) / map.width) * box.width, box.y + ((6 + 0.5) / rows) * box.height);
  await page.getByRole("button", { name: "イベントを編集…" }).click();
  await page.getByRole("button", { name: "コマンドを追加…" }).click();
  await page.getByRole("button", { name: "文章の表示" }).click();
  await page.getByLabel("本文").fill(LINE);
  await page.getByRole("button", { name: /^イベント：.*を閉じる$/ }).click();

  // ---- 書き出し（未保存の変更は、書き出す前に自動で保存される） ----
  const zipPath = testInfo.outputPath("game.zip");
  const htmlPath = testInfo.outputPath("game.html");
  await exportAs(page, /フォルダ形式/, zipPath);
  await exportAs(page, /単一 HTML/, htmlPath);

  // ---- (1) フォルダ形式：ZIP の構造を確かめ、別のオリジンで配信して遊ぶ ----
  const files = unzip(readFileSync(zipPath));
  expect([...files.keys()]).toEqual(expect.arrayContaining(["index.html", "player.js", "project/project.json", "project/maps/map_001.json", "README.txt"]));
  expect([...files.keys()].some((n) => /^assets\/[0-9a-f]{16}\.png$/.test(n))).toBe(true);
  const server = await serve(files);
  try {
    const context = await browser.newContext();
    const other = await context.newPage();
    const errors: string[] = [];
    other.on("pageerror", (e) => errors.push(e.message));
    await play(other, `${server.origin}/`);
    expect(errors).toEqual([]);
    // 見た目：タイルが描かれている（真っ黒ではない）
    const drawn = await other.evaluate(() => {
      const canvas = document.querySelector("canvas") as HTMLCanvasElement;
      const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      let colored = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i]! + data[i + 1]! + data[i + 2]! > 30) colored++;
      return colored;
    });
    expect(drawn).toBeGreaterThan(1000);
    await context.close();
  } finally {
    await server.close();
  }

  // ---- (2) 単一 HTML：file:// で開く。外部への通信は 0 件 ----
  const context = await browser.newContext();
  const single = await context.newPage();
  const requests: string[] = [];
  single.on("request", (r) => requests.push(r.url()));
  const errors: string[] = [];
  single.on("pageerror", (e) => errors.push(e.message));
  await play(single, pathToFileURL(htmlPath).href);
  expect(errors).toEqual([]);
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.filter((u) => !u.startsWith("file://") && !u.startsWith("data:") && !u.startsWith("blob:"))).toEqual([]);
  await context.close();
});
