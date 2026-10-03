import type { EventId, MapData, Tileset } from "@rpg/schema";
import { carryPlan, DIRECTION_VECTOR, hasConveyor, startsOnPlayerTouch } from "../map/index.js";
import type { CarryPlan } from "../map/index.js";
import type { Character, EventRuntime, GameState } from "../state.js";

type Speed = Character["speed"];

/** 運ばれる箱か：有効なページが `pushable`。 */
const boxOf = (map: MapData) => (ev: EventRuntime): boolean => ev.pageIndex !== null && map.events[ev.id]?.pages[ev.pageIndex]?.pushable === true;

/**
 * 運ばれている箱が動いている間は、プレイヤーは次の手を打てない（ベルトのあるタイルセットだけ。ほかでは、押した箱は押した手と一緒に止まる）。
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

/** 足元に、乗ると始まるイベント（階段・出口など。通常より下/上のプライオリティの接触）があるか。ある間は、プレイヤーは運ばれない。 */
const touchHere = (state: GameState): boolean => {
  const { player } = state.map;
  return Object.values(state.map.events).some((ev) => ev.pageIndex !== null && startsOnPlayerTouch(ev.trigger) && ev.priority !== "same" && ev.x === player.x && ev.y === player.y);
};

/**
 * 動くものがすべて止まったとき：ベルトの上にあるプレイヤーと箱を、いっせいに 1 タイル運ぶ「ラウンド」を始める。誰も動けなければ `undefined`。
 * 運ばれた先もベルトなら、その歩を歩き終えたときに、また次のラウンドが始まる（`tickPhase.ts`）。止まる（誰も動けない）まで続く。
 * プレイヤーの向きは変えない。`slidSpeed` は、プレイヤーがいま歩き終えた 1 歩の速さ（変わっていなければ `undefined`＝基準の速さ）で、運ばれる間も、箱も、同じ速さで進む。
 */
export function startCarryRound(state: GameState, map: MapData, tileset: Tileset, slidSpeed: Speed | undefined): GameState | undefined {
  if (!hasConveyor(tileset)) return undefined;
  const { player } = state.map;
  if (player.moving || boxesMoving(state, map, tileset)) return undefined;
  const plan = carryPlan({ ctx: { map, tileset, events: state.map.events }, player, carryPlayer: !touchHere(state), isBox: boxOf(map) });
  if (plan.player === undefined && plan.boxes.length === 0) return undefined;
  const carried = withBoxes(state, plan, slidSpeed ?? player.speed);
  if (plan.player === undefined) return carried;
  const { dx, dy } = DIRECTION_VECTOR[plan.player];
  const moved = { ...player, x: player.x + dx, y: player.y + dy, moving: true };
  return { ...carried, map: { ...carried.map, player: moved, ...(slidSpeed === undefined ? {} : { moveSpeed: slidSpeed }) } };
}
