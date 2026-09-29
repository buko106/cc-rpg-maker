/**
 * @rpg/core — GameState、インタプリタ、戦闘、式言語。
 *
 * 設計: docs/02-core-state.md, docs/03-interpreter.md, docs/04-battle.md, docs/05-expression.md
 * ブラウザ API（DOM / タイマー / Math.random / Date.now）に依存しない。
 */
export * from "./expression/index.js";
export { createRandom, restoreRandom } from "./random.js";
export type { Clock, Random, RandomState } from "./random.js";
