import { EQUIP_SLOTS } from "@rpg/schema";
import type { ActorId } from "@rpg/schema";
import type { Ctx } from "../ctx-types.js";
import type { Effect } from "../effects.js";
import type { InputFrame } from "../input.js";
import type { GameState, MenuConfirm, MenuPick, SceneState } from "../state.js";
import type { StepResult } from "./actions.js";
import { changeEquip, equipCandidates } from "./equip.js";
import { fieldItemUsable, fieldScope, fieldSkills, fieldSkillUsable, needsFieldTarget, useOnField } from "./fieldUse.js";
import type { FieldUse } from "./fieldUse.js";
import { initialState, titleState } from "./initial.js";
import { loadSlotNumbers, menuItemIds, menuItems, saveSlotNumbers, TITLE_ITEMS } from "./scenes.js";

/** 0..count-1 を循環するカーソル移動。 */
const move = (cursor: number, delta: number, count: number): number => (count <= 0 ? 0 : (((cursor + delta) % count) + count) % count);

/** 縦方向のカーソル移動量（押下開始のみ。押しっぱなしのリピートは無い）。 */
function vertical(input: InputFrame): number {
  return (input.triggered.has("down") ? 1 : 0) - (input.triggered.has("up") ? 1 : 0);
}

const withScene = (state: GameState, scene: SceneState, effects: Effect[] = []): StepResult => ({ state: { ...state, scene }, effects });

/**
 * タイトル画面の入力。ニューゲームは `initialState` から作り直す（`tick` は数え続ける）。
 * コンティニューはスロット一覧（オートセーブが有効なら先頭に付く）に進み、決定で `requestLoad`（読み込みと反映は runtime）。
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
  const slots = loadSlotNumbers(ctx.project);
  if (dy !== 0) return withScene(state, { ...scene, cursor: move(scene.cursor, dy, slots.length) });
  const slot = slots[scene.cursor];
  if (input.triggered.has("ok") && slot !== undefined) return { state, effects: [{ kind: "requestLoad", slot }] };
  return { state, effects: [] };
}

type MenuScene = Extract<SceneState, { kind: "menu" }>;

/** 各画面のカーソルの取りうる個数。スキル画面は、使う人を選ぶ間は人数、選んだあとはその人のスキルの数。 */
function screenSize(state: GameState, scene: MenuScene, ctx: Ctx): number {
  switch (scene.screen) {
    case "main":
      return menuItems(ctx.project).length;
    case "item":
      return menuItemIds(state).length;
    case "skill": {
      const user = scene.actor === undefined ? undefined : state.party.members[scene.actor];
      return user === undefined ? state.party.members.length : fieldSkills(state, ctx, user).length;
    }
    case "equip": {
      const actorId = scene.actor === undefined ? undefined : state.party.members[scene.actor];
      if (actorId === undefined) return state.party.members.length;
      const slot = scene.slot === undefined ? undefined : EQUIP_SLOTS[scene.slot];
      // 欄を選んだあとは、付けられる持ち物 + 末尾の「外す」
      return slot === undefined ? EQUIP_SLOTS.length : equipCandidates(state, ctx, slot).length + 1;
    }
    case "status":
      return state.party.members.length;
    case "save":
      return saveSlotNumbers().length;
    case "load":
      return loadSlotNumbers(ctx.project).length;
  }
}

/**
 * 確認ダイアログの入力。上下（左右）で「はい/いいえ」、決定で確定、キャンセルで閉じる。
 * 「はい」は `confirmed: true` つきで要求を出し直す（画面は開いたまま）。
 */
function handleConfirmInput(state: GameState, scene: Extract<SceneState, { kind: "menu" }>, confirm: MenuConfirm, input: InputFrame): StepResult {
  const { confirm: _closed, ...open } = scene;
  if (input.triggered.has("cancel")) return withScene(state, open);
  const toggle = ["up", "down", "left", "right"].some((b) => input.triggered.has(b as "up"));
  if (toggle) return withScene(state, { ...scene, confirm: { ...confirm, cursor: confirm.cursor === 0 ? 1 : 0 } });
  if (!input.triggered.has("ok")) return { state, effects: [] };
  if (confirm.cursor === 1) return withScene(state, open);
  const kind = confirm.kind === "save" ? "requestSave" : "requestLoad";
  return withScene(state, open, [{ kind, slot: confirm.slot, confirmed: true }]);
}

/** 使うものを決めたあとの動き：`self`・全体はすぐに使い、一人を選ぶ範囲なら対象の選択に進む。 */
function startUse(state: GameState, scene: MenuScene, use: Extract<FieldUse, { kind: "skill" }>, ctx: Ctx): StepResult {
  const scope = fieldScope(use, ctx);
  if (!needsFieldTarget(scope)) return applyUse(state, scene, use, undefined, ctx);
  return withScene(state, { ...scene, pick: { kind: "skill", id: use.id, user: use.user, cursor: 0 } });
}

/** 使う（できなければ何も起きない）。対象の選択は終わる。 */
function applyUse(state: GameState, scene: MenuScene, use: FieldUse, target: ActorId | undefined, ctx: Ctx): StepResult {
  const { pick: _pick, ...open } = scene;
  const used = useOnField(state, ctx, use, target);
  const next = used ?? state;
  // 使い切ったアイテムは一覧から消えるので、カーソルを範囲内に収める
  const cursor = scene.screen === "item" ? Math.min(scene.cursor, Math.max(0, menuItemIds(next).length - 1)) : scene.cursor;
  return withScene(next, { ...open, cursor });
}

/** 対象を選んでいる間の入力（一人を選ぶ範囲のものだけ）：上下で味方を選び、決定で使い、キャンセルで戻る。 */
function handlePickInput(state: GameState, scene: MenuScene, pick: MenuPick, input: InputFrame, ctx: Ctx): StepResult {
  const { pick: _pick, ...open } = scene;
  if (input.triggered.has("cancel")) return withScene(state, open);
  const count = state.party.members.length;
  const dy = vertical(input);
  if (dy !== 0) return withScene(state, { ...scene, pick: { ...pick, cursor: move(pick.cursor, dy, count) } });
  if (!input.triggered.has("ok")) return { state, effects: [] };
  const target = state.party.members[pick.cursor];
  return applyUse(state, scene, pick.kind === "item" ? { kind: "item", id: pick.id } : { kind: "skill", id: pick.id, user: pick.user }, target, ctx);
}

/**
 * 装備画面の決定：装備を替える人 → 替える欄 → 付けるもの（末尾は「外す」）。付け替えたら欄の一覧に戻る（同じ欄にカーソル）。
 * 付けられない（持ち物が無くなった など）ときは何も起きない。
 */
function handleEquipOk(state: GameState, scene: MenuScene, ctx: Ctx): StepResult {
  if (scene.actor === undefined) return state.party.members[scene.cursor] === undefined ? { state, effects: [] } : withScene(state, { ...scene, actor: scene.cursor, cursor: 0 });
  const actorId = state.party.members[scene.actor];
  if (actorId === undefined) return { state, effects: [] };
  if (scene.slot === undefined) return withScene(state, { ...scene, slot: scene.cursor, cursor: 0 });
  const slot = EQUIP_SLOTS[scene.slot];
  if (slot === undefined) return { state, effects: [] };
  const { slot: index, ...rest } = scene;
  const next = changeEquip(state, ctx, actorId, slot, equipCandidates(state, ctx, slot)[scene.cursor]);
  return next === undefined ? { state, effects: [] } : withScene(next, { ...rest, cursor: index });
}

/**
 * メニューの入力。キャンセルで一つ前の画面（メインならマップ）へ、メニューボタンで一度に閉じる。
 * セーブ/ロード画面の決定は `requestSave` / `requestLoad`（書き込み・読み込みは runtime）。
 */
export function handleMenuInput(state: GameState, input: InputFrame, ctx: Ctx): StepResult {
  const scene = state.scene;
  if (scene.kind !== "menu") return { state, effects: [] };

  if (input.triggered.has("menu")) return withScene(state, { kind: "map" });
  if (scene.confirm !== undefined) return handleConfirmInput(state, scene, scene.confirm, input);
  // 対象を選んでいる間・スキル/装備の画面で人（装備は欄も）を選んだあとは、キャンセルで一つ内側に戻るだけ（メインメニューへは戻らない）
  if (scene.pick !== undefined) return handlePickInput(state, scene, scene.pick, input, ctx);
  if (scene.screen === "equip" && scene.slot !== undefined && input.triggered.has("cancel")) {
    const { slot, ...rest } = scene;
    return withScene(state, { ...rest, cursor: slot });
  }
  if ((scene.screen === "skill" || scene.screen === "equip") && scene.actor !== undefined && input.triggered.has("cancel")) {
    const { actor, ...rest } = scene;
    return withScene(state, { ...rest, cursor: actor });
  }
  if (input.triggered.has("cancel")) {
    // イベントが直接開いたセーブ/ロード画面（ポータル）は、メインメニューを経由せずマップに戻る
    if (scene.screen === "main" || scene.portal === true) return withScene(state, { kind: "map" });
    return withScene(state, { kind: "menu", screen: "main", cursor: Math.max(0, menuItems(ctx.project).indexOf(scene.screen)) });
  }

  const count = screenSize(state, scene, ctx);
  const delta = scene.screen === "status" ? (input.triggered.has("pagedown") ? 1 : 0) - (input.triggered.has("pageup") ? 1 : 0) || vertical(input) : vertical(input);
  if (delta !== 0) return withScene(state, { ...scene, cursor: move(scene.cursor, delta, count) });

  if (!input.triggered.has("ok")) return { state, effects: [] };
  switch (scene.screen) {
    case "main": {
      const next = menuItems(ctx.project)[scene.cursor];
      return next === undefined ? { state, effects: [] } : withScene(state, { kind: "menu", screen: next, cursor: 0 });
    }
    case "item": {
      const id = menuItemIds(state)[scene.cursor];
      const item = id === undefined ? undefined : ctx.project.item(id as never);
      if (id === undefined || !fieldItemUsable(item)) return { state, effects: [] };
      return withScene(state, { ...scene, pick: { kind: "item", id: id as never, cursor: 0 } });
    }
    case "skill": {
      if (scene.actor === undefined) return state.party.members[scene.cursor] === undefined ? { state, effects: [] } : withScene(state, { ...scene, actor: scene.cursor, cursor: 0 });
      const user = state.party.members[scene.actor];
      const skill = user === undefined ? undefined : fieldSkills(state, ctx, user)[scene.cursor];
      if (user === undefined || skill === undefined || !fieldSkillUsable(skill)) return { state, effects: [] };
      return startUse(state, scene, { kind: "skill", id: skill.id, user }, ctx);
    }
    case "equip":
      return handleEquipOk(state, scene, ctx);
    case "save": {
      const slot = saveSlotNumbers()[scene.cursor];
      return slot === undefined ? { state, effects: [] } : { state, effects: [{ kind: "requestSave", slot }] };
    }
    case "load": {
      const slot = loadSlotNumbers(ctx.project)[scene.cursor];
      return slot === undefined ? { state, effects: [] } : { state, effects: [{ kind: "requestLoad", slot }] };
    }
    default:
      return { state, effects: [] };
  }
}

/** マップからメニューを開く。 */
export const openMenu = (state: GameState): StepResult => withScene(state, { kind: "menu", screen: "main", cursor: 0 });

/** ゲームオーバー画面：決定/キャンセルでタイトルに戻る（`tick` は数え続ける）。 */
export function handleGameoverInput(state: GameState, input: InputFrame, ctx: Ctx): StepResult {
  if (state.scene.kind !== "gameover") return { state, effects: [] };
  if (!input.triggered.has("ok") && !input.triggered.has("cancel")) return { state, effects: [] };
  return { state: { ...titleState(ctx, state.rng.seed), tick: state.tick }, effects: [{ kind: "stopBgm", fadeMs: 500 }] };
}
