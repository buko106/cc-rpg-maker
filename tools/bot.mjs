#!/usr/bin/env node
/**
 * 難易度調整の bot（`pnpm bot`。docs/20-bot.md）。`packages/bot/src/cli.ts` を esbuild でまとめて、そのまま動かす。
 *
 *   pnpm bot hokora --troop tr_boss --levels 3-8 --runs 30
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const out = await build({
  entryPoints: [join(root, "packages", "bot", "src", "cli.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  write: false,
  logLevel: "warning",
  // cli.ts の `import.meta.dirname`（fixtures の場所を決める）を、元のファイルの位置にする
  define: { "import.meta.dirname": JSON.stringify(join(root, "packages", "bot", "src")) },
});
const dir = mkdtempSync(join(tmpdir(), "rpg-bot-"));
try {
  const file = join(dir, "bot-cli.mjs");
  writeFileSync(file, out.outputFiles[0].text);
  const { runBotCli } = await import(pathToFileURL(file).href);
  console.log(runBotCli(process.argv.slice(2)));
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
