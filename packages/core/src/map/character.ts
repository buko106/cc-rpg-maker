import type { Direction } from "@rpg/schema";
import type { Character } from "../state.js";

export const DIRECTION_VECTOR: Readonly<Record<Direction, { readonly dx: number; readonly dy: number }>> = {
  up: { dx: 0, dy: -1 },
  down: { dx: 0, dy: 1 },
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
};

export const REVERSE: Readonly<Record<Direction, Direction>> = { up: "down", down: "up", left: "right", right: "left" };

export function newCharacter(x: number, y: number, direction: Direction): Character {
  return { x, y, realX: x, realY: y, direction, moving: false, speed: 4, through: false };
}

/** 1 フレームに進むタイル数。`2^speed / 256`（speed 4 で 16 フレーム/タイル）。2 のべきなので誤差が出ない。 */
export const stepDistance = (speed: Character["speed"]): number => 2 ** speed / 256;

const approach = (from: number, to: number, dist: number): number =>
  from < to ? Math.min(from + dist, to) : Math.max(from - dist, to);

/** `moving` の間、(x, y) に向かって 1 フレーム分だけ補間する。 */
export function advanceCharacter<C extends Character>(ch: C): C {
  if (!ch.moving) return ch;
  const dist = stepDistance(ch.speed);
  const realX = approach(ch.realX, ch.x, dist);
  const realY = approach(ch.realY, ch.y, dist);
  return { ...ch, realX, realY, moving: realX !== ch.x || realY !== ch.y };
}
