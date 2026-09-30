import { chromium, expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// M7：プレイヤーの描画方式（docs/15-player-export.md）。demo プロジェクトを WebGL と Canvas2D で動かして見た目を比べ、
// WebGL が使えないブラウザでは `auto` が Canvas2D に切り替わることを確かめる。

const rpg = (expr: string): string => `(() => { const s = window.__rpg.getState(); return ${expr}; })()`;

async function open(page: Page, renderer: string): Promise<void> {
  await page.goto(`/?renderer=${renderer}&debug`); // debug のとき WebGL は描いた内容を残す（ピクセルを読める）
  await page.waitForFunction(`window.__rpg !== undefined && ${rpg('s.scene.kind === "title" && s.tick > 2')}`);
}

/** キャンバスの内容を 2D のキャンバスに写して、ピクセルを取り出す。 */
const pixels = (page: Page): Promise<number[]> =>
  page.evaluate(() => {
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    const scratch = document.createElement("canvas");
    scratch.width = canvas.width;
    scratch.height = canvas.height;
    const g = scratch.getContext("2d")!;
    g.drawImage(canvas, 0, 0);
    return Array.from(g.getImageData(0, 0, canvas.width, canvas.height).data);
  });

/** 2 つの画像で、どれかのチャンネルが 8 より大きく違うピクセルの割合。 */
function diffRatio(a: number[], b: number[]): number {
  expect(a.length).toBe(b.length);
  let differing = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (Math.max(Math.abs(a[i]! - b[i]!), Math.abs(a[i + 1]! - b[i + 1]!), Math.abs(a[i + 2]! - b[i + 2]!)) > 8) differing++;
  }
  return differing / (a.length / 4);
}

const litRatio = (p: number[]): number => {
  let lit = 0;
  for (let i = 0; i < p.length; i += 4) if (p[i]! + p[i + 1]! + p[i + 2]! > 40) lit++;
  return lit / (p.length / 4);
};

test("WebGL で動く：デモのタイトル画面とマップが Canvas2D と同じ見た目（差 1% 以内）", async ({ browser }) => {
  const gl = await (await browser.newContext()).newPage();
  const flat = await (await browser.newContext()).newPage();
  await open(gl, "webgl");
  await open(flat, "canvas2d");
  expect(await gl.locator("canvas").getAttribute("data-renderer")).toBe("webgl");
  expect(await flat.locator("canvas").getAttribute("data-renderer")).toBe("canvas2d");

  // タイトル画面
  const titleGl = await pixels(gl);
  const titleFlat = await pixels(flat);
  expect(litRatio(titleFlat)).toBeGreaterThan(0.01);
  expect(litRatio(titleGl)).toBeGreaterThan(0.01);
  expect(diffRatio(titleGl, titleFlat)).toBeLessThanOrEqual(0.01);

  // ニューゲーム → マップ（タイル・キャラクター・イベントの絵）
  for (const page of [gl, flat]) {
    await page.keyboard.press("Enter");
    await page.waitForFunction(`${rpg('s.scene.kind === "map" && s.tick > 8')}`);
    await page.waitForTimeout(150); // 画像の読み込みが終わって、描かれるまで
  }
  const mapGl = await pixels(gl);
  const mapFlat = await pixels(flat);
  expect(litRatio(mapFlat)).toBeGreaterThan(0.2);
  expect(diffRatio(mapGl, mapFlat)).toBeLessThanOrEqual(0.01);

  await gl.close();
  await flat.close();
});

/** WebGL を無効にしたブラウザ（`--disable-3d-apis`）でページを開く。 */
async function withoutWebgl(run: (page: Page) => Promise<void>): Promise<void> {
  const browser = await chromium.launch({ args: ["--disable-3d-apis"] });
  try {
    const page = await (await browser.newContext({ baseURL: "http://127.0.0.1:4173" })).newPage();
    await run(page);
  } finally {
    await browser.close();
  }
}

test("WebGL が使えないブラウザでは、auto は Canvas2D に切り替わり、ゲームが動く", async () => {
  await withoutWebgl(async (page) => {
    await page.goto("/");
    expect(await page.evaluate(() => document.createElement("canvas").getContext("webgl") === null && document.createElement("canvas").getContext("webgl2") === null)).toBe(true);
    await open(page, "auto");
    expect(await page.locator("canvas").getAttribute("data-renderer")).toBe("canvas2d");
    expect(litRatio(await pixels(page))).toBeGreaterThan(0.01);
  });
});

test("WebGL が使えないブラウザで webgl を明示すると、エラー画面を出す", async () => {
  await withoutWebgl(async (page) => {
    await page.goto("/?renderer=webgl");
    await expect(page.getByRole("alert")).toContainText("WebGL");
  });
});
