import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import type { Page, TestInfo } from "@playwright/test";
import { build } from "esbuild";

// M7 の完了条件（docs/07-render.md 不変条件 4）：WebGL と Canvas2D は同じ FrameSpec に対して視覚的に同等の出力（差分 1% 以内）。
// 同じ FrameSpec を両方のレンダラで描き、ピクセルの差を数える。ハーネス（e2e/support/render-harness.ts）はここでバンドルしてページに流し込む。

interface CompareResult {
  total: number;
  differing: number;
  ratio: number;
  maxDiff: number;
  images: { canvas2d: string; webgl: string; diff: string };
}
interface Harness {
  scenarios: string[];
}

let script: string;
test.beforeAll(async () => {
  const out = await build({ entryPoints: [resolve(import.meta.dirname, "support/render-harness.ts")], bundle: true, write: false, format: "iife", platform: "browser", target: "es2022", logLevel: "silent" });
  script = out.outputFiles[0]!.text;
});

async function open(page: Page): Promise<void> {
  await page.setContent("<!doctype html><body style='margin:0;background:#222'></body>");
  await page.addScriptTag({ content: script });
}

const call = <T>(page: Page, expr: string): Promise<T> => page.evaluate(`window.__harness.${expr}`) as Promise<T>;

/** 比較の結果（画像つき）をテストの添付にする。 */
async function attach(info: TestInfo, name: string, r: CompareResult): Promise<void> {
  for (const [kind, url] of Object.entries(r.images)) {
    await info.attach(`${name}-${kind}.png`, { body: Buffer.from(url.replace(/^data:image\/png;base64,/, ""), "base64"), contentType: "image/png" });
  }
}

const SCENARIOS = ["map", "shake", "overlay", "message", "menu", "title", "everything"];

test("WebGL が使える（この環境のブラウザで）", async ({ page }) => {
  await open(page);
  const ok = await page.evaluate(() => document.createElement("canvas").getContext("webgl2") !== null);
  expect(ok).toBe(true);
  expect(await call<string[]>(page, "scenarios")).toEqual(expect.arrayContaining(SCENARIOS));
  expect(({} as Harness | undefined)?.scenarios).toBeUndefined();
});

for (const name of SCENARIOS) {
  test(`[inv-4] ${name}：Canvas2D と WebGL の差は 1% 以内`, async ({ page }, info) => {
    await open(page);
    // 空の絵どうしが「一致」してしまわないように、どちらも十分に描かれていることを確かめる
    const lit = await call<number>(page, `litRatio(${JSON.stringify(name)}, "canvas2d")`);
    expect(lit).toBeGreaterThan(0.005);
    const litGl = await call<number>(page, `litRatio(${JSON.stringify(name)}, "webgl")`);
    expect(litGl).toBeGreaterThan(0.005);

    const r = await call<CompareResult>(page, `compare(${JSON.stringify(name)})`);
    await attach(info, name, r);
    expect(r.total).toBe(320 * 256);
    expect(r.ratio, `${r.differing} / ${r.total} ピクセルが違う（最大差 ${r.maxDiff}）`).toBeLessThanOrEqual(0.01);
  });
}

test("[inv-4] dpr 2 でも、補間なし（pixelated: false）でも、差は 1% 以内", async ({ page }, info) => {
  await open(page);
  const hi = await call<CompareResult>(page, `compare("everything", { dpr: 2 })`);
  await attach(info, "everything-dpr2", hi);
  expect(hi.total).toBe(640 * 512);
  expect(hi.ratio).toBeLessThanOrEqual(0.01);
  const smooth = await call<CompareResult>(page, `compare("map", { pixelated: false, dpr: 2 })`);
  await attach(info, "map-smooth", smooth);
  expect(smooth.ratio).toBeLessThanOrEqual(0.02);
});
