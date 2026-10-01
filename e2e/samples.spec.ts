import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { unzip } from "./helpers";

// プロジェクト一覧の「サンプルから作る」：エディタのビルドに同梱したデモの編集データ（samples/）を、新しいプロジェクトとして取り込む。
// 取り込んだプロジェクトは「ZIP」で編集データとして書き出せて、「ZIP から読み込む…」で取り込み直せる。
const EDITOR = "http://127.0.0.1:4174/";

// window.__editor / __rpgPlaytest の型は editor.spec.ts の declare global と衝突しないよう、ここでは局所的に読む
interface Handles {
  __editor: { doc: { project: { meta: { title: string } }; maps: Record<string, unknown> } };
  __rpgPlaytest?: { getState(): { scene: { kind: string }; map: { mapId: string } } };
}

test.beforeEach(async ({ page }) => {
  await page.goto(EDITOR);
  await page.evaluate(() => new Promise<void>((resolve) => Object.assign(indexedDB.deleteDatabase("rpg-projects"), { onsuccess: () => resolve(), onerror: () => resolve(), onblocked: () => resolve() })));
  await page.reload();
});

test("サンプル（はじまりの村・地下迷宮・バトルタワー・謎解きの館・おばけ屋敷の鬼ごっこ）が画面写真つきで並び、地下迷宮から作るとテストプレイで遊べる", async ({ page }) => {
  const samples = page.getByRole("list", { name: "サンプル" });
  await expect(samples.getByRole("listitem")).toHaveCount(5);
  await expect(samples.getByText("はじまりの村", { exact: true })).toBeVisible();
  await expect(samples.getByText("地下迷宮", { exact: true })).toBeVisible();
  await expect(samples.getByText("バトルタワー", { exact: true })).toBeVisible();
  await expect(samples.getByText("謎解きの館", { exact: true })).toBeVisible();
  await expect(samples.getByText("おばけ屋敷の鬼ごっこ", { exact: true })).toBeVisible();
  // 画面写真が読み込めている
  await expect.poll(() => samples.locator("img").evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).naturalWidth > 0))).toEqual([true, true, true, true, true]);

  await page.getByRole("button", { name: "地下迷宮 のサンプルから作る" }).click();
  await expect(page.getByRole("application")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as Handles).__editor.doc.project.meta.title)).toBe("デモ：地下迷宮");
  expect(await page.evaluate(() => Object.keys((window as unknown as Handles).__editor.doc.maps).length)).toBe(20);

  await page.getByRole("button", { name: "テストプレイ", exact: true }).click();
  await page.waitForFunction(() => (window as unknown as Handles).__rpgPlaytest?.getState().scene.kind === "title");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => (window as unknown as Handles).__rpgPlaytest!.getState().scene.kind === "map");
  expect(await page.evaluate(() => (window as unknown as Handles).__rpgPlaytest!.getState().map.mapId)).toBe("map_room01");
});

test("はじまりの村から作ったプロジェクトを ZIP に書き出し、ZIP から読み込み直せる", async ({ page }) => {
  await page.getByRole("button", { name: "はじまりの村 のサンプルから作る" }).click();
  await expect(page.getByRole("application")).toBeVisible();
  const maps = await page.evaluate(() => Object.keys((window as unknown as Handles).__editor.doc.maps).sort());
  await page.getByRole("button", { name: "← プロジェクト一覧" }).click();

  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "デモ：はじまりの村 を ZIP に書き出す" }).click();
  const download = await downloading;
  // ファイル名（「デモ：はじまりの村.zip」）は確かめない：ヘッドレスの Chromium は ASCII 以外のファイル名を "download" にする（名前はコンポーネントのテストで見る）
  const path = await download.path();
  const files = unzip(readFileSync(path));
  expect(files.has("project.json")).toBe(true);
  expect([...files.keys()].filter((n) => n.startsWith("maps/")).length).toBe(maps.length);
  expect([...files.keys()].some((n) => n.startsWith("assets/"))).toBe(true);

  await page.getByLabel("読み込む ZIP ファイル").setInputFiles(path);
  await expect(page.getByRole("application")).toBeVisible();
  expect(await page.evaluate(() => Object.keys((window as unknown as Handles).__editor.doc.maps).sort())).toEqual(maps);
  await page.getByRole("button", { name: "← プロジェクト一覧" }).click();
  await expect(page.getByRole("button", { name: "デモ：はじまりの村 を開く" })).toHaveCount(2);
});
