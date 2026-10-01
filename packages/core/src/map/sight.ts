import type { Direction, EventPage } from "@rpg/schema";
import type { Character, EventRuntime } from "../state.js";
import { DIRECTION_VECTOR } from "./character.js";
import { canPass } from "./passability.js";
import type { PassabilityCtx } from "./passability.js";

/** `eventSight` の視界の長さの既定値（タイル数）。 */
export const DEFAULT_SIGHT_RANGE = 4;

/**
 * `ev` が向いている方向の直線で、`range` タイル以内にプレイヤーが見えるか。
 * 見えるのは 1 タイルずつ「そこへ進める」間だけ：通れないタイル・通れないイベントがあるとそこでさえぎられる
 * （`through` のイベントも壁は抜けられるが、視界は壁を抜けない）。同じタイルに居ても見える。
 */
export function seesPlayer(ev: EventRuntime, range: number, player: Pick<Character, "x" | "y">, ctx: PassabilityCtx): boolean {
  if (ev.x === player.x && ev.y === player.y) return true;
  const { dx, dy } = DIRECTION_VECTOR[ev.direction];
  let probe: Character = { ...ev, through: false };
  for (let i = 0; i < range; i++) {
    if (!canPass(ctx.map, ctx.tileset, ctx.events, probe, ev.direction)) return false;
    probe = { ...probe, x: probe.x + dx, y: probe.y + dy };
    if (probe.x === player.x && probe.y === player.y) return true;
  }
  return false;
}

/** 視界を持つページか（`eventSight`）。 */
export const hasSight = (page: Pick<EventPage, "trigger"> | undefined): boolean => page?.trigger === "eventSight";

/** 経路探索で調べるタイル数の上限。広いマップで 1 歩ごとの探索が重くならないように（超えたら見つからなかったものとして扱う）。 */
export const CHASE_SEARCH_LIMIT = 1500;

const SEARCH_ORDER: readonly Direction[] = ["down", "left", "right", "up"];

/**
 * `from` から `to` へ向かう最短経路（幅優先。タイル・イベントの通行判定に従う）の最初の 1 歩の向き。
 * 同じ長さの経路は、下・左・右・上の順に探した方を選ぶ（決定的）。着いている・たどり着けない・探索の上限を超えたときは `undefined`。
 */
export function chaseDirection(from: Character, to: Pick<Character, "x" | "y">, ctx: PassabilityCtx): Direction | undefined {
  if (from.x === to.x && from.y === to.y) return undefined;
  const { map } = ctx;
  const seen = new Set<number>([from.y * map.width + from.x]);
  let frontier: { ch: Character; first: Direction | undefined }[] = [{ ch: from, first: undefined }];
  let visited = 0;
  while (frontier.length > 0 && visited < CHASE_SEARCH_LIMIT) {
    const next: typeof frontier = [];
    for (const { ch, first } of frontier) {
      for (const dir of SEARCH_ORDER) {
        if (!canPass(map, ctx.tileset, ctx.events, ch, dir)) continue;
        const { dx, dy } = DIRECTION_VECTOR[dir];
        const x = ch.x + dx;
        const y = ch.y + dy;
        const key = y * map.width + x;
        if (seen.has(key)) continue;
        seen.add(key);
        const head = first ?? dir;
        if (x === to.x && y === to.y) return head;
        next.push({ ch: { ...ch, x, y }, first: head });
        visited++;
      }
    }
    frontier = next;
  }
  return undefined;
}
