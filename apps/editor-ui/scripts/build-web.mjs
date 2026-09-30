#!/usr/bin/env node
/**
 * エディタを静的ファイルとしてビルドする。
 *
 *   node apps/editor-ui/scripts/build-web.mjs [--out <dir>]
 *
 * 出力: <out>/index.html, editor.js, editor.css（プロジェクトの保存先はブラウザの IndexedDB）
 */
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { build } from "esbuild";

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
cpSync(join(root, "static", "index.html"), join(out, "index.html"));
console.log(`editor を ${out} にビルドした`);
