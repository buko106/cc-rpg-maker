// テスト専用：小さなダンジョンの設定。
import { parseConfig } from "./config.js";
import type { Config } from "./config.js";

export const TILES = { rock: 1, wallFace: 2, floor: [3, 4], stairs: 5, treasure: 6 };

export const testConfig = (patch: Record<string, unknown> = {}): Config => {
  const r = parseConfig({
    floorMap: "map_floor",
    width: 39,
    height: 27,
    goalFloor: 5,
    home: { map: "map_town", x: 1, y: 1 },
    tiles: TILES,
    sprites: { asset: "aaaaaaaaaaaaaaaa", drop: { sx: 0, sy: 0 } },
    enemies: [
      { enemy: "e_slime", floors: [1, 3], weight: 3, sprite: { sx: 0, sy: 0 } },
      { enemy: "e_bat", floors: [2, 5], weight: 1, sprite: { sx: 32, sy: 0 }, act: "fast" },
      { enemy: "e_golem", floors: [3, 5], weight: 1, sprite: { sx: 64, sy: 0 }, act: "slow" },
      { enemy: "e_dragon", boss: true, sprite: { sx: 96, sy: 0 } },
    ],
    items: [
      { kind: "item", key: "potion", item: "item_potion", weight: 2, sprite: { sx: 0, sy: 32 } },
      { kind: "food", key: "onigiri", name: "おにぎり", amount: 40, sprite: { sx: 32, sy: 32 } },
      { kind: "gold", key: "gold", min: 10, max: 30, floors: [2, 99], sprite: { sx: 64, sy: 32 } },
      { kind: "seed", key: "seed", name: "ちからの種", atk: 2, sprite: { sx: 96, sy: 32 } },
    ],
    ...patch,
  });
  if (!r.ok) throw new Error(r.message);
  return r.config;
};
