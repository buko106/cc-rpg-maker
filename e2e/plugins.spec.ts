import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { exportAs, serve, unzip } from "./helpers.js";

// M7 の完了条件（docs/17-milestones.md）：プラグインが両アプリで動く。
// エディタでサンプルプラグイン（hud・custom-command）を有効にし、独自コマンドを置いて、
// (1) エディタのテストプレイ、(2) 書き出したゲーム（別オリジン）の両方で動くことを確かめる。
const EDITOR = "http://127.0.0.1:4174/";

/** ページ内の式を文字列で評価する（e2e の各ファイルが `Window` に別々の型を宣言しているため）。 */
const evalIn = <T>(page: Page, expr: string): Promise<T> => page.evaluate(expr) as Promise<T>;
const rpgWait = (page: Page, global: string, expr: string): Promise<unknown> => page.waitForFunction(`window.${global} !== undefined && (() => { const s = window.${global}.getState(); return ${expr}; })()`);

interface Snapshot {
  gold: number;
  twice: number | undefined;
  hudTexts: string[];
}
const snapshot = (page: Page, global: string): Promise<Snapshot> =>
  evalIn<Snapshot>(
    page,
    `(() => {
      const rt = window.${global};
      const s = rt.getState();
      const texts = (nodes) => nodes.flatMap((n) => (n.kind === "text" ? [n.text] : n.kind === "window" ? texts(n.children) : []));
      return { gold: s.party.gold, twice: s.variables.var_twice, hudTexts: texts(rt.project().ui) };
    })()`,
  );

async function talkToChest(page: Page, global: string): Promise<void> {
  await rpgWait(page, global, 's.scene.kind === "title" && s.tick > 2');
  await page.keyboard.press("Enter");
  await rpgWait(page, global, 's.scene.kind === "map" && s.tick > 5');
  await page.waitForTimeout(200);
  await page.keyboard.press("Enter"); // 開始位置 (5,5) で下向き → 真下 (5,6) の箱に話しかける
  await rpgWait(page, global, "s.party.gold > 0"); // 独自コマンドが所持金を増やす
}

test("サンプルプラグインを有効にして、エディタのテストプレイと書き出したゲームの両方で動く", async ({ page, browser }, testInfo) => {
  test.setTimeout(120_000);
  await page.goto(EDITOR);
  await page.evaluate(() => new Promise<void>((resolve) => Object.assign(indexedDB.deleteDatabase("rpg-projects"), { onsuccess: () => resolve(), onerror: () => resolve(), onblocked: () => resolve() })));
  await page.reload();
  await page.getByLabel("新しいプロジェクトの名前").fill("プラグインのゲーム");
  await page.getByRole("button", { name: "新規作成" }).click();
  await expect(page.getByRole("application")).toBeVisible();

  // ---- システム設定 → プラグイン：hud を有効にして、ラベルを変える。custom-command も有効にする ----
  await page.getByRole("button", { name: "システム", exact: true }).click();
  await page.getByRole("tab", { name: "プラグイン" }).click();
  await page.getByRole("checkbox", { name: "hud を有効にする" }).check();
  await page.getByLabel("hud の設定（JSON）").fill('{"label":"ゴールド"}');
  await page.getByRole("checkbox", { name: "custom-command を有効にする" }).check();
  await page.getByRole("dialog", { name: "システム" }).getByRole("button", { name: "システムを閉じる" }).click();

  // ---- 開始位置の真下に箱（イベント）を置き、独自コマンドを追加する ----
  await page.getByRole("radio", { name: "イベント" }).click();
  const box = (await page.getByRole("application").boundingBox())!;
  const map = await evalIn<{ width: number; tiles: number }>(page, "(() => { const m = Object.values(window.__editor.doc.maps)[0]; return { width: m.width, tiles: m.layers[0].tiles.length }; })()");
  await page.mouse.click(box.x + ((5 + 0.5) / map.width) * box.width, box.y + ((6 + 0.5) / (map.tiles / map.width)) * box.height);
  await page.getByRole("button", { name: "イベントを編集…" }).click();
  await page.getByRole("button", { name: "コマンドを追加…" }).click();
  await page.getByRole("button", { name: "ランダムな所持金" }).click();
  await page.getByLabel("min").fill("10");
  await page.getByLabel("max").fill("20");
  await page.getByRole("button", { name: /^イベント：.*を閉じる$/ }).click();
  // プラグインの診断は出ない（有効にしてあり、範囲も正しい）
  expect(await evalIn<string[]>(page, "window.__editor.validate().map((d) => d.code)")).not.toEqual(expect.arrayContaining(["pluginNotEnabled", "randomGoldRange"]));

  // ---- (1) エディタのテストプレイ ----
  await page.getByRole("button", { name: "テストプレイ", exact: true }).click();
  await talkToChest(page, "__rpgPlaytest");
  const inEditor = await snapshot(page, "__rpgPlaytest");
  expect(inEditor.gold).toBeGreaterThanOrEqual(10);
  expect(inEditor.gold).toBeLessThanOrEqual(20);
  expect(inEditor.hudTexts).toContain(`${inEditor.gold} ゴールド`);
  await page.keyboard.press("Escape"); // テストプレイを閉じる

  // ---- (2) 書き出したゲームを別のオリジンで ----
  const zipPath = testInfo.outputPath("game.zip");
  await exportAs(page, /フォルダ形式/, zipPath);
  const files = unzip(readFileSync(zipPath));
  const project = JSON.parse(files.get("project/project.json")!.toString("utf8")) as { formatVersion: number; system: { plugins: { name: string; params: unknown }[] } };
  expect(project.formatVersion).toBe(2);
  expect(project.system.plugins).toEqual([
    { name: "hud", version: "1.0.0", params: { label: "ゴールド" } },
    { name: "custom-command", version: "1.0.0", params: {} },
  ]);
  const server = await serve(files);
  try {
    const context = await browser.newContext();
    const other = await context.newPage();
    const errors: string[] = [];
    other.on("pageerror", (e) => errors.push(e.message));
    await other.goto(`${server.origin}/`);
    await talkToChest(other, "__rpg");
    const shipped = await snapshot(other, "__rpg");
    expect(shipped.gold).toBeGreaterThanOrEqual(10);
    expect(shipped.gold).toBeLessThanOrEqual(20);
    expect(shipped.hudTexts).toContain(`${shipped.gold} ゴールド`);
    expect(errors).toEqual([]);
    await context.close();
  } finally {
    await server.close();
  }
});
