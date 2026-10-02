import { dungeonPlugin } from "@rpg/plugin-dungeon";
import { fishingPlugin } from "@rpg/plugin-fishing";
import { samplePlugins } from "@rpg/plugin-samples";
import { bootPlayer } from "./boot.js";
import type { PlayerConfig, RendererKind } from "./boot.js";
import type { EmbeddedData } from "./embedded-project-source.js";
import type { TouchPadMode } from "./touch-pad.js";

/**
 * ブラウザのエントリポイント（`player.js`）。
 * - 単一 HTML：`<script type="application/json" id="rpg-embedded">` があれば、それを読んで起動する（通信しない）。
 * - フォルダ形式：`?project=<url>` でプロジェクトを指定でき、既定は `project/project.json`。`?debug` でスタックを表示する。
 * - 描画方式：`?renderer=canvas2d|webgl|auto`、無ければ `#app` の `data-renderer`（書き出しが埋める）、それも無ければ `auto`。
 * - 操作パッド：`?touch=on|off`（既定 `auto` は主入力が指の端末だけ）。
 * 起動した Runtime は `window.__rpg` に置く（E2E とデバッグ用）。
 */
const params = new URLSearchParams(location.search);
const root = document.getElementById("app");
if (root === null) throw new Error("#app が無い");

const isRenderer = (v: string | null | undefined): v is RendererKind => v === "canvas2d" || v === "webgl" || v === "auto";
const requested = params.get("renderer") ?? root.dataset["renderer"];
const renderer: RendererKind = isRenderer(requested) ? requested : "auto";

const touchParam = params.get("touch");
const touchPad: TouchPadMode = touchParam === "on" || touchParam === "off" ? touchParam : "auto";

const embeddedElement = document.getElementById("rpg-embedded");
const debug = params.has("debug");
let config: PlayerConfig;
try {
  const common = { debug, renderer, touchPad, plugins: [...samplePlugins, dungeonPlugin, fishingPlugin] };
  config = embeddedElement === null ? { projectUrl: params.get("project") ?? "project/project.json", ...common } : { embedded: JSON.parse(embeddedElement.textContent ?? "") as EmbeddedData, ...common };
} catch (e) {
  // 埋め込みの JSON が壊れているときも、白い画面ではなくエラー画面を出す
  root.textContent = `エラーが発生しました\n${e instanceof Error ? e.message : String(e)}`;
  root.style.cssText = "color:#ffb4b4;font:16px sans-serif;white-space:pre-wrap;padding:16px";
  throw e;
}

bootPlayer(root, config).then(
  (runtime) => {
    (window as unknown as { __rpg: unknown }).__rpg = runtime;
  },
  () => {
    // エラー画面は bootPlayer が出している
  },
);
