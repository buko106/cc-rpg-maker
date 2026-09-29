import { bootPlayer } from "./boot.js";

/**
 * ブラウザのエントリポイント（`player.js`）。`?project=<url>` でプロジェクトを指定でき、既定は `project/project.json`。
 * 起動した Runtime は `window.__rpg` に置く（E2E とデバッグ用）。
 */
const params = new URLSearchParams(location.search);
const root = document.getElementById("app");
if (root === null) throw new Error("#app が無い");

bootPlayer(root, { projectUrl: params.get("project") ?? "project/project.json", debug: params.has("debug") }).then(
  (runtime) => {
    (window as unknown as { __rpg: unknown }).__rpg = runtime;
  },
  () => {
    // エラー画面は bootPlayer が出している
  },
);
