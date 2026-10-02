/**
 * @rpg/core — GameState、インタプリタ、戦闘、式言語。
 *
 * 設計: docs/02-core-state.md, docs/03-interpreter.md, docs/04-battle.md, docs/05-expression.md
 * ブラウザ API（DOM / タイマー / Math.random / Date.now）に依存しない。
 */
export * from "./battle/index.js";
export * from "./expression/index.js";
export * from "./interpreter/index.js";
export { computeCamera, activePage, activePageIndex, canPass, currentMap, eventsToTrigger, moveCharacter, newCharacter, refreshEventPages, tileKey, withTileChanges } from "./map/index.js";
export type { MapTileChanges, PassabilityCtx } from "./map/index.js";
export {
  AUTOSAVE_SLOT, autosaveOnTransfer, dispatch, fieldItemUsable, fieldScope, fieldSkills, fieldSkillUsable, initialState, isSellable, loadSlotNumbers, MENU_ITEMS, maxBuyQuantity, menuItemIds, menuItems, needsFieldTarget, openShop, paramAt, SAVE_SLOT_COUNT, SAVE_SLOT_FIRST, saveSlotNumbers, sellableItemIds, sellPrice, SHOP_ITEM_LIMIT, shopCommands,
  shopListIds, step, TITLE_ITEMS, titleState, useOnField,
} from "./game/index.js";
export type { Action, FieldUse, InterpreterAction, StepResult } from "./game/index.js";
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
export { IDLE_MESSAGE, pluginStateOf, selfSwitchKey, withPluginState } from "./state.js";
export type {
  ActorState, Character, EventRuntime, GameState, JsonValue, MapState, MenuConfirm, MenuPick, MenuScreen, MessageState, PartyState, SceneState, ShopScene, ShopScreen, TimerState, TitleScreen,
} from "./state.js";
