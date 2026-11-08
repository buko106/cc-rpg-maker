import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// 実験用の ASCII 描画（?renderer=ascii）。タイトルからマップまで進めて、文字で描かれていることを確かめる。

const rpg = (expr: string): string => `(() => { const s = window.__rpg.getState(); return ${expr}; })()`;

async function open(page: Page): Promise<void> {
  await page.goto("/?renderer=ascii&debug");
  await page.waitForFunction(`window.__rpg !== undefined && ${rpg('s.scene.kind === "title" && s.tick > 2')}`);
}

test("ASCII で動く：タイトルの文字が読め、マップは文字のマス目になる", async ({ page }) => {
  await open(page);
  const surface = page.getByLabel("ゲーム画面");
  expect(await page.locator("canvas").count()).toBe(0);
  // タイトルのメニューは文字としてそのまま取れる
  await expect(surface).toContainText("ニューゲーム");

  await page.keyboard.press("Enter");
  await page.waitForFunction(`${rpg('s.scene.kind === "map" && s.tick > 8')}`);
  await page.waitForTimeout(400);
  const text = (await surface.textContent()) ?? "";
  // 地形（明るさの違う文字）とキャラクターが並ぶ
  expect(new Set([...text]).size).toBeGreaterThan(4);
  expect(text.length).toBeGreaterThan(300);
  await page.screenshot({ path: "test-results/ascii-map.png" });
});
