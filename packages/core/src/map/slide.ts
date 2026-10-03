import type { Direction, EventId, MapData, Tileset } from "@rpg/schema";
import type { Character, EventRuntime } from "../state.js";
import { DIRECTION_VECTOR } from "./character.js";
import { canPass, moveCharacter } from "./passability.js";
import { startsOnPlayerTouch } from "./pages.js";
import type { PassabilityCtx } from "./passability.js";

/** タイル (x, y) が氷（滑る床）か。どのレイヤにあっても、`tileset.ice` に挙げたタイルがあれば氷。 */
export function isIce(map: MapData, tileset: Tileset, x: number, y: number): boolean {
  const ice = tileset.ice;
  if (ice === undefined || ice.length === 0 || x < 0 || y < 0 || x >= map.width || y >= map.height) return false;
  const index = y * map.width + x;
  return map.layers.some((layer) => ice.includes(layer.tiles[index] ?? 0));
}

/**
 * 氷の上に着いたプレイヤーを、同じ向きに 1 タイル滑らせる。氷でない・先が通れない（壁・通れないイベント・岩）ときは `undefined`
 * （そこで止まる）。滑っている間は途切れずに `moving` のままなので、プレイヤーは操作できない。
 */
export function slide<C extends Character>(ch: C, ctx: PassabilityCtx): C | undefined {
  if (!isIce(ctx.map, ctx.tileset, ch.x, ch.y)) return undefined;
  const moved = moveCharacter(ch, ch.direction, ctx);
  return moved.x === ch.x && moved.y === ch.y ? undefined : moved;
}

/**
 * プレイヤーが `dir` へ押して動かせる岩：目の前の（`pushable` なページが有効で、通常プライオリティの）イベントで、
 * その先のタイルへ進めるもの。動かせないとき（先が壁・別のイベント・マップの外、または触れる・話しかけると何かが起こるイベントのある
 * タイル＝階段や台座・扉）は `undefined`（階段や扉の上に岩を載せて、通れなくしてしまわないため）。
 * `pushable` はページ側の設定なので、`isPushable` で呼び出し側が見る（ランタイムはページの中身を写していない）。
 */
export function pushableAt(
  ctx: PassabilityCtx,
  player: Character,
  dir: Direction,
  isPushable: (ev: EventRuntime) => boolean,
): EventRuntime | undefined {
  const { dx, dy } = DIRECTION_VECTOR[dir];
  const x = player.x + dx;
  const y = player.y + dy;
  const rock = (Object.values(ctx.events) as EventRuntime[]).find((ev) => ev.pageIndex !== null && ev.priority === "same" && !ev.through && ev.x === x && ev.y === y && isPushable(ev));
  if (rock === undefined) return undefined;
  if (!canPass(ctx.map, ctx.tileset, ctx.events as Readonly<Record<EventId, EventRuntime>>, rock, dir)) return undefined;
  return hasInteractiveEvent(ctx.events, x + dx, y + dy) ? undefined : rock;
}

/**
 * タイル (x, y) に、触れる・話しかけると何かが起こるイベント（有効なページのトリガが `action` / `touch` / `eventTouch` / `eventSight`）があるか。箱を載せない目印。
 * `ignore` が真を返すイベント（ほかの箱など）は数えない。
 */
export function hasInteractiveEvent(events: Readonly<Record<EventId, EventRuntime>>, x: number, y: number, ignore?: (ev: EventRuntime) => boolean): boolean {
  return (Object.values(events) as EventRuntime[]).some(
    (ev) => ev.pageIndex !== null && ev.x === x && ev.y === y && (ev.trigger === "action" || startsOnPlayerTouch(ev.trigger)) && ignore?.(ev) !== true,
  );
}
