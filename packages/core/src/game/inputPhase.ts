import type { Direction, EventId, MapData, Tileset } from "@rpg/schema";
import type { Ctx } from "../ctx-types.js";
import type { InputFrame } from "../input.js";
import { startInterpreter } from "../interpreter/index.js";
import { DIRECTION_VECTOR, moveCharacter, REVERSE } from "../map/index.js";
import type { EventRuntime, GameState } from "../state.js";
import { IDLE_MESSAGE } from "../state.js";
import type { StepResult } from "./actions.js";
import { battleInput } from "../battle/index.js";
import { handleGameoverInput, handleMenuInput, handleTitleInput, openMenu } from "./uiPhase.js";

/** 通行フラグを持たないタイルセット（未定義のタイルセットを参照したマップ用）。 */
const OPEN_TILESET: Tileset = { id: "" as Tileset["id"], name: "", passage: [] };

/** 同時押しのときの優先順位（下 → 左 → 右 → 上）。 */
const DIRECTION_PRIORITY: readonly Direction[] = ["down", "left", "right", "up"];

export const hasNormalInterpreter = (s: GameState): boolean => s.interpreters.some((i) => i.mode === "normal");

/** マップイベントの現在のページのコマンドで、通常のインタプリタを開始する。 */
export function startMapEvent(state: GameState, map: MapData, eventId: EventId): GameState {
  const rt = state.map.events[eventId];
  const page = rt?.pageIndex === null || rt === undefined ? undefined : map.events[eventId]?.pages[rt.pageIndex];
  if (rt === undefined || page === undefined || rt.pageIndex === null) return state;
  return startInterpreter(state, { kind: "mapEvent", mapId: state.map.mapId, eventId, page: rt.pageIndex }, page.commands, "normal");
}

function eventsAt(state: GameState, x: number, y: number, keep: (ev: EventRuntime) => boolean): EventRuntime[] {
  return Object.values(state.map.events).filter((ev) => ev.pageIndex !== null && ev.x === x && ev.y === y && keep(ev));
}

/** 決定ボタン：足元の（通常より下/上の）アクションイベントか、目の前の通常プライオリティのアクションイベントを起動する。 */
function triggerAction(state: GameState, map: MapData): GameState | undefined {
  const { player } = state.map;
  const here = eventsAt(state, player.x, player.y, (ev) => ev.trigger === "action" && ev.priority !== "same")[0];
  if (here) return startMapEvent(state, map, here.id);
  const { dx, dy } = DIRECTION_VECTOR[player.direction];
  const there = eventsAt(state, player.x + dx, player.y + dy, (ev) => ev.trigger === "action" && ev.priority === "same")[0];
  if (!there) return undefined;
  // 話しかけられた側はプレイヤーの方を向く
  const events = { ...state.map.events, [there.id]: { ...there, direction: REVERSE[player.direction] } };
  return startMapEvent({ ...state, map: { ...state.map, events } }, map, there.id);
}

/** 押されている方向キーから移動方向を決める。 */
function directionOf(input: InputFrame): Direction | undefined {
  return DIRECTION_PRIORITY.find((d) => input.pressed.has(d));
}

/**
 * 入力フレームを処理する（時間は進めない）。
 * - タイトル・メニュー・ゲームオーバー：`uiPhase.ts`。戦闘：`battle/flow.ts`。
 * - メッセージ表示中：決定/キャンセルで閉じる。
 * - イベント実行中・場所移動の予約中・移動中：プレイヤーは操作できない。
 * - メニュー/キャンセル：メニューを開く。決定：目の前/足元のアクションイベントを起動。方向キー：1タイル移動を開始（通れなければ向きだけ変わり、
 *   通常プライオリティの「接触」イベントに突き当たったらそれを起動）。
 */
export function handleInput(state: GameState, input: InputFrame, ctx: Ctx): StepResult {
  const idle: StepResult = { state, effects: [] };
  if (state.scene.kind === "title") return handleTitleInput(state, input, ctx);
  if (state.scene.kind === "menu") return handleMenuInput(state, input);
  if (state.scene.kind === "battle") return battleInput(state, input, ctx);
  if (state.scene.kind === "gameover") return handleGameoverInput(state, input, ctx);
  if (state.scene.kind !== "map") return idle;

  if (state.message.open) {
    const dismiss = input.triggered.has("ok") || input.triggered.has("cancel");
    return dismiss ? { state: { ...state, message: IDLE_MESSAGE }, effects: [] } : idle;
  }
  if (hasNormalInterpreter(state) || state.map.transfer !== undefined || state.map.player.moving) return idle;

  const map = ctx.project.map(state.map.mapId);
  if (map === undefined) return idle;

  if (input.triggered.has("menu") || input.triggered.has("cancel")) return openMenu(state);

  if (input.triggered.has("ok")) {
    const started = triggerAction(state, map);
    if (started) return { state: started, effects: [] };
  }

  const dir = directionOf(input);
  if (dir === undefined) return idle;

  const tileset = ctx.project.tileset(map.tileset) ?? OPEN_TILESET;
  const { player } = state.map;
  const moved = moveCharacter(player, dir, { map, tileset, events: state.map.events });
  let next: GameState = { ...state, map: { ...state.map, player: moved } };
  if (moved.x === player.x && moved.y === player.y) {
    // 突き当たり：目の前の通常プライオリティの接触イベントを起動
    const { dx, dy } = DIRECTION_VECTOR[dir];
    const bumped = eventsAt(state, player.x + dx, player.y + dy, (ev) => ev.trigger === "touch" && ev.priority === "same")[0];
    if (bumped) next = startMapEvent(next, map, bumped.id);
  }
  return { state: next, effects: [] };
}
