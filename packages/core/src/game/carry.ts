import type { EventId, MapData, Tileset } from "@rpg/schema";
import { carryPlan, DIRECTION_VECTOR, hasConveyor } from "../map/index.js";
import type { CarryPlan } from "../map/index.js";
import type { Character, EventRuntime, GameState } from "../state.js";

type Speed = Character["speed"];

/** 運ばれる箱か：有効なページが `pushable`。 */
const boxOf = (map: MapData) => (ev: EventRuntime): boolean => ev.pageIndex !== null && map.events[ev.id]?.pages[ev.pageIndex]?.pushable === true;

/**
 * 運ばれている箱が動いている間は、プレイヤーは次の手を打てない（ベルトのあるタイルセットだけ。ほかでは、押した箱は押した手と一緒に止まる）。
 * 箱がプレイヤーより先に止まって、動いている箱の上にまた箱を運ぶ、といったずれを作らないため。
 */
export function boxesMoving(state: GameState, map: MapData, tileset: Tileset): boolean {
  if (!hasConveyor(tileset)) return false;
  const isBox = boxOf(map);
  return Object.values(state.map.events).some((ev) => ev.moving && isBox(ev));
}

function withBoxes(state: GameState, plan: CarryPlan, speed: Speed): GameState {
  if (plan.boxes.length === 0) return state;
  const events = { ...state.map.events };
  for (const { id, dir } of plan.boxes) {
    const ev = events[id as EventId];
    if (ev === undefined) continue;
    const { dx, dy } = DIRECTION_VECTOR[dir];
    events[id as EventId] = { ...ev, x: ev.x + dx, y: ev.y + dy, moving: true, speed };
  }
  return { ...state, map: { ...state.map, events } };
}

/**
 * プレイヤーが方向キーで 1 歩を歩き出した（箱を押した）のに合わせて、ベルトの上の箱を 1 タイルずつ運ぶ（`skip` は、いま押した箱）。
 * 箱の速さは、その 1 歩の速さ（`speed`）にそろえるので、箱とプレイヤーは同じフレームに着く。ベルトが無いタイルセットでは何もしない。
 */
export function carryBoxes(state: GameState, map: MapData, tileset: Tileset, speed: Speed, skip?: ReadonlySet<EventId>): GameState {
  if (!hasConveyor(tileset)) return state;
  const plan = carryPlan({ ctx: { map, tileset, events: state.map.events }, player: state.map.player, carryPlayer: false, isBox: boxOf(map), ...(skip === undefined ? {} : { skip }) });
  return withBoxes(state, plan, speed);
}

/**
 * プレイヤーが 1 歩を歩き終えた直後：足元がベルトなら、プレイヤーと、ベルトの上の箱を、いっせいに 1 タイル運ぶ。
 * プレイヤーが動けなければ（行き先が壁・通れないイベントなど）、箱も動かさずに `undefined`（その場に止まる）。
 * プレイヤーの向きは変えない。`slidSpeed` は、いまの 1 歩の速さ（変わっていなければ `undefined`＝基準の速さ）で、運ばれる間も同じ速さで進む。
 */
export function carryPlayerAndBoxes(state: GameState, map: MapData, tileset: Tileset, slidSpeed: Speed | undefined): GameState | undefined {
  if (!hasConveyor(tileset)) return undefined;
  const { player } = state.map;
  const plan = carryPlan({ ctx: { map, tileset, events: state.map.events }, player, carryPlayer: true, isBox: boxOf(map) });
  if (plan.player === undefined) return undefined;
  const { dx, dy } = DIRECTION_VECTOR[plan.player];
  const carried = withBoxes(state, plan, slidSpeed ?? player.speed);
  const moved = { ...player, x: player.x + dx, y: player.y + dy, moving: true };
  return { ...carried, map: { ...carried.map, player: moved, ...(slidSpeed === undefined ? {} : { moveSpeed: slidSpeed }) } };
}
