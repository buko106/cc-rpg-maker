import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// M5 の完了条件（docs/13-editor-ui.md）：
// 新規プロジェクト → タイル描画 → イベント作成（ShowText）→ 保存 → リロード → テストプレイでメッセージが出る。
const EDITOR = "http://127.0.0.1:4174/";

interface EditorHandle {
  doc: { revision: number; project: { meta: { id: string }; system: { startX: number; startY: number } }; maps: Record<string, { width: number; layers: { tiles: number[] }[]; events: Record<string, { x: number; y: number; pages: { commands: { code: string; params: Record<string, unknown> }[] }[] }> }> };
  dirty: boolean;
  canUndo: boolean;
  saveStatus: { kind: string };
}
declare global {
  interface Window {
    __editor: EditorHandle;
    __rpgPlaytest: { getState(): { scene: { kind: string }; message: { open: boolean; text: string }; map: { player: { x: number; y: number } } } };
  }
}

const editor = <T>(page: Page, f: (s: EditorHandle) => T): Promise<T> => page.evaluate(`(${f.toString()})(window.__editor)`) as Promise<T>;

/** マップキャンバスの、セル (x, y) の中心の画面座標。 */
async function cellCenter(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = await page.getByRole("application").boundingBox();
  if (box === null) throw new Error("キャンバスが無い");
  const cols = await editor(page, (s) => Object.values(s.doc.maps)[0]!.width);
  const rows = await editor(page, (s) => Object.values(s.doc.maps)[0]!.layers[0]!.tiles.length / Object.values(s.doc.maps)[0]!.width);
  return { x: box.x + ((x + 0.5) / cols) * box.width, y: box.y + ((y + 0.5) / rows) * box.height };
}

test.beforeEach(async ({ page }) => {
  await page.goto(EDITOR);
  // 前のテストのプロジェクトが残らないように IndexedDB を消す
  await page.evaluate(() => new Promise<void>((resolve) => Object.assign(indexedDB.deleteDatabase("rpg-projects"), { onsuccess: () => resolve(), onerror: () => resolve(), onblocked: () => resolve() })));
  await page.reload();
});

async function createProject(page: Page, title: string): Promise<void> {
  await page.getByLabel("新しいプロジェクトの名前").fill(title);
  await page.getByRole("button", { name: "新規作成" }).click();
  await expect(page.getByRole("application")).toBeVisible();
}

test("新規作成 → タイル描画 → イベント（ShowText）→ 保存 → リロード → テストプレイでメッセージが出る", async ({ page }) => {
  await createProject(page, "E2E のゲーム");

  // タイル描画：砂（タイル 3）を選んで、(0,0)→(3,0) をドラッグ
  await page.getByRole("button", { name: "タイル 3", exact: true }).click();
  const from = await cellCenter(page, 0, 0);
  const to = await cellCenter(page, 3, 0);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
  expect(await editor(page, (s) => Object.values(s.doc.maps)[0]!.layers[0]!.tiles.slice(0, 5))).toEqual([3, 3, 3, 3, 1]);

  // Undo / Redo はどの画面からでも効く
  await page.keyboard.press("Control+z");
  expect(await editor(page, (s) => Object.values(s.doc.maps)[0]!.layers[0]!.tiles.slice(0, 5))).toEqual([1, 1, 1, 1, 1]);
  await page.keyboard.press("Control+Shift+z");
  expect(await editor(page, (s) => Object.values(s.doc.maps)[0]!.layers[0]!.tiles[0])).toBe(3);

  // イベント：開始位置 (5,5) の真下 (5,6) に置く
  await page.getByRole("radio", { name: "イベント" }).click();
  const spot = await cellCenter(page, 5, 6);
  await page.mouse.click(spot.x, spot.y);
  await page.getByRole("button", { name: "イベントを編集…" }).click();
  await page.getByRole("button", { name: "コマンドを追加…" }).click();
  await page.getByRole("button", { name: "文章の表示" }).click();
  await page.getByLabel("本文").fill("こんにちは、E2E です。");
  await page.getByRole("button", { name: /^イベント：.*を閉じる$/ }).click();

  // 保存 → リロード → 開き直す
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "保存済み" })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "E2E のゲーム を開く" }).click();
  await expect(page.getByRole("application")).toBeVisible();
  expect(await editor(page, (s) => Object.values(s.doc.maps)[0]!.layers[0]!.tiles.slice(0, 5))).toEqual([3, 3, 3, 3, 1]);
  const event = await editor(page, (s) => Object.values(Object.values(s.doc.maps)[0]!.events)[0]);
  expect(event).toMatchObject({ x: 5, y: 6, pages: [{ commands: [{ code: "ShowText", params: { text: "こんにちは、E2E です。" } }] }] });

  // テストプレイ：タイトル → ニューゲーム → 下向きのまま決定キーでイベントに話しかける
  await page.getByRole("button", { name: "テストプレイ", exact: true }).click();
  await page.waitForFunction(() => window.__rpgPlaytest !== undefined && window.__rpgPlaytest.getState().scene.kind === "title");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__rpgPlaytest.getState().scene.kind === "map");
  await page.waitForTimeout(200);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__rpgPlaytest.getState().message.open);
  expect(await page.evaluate(() => window.__rpgPlaytest.getState().message.text)).toBe("こんにちは、E2E です。");
});

test("自動保存：編集して待つだけで保存され、リロードしても残る", async ({ page }) => {
  await createProject(page, "自動保存");
  await page.getByRole("button", { name: "タイル 4", exact: true }).click();
  const cell = await cellCenter(page, 2, 2);
  await page.mouse.click(cell.x, cell.y);
  expect(await editor(page, (s) => s.dirty)).toBe(true);
  await page.waitForFunction(() => window.__editor.dirty === false, undefined, { timeout: 5000 });
  await page.reload();
  await page.getByRole("button", { name: "自動保存 を開く" }).click();
  await expect(page.getByRole("application")).toBeVisible();
  expect(await editor(page, (s) => Object.values(s.doc.maps)[0]!.layers[0]!.tiles[2 * 20 + 2])).toBe(4);
});

test("データベースにアクターを追加し、参照されているアクターの削除は確認される", async ({ page }) => {
  await createProject(page, "DB");
  await page.getByRole("button", { name: "データベース" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "＋ 追加" }).click();
  await expect(page.getByRole("list", { name: "アクターの一覧" }).getByRole("button")).toHaveCount(2);
  await page.getByLabel("名前", { exact: true }).fill("魔法使い");
  // 最初のアクター（初期パーティが参照している）を選んで削除 → 確認ダイアログ
  await page.getByRole("list", { name: "アクターの一覧" }).getByRole("button", { name: "勇者" }).click();
  await page.getByRole("button", { name: "削除", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "削除の確認" })).toBeVisible();
  await page.getByRole("button", { name: "キャンセル" }).click();
  await expect(page.getByRole("list", { name: "アクターの一覧" }).getByRole("button")).toHaveCount(2);
});
