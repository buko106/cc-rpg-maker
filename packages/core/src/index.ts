/**
 * @rpg/core — GameState、インタプリタ、戦闘、式言語。
 *
 * 設計: docs/02-core-state.md, docs/03-interpreter.md, docs/04-battle.md, docs/05-expression.md
 * ブラウザ API（DOM / タイマー / Math.random / Date.now）に依存しない。
 */
export * from "./battle/index.js";
export * from "./expression/index.js";
export * from "./interpreter/index.js";
export { computeCamera, activePage, activePageIndex, canPass, eventsToTrigger, moveCharacter, newCharacter, refreshEventPages } from "./map/index.js";
export type { PassabilityCtx } from "./map/index.js";
export {
  dispatch, initialState, isSellable, MENU_ITEMS, maxBuyQuantity, menuItemIds, openShop, paramAt, SAVE_SLOT_COUNT, SAVE_SLOT_FIRST, sellableItemIds, sellPrice, SHOP_ITEM_LIMIT, shopCommands,
  shopListIds, step, TITLE_ITEMS, titleState,
} from "./game/index.js";
export type { Action, InterpreterAction, StepResult } from "./game/index.js";
export { createCtx } from "./ctx.js";
export type { Ctx } from "./ctx.js";
export { warn } from "./effects.js";
export type { Effect, RGBA } from "./effects.js";
export { emptyInput, inputFrame } from "./input.js";
export type { Button, InputFrame } from "./input.js";
export { createProjectView } from "./project-view.js";
export type { ProjectView } from "./project-view.js";
export { createRandom, restoreRandom } from "./random.js";
export type { Clock, Random, RandomState } from "./random.js";
export { fromSnapshot, migrateSnapshot, progressFingerprint, SNAPSHOT_VERSION, snapshotMigrations, stripTransient, toSnapshot } from "./snapshot.js";
export type { SaveSnapshot, SerializedGameState, SnapshotError, SnapshotMigration } from "./snapshot.js";
export { IDLE_MESSAGE, selfSwitchKey } from "./state.js";
export type {
  ActorState, Character, EventRuntime, GameState, MapState, MenuConfirm, MenuScreen, MessageState, PartyState, SceneState, ShopScene, ShopScreen, TimerState, TitleScreen,
} from "./state.js";
