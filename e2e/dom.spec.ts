import { expect, test } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";

// 実験用の DOM 描画（?renderer=dom）。canvas2d と並べて動かして、構造と見た目が近いことを確かめる。
// フォントの描画やサブピクセル位置は一致しないので、ピクセル差は緩い（canvas2d / webgl の 1% とは別）。

const rpg = (expr: string): string => `(() => { const s = window.__rpg.getState(); return ${expr}; })()`;

async function open(page: Page, renderer: string): Promise<void> {
  await page.goto(`/?renderer=${renderer}&debug`);
  await page.waitForFunction(`window.__rpg !== undefined && ${rpg('s.scene.kind === "title" && s.tick > 2')}`);
}

/** 2 枚の PNG を同じ大きさに並べて、どれかのチャンネルが 24 より大きく違うピクセルの割合を返す。 */
async function diffRatio(browser: Browser, a: Buffer, b: Buffer): Promise<number> {
  const page = await (await browser.newContext()).newPage();
  const ratio = await page.evaluate(
    async ([pa, pb]) => {
      const load = (b64: string): Promise<ImageData> =>
        new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            const c = document.createElement("canvas");
            c.width = 480;
            c.height = 320;
            const g = c.getContext("2d")!;
            g.drawImage(img, 0, 0, 480, 320);
            resolve(g.getImageData(0, 0, 480, 320));
          };
          img.onerror = reject;
          img.src = `data:image/png;base64,${b64}`;
        });
      const [x, y] = await Promise.all([load(pa!), load(pb!)]);
      let differing = 0;
      for (let i = 0; i < x.data.length; i += 4) {
        if (Math.max(Math.abs(x.data[i]! - y.data[i]!), Math.abs(x.data[i + 1]! - y.data[i + 1]!), Math.abs(x.data[i + 2]! - y.data[i + 2]!)) > 24) differing++;
      }
      return differing / (x.data.length / 4);
    },
    [a.toString("base64"), b.toString("base64")],
  );
  await page.close();
  return ratio;
}

test("DOM で動く：タイトルからマップまで進み、見た目が Canvas2D に近い", async ({ browser }) => {
  const dom = await (await browser.newContext({ viewport: { width: 1000, height: 700 } })).newPage();
  const flat = await (await browser.newContext({ viewport: { width: 1000, height: 700 } })).newPage();
  await open(dom, "dom");
  await open(flat, "canvas2d");
  const frame = (p: Page, sel: string) => p.locator(sel).screenshot();

  expect(await dom.locator("[data-renderer=dom]").count()).toBeGreaterThan(0);
  expect(await dom.locator("canvas").count()).toBe(0);
  // タイトルの文字は DOM のテキストとして取れる
  await expect(dom.locator("[aria-live]")).not.toBeEmpty();

  const title = await diffRatio(browser, await frame(dom, "[aria-label=ゲーム画面]"), await frame(flat, "canvas"));
  expect(title).toBeLessThanOrEqual(0.12);

  for (const page of [dom, flat]) {
    await page.keyboard.press("Enter");
    await page.waitForFunction(`${rpg('s.scene.kind === "map" && s.tick > 8')}`);
    await page.waitForTimeout(300);
  }
  // マップ：タイルとキャラクターが背景画像の要素として並ぶ
  expect(await dom.locator("[data-renderer=dom] div[style*='background: url']").count()).toBeGreaterThan(10);
  const map = await diffRatio(browser, await frame(dom, "[aria-label=ゲーム画面]"), await frame(flat, "canvas"));
  expect(map).toBeLessThanOrEqual(0.12);
  console.log(`dom vs canvas2d diff: title=${title.toFixed(4)} map=${map.toFixed(4)}`);
  await dom.screenshot({ path: "test-results/dom-map.png" });
  await dom.close();
  await flat.close();
});
