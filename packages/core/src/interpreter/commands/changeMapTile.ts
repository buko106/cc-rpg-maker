import { mapIdSchema, nonNegativeInt } from "@rpg/schema";
import * as z from "zod";
import { warn } from "../../effects.js";
import { tileKey } from "../../map/tiles.js";
import { defineCommand } from "../handler.js";

const params = z.strictObject({
  /** `"this"`（既定）は、いまのマップ。 */
  map: z.union([z.literal("this"), mapIdSchema]).default("this"),
  layer: nonNegativeInt.default(0),
  x: nonNegativeInt,
  y: nonNegativeInt,
  width: z.number().int().min(1).default(1),
  height: z.number().int().min(1).default(1),
  /** 置くタイルの番号。0 = 空。 */
  tile: z.number().int().min(0).max(0xffff),
});

/**
 * マップのタイルを書き換える（水門・崩れる橋・開く壁など）。(x, y) から `width` × `height` マスの、`layer` 枚目のタイルを `tile` にする。
 * 書き換えは `GameState.mapTiles` に残り、マップを出入りしても、セーブしても戻らない（もとに戻すには、もとのタイルでもう一度書き換える）。
 * 通行判定・氷・描画は、書き換えたタイルを見る。マップが読み込み済みなら、存在しないレイヤは警告してスキップし、マップの外にはみ出す範囲は切り詰める。
 * 別のマップ（`map`）は、まだ読み込んでいなくても書き換えられる（入ったときに反映される）。
 */
export const changeMapTile = defineCommand({
  code: "ChangeMapTile",
  params,
  meta: {
    label: "マップタイルの変更",
    category: "マップ",
    describe: (p) => {
      const area = p.width === 1 && p.height === 1 ? `(${p.x}, ${p.y})` : `(${p.x}, ${p.y}) から ${p.width}×${p.height}`;
      return `マップタイル：${p.map === "this" ? "このマップ" : p.map} 層${p.layer} ${area} → ${p.tile}`;
    },
    refs: (p) => (p.map === "this" ? [] : [{ kind: "map", id: p.map }]),
  },
  run(p, c) {
    const mapId = p.map === "this" ? c.state.map.mapId : p.map;
    if (c.project.project.maps[mapId] === undefined) return { effects: [warn(`ChangeMapTile: マップ ${mapId} が存在しない`)] };
    const map = c.project.map(mapId);
    if (map !== undefined && p.layer >= map.layers.length) return { effects: [warn(`ChangeMapTile: レイヤ ${p.layer} が無い（${mapId} は ${map.layers.length} 枚）`)] };
    const x2 = Math.min(p.x + p.width, map?.width ?? p.x + p.width);
    const y2 = Math.min(p.y + p.height, map?.height ?? p.y + p.height);
    const effects = x2 < p.x + p.width || y2 < p.y + p.height ? [warn(`ChangeMapTile: 範囲が ${mapId} の外にはみ出す（はみ出した分は無視）`)] : [];
    const next = { ...(c.state.mapTiles?.[mapId] ?? {}) };
    for (let y = p.y; y < y2; y++) for (let x = p.x; x < x2; x++) next[tileKey(p.layer, x, y)] = p.tile;
    return { state: { ...c.state, mapTiles: { ...c.state.mapTiles, [mapId]: next } }, effects };
  },
});
