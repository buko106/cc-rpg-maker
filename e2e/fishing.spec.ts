import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { startNewGame } from "./helpers";

// デモ「港町の釣り大会」（fixtures/projects/v2/fishing。プラグイン @rpg/plugin-fishing）を、ブラウザで遊ぶ。
// 桟橋で竿を振り、あたりを待ち、巻き上げのバーが描かれる。受付で大会に申しこむと、タイマーと点数が出る。

interface Cast {
  phase: "wait" | "bite" | "reel" | "done";
  left: number;
  zone: number;
  zoneVel: number;
  pos: number;
  zoneSize: number;
  result: { kind: string } | null;
}
interface State {
  scene: { kind: string };
  map: { mapId: string; player: { x: number; y: number; moving: boolean; direction: string } };
  message: { open: boolean; choices: string[] | null };
  interpreters: { mode: string }[];
  party: { gold: number; items: Record<string, number> };
  switches: Record<string, boolean>;
  timers: { active: boolean; ticks: number };
  pluginState?: { fishing?: { cast: Cast | null; album: Record<string, unknown>; tournament: { score: number } | null } };
}
/** ページの中の `window.__rpg`（ほかの spec が `Window.__rpg` を別の形で宣言しているので、ここでは型をグローバルに足さない）。 */
type Rpg = { __rpg: { getState(): State } };

test.use({ baseURL: "http://127.0.0.1:4177" });

const state = (page: Page): Promise<State> => page.evaluate(() => (window as unknown as Rpg).__rpg.getState());
const waitFor = (page: Page, cond: string, timeout = 15_000): Promise<unknown> => page.waitForFunction(`(() => { const s = window.__rpg.getState(); const f = s.pluginState && s.pluginState.fishing; return ${cond}; })()`, undefined, { timeout });
const idle = (page: Page): Promise<unknown> => waitFor(page, "!s.map.player.moving");
/** キーを押し続けて、`until`（ページ内で評価）が真になったら離し、動きが終わるのを待つ（短く押すだけだと、遅い環境では入力を取りこぼす）。 */
const hold = async (page: Page, key: string, until: string): Promise<void> => {
  await page.keyboard.down(key);
  await waitFor(page, until);
  await page.keyboard.up(key);
  await idle(page);
};
const pixel = (page: Page, x: number, y: number): Promise<number[]> =>
  page.evaluate(([px, py]) => [...(document.querySelector("canvas") as HTMLCanvasElement).getContext("2d")!.getImageData(px!, py!, 1, 1).data], [x, y] as const);

/** タイトルからニューゲームして、最初の説明を聞き終わるまで。 */
async function start(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/?renderer=canvas2d");
  await startNewGame(page);
  await waitFor(page, "s.map.mapId === 'map_harbor'");
  // 説明の文章を、終わるまで送る
  for (let i = 0; i < 60 && !(await state(page)).switches["sw_intro"]; i++) {
    await page.keyboard.press("Enter");
    await page.waitForTimeout(80);
  }
  await waitFor(page, "s.switches.sw_intro && !s.message.open && !s.interpreters.some((i) => i.mode === 'normal')");
  return errors;
}

/** 桟橋の (12, 8) まで歩いて、左の水に向く。 */
async function toPier(page: Page): Promise<void> {
  await hold(page, "ArrowUp", "s.map.player.y <= 8");
  await page.keyboard.down("ArrowLeft"); // 水は通れないので、向きが変わるだけ
  await waitFor(page, "s.map.player.direction === 'left'");
  await page.keyboard.up("ArrowLeft");
}

test("桟橋で竿を振ると、あたりが来て、巻き上げのバーが描かれる。何もしなければ逃げられて、また動ける", async ({ page }) => {
  const errors = await start(page);
  expect((await state(page)).party).toMatchObject({ gold: 300, items: { item_worm: 8 } });
  await toPier(page);
  expect((await state(page)).map.player).toMatchObject({ x: 12, y: 8, direction: "left" });

  await page.keyboard.press("Enter"); // 竿を振る
  await waitFor(page, "f && f.cast && f.cast.phase === 'wait'");
  expect((await state(page)).party.items["item_worm"]).toBe(7); // エサを 1 つ使った
  // 待っている間は歩けない
  await page.keyboard.down("ArrowDown");
  await page.waitForTimeout(300);
  await page.keyboard.up("ArrowDown");
  expect((await state(page)).map.player.y).toBe(8);

  await waitFor(page, "f.cast.phase === 'bite'", 20_000);
  await page.keyboard.press("Enter"); // あたり！
  await waitFor(page, "f.cast.phase === 'reel'");
  // 巻き上げのバー：下の窓（濃い青）と、バーの行の当たり判定（緑）が描かれている。緑は動くので、バーの行にある緑の画素数（幅 300 × 0.2 = 60 ほど）を数える
  // （canvas の内部の大きさは 480×352。画面の座標と同じ）
  const [r, , b] = await pixel(page, 160, 352 - 98 - 4);
  expect(b!).toBeGreaterThan(r!);
  const green = await page.evaluate(([left, y]) => {
    const row = (document.querySelector("canvas") as HTMLCanvasElement).getContext("2d")!.getImageData(left!, y!, 300, 1).data;
    let n = 0;
    for (let i = 0; i < 300; i++) if (row[i * 4 + 1]! > row[i * 4]! + 50 && row[i * 4 + 1]! > row[i * 4 + 2]! + 30) n++;
    return n;
  }, [(480 - 300) / 2, 352 - 98 + 28] as const);
  expect(green).toBeGreaterThan(40);
  expect(green).toBeLessThan(90);
  await page.screenshot({ path: "test-results/fishing-reel.png" });

  // 何もしないと、そのうち逃げられる（当たり判定が左に寄って、魚が外れる）
  await waitFor(page, "f.cast === null || f.cast.phase === 'done'", 60_000);
  await page.keyboard.press("Enter");
  await waitFor(page, "f.cast === null && !s.interpreters.some((i) => i.mode === 'normal')", 10_000);
  await hold(page, "ArrowDown", "s.map.player.y >= 9");
  expect(errors).toEqual([]);
});

test("受付で大会に申しこむと、100G を払って、タイマー（2 分）と点数が出る", async ({ page }) => {
  const errors = await start(page);
  await hold(page, "ArrowDown", "s.map.player.y >= 13");
  await hold(page, "ArrowLeft", "s.map.player.x <= 5");
  await page.keyboard.down("ArrowUp"); // 受付の人に向く
  await waitFor(page, "s.map.player.direction === 'up'");
  await page.keyboard.up("ArrowUp");
  await page.keyboard.press("Enter"); // 話しかける
  await waitFor(page, "s.message.open");
  await page.keyboard.press("Enter"); // 文章を閉じて、選択肢が出る
  await waitFor(page, "s.message.choices !== null");
  await page.keyboard.press("Enter"); // 「参加する」
  // そのあとの文章（参加費・スタート）を送る
  for (let i = 0; i < 40 && !(await state(page)).timers.active; i++) {
    await page.keyboard.press("Enter");
    await page.waitForTimeout(100);
  }
  await waitFor(page, "s.switches.sw_tournament && s.timers.active && !s.interpreters.some((i) => i.mode === 'normal') && !s.message.open", 20_000);
  const s = await state(page);
  expect(s.party.gold).toBe(200);
  expect(s.timers.ticks).toBeGreaterThan(7000);
  expect(s.pluginState!.fishing!.tournament).toEqual({ score: 0, catches: 0, biggest: null });
  // 左上の大会の窓（濃い青。文字のない右下のあたり）が描かれている
  const [r, , b] = await pixel(page, 150, 46);
  expect(b!).toBeGreaterThan(r!);
  await page.screenshot({ path: "test-results/fishing-tournament.png" });
  expect(errors).toEqual([]);
});
