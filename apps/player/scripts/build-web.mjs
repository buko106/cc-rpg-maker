#!/usr/bin/env node
/**
 * プレイヤーを静的ファイルとしてビルドする（フォルダ形式：docs/15-player-export.md）。
 *
 *   node apps/player/scripts/build-web.mjs [--project <dir>] [--out <dir>]
 *
 * 出力: <out>/index.html, <out>/player.js（+ <project>/ があれば <out>/project/ と <out>/assets/）
 * <project> は `project.json` と `maps/` と `assets/` を持つフォルダ（fixtures/projects/v1/<name> と同じ形）。
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const { values } = parseArgs({ options: { project: { type: "string" }, out: { type: "string" } } });
const out = resolve(values.out ?? join(root, "dist-web"));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [join(root, "src", "main.ts")],
  outfile: join(out, "player.js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  sourcemap: true,
  logLevel: "warning",
});
cpSync(join(root, "static", "index.html"), join(out, "index.html"));

if (values.project !== undefined) {
  const project = resolve(values.project);
  if (!existsSync(join(project, "project.json"))) throw new Error(`${project}/project.json が無い`);
  mkdirSync(join(out, "project"), { recursive: true });
  cpSync(join(project, "project.json"), join(out, "project", "project.json"));
  cpSync(join(project, "maps"), join(out, "project", "maps"), { recursive: true });
  if (existsSync(join(project, "assets"))) cpSync(join(project, "assets"), join(out, "assets"), { recursive: true });
}
console.log(`player を ${out} にビルドした`);
