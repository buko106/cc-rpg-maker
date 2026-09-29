import { expect, test } from "@playwright/test";

// M0: ブラウザテスト基盤（Playwright + Chromium）が動くことの確認。
// プレイヤー/エディタが動くようになる M2 以降で、実際の E2E に置き換える。
test("browser test toolchain runs", async ({ page }) => {
  await page.setContent('<canvas id="c" width="4" height="4"></canvas>');
  const supportsCanvas2d = await page.evaluate(() => {
    const canvas = document.getElementById("c") as HTMLCanvasElement;
    return canvas.getContext("2d") !== null;
  });
  expect(supportsCanvas2d).toBe(true);
});
