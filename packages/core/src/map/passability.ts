import type { Direction, EventId, MapData, Tileset } from "@rpg/schema";
import type { Character, EventRuntime } from "../state.js";
import { DIRECTION_VECTOR, REVERSE } from "./character.js";

/** `Tileset.passage` のビット。下=1, 左=2, 右=4, 上=8。 */
const DIRECTION_BIT: Readonly<Record<Direction, number>> = { down: 1, left: 2, right: 4, up: 8 };
const ALL_PASSABLE = 15;

export interface PassabilityCtx {
  readonly map: MapData;
  readonly tileset: Tileset;
  readonly events: Readonly<Record<EventId, EventRuntime>>;
}

const inside = (map: MapData, x: number, y: number): boolean => x >= 0 && y >= 0 && x < map.width && y < map.height;

/** タイル (x, y) から `dir` 方向に出入りできるか。空タイル（0）は無視し、すべてのレイヤが許可したときだけ通れる。 */
function tilePassable(map: MapData, tileset: Tileset, x: number, y: number, dir: Direction): boolean {
  const index = y * map.width + x;
  for (const layer of map.layers) {
    const tile = layer.tiles[index] ?? 0;
    if (tile === 0) continue;
    const mask = tileset.passage[tile] ?? ALL_PASSABLE;
    if ((mask & DIRECTION_BIT[dir]) === 0) return false;
  }
  return true;
}

/**
 * `ch` が `dir` 方向に 1 タイル進めるか。
 * - マップの外へは常に出られない（`through` でも）。
 * - `through` ならそれ以外の判定を無視する。
 * - 出る側と入る側のタイルの通行フラグが、どちらも許可していること。
 * - 有効なページを持つ「通行不可・通常プライオリティ（same）」のイベントがいる位置へは入れない（自分自身を除く）。
 */
export function canPass(
  map: MapData,
  tileset: Tileset,
  events: Readonly<Record<EventId, EventRuntime>>,
  ch: Character,
  dir: Direction,
): boolean {
  const { dx, dy } = DIRECTION_VECTOR[dir];
  const x2 = ch.x + dx;
  const y2 = ch.y + dy;
  if (!inside(map, x2, y2)) return false;
  if (ch.through) return true;
  if (!tilePassable(map, tileset, ch.x, ch.y, dir)) return false;
  if (!tilePassable(map, tileset, x2, y2, REVERSE[dir])) return false;
  const selfId = "id" in ch ? (ch as EventRuntime).id : undefined;
  for (const ev of Object.values(events)) {
    if (ev.id === selfId || ev.pageIndex === null || ev.through || ev.priority !== "same") continue;
    if (ev.x === x2 && ev.y === y2) return false;
  }
  return true;
}

/**
 * `dir` へ 1 タイル動かす。通れるなら座標を進めて `moving` にし（`realX/realY` は補間で追いつく）、
 * 通れないなら向きだけ変える。座標が変わるのは `canPass` が真のときだけ。
 */
export function moveCharacter<C extends Character>(ch: C, dir: Direction, ctx: PassabilityCtx): C {
  if (!canPass(ctx.map, ctx.tileset, ctx.events, ch, dir)) return { ...ch, direction: dir };
  const { dx, dy } = DIRECTION_VECTOR[dir];
  return { ...ch, x: ch.x + dx, y: ch.y + dy, direction: dir, moving: true };
}
