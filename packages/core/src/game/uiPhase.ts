import type { Ctx } from "../ctx.js";
import type { Effect } from "../effects.js";
import type { InputFrame } from "../input.js";
import type { GameState, MenuScreen, SceneState } from "../state.js";
import type { StepResult } from "./actions.js";
import { initialState } from "./initial.js";
import { MENU_ITEMS, menuItemIds, SAVE_SLOT_COUNT, SAVE_SLOT_FIRST, TITLE_ITEMS } from "./scenes.js";

/** 0..count-1 を循環するカーソル移動。 */
const move = (cursor: number, delta: number, count: number): number => (count <= 0 ? 0 : (((cursor + delta) % count) + count) % count);

/** 縦方向のカーソル移動量（押下開始のみ。押しっぱなしのリピートは無い）。 */
function vertical(input: InputFrame): number {
  return (input.triggered.has("down") ? 1 : 0) - (input.triggered.has("up") ? 1 : 0);
}

const withScene = (state: GameState, scene: SceneState, effects: Effect[] = []): StepResult => ({ state: { ...state, scene }, effects });

/**
 * タイトル画面の入力。ニューゲームは `initialState` から作り直す（`tick` は数え続ける）。
 * コンティニューはスロット一覧に進み、決定で `requestLoad`（読み込みと反映は runtime）。
 */
export function handleTitleInput(state: GameState, input: InputFrame, ctx: Ctx): StepResult {
  const scene = state.scene;
  if (scene.kind !== "title") return { state, effects: [] };
  const dy = vertical(input);

  if (scene.screen === "main") {
    if (dy !== 0) return withScene(state, { ...scene, cursor: move(scene.cursor, dy, TITLE_ITEMS.length) });
    if (!input.triggered.has("ok")) return { state, effects: [] };
    if (TITLE_ITEMS[scene.cursor] === "newGame") {
      return { state: { ...initialState(ctx, state.rng.seed), tick: state.tick }, effects: [{ kind: "stopBgm", fadeMs: 500 }] };
    }
    return withScene(state, { kind: "title", screen: "continue", cursor: 0 });
  }

  if (input.triggered.has("cancel")) return withScene(state, { kind: "title", screen: "main", cursor: TITLE_ITEMS.indexOf("continue") });
  if (dy !== 0) return withScene(state, { ...scene, cursor: move(scene.cursor, dy, SAVE_SLOT_COUNT) });
  if (input.triggered.has("ok")) return { state, effects: [{ kind: "requestLoad", slot: SAVE_SLOT_FIRST + scene.cursor }] };
  return { state, effects: [] };
}

/** 各画面のカーソルの取りうる個数。 */
function screenSize(state: GameState, screen: MenuScreen): number {
  switch (screen) {
    case "main":
      return MENU_ITEMS.length;
    case "item":
      return menuItemIds(state).length;
    case "status":
      return state.party.members.length;
    case "save":
    case "load":
      return SAVE_SLOT_COUNT;
  }
}

/**
 * メニューの入力。キャンセルで一つ前の画面（メインならマップ）へ、メニューボタンで一度に閉じる。
 * セーブ/ロード画面の決定は `requestSave` / `requestLoad`（書き込み・読み込みは runtime）。
 */
export function handleMenuInput(state: GameState, input: InputFrame): StepResult {
  const scene = state.scene;
  if (scene.kind !== "menu") return { state, effects: [] };

  if (input.triggered.has("menu")) return withScene(state, { kind: "map" });
  if (input.triggered.has("cancel")) {
    if (scene.screen === "main") return withScene(state, { kind: "map" });
    return withScene(state, { kind: "menu", screen: "main", cursor: MENU_ITEMS.indexOf(scene.screen) });
  }

  const count = screenSize(state, scene.screen);
  const delta = scene.screen === "status" ? (input.triggered.has("pagedown") ? 1 : 0) - (input.triggered.has("pageup") ? 1 : 0) || vertical(input) : vertical(input);
  if (delta !== 0) return withScene(state, { ...scene, cursor: move(scene.cursor, delta, count) });

  if (!input.triggered.has("ok")) return { state, effects: [] };
  switch (scene.screen) {
    case "main": {
      const next = MENU_ITEMS[scene.cursor];
      return next === undefined ? { state, effects: [] } : withScene(state, { kind: "menu", screen: next, cursor: 0 });
    }
    case "save":
      return { state, effects: [{ kind: "requestSave", slot: SAVE_SLOT_FIRST + scene.cursor }] };
    case "load":
      return { state, effects: [{ kind: "requestLoad", slot: SAVE_SLOT_FIRST + scene.cursor }] };
    default:
      return { state, effects: [] };
  }
}

/** マップからメニューを開く。 */
export const openMenu = (state: GameState): StepResult => withScene(state, { kind: "menu", screen: "main", cursor: 0 });
