import type { Direction, EventId, MapData, Tileset } from "@rpg/schema";
import type { Ctx } from "../ctx-types.js";
import type { InputFrame } from "../input.js";
import { pacedRouteTarget, startInterpreter } from "../interpreter/index.js";
import { currentMap, DIRECTION_VECTOR, hasPacedEvents, moveCharacter, pacedEventsMoving, playerStepSpeed, pushableAt, REVERSE, startsOnPlayerTouch, withTurn } from "../map/index.js";
import type { EventRuntime, GameState } from "../state.js";
import type { StepResult } from "./actions.js";
import { battleInput } from "../battle/index.js";
import { boxesMoving, carryBoxes } from "./carry.js";
import { handleMessageInput } from "./messageInput.js";
import { handleShopInput } from "./shop.js";
import { handleGameoverInput, handleMenuInput, handleTitleInput, openMenu } from "./uiPhase.js";

/** 通行フラグを持たないタイルセット（未定義のタイルセットを参照したマップ用）。 */
const OPEN_TILESET: Tileset = { id: "" as Tileset["id"], name: "", passage: [] };

/** 同時押しのときの優先順位（下 → 左 → 右 → 上）。 */
const DIRECTION_PRIORITY: readonly Direction[] = ["down", "left", "right", "up"];

/** 振り向きのあと、押しっぱなしでも歩き出さずに待つフレーム数（`system.turnInPlace`）。 */
export const TURN_IN_PLACE_FRAMES = 6;

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
 * - タイトル・メニュー・ゲームオーバー：`uiPhase.ts`。ショップ：`shop.ts`。戦闘：`battle/flow.ts`。
 * - メッセージ表示中：決定/キャンセルで閉じる。
 * - イベント実行中・場所移動の予約中・移動中：プレイヤーは操作できない。
 * - 振り向き（`system.turnInPlace`）：今の向きと違う方向キーを押した瞬間は、向きだけ変えて移動しない。
 * - メニュー/キャンセル：メニューを開く。決定：目の前/足元のアクションイベントを起動。方向キー：1タイル移動を開始（通れなければ向きだけ変わり、
 *   通常プライオリティの「接触」イベントに突き当たったらそれを起動）。
 */
export function handleInput(state: GameState, input: InputFrame, ctx: Ctx): StepResult {
  const idle: StepResult = { state, effects: [] };
  if (state.scene.kind === "title") return handleTitleInput(state, input, ctx);
  if (state.scene.kind === "menu") return handleMenuInput(state, input, ctx);
  if (state.scene.kind === "battle") return battleInput(state, input, ctx);
  if (state.scene.kind === "gameover") return handleGameoverInput(state, input, ctx);
  if (state.scene.kind === "shop") return handleShopInput(state, input, ctx);
  if (state.scene.kind !== "map") return idle;

  if (state.message.open) return handleMessageInput(state, input);
  if (hasNormalInterpreter(state) || state.map.transfer !== undefined || state.map.player.moving) return idle;

  const map = currentMap(ctx.project, state);
  if (map === undefined) return idle;
  // ターン制のイベント（`pace: "playerStep"`）が歩いている間は、次の手を打てない
  // （`SetMoveRoute` のターン制のルートで動かされているイベントも含む）
  const forced = state.interpreters.flatMap((i) => pacedRouteTarget(i) ?? []);
  if (pacedEventsMoving(state, map, forced)) return idle;
  // ベルトで運ばれている箱が動いている間も、次の手は打てない
  const tileset = ctx.project.tileset(map.tileset) ?? OPEN_TILESET;
  if (boxesMoving(state, map, tileset)) return idle;
  // 手数を数えるのは、ターン制のイベントが居るマップだけ（居なければ、状態に何も足さない）
  const paced = hasPacedEvents(state, map, forced);
  const turn = (s: GameState): GameState => (paced ? withTurn(s) : s);

  if (input.triggered.has("menu") || input.triggered.has("cancel")) return openMenu(state);

  if (input.triggered.has("ok")) {
    const started = triggerAction(state, map);
    if (started) return { state: started, effects: [] };
    // 何も起こらない決定ボタンは「足踏み」：ターン制のイベントが居るときだけ、1 手として数える（その場で待つ）
    if (paced) return { state: withTurn(state), effects: [] };
  }

  // 振り向き（`system.turnInPlace`）：いまの向きと違う方向キーを押した瞬間は、移動せずに向きだけ変える（手数にも数えない）。
  // キーを押しっぱなしにしても、`TURN_IN_PLACE_FRAMES` フレームのあいだは歩き出さない（軽く押して離せば、向きだけ変えられる）。
  // 向いた方向をもう一度押せば（`triggered`）、待たずにすぐ歩く。
  const dir = directionOf(input);
  if (ctx.project.project.system.turnInPlace === true) {
    const { turnWait, ...rest } = state.map;
    const turnTo = DIRECTION_PRIORITY.find((d) => input.triggered.has(d) && d !== rest.player.direction);
    if (turnTo !== undefined) {
      return { state: { ...state, map: { ...rest, player: { ...rest.player, direction: turnTo }, turnWait: TURN_IN_PLACE_FRAMES } }, effects: [] };
    }
    if (dir === undefined) return turnWait === undefined ? idle : { state: { ...state, map: rest }, effects: [] };
    if (turnWait !== undefined && !input.triggered.has(dir)) {
      return { state: { ...state, map: turnWait > 1 ? { ...rest, turnWait: turnWait - 1 } : rest }, effects: [] };
    }
    state = { ...state, map: rest };
  }
  if (dir === undefined) return idle;

  const { player } = state.map;
  const pass = { map, tileset, events: state.map.events };
  // この 1 歩の速さ：足元のタイル・状態・走る操作（Shift）で、基準の速さ（`player.speed`）から変わる。変わらなければ状態に何も足さない
  const speed = playerStepSpeed({ project: ctx.project.project, map, tileset, state, dashing: input.pressed.has("shift") });
  const { moveSpeed: _stale, ...mapRest } = state.map;
  const withSpeed = (m: GameState["map"]): GameState["map"] => (speed === player.speed ? m : { ...m, moveSpeed: speed });
  state = { ...state, map: mapRest };
  const moved = moveCharacter(player, dir, pass);
  let next: GameState = { ...state, map: { ...state.map, player: moved } };
  // 歩き出したら 1 手（通れずに向きだけ変わったときは数えない）
  // （ベルトの上の箱も、同じ 1 歩の速さで、同時に 1 タイル運ばれる）
  if (moved.x !== player.x || moved.y !== player.y) next = carryBoxes(turn({ ...next, map: withSpeed(next.map) }), map, tileset, speed);
  if (moved.x === player.x && moved.y === player.y) {
    // 押せる岩：その先が通れるなら、岩を 1 タイル押して、プレイヤーも同じ向きに 1 タイル進む（岩の向きは変えない）
    const rock = pushableAt(pass, player, dir, (ev) => ev.pageIndex !== null && map.events[ev.id]?.pages[ev.pageIndex]?.pushable === true);
    if (rock !== undefined) {
      const { dx, dy } = DIRECTION_VECTOR[dir];
      // 岩はプレイヤーと同じ速さで動く（遅い足元・走るときも、岩とプレイヤーが離れない）
      const pushed = { ...rock, x: rock.x + dx, y: rock.y + dy, moving: true, speed };
      const stepped = { ...player, x: player.x + dx, y: player.y + dy, direction: dir, moving: true };
      const pushedState = turn({ ...state, map: withSpeed({ ...state.map, player: stepped, events: { ...state.map.events, [rock.id]: pushed } }) });
      // ベルトの上のほかの箱は運ばれる（いま押した箱は、押した分で動いたので運ばない）
      return { state: carryBoxes(pushedState, map, tileset, speed, new Set([rock.id])), effects: [] };
    }
    // 突き当たり：目の前の通常プライオリティの接触イベント（プレイヤーから / イベントから）を起動
    const { dx, dy } = DIRECTION_VECTOR[dir];
    const bumped = eventsAt(state, player.x + dx, player.y + dy, (ev) => startsOnPlayerTouch(ev.trigger) && ev.priority === "same")[0];
    if (bumped) next = startMapEvent(next, map, bumped.id);
  }
  return { state: next, effects: [] };
}
