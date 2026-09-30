import { bootPlayer } from "./boot.js";
import type { EmbeddedData } from "./embedded-project-source.js";

/**
 * ブラウザのエントリポイント（`player.js`）。
 * - 単一 HTML：`<script type="application/json" id="rpg-embedded">` があれば、それを読んで起動する（通信しない）。
 * - フォルダ形式：`?project=<url>` でプロジェクトを指定でき、既定は `project/project.json`。`?debug` でスタックを表示する。
 * 起動した Runtime は `window.__rpg` に置く（E2E とデバッグ用）。
 */
const params = new URLSearchParams(location.search);
const root = document.getElementById("app");
if (root === null) throw new Error("#app が無い");

const embeddedElement = document.getElementById("rpg-embedded");
const debug = params.has("debug");
let config: Parameters<typeof bootPlayer>[1];
try {
  config = embeddedElement === null ? { projectUrl: params.get("project") ?? "project/project.json", debug } : { embedded: JSON.parse(embeddedElement.textContent ?? "") as EmbeddedData, debug };
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
