#!/usr/bin/env node
/**
 * GitHub Pages に置くサイト全体をビルドする。
 *
 *   node tools/build-site.mjs [--out <dir>]
 *
 * 出力（既定は site-dist/。https://<host>/cc-rpg-maker/ の直下に置く想定）:
 *   index.html       ランディングページ（site/ をそのままコピー）
 *   editor/          エディタ（apps/editor-ui/scripts/build-web.mjs）
 *   demo/            デモを選ぶページと、デモごとのプレイヤー（tools/build-demos.mjs。demo/village/・demo/maze/・demo/tower/・demo/mansion/）
 *   .nojekyll        Jekyll の処理を止める
 * どのページも相対パスだけで参照し合うので、サブパス（/cc-rpg-maker/）でも動く。
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildDemos } from "./build-demos.mjs";

const repo = resolve(import.meta.dirname, "..");

export async function buildSite({ out, quiet = false }) {
  const dir = resolve(out);
  const stdio = quiet ? "ignore" : "inherit";
  const node = (script, ...args) => execFileSync(process.execPath, [join(repo, script), ...args], { stdio, cwd: repo });

  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  node("apps/editor-ui/scripts/build-web.mjs", "--out", join(dir, "editor"));
  await buildDemos({ out: join(dir, "demo"), quiet });
  cpSync(join(repo, "site"), dir, { recursive: true });
  writeFileSync(join(dir, ".nojekyll"), "");
  if (!quiet) console.log(`サイトを ${dir} にビルドした`);
}

// CLI として起動されたときだけビルドする（テストからは buildSite を import する）
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  await buildSite({ out: values.out ?? join(repo, "site-dist") });
}
