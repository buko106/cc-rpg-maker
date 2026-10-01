#!/usr/bin/env node
/**
 * エディタを静的ファイルとしてビルドする。
 *
 *   node apps/editor-ui/scripts/build-web.mjs [--out <dir>]
 *
 * 出力: <out>/index.html, editor.js, editor.css（プロジェクトの保存先はブラウザの IndexedDB）
 *       <out>/player/player.js（配布物に同梱するプレイヤー本体。「配布物を書き出す」が読む）
 *       <out>/samples/（プロジェクト一覧の「サンプルから作る」。tools/build-demos.mjs の DEMOS の編集データ）
 *         index.json        サンプルの一覧（id・タイトル・説明・タグ・画面写真・ファイルの一覧）
 *         <id>/             project.json + maps/ + assets/（fixtures/projects/v1/<name> をそのまま）
 *         <id>.png          一覧に出す画面写真
 */
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { DEMOS } from "../../../tools/build-demos.mjs";

const root = resolve(import.meta.dirname, "..");
const { values } = parseArgs({ options: { out: { type: "string" } } });
const out = resolve(values.out ?? join(root, "dist-web"));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [join(root, "src", "main.tsx")],
  outdir: out,
  entryNames: "editor",
  bundle: true,
  format: "esm",
  target: "es2022",
  jsx: "automatic",
  sourcemap: true,
  minify: false,
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
});
// 配布物に同梱するプレイヤー本体（apps/player の main.ts をそのままバンドルしたもの）
await build({
  entryPoints: [join(root, "..", "player", "src", "main.ts")],
  outfile: join(out, "player", "player.js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  logLevel: "warning",
});
cpSync(join(root, "static", "index.html"), join(out, "index.html"));

// サンプル：デモの編集データ。エディタはこれを ZIP にまとめて importZip で新しいプロジェクトにする
const repo = resolve(root, "..", "..");
const filesOf = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name)).replaceAll("\\", "/")).sort();
const samples = DEMOS.map((demo) => {
  const dir = join(out, "samples", demo.slug);
  for (const part of ["project.json", "maps", "assets"]) cpSync(join(repo, demo.project, part), join(dir, part), { recursive: true });
  cpSync(join(repo, demo.image), join(out, "samples", `${demo.slug}.png`));
  return { id: demo.slug, title: demo.title, description: demo.description, tags: demo.tags, image: `${demo.slug}.png`, files: filesOf(dir) };
});
writeFileSync(join(out, "samples", "index.json"), `${JSON.stringify(samples, null, 2)}\n`);
console.log(`editor を ${out} にビルドした`);
