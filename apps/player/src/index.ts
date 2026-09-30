/**
 * @rpg/player — 配布用シェル（`bootPlayer`）。エクスポータは `@rpg/exporter`。
 *
 * 設計: docs/15-player-export.md
 * フォルダ形式（`static/index.html` + `player.js` + `project/` + `assets/`）と、単一 HTML（`embedded`）の起動。
 */
export { bootPlayer } from "./boot.js";
export type { PlayerConfig } from "./boot.js";
export { createEmbeddedProjectSource } from "./embedded-project-source.js";
export type { EmbeddedData } from "./embedded-project-source.js";
export { createHttpProjectSource } from "./http-project-source.js";
export type { HttpProjectSourceOptions } from "./http-project-source.js";
export { collectStartAssets } from "./preload.js";
export { createRafScheduler } from "./raf-scheduler.js";
