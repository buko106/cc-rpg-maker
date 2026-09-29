/**
 * @rpg/player — 配布用シェル（`bootPlayer`）。エクスポータは M7。
 *
 * 設計: docs/15-player-export.md
 * M2 ではフォルダ形式の起動のみ（`static/index.html` + `player.js` + `project/` + `assets/`）。
 */
export { bootPlayer } from "./boot.js";
export type { PlayerConfig } from "./boot.js";
export { createHttpProjectSource } from "./http-project-source.js";
export type { HttpProjectSourceOptions } from "./http-project-source.js";
export { collectStartAssets } from "./preload.js";
export { createRafScheduler } from "./raf-scheduler.js";
