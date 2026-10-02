import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// デモ「風鳴りの洞窟」（fixtures/projects/v2/dungeon。プラグイン @rpg/plugin-dungeon）を、ブラウザで遊ぶ。
// 町の洞窟に入り、1 歩ごとにターンが進み、HUD が描かれ、階段で次の階に降りる。

interface Dungeon {
  floor: number;
  turn: number;
  belly: number;
  px: number;
  py: number;
  width: number;
  height: number;
  grid: string;
  goal: [number, number];
  enemies: { x: number; y: number }[];
  log: string[];
}
interface State {
  scene: { kind: string };
  map: { mapId: string; player: { x: number; y: number; moving: boolean } };
  message: { open: boolean; choices: string[] | null };
  interpreters: { mode: string }[];
  party: { items: Record<string, number> };
  variables: Record<string, number>;
  pluginState?: { dungeon?: Dungeon | null };
}
/** ページの中の `window.__rpg`（ほかの spec が `Window.__rpg` を別の形で宣言しているので、ここでは型をグローバルに足さない）。 */
type Rpg = { __rpg: { getState(): State } };

test.use({ baseURL: "http://127.0.0.1:4176" });

const state = (page: Page): Promise<State> => page.evaluate(() => (window as unknown as Rpg).__rpg.getState());
const idle = (page: Page): Promise<unknown> => page.waitForFunction(() => !(window as unknown as Rpg).__rpg.getState().map.player.moving);
/** キーを押し続けて、`until`（ページ内で評価）が真になったら離し、動きが終わるのを待つ（短く押すだけだと、遅い環境では入力を取りこぼす）。 */
const hold = async (page: Page, key: string, until: string): Promise<void> => {
  await page.keyboard.down(key);
  await page.waitForFunction(`(() => { const s = window.__rpg.getState(); const ds = s.pluginState && s.pluginState.dungeon; return ${until}; })()`);
  await page.keyboard.up(key);
  await idle(page);
};
/** ダンジョンの中で 1 ターン（1 歩・攻撃）進める：ターン数・階・イベントのどれかが変わるまで押す。 */
const tap = async (page: Page, key: string): Promise<void> => {
  const before = (await state(page)).pluginState?.dungeon;
  await hold(page, key, `!ds || ds.turn !== ${before?.turn ?? -1} || ds.floor !== ${before?.floor ?? -1} || s.variables.var_dungeon_event`);
};
const pixel = (page: Page, x: number, y: number): Promise<number[]> =>
  page.evaluate(([px, py]) => [...(document.querySelector("canvas") as HTMLCanvasElement).getContext("2d")!.getImageData(px!, py!, 1, 1).data], [x, y] as const);

/** タイトルからニューゲームして、洞窟の入口で「入る」を選び、1 階に着くまで。 */
async function enter(page: Page): Promise<void> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/?renderer=canvas2d");
  await page.waitForFunction(() => (window as unknown as Rpg).__rpg !== undefined && (window as unknown as Rpg).__rpg.getState().scene.kind === "title" && (window as unknown as Rpg).__rpg.getState().map.mapId !== undefined);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => (window as unknown as Rpg).__rpg.getState().scene.kind === "map" && (window as unknown as Rpg).__rpg.getState().map.mapId === "map_town");
  await hold(page, "ArrowUp", "s.message.open"); // 洞窟の入口に触れるまで上へ歩く
  await page.keyboard.press("Enter"); // 文章を閉じて、選択肢が出る
  await page.waitForFunction(() => (window as unknown as Rpg).__rpg.getState().message.choices !== null);
  await page.keyboard.press("Enter"); // 「入る」
  await page.waitForFunction(() => (window as unknown as Rpg).__rpg.getState().map.mapId === "map_floor", undefined, { timeout: 15_000 });
  await page.waitForFunction(() => (window as unknown as Rpg).__rpg.getState().pluginState?.dungeon?.floor === 1);
  // 場所移動の明転が終わって、イベントが動いていない（操作できる）ところまで待つ
  await page.waitForFunction(() => {
    const st = (window as unknown as Rpg).__rpg.getState();
    return st.map.mapId === "map_floor" && !st.interpreters.some((i) => i.mode === "normal");
  });
  expect(errors).toEqual([]);
}

test("町の洞窟に入ると 1 階が作られ、HUD が描かれる。1 歩ごと・決定ボタンでターンが進む", async ({ page }) => {
  await enter(page);
  const s = await state(page);
  const ds = s.pluginState!.dungeon!;
  expect(ds).toMatchObject({ floor: 1, turn: 0, belly: 100 });
  expect(s.party.items).toEqual({ item_herb: 2 });
  // HUD の左上のウィンドウ（濃い青）が描かれている
  const [r, , b] = await pixel(page, 20, 20);
  expect(b!).toBeGreaterThan(r!);
  await page.screenshot({ path: "test-results/dungeon-floor1.png" });

  await page.keyboard.press("Enter"); // その場で 1 ターン休む
  await page.waitForFunction(() => (window as unknown as Rpg).__rpg.getState().pluginState?.dungeon?.turn === 1);
  // 通れる向きに 1 歩
  const open = (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"] as const).find((k) => {
    const [dx, dy] = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[k] as [number, number];
    const ch = ds.grid[(ds.py + dy) * ds.width + ds.px + dx];
    return ch === "." && !ds.enemies.some((e) => e.x === ds.px + dx && e.y === ds.py + dy);
  })!;
  await tap(page, open);
  const after = (await state(page)).pluginState!.dungeon!;
  expect(after.turn).toBe(2);
  expect([after.px, after.py]).not.toEqual([ds.px, ds.py]);
});

test("階段まで歩いて降りると、地下 2 階（歩く途中で倒れたときは、倒れた流れになる）", async ({ page }) => {
  await enter(page);
  // 階段へ：幅優先探索で道を求めて、1 歩ずつ歩く（敵に当たったら、そのまま殴る）
  const nextKey = async (): Promise<string | undefined> =>
    page.evaluate(() => {
      const ds = (window as unknown as Rpg).__rpg.getState().pluginState!.dungeon!;
      const D: [string, number, number][] = [["ArrowUp", 0, -1], ["ArrowDown", 0, 1], ["ArrowLeft", -1, 0], ["ArrowRight", 1, 0]];
      for (const [k, dx, dy] of D) if (ds.enemies.some((e) => e.x === ds.px + dx && e.y === ds.py + dy)) return k;
      const dist = new Map<number, number>([[ds.goal[1] * ds.width + ds.goal[0], 0]]);
      const queue: [number, number][] = [[ds.goal[0], ds.goal[1]]];
      for (let h = 0; h < queue.length; h++) {
        const [x, y] = queue[h]!;
        for (const [, dx, dy] of D) {
          const k = (y + dy) * ds.width + x + dx;
          if (!dist.has(k) && ds.grid[k] !== "#") {
            dist.set(k, dist.get(y * ds.width + x)! + 1);
            queue.push([x + dx, y + dy]);
          }
        }
      }
      let best: { d: number; key: string } | undefined;
      for (const [key, dx, dy] of D) {
        const d = dist.get((ds.py + dy) * ds.width + ds.px + dx);
        if (d !== undefined && (best === undefined || d < best.d)) best = { d, key };
      }
      return best?.key;
    });
  for (let i = 0; i < 600; i++) {
    const s = await state(page);
    if (s.pluginState?.dungeon?.floor !== 1 || s.variables["var_dungeon_event"] !== undefined && s.variables["var_dungeon_event"] !== 0) break;
    const key = await nextKey();
    if (key === undefined) break;
    await tap(page, key);
  }
  const s = await state(page);
  if (s.pluginState?.dungeon?.floor === 2) {
    expect(s.pluginState.dungeon.log.at(-1)).toBe("地下 2 階に 降りた。");
    expect(s.variables["var_dungeon_best"]).toBe(2);
  } else {
    // 1 階で倒れてしまうことは（めったに）ない。そのときは、倒れた流れを確かめる
    expect(s.variables["var_dungeon_event"]).toBe(1);
  }
});
