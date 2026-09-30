import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// M2 の完了条件：ブラウザでマップを歩き、イベントに話しかけてメッセージが出る。
// M3 の完了条件：セーブ → リロード → ロードで同じ位置から再開する。
// demo プロジェクト（fixtures/projects/v1/demo）をフォルダ形式で配信して確かめる。

interface State {
  tick: number;
  scene: { kind: string; screen?: string; cursor?: number };
  map: { mapId: string; name: string; player: { x: number; y: number; moving: boolean } };
  message: { open: boolean; text: string };
  variables: Record<string, number>;
}
declare global {
  interface Window {
    __rpg: { getState(): State; status: string; settled(): Promise<void> };
  }
}

const state = (page: Page): Promise<State> => page.evaluate(() => window.__rpg.getState());

/** タイトル画面が出るところまで。 */
async function openTitle(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => window.__rpg !== undefined && window.__rpg.getState().scene.kind === "title" && window.__rpg.getState().tick > 2);
}

/** タイトルでニューゲームを選んで、マップを歩ける状態まで。 */
async function open(page: Page): Promise<void> {
  await openTitle(page);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__rpg.getState().scene.kind === "map" && window.__rpg.getState().tick > 5);
}

/** キーを押しっぱなしにして、`until`（ページ内で評価）が真になったら離し、歩き終わるのを待つ。 */
async function hold(page: Page, key: string, until: string): Promise<void> {
  await page.keyboard.down(key);
  await page.waitForFunction(`(() => { const s = window.__rpg.getState(); return ${until}; })()`);
  await page.keyboard.up(key);
  await page.waitForFunction(() => !window.__rpg.getState().map.player.moving);
}

/** キーを 1 回押す。続けて押した 2 回が 1 フレームに合流しないよう、数フレーム進むのを待つ。 */
async function press(page: Page, key: string): Promise<void> {
  const tick = (await state(page)).tick;
  await page.keyboard.press(key);
  await page.waitForFunction((t) => window.__rpg.getState().tick >= t + 3, tick);
}

/** キャンバスの (x, y) の色（論理ピクセル座標。canvas は 320x256）。 */
const pixel = (page: Page, x: number, y: number): Promise<number[]> =>
  page.evaluate(
    ([px, py]) => {
      const canvas = document.querySelector("canvas") as HTMLCanvasElement;
      return [...canvas.getContext("2d")!.getImageData(px!, py!, 1, 1).data];
    },
    [x, y] as const,
  );

test("プレイヤーが起動し、ゲーム画面（タイルとキャラクター）が描かれる", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await open(page);

  const canvas = page.locator("canvas");
  await expect(canvas).toHaveJSProperty("width", 320);
  await expect(canvas).toHaveJSProperty("height", 256);
  expect((await state(page)).map).toMatchObject({ mapId: "map_town", name: "はじまりの村", player: { x: 3, y: 3 } });

  // 草のタイル（緑が強い）とプレイヤーの顔（肌色）。プレイヤーは (3,3) = 画面 (96,96)、顔は (16,9) あたり。
  const [gr, gg, gb] = await pixel(page, 50, 110);
  expect(gg).toBeGreaterThan(gr! + 30);
  expect(gg).toBeGreaterThan(gb! + 30);
  const [sr, sg] = await pixel(page, 96 + 16, 96 + 9);
  expect(sr).toBeGreaterThan(200);
  expect(sg).toBeGreaterThan(150);
  expect(errors).toEqual([]);
});

test("方向キーでマップを歩ける（壁にぶつかると止まる）", async ({ page }) => {
  await open(page);
  await hold(page, "ArrowRight", "s.map.player.x === 5");
  await expect.poll(async () => (await state(page)).map.player).toMatchObject({ x: 5, y: 3 });
  const tick = (await state(page)).tick;
  await hold(page, "ArrowUp", "s.map.player.y === 1");
  // 上の壁（y=0）で止まる。押し続けても進まない。
  await page.keyboard.down("ArrowUp");
  await page.waitForFunction((t) => window.__rpg.getState().tick > t + 40, tick + 40);
  await page.keyboard.up("ArrowUp");
  expect((await state(page)).map.player).toMatchObject({ x: 5, y: 1 });
});

test("村人に話しかけるとメッセージが表示され、決定ボタンで閉じる", async ({ page }) => {
  await open(page);
  const before = await pixel(page, 40, 200);

  // (3,3) から右へ。村人 (6,3) に突き当たって (5,3) で止まる。
  await hold(page, "ArrowRight", "s.map.player.x === 5");
  await press(page, "Enter");
  await page.waitForFunction(() => window.__rpg.getState().message.open);
  expect((await state(page)).message.text).toContain("こんにちは、\\N[actor_hero]！");

  // 画面：ウィンドウ（濃い青）が出て、その中に文字（白）が描かれている
  await page.waitForTimeout(100);
  const [wr, , wb] = await pixel(page, 40, 200);
  expect(wb).toBeGreaterThan(wr! + 20);
  expect([wr, wb]).not.toEqual([before[0], before[2]]);
  const whitePixels = await page.evaluate(() => {
    const c = document.querySelector("canvas") as HTMLCanvasElement;
    const d = c.getContext("2d")!.getImageData(14, 154, 292, 88).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i]! > 230 && d[i + 1]! > 230 && d[i + 2]! > 230) n++;
    return n;
  });
  expect(whitePixels).toBeGreaterThan(80);
  await page.screenshot({ path: "test-results/player-message.png" });

  await press(page, "Enter");
  await page.waitForFunction(() => !window.__rpg.getState().message.open);
  await expect.poll(async () => (await state(page)).variables["var_talk_count"]).toBe(1);

  // もう一度話しかけると、話した回数入りの 2 ページ目
  await press(page, "Enter");
  await page.waitForFunction(() => window.__rpg.getState().message.open);
  expect((await state(page)).message.text).toContain("また来たね。");
});

test("家の扉に触れるとマップが遅延ロードされ、家の中へ移動する", async ({ page }) => {
  const mapRequests: string[] = [];
  page.on("request", (r) => r.url().includes("/maps/") && mapRequests.push(new URL(r.url()).pathname));
  await open(page);
  expect(mapRequests).toEqual(["/project/maps/map_town.json"]); // 家のマップはまだ読まない

  await hold(page, "ArrowDown", "s.map.player.y === 5");
  await hold(page, "ArrowRight", "s.map.player.x === 13");
  await hold(page, "ArrowUp", "s.map.player.y === 3");
  await page.keyboard.down("ArrowUp"); // 扉（13,2）に突き当たる → 触れると起動
  await page.waitForFunction(() => window.__rpg.getState().message.open);
  await page.keyboard.up("ArrowUp");
  expect((await state(page)).message.text).toContain("おじゃまします");

  await press(page, "Enter");
  await page.waitForFunction(() => window.__rpg.getState().map.mapId === "map_house");
  expect(mapRequests).toEqual(["/project/maps/map_town.json", "/project/maps/map_house.json"]);
  expect((await state(page)).map).toMatchObject({ name: "村人の家", player: { x: 5, y: 6 } });

  // 家の床（茶色の木）が描かれている
  await page.waitForTimeout(100);
  const [r, g, b] = await pixel(page, 8 * 32 - 5, 100);
  expect(r).toBeGreaterThan(g! + 20);
  expect(g).toBeGreaterThan(b! + 20);
  await page.screenshot({ path: "test-results/player-house.png" });
});

test("プロジェクトの読み込みに失敗したらエラー画面を出す", async ({ page }) => {
  await page.goto("/?project=missing/project.json");
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("エラーが発生しました");
  await expect(alert).toContainText("404");
});

test("タイトル画面が描かれ、ニューゲームで始まる", async ({ page }) => {
  await openTitle(page);
  await page.waitForTimeout(100);
  // 暗い背景に、白いタイトル文字とコマンドウィンドウ（濃い青）
  const white = (x: number, y: number, w: number, h: number): Promise<number> =>
    page.evaluate(
      ([px, py, pw, ph]) => {
        const d = (document.querySelector("canvas") as HTMLCanvasElement).getContext("2d")!.getImageData(px!, py!, pw!, ph!).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i]! > 230 && d[i + 1]! > 230 && d[i + 2]! > 230) n++;
        return n;
      },
      [x, y, w, h] as const,
    );
  expect(await white(60, 50, 200, 40)).toBeGreaterThan(50); // タイトル
  expect(await white(76, 158, 168, 60)).toBeGreaterThan(50); // コマンド
  const [r, , b] = await pixel(page, 90, 200);
  expect(b).toBeGreaterThan(r! + 20);
  await page.screenshot({ path: "test-results/player-title.png" });

  // タイトルの間は歩けない
  await page.keyboard.down("ArrowRight");
  await page.waitForTimeout(200);
  await page.keyboard.up("ArrowRight");
  expect((await state(page)).scene.kind).toBe("title");
  expect((await state(page)).map.player).toMatchObject({ x: 3, y: 3 });
});

test("メニューでセーブし、リロードしてコンティニューすると同じ位置から再開する", async ({ page }) => {
  await open(page);
  await hold(page, "ArrowRight", "s.map.player.x === 5");

  // メニュー（M）→ セーブ → スロット 1
  await press(page, "m");
  await page.waitForFunction(() => window.__rpg.getState().scene.kind === "menu");
  await page.waitForTimeout(100);
  await page.screenshot({ path: "test-results/player-menu.png" });
  await press(page, "ArrowDown");
  await press(page, "ArrowDown");
  await press(page, "Enter");
  await page.waitForFunction(() => window.__rpg.getState().scene.screen === "save");
  await press(page, "Enter");
  await page.evaluate(() => window.__rpg.settled());
  await page.waitForTimeout(100);
  await page.screenshot({ path: "test-results/player-save.png" });
  const saved = await state(page);

  // リロード（IndexedDB のセーブは残る）。タイトルのコンティニューからスロット 1 を読む。
  await page.reload();
  await page.waitForFunction(() => window.__rpg !== undefined && window.__rpg.getState().scene.kind === "title");
  expect((await state(page)).map.player).toMatchObject({ x: 3, y: 3 }); // 新しいセッション
  await press(page, "ArrowDown");
  await press(page, "Enter");
  await page.waitForFunction(() => window.__rpg.getState().scene.screen === "continue");
  await page.waitForTimeout(100);
  await page.screenshot({ path: "test-results/player-continue.png" });
  await press(page, "Enter");
  await page.waitForFunction(() => window.__rpg.getState().scene.kind === "map");
  await page.evaluate(() => window.__rpg.settled());

  const loaded = await state(page);
  expect(loaded.map.player).toMatchObject({ x: 5, y: 3 });
  expect(loaded.map.mapId).toBe(saved.map.mapId);
  // 再開後も歩ける
  await hold(page, "ArrowDown", "s.map.player.y === 5");
  expect((await state(page)).map.player).toMatchObject({ x: 5, y: 5 });
});

test("メニューのロードで、保存した位置に戻る。空のスロットは読めない", async ({ page }) => {
  await open(page);
  await hold(page, "ArrowRight", "s.map.player.x === 4");
  await press(page, "m");
  await press(page, "ArrowDown");
  await press(page, "ArrowDown");
  await press(page, "Enter");
  await press(page, "Enter"); // スロット 1 に保存
  await page.evaluate(() => window.__rpg.settled());
  await press(page, "m");
  await page.waitForFunction(() => window.__rpg.getState().scene.kind === "map");
  await hold(page, "ArrowDown", "s.map.player.y === 5");

  await press(page, "m");
  await press(page, "ArrowDown");
  await press(page, "ArrowDown");
  await press(page, "ArrowDown");
  await press(page, "Enter"); // ロード
  await page.waitForFunction(() => window.__rpg.getState().scene.screen === "load");
  await press(page, "ArrowDown");
  await press(page, "Enter"); // スロット 2 は空
  await page.evaluate(() => window.__rpg.settled());
  expect((await state(page)).scene).toMatchObject({ kind: "menu", screen: "load" });
  await press(page, "ArrowUp");
  await press(page, "Enter"); // スロット 1
  await page.evaluate(() => window.__rpg.settled());
  await page.waitForFunction(() => window.__rpg.getState().scene.kind === "map");
  expect((await state(page)).map.player).toMatchObject({ x: 4, y: 3 });
});
