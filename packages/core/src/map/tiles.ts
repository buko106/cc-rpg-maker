import type { MapData, MapId } from "@rpg/schema";
import type { ProjectView } from "../project-view.js";
import type { GameState } from "../state.js";

/** マップの 1 マス（レイヤ・座標）の書き換え。`mapTiles[mapId]` のキーは `tileKey(layer, x, y)`、値は置き換えたタイル番号（0 = 空）。 */
export type MapTileChanges = Readonly<Record<string, number>>;

export const tileKey = (layer: number, x: number, y: number): string => `${layer}:${x},${y}`;

const KEY = /^(\d+):(\d+),(\d+)$/;
// 同じ `MapData` と同じ書き換えの組み合わせには、同じ結果を返す（毎フレーム作り直さないため）。書き換えが変わると `changes` の参照も変わる。
const cache = new WeakMap<MapData, WeakMap<object, MapData>>();

/** `map` に書き換え（`ChangeMapTile`）を重ねたマップ。書き換えが無ければ `map` そのもの。範囲外のレイヤ・座標の書き換えは無視する。 */
export function withTileChanges(map: MapData, changes: MapTileChanges | undefined): MapData {
  if (changes === undefined) return map;
  const entries = Object.entries(changes);
  if (entries.length === 0) return map;
  const byMap = cache.get(map) ?? new WeakMap<object, MapData>();
  const hit = byMap.get(changes);
  if (hit !== undefined) return hit;
  const layers = map.layers.map((l) => ({ ...l, tiles: l.tiles.slice() }));
  for (const [key, tile] of entries) {
    const m = KEY.exec(key);
    if (m === null) continue;
    const layer = layers[Number(m[1])];
    const x = Number(m[2]);
    const y = Number(m[3]);
    if (layer === undefined || x >= map.width || y >= map.height) continue;
    layer.tiles[y * map.width + x] = tile;
  }
  const result: MapData = { ...map, layers };
  byMap.set(changes, result);
  cache.set(map, byMap);
  return result;
}

/** `mapId`（既定：いまのマップ）の、書き換えを反映したタイルを持つ `MapData`。未ロードなら `undefined`。通行・氷・描画はこれを見る。 */
export function currentMap(project: ProjectView, state: GameState, mapId: MapId = state.map.mapId): MapData | undefined {
  const base = project.map(mapId);
  return base === undefined ? undefined : withTileChanges(base, state.mapTiles?.[mapId]);
}
