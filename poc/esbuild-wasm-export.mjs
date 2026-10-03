#!/usr/bin/env node
/**
 * PoC：書き出し時に esbuild-wasm でプレイヤー（player.js）を作り直す。
 *
 *   node poc/esbuild-wasm-export.mjs
 *
 * プロジェクトの設定（使うプラグイン・描画方式）から「生成したエントリ」を作り、esbuild-wasm でバンドルする。
 * ここは Node で動かす PoC なので、ソースは実ファイルシステムから読む。ブラウザでは、同じ入力を
 * メモリ上の仮想 FS（プラグインで onResolve / onLoad）として渡す必要がある（inputs の合計サイズを出す）。
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as native from "esbuild";
import * as wasm from "esbuild-wasm";

const repo = resolve(import.meta.dirname, "..");
const mainTs = join(repo, "apps/player/src/main.ts");
const common = { bundle: true, format: "esm", target: "es2022", minify: true, write: false, logLevel: "warning" };

/** 設定から main.ts を作る：使わないプラグインの import と、webgl のコードを落とす。 */
function generateEntry({ plugins, webgl }) {
  const names = { samples: "samplePlugins", dungeon: "dungeonPlugin", fishing: "fishingPlugin" };
  let src = readFileSync(mainTs, "utf8");
  for (const key of Object.keys(names)) {
    if (plugins.includes(key)) continue;
    src = src.replace(new RegExp(`^import \\{ ${names[key]} \\}.*\\n`, "m"), "");
  }
  const list = plugins.map((k) => (k === "samples" ? "...samplePlugins" : names[k])).join(", ");
  src = src.replace("[...samplePlugins, dungeonPlugin, fishingPlugin]", `[${list}]`);
  const alias = webgl ? {} : { "@rpg/render-webgl": join(import.meta.dirname, "webgl-stub.ts") };
  return { src, alias };
}

async function bundle(esbuild, variant) {
  const { src, alias } = generateEntry(variant);
  const r = await esbuild.build({ ...common, stdin: { contents: src, resolveDir: join(repo, "apps/player/src"), sourcefile: "main.ts", loader: "ts" }, alias, metafile: true });
  return { bytes: r.outputFiles[0].contents.length, inputs: Object.keys(Object.values(r.metafile.outputs)[0].inputs) };
}

const variants = [
  { label: "全部入り（今の player.js と同じ）", plugins: ["samples", "dungeon", "fishing"], webgl: true },
  { label: "プラグインなし", plugins: [], webgl: true },
  { label: "プラグインなし + WebGL なし（Canvas2D のみ）", plugins: [], webgl: false },
  { label: "samples のみ + WebGL なし", plugins: ["samples"], webgl: false },
];

const t0 = performance.now();
await wasm.initialize({});
const initMs = Math.round(performance.now() - t0);
console.log(`esbuild-wasm ${wasm.version} 初期化 ${initMs} ms`);

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
for (const v of variants) {
  const t = performance.now();
  const w = await bundle(wasm, v);
  const ms = Math.round(performance.now() - t);
  const n = await bundle(native, v);
  console.log(`${v.label}\n  wasm ${kb(w.bytes)}（${ms} ms） / native ${kb(n.bytes)}${w.bytes === n.bytes ? "（一致）" : "（差あり）"}`);
}

// ブラウザで仮想 FS にするとき、渡すソースの総量
const all = await bundle(native, variants[0]);
const total = all.inputs.map((f) => { try { return readFileSync(join(repo, f)).length; } catch { return 0; } }).reduce((a, b) => a + b, 0);
console.log(`入力ファイル ${all.inputs.length} 個、合計 ${kb(total)}`);
await wasm.stop();
