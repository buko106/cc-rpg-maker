import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error -- .mjs（型宣言なし）
import { buildSite } from "./build-site.mjs";
// @ts-expect-error -- .mjs（型宣言なし）
import { DEMOS } from "./build-demos.mjs";

// GitHub Pages に置くサイト（ランディング + editor/ + demo/（デモを選ぶページと各デモ））が、サブパス配信でも壊れない形で出力されること。
describe("build-site", () => {
  let out = "";
  beforeAll(async () => {
    out = mkdtempSync(join(tmpdir(), "site-"));
    await buildSite({ out, quiet: true });
  }, 120_000);
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it("ランディング・エディタ・デモを選ぶページ・各デモが出力される", () => {
    for (const f of ["index.html", ".nojekyll", "editor/index.html", "editor/editor.js", "editor/player/player.js", "demo/index.html"]) {
      expect(existsSync(join(out, f)), f).toBe(true);
    }
    expect(DEMOS.map((d: { slug: string }) => d.slug)).toEqual(["village", "maze", "tower", "mansion", "haunted", "stealth", "hokora", "ice", "water", "dungeon"]);
    for (const { slug } of DEMOS as { slug: string }[]) {
      for (const f of ["index.html", "player.js", "project/project.json", "assets"]) expect(existsSync(join(out, "demo", slug, f)), `demo/${slug}/${f}`).toBe(true);
    }
  });

  // ランディングとデモを選ぶページの href / src が、相対パスで、出力先に実在する（サブパス配信でも動く）
  it.each(["index.html", "demo/index.html"])("%s の href / src は、すべて相対パスで、出力先に実在する", (page) => {
    const html = readFileSync(join(out, page), "utf8");
    const refs = [...html.matchAll(/\b(?:href|src)="([^"]+)"/g)].map((m) => m[1]!);
    const local = refs.filter((r) => !/^(https?:|#|mailto:)/.test(r));
    expect(local.length).toBeGreaterThan(0);
    for (const r of local) {
      expect(r.startsWith("/"), `${r} は絶対パス`).toBe(false);
      const target = join(out, dirname(page), r.split(/[?#]/)[0]!);
      expect(existsSync(r.endsWith("/") ? join(target, "index.html") : target), r).toBe(true);
    }
  });

  it("エディタに、すべてのデモの編集データがサンプルとして入っている（samples/index.json と、そこに載ったファイル）", () => {
    const index = JSON.parse(readFileSync(join(out, "editor/samples/index.json"), "utf8")) as { id: string; image: string; files: string[] }[];
    expect(index.map((s) => s.id)).toEqual((DEMOS as { slug: string }[]).map((d) => d.slug));
    for (const s of index) {
      expect(existsSync(join(out, "editor/samples", s.image)), s.image).toBe(true);
      expect(s.files).toContain("project.json");
      expect(s.files.some((f) => f.startsWith("maps/"))).toBe(true);
      expect(s.files.some((f) => f.startsWith("assets/"))).toBe(true);
      for (const f of s.files) expect(existsSync(join(out, "editor/samples", s.id, f)), `${s.id}/${f}`).toBe(true);
    }
  });

  it("デモを選ぶページに、すべてのデモへのリンクがある", () => {
    const html = readFileSync(join(out, "demo/index.html"), "utf8");
    for (const { slug } of DEMOS as { slug: string }[]) expect(html).toContain(`href="${slug}/"`);
  });

  it("エディタとデモの HTML も相対パスで参照している", () => {
    for (const f of ["editor/index.html", "demo/village/index.html", "demo/maze/index.html", "demo/tower/index.html", "demo/mansion/index.html", "demo/haunted/index.html", "demo/stealth/index.html", "demo/hokora/index.html", "demo/ice/index.html", "demo/water/index.html", "demo/dungeon/index.html"]) {
      const html = readFileSync(join(out, f), "utf8");
      const refs = [...html.matchAll(/\b(?:href|src)="([^"]+)"/g)].map((m) => m[1]!);
      expect(refs.filter((r) => r.startsWith("/")), f).toEqual([]);
    }
  });
});
