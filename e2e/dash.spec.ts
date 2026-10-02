import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { startNewGame } from "./helpers.js";

// 走る機能（system.dash）：デモ「ほこらの冒険」（fixtures/projects/v1/hokora）は有効にしてある。
// キーボードは Shift を押しながら、スマホは操作パッドの走るボタン（タップでオン・オフ）で、歩くより速く進む。
// 走れないゲームの操作パッドが従来のままであることは、e2e/touchpad.spec.ts で確かめる。
// 速さは時計の時間ではなく、ゲームのフレーム数（`tick`）で比べる。

interface State {
  tick: number;
  scene: { kind: string };
  map: { player: { x: number; y: number; moving: boolean } };
  message: { open: boolean };
  interpreters: unknown[];
}
/** ページの中の `window.__rpg`（ほかの spec が `Window.__rpg` を別の形で宣言しているので、ここでは型をグローバルに足さない）。 */
type Rpg = { __rpg: { getState(): State } };

test.use({ baseURL: "http://127.0.0.1:4178" });

const state = (page: Page): Promise<State> => page.evaluate(() => (window as unknown as Rpg).__rpg.getState());

/** ニューゲームから、はじまりのイベントのメッセージを閉じて、村を歩ける状態まで。 */
async function boot(page: Page): Promise<void> {
  await page.goto("/?renderer=canvas2d");
  await startNewGame(page);
  for (let i = 0; i < 100; i++) {
    const s = await state(page);
    if (!s.message.open && s.interpreters.length === 0 && !s.map.player.moving) break;
    await page.keyboard.press("Enter");
    await page.waitForTimeout(100);
  }
  await page.waitForFunction(() => {
    const s = (window as unknown as Rpg).__rpg.getState();
    return !s.message.open && s.interpreters.length === 0 && !s.map.player.moving;
  });
}

const idle = (page: Page): Promise<unknown> => page.waitForFunction(() => !(window as unknown as Rpg).__rpg.getState().map.player.moving);

/** 4 マス目に歩き出すところまで進んだとき。 */
const FAR = (from: { x: number; y: number }): string =>
  `(() => { const p = window.__rpg.getState().map.player; return Math.abs(p.x - ${from.x}) + Math.abs(p.y - ${from.y}) >= 4; })()`;

test.describe("キーボード", () => {
  test("Shift を押しながら歩くと、押さないときの 6 割ほどのフレームで同じ距離を進む", async ({ page }) => {
    await boot(page);
    const measure = async (key: string, shift: boolean): Promise<number> => {
      const from = await state(page);
      if (shift) await page.keyboard.down("Shift");
      await page.keyboard.down(key);
      await page.waitForFunction(FAR(from.map.player));
      await page.keyboard.up(key);
      if (shift) await page.keyboard.up("Shift");
      const to = await state(page);
      await idle(page);
      return to.tick - from.tick;
    };
    // 村の入口から上へ 4 マス（歩く）、そこから下へ 4 マス（走る）。歩きは 1 タイル 16 フレーム、走りは 8 フレーム
    const walk = await measure("ArrowUp", false);
    const run = await measure("ArrowDown", true);
    expect(walk).toBeGreaterThan(40);
    expect(run).toBeLessThan(walk * 0.75);
  });
});

test.describe("タッチ端末", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 780 } });

  const centerOf = async (page: Page, control: string): Promise<{ x: number; y: number }> => {
    const box = await page.locator(`[data-touch-pad] [data-control="${control}"]`).boundingBox();
    if (box === null) throw new Error(`${control} が見えない`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };

  test("操作パッドに走るボタンが出て、タップでオン・オフでき、オンなら十字キーで速く歩く", async ({ page }) => {
    await boot(page);
    const dash = page.locator('[data-touch-pad] [data-control="shift"]');
    // 走れるゲームの操作パッド：従来の 4 つ（十字キー・メニュー・B・A）に走るボタンが 1 つ足される。矢印・メニューと同じく SVG
    await expect(page.locator("[data-touch-pad] [data-control]")).toHaveCount(5);
    await expect(dash).toBeVisible();
    await expect(dash.locator("svg")).toHaveCount(1);
    await expect(dash).toHaveAttribute("aria-pressed", "false");

    const cdp = await page.context().newCDPSession(page);
    const dpad = await centerOf(page, "dpad");
    const measure = async (dy: number): Promise<number> => {
      const from = await state(page);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: dpad.x, y: dpad.y + dy }] });
      await page.waitForFunction(FAR(from.map.player));
      const to = await state(page);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await idle(page);
      return to.tick - from.tick;
    };

    const walk = await measure(-50); // オフ：上へ 4 マス歩く
    const at = await centerOf(page, "shift");
    await page.touchscreen.tap(at.x, at.y);
    await expect(dash).toHaveAttribute("aria-pressed", "true");
    await expect(dash).toHaveAttribute("data-pressed", "true");
    const run = await measure(50); // オン：下へ 4 マス走る
    expect(run).toBeLessThan(walk * 0.75);

    // もう一度タップするとオフに戻り、歩きの速さに戻る
    await page.touchscreen.tap(at.x, at.y);
    await expect(dash).toHaveAttribute("aria-pressed", "false");
    const again = await measure(-50);
    expect(again).toBeGreaterThan(run * 1.3);
  });
});
