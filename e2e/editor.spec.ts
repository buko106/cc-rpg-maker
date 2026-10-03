import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { startNewGame } from "./helpers.js";

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

test("イベントの入力の手間を減らす：文章をすぐ追加・コマンドの絞り込み・スイッチをその場で作成 → テストプレイで選択肢の分岐が動く", async ({ page }) => {
  await createProject(page, "かんたん入力");
  await page.getByRole("radio", { name: "イベント" }).click();
  const spot = await cellCenter(page, 5, 6);
  await page.mouse.click(spot.x, spot.y);
  await page.getByRole("button", { name: "イベントを編集…" }).click();
  const rows = page.getByRole("listbox", { name: "イベントコマンド" }).getByRole("option");
  const commands = () => editor(page, (s) => Object.values(Object.values(s.doc.maps)[0]!.events)[0]!.pages[0]!.commands);

  // 文章をすぐ追加：Shift+Enter で改行、Enter で「文章の表示」が入る
  const quick = page.getByLabel("文章をすぐ追加");
  await quick.fill("いらっしゃい");
  await quick.press("Shift+Enter");
  await quick.pressSequentially("宿屋へようこそ");
  await quick.press("Enter");
  await expect(quick).toHaveValue("");
  expect(await commands()).toMatchObject([{ code: "ShowText", params: { text: "いらっしゃい\n宿屋へようこそ" } }]);

  // コマンドの追加：打って絞り込み、Enter で先頭を追加。選択肢は「はい / いいえ」で入り、1 つ目の欄を打ち替えられる
  await page.getByRole("button", { name: "コマンドを追加…" }).click();
  await page.keyboard.type("選択肢");
  await page.keyboard.press("Enter");
  await expect(rows).toHaveText(["文章：いらっしゃい", "選択肢：はい / いいえ", "[はい] のとき", "[いいえ] のとき", "分岐終了"]);
  await page.keyboard.type("泊まる");
  await expect(rows.nth(2)).toHaveText("[泊まる] のとき");

  // 「[泊まる] のとき」の中に「スイッチの操作」を入れ、スイッチをその場で作る
  await rows.nth(2).click();
  await page.getByRole("button", { name: "コマンドを追加…" }).click();
  await page.keyboard.type("スイッチの操作");
  await page.keyboard.press("Enter");
  await page.getByRole("combobox", { name: "対象 1" }).selectOption({ label: "＋ 新しいスイッチ…" });
  await page.getByLabel("新しいスイッチの名前").fill("泊まった");
  await page.getByLabel("新しいスイッチの名前").press("Enter");
  await expect(rows.nth(3)).toHaveText("スイッチ 泊まった = ON");
  expect(await editor(page, (s) => (s.doc.project as unknown as { switches: unknown }).switches)).toEqual({ sw_001: { name: "泊まった" } });
  expect((await commands())[3]).toMatchObject({ code: "ControlSwitches", params: { ids: ["sw_001"], value: true }, indent: 1 });

  // 作成と選択は 1 回の Undo で戻り、Redo でそろって戻る
  await page.keyboard.press("Control+z");
  expect(await editor(page, (s) => (s.doc.project as unknown as { switches: unknown }).switches)).toEqual({});
  await page.keyboard.press("Control+Shift+z");
  expect((await commands())[3]).toMatchObject({ params: { ids: ["sw_001"] } });
  await page.getByRole("button", { name: /^イベント：.*を閉じる$/ }).click();

  // テストプレイ：話しかける → 文章 → 「泊まる」を選ぶとスイッチが入る
  await page.getByRole("button", { name: "テストプレイ", exact: true }).click();
  await page.waitForFunction(() => window.__rpgPlaytest !== undefined && window.__rpgPlaytest.getState().scene.kind === "title");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__rpgPlaytest.getState().scene.kind === "map");
  await page.waitForTimeout(200);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__rpgPlaytest.getState().message.open);
  expect(await page.evaluate(() => window.__rpgPlaytest.getState().message.text)).toBe("いらっしゃい\n宿屋へようこそ");
  await page.keyboard.press("Enter");
  await page.waitForFunction("window.__rpgPlaytest.getState().message.choices !== null");
  await page.waitForTimeout(200);
  await page.keyboard.press("Enter");
  await page.waitForFunction("window.__rpgPlaytest.getState().switches.sw_001 === true");
});

test("コマンドの並べ替え・複数選択・コピー＆貼り付け → Undo で戻り、テストプレイでは並べ替えた順に話す", async ({ page }) => {
  await createProject(page, "並べ替え");
  await page.getByRole("radio", { name: "イベント" }).click();
  const spot = await cellCenter(page, 5, 6);
  await page.mouse.click(spot.x, spot.y);
  await page.getByRole("button", { name: "イベントを編集…" }).click();
  const rows = page.getByRole("listbox", { name: "イベントコマンド" }).getByRole("option");
  const status = page.locator(".command-actions").getByRole("status");
  const texts = () => editor(page, (s) => Object.values(Object.values(s.doc.maps)[0]!.events)[0]!.pages[0]!.commands.map((c) => String(c.params["text"])));

  const quick = page.getByLabel("文章をすぐ追加");
  for (const line of ["一つ目", "二つ目", "三つ目"]) {
    await quick.fill(line);
    await quick.press("Enter");
  }
  expect(await texts()).toEqual(["一つ目", "二つ目", "三つ目"]);

  // 「二つ目」を上へ → ボタンで入れ替わり、選択も一緒に動く
  await rows.nth(1).click();
  await page.getByRole("button", { name: "コマンドを上へ" }).click();
  expect(await texts()).toEqual(["二つ目", "一つ目", "三つ目"]);
  await expect(rows.nth(0)).toHaveAttribute("aria-selected", "true");

  // Shift+↓ で先頭から 2 行を選び、Ctrl+C。最後の行を選んで Ctrl+V → 後ろに 2 行が並ぶ
  await rows.nth(0).click();
  await page.keyboard.press("Shift+ArrowDown");
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(status).toContainText("2 行を選択中");
  await page.keyboard.press("Control+c");
  await expect(status).toContainText("クリップボード：2 行");
  await rows.nth(2).click();
  await page.keyboard.press("Control+v");
  expect(await texts()).toEqual(["二つ目", "一つ目", "三つ目", "二つ目", "一つ目"]);

  // Alt+↑ で貼った範囲をひとつ上へ。Undo を 2 回で貼り付けの前に戻る
  await page.keyboard.press("Alt+ArrowUp");
  expect(await texts()).toEqual(["二つ目", "一つ目", "二つ目", "一つ目", "三つ目"]);
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  expect(await texts()).toEqual(["二つ目", "一つ目", "三つ目"]);
  await page.getByRole("button", { name: /^イベント：.*を閉じる$/ }).click();

  // テストプレイ：話しかけると、並べ替えた順（二つ目が最初）に出る
  await page.getByRole("button", { name: "テストプレイ", exact: true }).click();
  await page.waitForFunction(() => window.__rpgPlaytest !== undefined && window.__rpgPlaytest.getState().scene.kind === "title");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__rpgPlaytest.getState().scene.kind === "map");
  await page.waitForTimeout(200);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__rpgPlaytest.getState().message.open);
  expect(await page.evaluate(() => window.__rpgPlaytest.getState().message.text)).toBe("二つ目");
});

test("イベントのひな形：宝箱（お金）と扉（移動先はマップのクリックで選ぶ）を置く → テストプレイで手に入り、扉で移動する", async ({ page }) => {
  await createProject(page, "ひな形");
  const events = () => editor(page, (s) => Object.values(Object.values(s.doc.maps)[0]!.events));

  // 宝箱：開始位置 (5, 5) の真下に置く。中身をお金に切り替える
  await page.getByLabel("置くイベント").selectOption({ label: "宝箱" });
  const below = await cellCenter(page, 5, 6);
  await page.mouse.click(below.x, below.y);
  const chest = page.getByRole("dialog", { name: "ひな形から作成：宝箱" });
  await expect(chest.getByRole("button", { name: "作成", exact: true })).toBeDisabled(); // アイテムが無いので、まだ作れない
  await chest.getByLabel("中身の種類").selectOption({ label: "お金" });
  await chest.getByLabel("中身 金額").fill("120");
  await chest.getByRole("button", { name: "作成", exact: true }).click();
  await expect(chest).toBeHidden();

  // 扉：開始位置の左に置き、移動先はプレビューの (15, 10) をクリックして選ぶ
  await page.getByLabel("置くイベント").selectOption({ label: "扉・場所移動" });
  const left = await cellCenter(page, 4, 5);
  await page.mouse.click(left.x, left.y);
  const door = page.getByRole("dialog", { name: "ひな形から作成：扉・場所移動" });
  const picker = door.getByRole("application");
  const box = await picker.boundingBox();
  if (box === null) throw new Error("プレビューが無い");
  await page.mouse.click(box.x + (15.5 / 20) * box.width, box.y + (10.5 / 15) * box.height);
  await expect(door.getByText("選んでいる位置：(15, 10)")).toBeVisible();
  await door.getByRole("button", { name: "作成", exact: true }).click();
  expect(await events()).toMatchObject([
    { x: 5, y: 6, pages: [{ commands: [{ code: "ShowText" }, { code: "ChangeGold" }, { code: "ControlSelfSwitch" }] }, { commands: [] }] },
    { x: 4, y: 5, pages: [{ trigger: "touch", commands: [{ code: "TransferPlayer", params: { x: 15, y: 10 } }] }] },
  ]);

  // テストプレイ：下の宝箱を調べるとお金が手に入り、左の扉にぶつかると移動する
  await page.getByRole("button", { name: "テストプレイ", exact: true }).click();
  await page.waitForFunction(() => window.__rpgPlaytest !== undefined && window.__rpgPlaytest.getState().scene.kind === "title");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__rpgPlaytest.getState().scene.kind === "map");
  await page.waitForTimeout(200);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__rpgPlaytest.getState().message.open);
  expect(await page.evaluate(() => window.__rpgPlaytest.getState().message.text)).toContain("120G");
  await page.keyboard.press("Enter");
  await page.waitForFunction("window.__rpgPlaytest.getState().party.gold === 120");
  await page.keyboard.down("ArrowLeft");
  await page.waitForFunction(() => window.__rpgPlaytest.getState().map.player.x === 15, undefined, { timeout: 5000 });
  await page.keyboard.up("ArrowLeft");
  expect(await page.evaluate(() => window.__rpgPlaytest.getState().map.player)).toMatchObject({ x: 15, y: 10 });
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

test("イベントの自律移動：ページで「自律移動する」を入れると、テストプレイで勝手に歩き回る", async ({ page }) => {
  await createProject(page, "自律移動");
  await page.getByRole("radio", { name: "イベント" }).click();
  const spot = await cellCenter(page, 10, 8);
  await page.mouse.click(spot.x, spot.y);
  await page.getByRole("button", { name: "イベントを編集…" }).click();
  await page.getByRole("checkbox", { name: /自律移動する/ }).check();
  expect(await editor(page, (s) => Object.values(Object.values(s.doc.maps)[0]!.events)[0])).toMatchObject({ x: 10, y: 8, pages: [{ moveRoute: { repeat: true, steps: [{ kind: "move", dir: "random" }, { kind: "wait" }] } }] });
  await page.getByRole("button", { name: /^イベント：.*を閉じる$/ }).click();

  await page.getByRole("button", { name: "テストプレイ", exact: true }).click();
  await page.waitForFunction(() => window.__rpgPlaytest !== undefined && window.__rpgPlaytest.getState().scene.kind === "title");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__rpgPlaytest.getState().scene.kind === "map");
  // 数秒のうちに、開始位置から動く（ランダムに歩く）
  await page.waitForFunction(
    "Object.values(window.__rpgPlaytest.getState().map.events).some((e) => e.x !== 10 || e.y !== 8)",
    undefined,
    { timeout: 15000 },
  );
});

test("イベントのコピー＆ペースト：Ctrl+C / Ctrl+V で別のセルに複製でき、Undo で消える", async ({ page }) => {
  await createProject(page, "コピペ");
  await page.getByRole("radio", { name: "イベント" }).click();
  const origin = await cellCenter(page, 4, 3);
  await page.mouse.click(origin.x, origin.y); // 空きセルなので作って選択する
  const events = (): Promise<{ x: number; y: number }[]> => editor(page, (s) => Object.values(Object.values(s.doc.maps)[0]!.events));

  await page.keyboard.press("Control+c");
  const target = await cellCenter(page, 9, 6);
  await page.mouse.move(target.x, target.y);
  await page.keyboard.press("Control+v");
  expect((await events()).map((e) => [e.x, e.y]).sort()).toEqual([[4, 3], [9, 6]]);

  // 同じセルには重ねられない（エラーが出て、増えない）
  await page.keyboard.press("Control+v");
  await expect(page.getByRole("alert")).toContainText("既にイベント");
  expect(await events()).toHaveLength(2);

  await page.keyboard.press("Control+z");
  expect(await events()).toHaveLength(1);
});

test.describe("スマホ（指が主入力）", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 780 } });

  test("テストプレイに操作パッドが出て、タッチでニューゲームを始め、十字キーで歩ける。閉じると外れる", async ({ page }) => {
    await createProject(page, "スマホのゲーム");
    await page.getByRole("button", { name: "テストプレイ", exact: true }).click();
    const pad = page.locator("[data-touch-pad]");
    await expect(pad).toBeVisible();
    await page.waitForFunction(() => window.__rpgPlaytest !== undefined && window.__rpgPlaytest.getState().scene.kind === "title");
    const center = async (control: string): Promise<{ x: number; y: number }> => {
      const box = await page.locator(`[data-touch-pad] [data-control="${control}"]`).boundingBox();
      if (box === null) throw new Error(`${control} が無い`);
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };
    // タイトルのあいだ A をタップし続ける（読み込み中の取りこぼし対策。startNewGame と同じ）
    const a = await center("ok");
    for (let i = 0; i < 100 && (await page.evaluate(() => window.__rpgPlaytest.getState().scene.kind)) === "title"; i++) {
      await page.touchscreen.tap(a.x, a.y);
      await page.waitForTimeout(100);
    }
    await page.waitForFunction(() => window.__rpgPlaytest.getState().scene.kind === "map");
    // 十字キーの右を押している間、右へ歩く
    const before = await page.evaluate(() => window.__rpgPlaytest.getState().map.player.x);
    const dpad = await center("dpad");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: dpad.x + 50, y: dpad.y }] });
    await page.waitForFunction((x) => window.__rpgPlaytest.getState().map.player.x > x, before);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    // 閉じると操作パッドも消える
    await page.getByRole("button", { name: "テストプレイを閉じる" }).click();
    await expect(pad).toHaveCount(0);
  });
});

test("テストプレイのデバッグパネル：所持金を増やして、別の位置へ移動できる。入力中の矢印キーでは歩かない", async ({ page }) => {
  await createProject(page, "デバッグのゲーム");
  await page.getByRole("button", { name: "テストプレイ", exact: true }).click();
  await page.waitForFunction(() => window.__rpgPlaytest !== undefined && window.__rpgPlaytest.getState().scene.kind === "title");
  await startNewGame(page, "__rpgPlaytest");
  const state = <T>(f: string): Promise<T> => page.evaluate(`(${f})(window.__rpgPlaytest.getState())`) as Promise<T>;

  await page.getByText("デバッグ", { exact: true }).click();
  await page.getByRole("button", { name: "所持金を増やす" }).click();
  await page.waitForFunction(() => (window.__rpgPlaytest.getState() as unknown as { party: { gold: number } }).party.gold === 100);

  // 数値の入力中の矢印キーは、ゲームに届かない（プレイヤーは動かない）
  const before = await state<{ x: number; y: number }>("(s) => ({ x: s.map.player.x, y: s.map.player.y })");
  await page.getByLabel("移動先の X").focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(300);
  expect(await state("(s) => ({ x: s.map.player.x, y: s.map.player.y })")).toEqual(before);

  await page.getByLabel("移動先の X").fill("3");
  await page.getByLabel("移動先の Y").fill("2");
  await page.getByRole("button", { name: "移動" }).click();
  await page.waitForFunction(() => {
    const p = window.__rpgPlaytest.getState().map.player;
    return p.x === 3 && p.y === 2;
  });
});
