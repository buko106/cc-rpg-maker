/**
 * @rpg/exporter — エディタのプロジェクトから配布物を作る（フォルダ形式の ZIP / 単一 HTML）。
 *
 * 設計: docs/15-player-export.md
 * ProjectRepository（ポート）から読むだけで、プレイヤーの実装（`player.js`）は呼び出し側から受け取る。
 */
export { exportGame, escapeForScript, escapeJsonForScript, toBase64 } from "./export-game.js";
export type { ExportOptions, ExportedGame, PlayerBundle, RendererKind } from "./export-game.js";
export { renderServiceWorker, SW_FILE, SW_REGISTER } from "./service-worker.js";
export { renderIndexHtml, renderSingleHtml, README_TEXT } from "./templates.js";
export type { EmbeddedGame } from "./templates.js";
