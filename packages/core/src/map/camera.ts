import type { MapData, SystemSettings } from "@rpg/schema";
import type { Character } from "../state.js";

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/** プレイヤーを画面中央に置き、マップの端では止める。画面がマップより大きければ 0。 */
export function computeCamera(player: Character, map: MapData, system: SystemSettings): { x: number; y: number } {
  const tilesW = system.screen.width / system.tileSize;
  const tilesH = system.screen.height / system.tileSize;
  return {
    x: clamp(player.realX + 0.5 - tilesW / 2, 0, Math.max(0, map.width - tilesW)),
    y: clamp(player.realY + 0.5 - tilesH / 2, 0, Math.max(0, map.height - tilesH)),
  };
}
