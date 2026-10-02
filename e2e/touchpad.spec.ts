import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// スマホ用の操作パッド：主入力が指の端末では自動で出て、十字キー・決定ボタンでゲームを進められる。
// 判定ロジックは packages/input-browser の単体テスト。ここでは DOM（ポインタイベント）との結線を確かめる。

interface State {
  tick: number;
  scene: { kind: string };
  map: { player: { x: number; y: number; moving: boolean } };
  message: { open: boolean };
}
// window.__rpg の型は e2e/player.spec.ts が宣言している（同じ宣言を重ねられないので、ここでは State だけ持つ）
const state = (page: Page): Promise<State> => page.evaluate(() => (window as unknown as { __rpg: { getState(): State } }).__rpg.getState());
const centerOf = async (page: Page, control: string): Promise<{ x: number; y: number }> => {
  const box = await page.locator(`[data-touch-pad] [data-control="${control}"]`).boundingBox();
  if (box === null) throw new Error(`${control} が見えない`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
async function boot(page: Page, query: string): Promise<void> {
  await page.goto(`/?renderer=canvas2d${query}`);
  await page.waitForFunction(() => window.__rpg !== undefined && window.__rpg.getState().scene.kind === "title" && window.__rpg.getState().tick > 2);
}

test.describe("タッチ端末", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 780 } });

  test("自動で操作パッドが出て、決定ボタンのタップと十字キーの押しっぱなしで歩ける", async ({ page }) => {
    await boot(page, "");
    await expect(page.locator("[data-touch-pad]")).toBeVisible();

    // 矢印・メニューは SVG（記号文字だと iOS で絵文字になる）。ボタンにも拡大を誘発する既定動作が無い
    await expect(page.locator('[data-touch-pad] [data-control="dpad"] svg')).toHaveCount(4);
    await expect(page.locator('[data-touch-pad] [data-control="menu"] svg')).toHaveCount(1);
    expect(await page.locator('[data-touch-pad] [data-control="dpad"]').innerText()).toBe("");
    // 走る機能のないゲーム（デモ「はじまりの村」）の操作パッドは、走るボタンの無い従来のまま（十字キー・メニュー・B・A だけ）
    await expect(page.locator("[data-touch-pad] [data-control]")).toHaveCount(4);
    await expect(page.locator('[data-touch-pad] [data-control="shift"]')).toHaveCount(0);
    const prevented = await page.evaluate(() => {
      const el = document.querySelector('[data-touch-pad] [data-control="ok"]') as HTMLElement;
      const ev = new Event("touchstart", { bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      return ev.defaultPrevented;
    });
    expect(prevented).toBe(true);

    // タイトル：決定（A）でニューゲーム
    const a = await centerOf(page, "ok");
    await page.touchscreen.tap(a.x, a.y);
    await page.waitForFunction(() => window.__rpg.getState().scene.kind === "map" && window.__rpg.getState().tick > 5);
    const start = (await state(page)).map.player;

    // 十字キーの右側に触れ続けると、右へ歩く
    const dpad = await centerOf(page, "dpad");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: dpad.x + 50, y: dpad.y }] });
    await expect(page.locator('[data-touch-pad] [data-control="dpad"]')).toHaveAttribute("data-pressed", "true");
    await page.waitForFunction((x) => window.__rpg.getState().map.player.x >= x + 2, start.x);
    // 指を上へずらすと向きが変わる（上の壁で止まるまで y が減る）
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: dpad.x, y: dpad.y - 50 }] });
    await page.waitForFunction((y) => window.__rpg.getState().map.player.y < y, start.y);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(page.locator('[data-touch-pad] [data-control="dpad"]')).toHaveAttribute("data-pressed", "false");
    await page.waitForFunction(() => !window.__rpg.getState().map.player.moving);

    // 離したら止まっている
    const stopped = (await state(page)).map.player;
    const tick = (await state(page)).tick;
    await page.waitForFunction((t) => window.__rpg.getState().tick > t + 20, tick);
    expect((await state(page)).map.player).toMatchObject({ x: stopped.x, y: stopped.y });
  });

  test("?touch=off なら出さない", async ({ page }) => {
    await boot(page, "&touch=off");
    await expect(page.locator("[data-touch-pad]")).toHaveCount(0);
  });
});

test.describe("マウス端末", () => {
  test("既定では出さない。?touch=on で出し、マウスでも操作できる", async ({ page }) => {
    await boot(page, "");
    await expect(page.locator("[data-touch-pad]")).toHaveCount(0);

    await boot(page, "&touch=on");
    await expect(page.locator("[data-touch-pad]")).toBeVisible();
    const a = await centerOf(page, "ok");
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await expect(page.locator('[data-touch-pad] [data-control="ok"]')).toHaveAttribute("data-pressed", "true");
    await page.mouse.up();
    await page.waitForFunction(() => window.__rpg.getState().scene.kind === "map");
  });
});
