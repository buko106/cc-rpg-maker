import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import type { OpfsReport } from "./support/opfs-harness.js";

// M7：本物のブラウザの OPFS で ProjectRepository（ディレクトリ版）が動く（docs/10-project-store.md）。
// Node の契約テストは、メモリ上のフェイクのディレクトリで同じ契約を確かめている。ここでは実物の OPFS で一通り。

test("OPFS の ProjectRepository：作成・保存・楽観ロック・読み込み・ZIP の往復・削除", async ({ page }) => {
  const out = await build({ entryPoints: [resolve(import.meta.dirname, "support/opfs-harness.ts")], bundle: true, write: false, format: "iife", platform: "browser", target: "es2022", logLevel: "silent" });
  await page.goto("http://127.0.0.1:4174/"); // OPFS はセキュアコンテキスト（localhost / 127.0.0.1）で使える
  expect(await page.evaluate(() => typeof navigator.storage?.getDirectory)).toBe("function");
  await page.addScriptTag({ content: out.outputFiles[0]!.text });
  const r = (await page.evaluate("window.__opfs.run()")) as OpfsReport;

  expect(r.created).toEqual({ revision: 1, title: "OPFS のゲーム" });
  expect(r.listed).toHaveLength(1);
  expect(r.loadedEqual).toBe(true);
  expect(r.savedRevision).toBe(2);
  expect(r.conflict).toBe("conflict");
  expect(r.reloadedTitle).toBe("改題した");
  expect(r.assetBytes).toBeGreaterThan(0);
  expect(r.layout).toEqual(expect.arrayContaining(["<id>/meta.json", "<id>/project.json", "<id>/maps/map_001.json"]));
  expect(r.layout.some((p) => /^<id>\/assets\/[0-9a-f]{16}\.bin$/.test(p))).toBe(true);
  expect(r.zipBytes).toBeGreaterThan(r.assetBytes);
  expect(r.importedTitle).toBe("改題した");
  expect(r.importedIsNew).toBe(true);
  expect(r.importedAssetBytes).toBe(r.assetBytes);
  expect(r.listedAfterImport).toBe(2);
  expect(r.afterRemove).toEqual([]);
  expect(r.loadAfterRemove).toBe("notFound");
});
