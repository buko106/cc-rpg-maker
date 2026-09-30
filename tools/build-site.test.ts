import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error -- .mjs（型宣言なし）
import { buildSite } from "./build-site.mjs";

// GitHub Pages に置くサイト（ランディング + editor/ + demo/）が、サブパス配信でも壊れない形で出力されること。
describe("build-site", () => {
  let out = "";
  beforeAll(async () => {
    out = mkdtempSync(join(tmpdir(), "site-"));
    await buildSite({ out, quiet: true });
  }, 120_000);
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it("ランディング・エディタ・デモが出力される", () => {
    for (const f of ["index.html", ".nojekyll", "editor/index.html", "editor/editor.js", "editor/player/player.js", "demo/index.html", "demo/player.js", "demo/project/project.json"]) {
      expect(existsSync(join(out, f)), f).toBe(true);
    }
  });

  it("ランディングの href / src は、すべて相対パスで、出力先に実在する（サブパス配信でも動く）", () => {
    const html = readFileSync(join(out, "index.html"), "utf8");
    const refs = [...html.matchAll(/\b(?:href|src)="([^"]+)"/g)].map((m) => m[1]!);
    const local = refs.filter((r) => !/^(https?:|#|mailto:)/.test(r));
    expect(local.length).toBeGreaterThan(0);
    for (const r of local) {
      expect(r.startsWith("/"), `${r} は絶対パス`).toBe(false);
      const target = join(out, r.split(/[?#]/)[0]!);
      expect(existsSync(r.endsWith("/") ? join(target, "index.html") : target), r).toBe(true);
    }
  });

  it("エディタとデモの HTML も相対パスで参照している", () => {
    for (const f of ["editor/index.html", "demo/index.html"]) {
      const html = readFileSync(join(out, f), "utf8");
      const refs = [...html.matchAll(/\b(?:href|src)="([^"]+)"/g)].map((m) => m[1]!);
      expect(refs.filter((r) => r.startsWith("/")), f).toEqual([]);
    }
  });
});
