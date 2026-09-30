import { newId } from "@rpg/schema";
import type { AudioRef, MapData, MapId, MapMeta, TilesetId } from "@rpg/schema";
import { defineEdit, err, invalid, mapOf, notFound, ok, withEntry, withMap } from "../command.js";
import type { EditorCommand } from "../command.js";

export interface TileCell {
  x: number;
  y: number;
  tile: number;
}

export interface PaintTilesCommand extends EditorCommand {
  readonly kind: "paintTiles";
  readonly mapId: MapId;
  readonly layer: number;
  readonly cells: readonly TileCell[];
}

const MAX_TILE = 0xffff;
const isPaint = (c: EditorCommand): c is PaintTilesCommand => c.kind === "paintTiles";

/** 新しいレイヤ配列（対象レイヤのタイルを差し替える）。 */
function withLayerTiles(map: MapData, layer: number, tiles: number[]): MapData {
  return { ...map, layers: map.layers.map((l, i) => (i === layer ? { ...l, tiles } : l)) };
}

/** レイヤ番号を確かめて、そのレイヤを返す。 */
function layerOf(map: MapData, layer: number) {
  const l = map.layers[layer];
  return Number.isInteger(layer) && l !== undefined ? ok(l) : err(invalid(`レイヤ ${layer} が無い（マップ ${map.id} は ${map.layers.length} 枚）`));
}

/** タイルを置く。範囲外・不正なタイル番号は `invalid`。同じタイルを置くだけなら何も変えない。 */
export function paintTiles(mapId: MapId, layer: number, cells: readonly TileCell[]): PaintTilesCommand {
  const base = defineEdit({
    kind: "paintTiles",
    label: "タイルを描く",
    maps: [mapId],
    apply(doc) {
      const map = mapOf(doc, mapId);
      if (map === undefined) return err(notFound("マップ", mapId));
      const l = layerOf(map, layer);
      if (!l.ok) return l;
      const tiles = Array.from(l.value.tiles);
      let changed = false;
      for (const c of cells) {
        if (!Number.isInteger(c.x) || !Number.isInteger(c.y) || c.x < 0 || c.y < 0 || c.x >= map.width || c.y >= map.height) {
          return err(invalid(`(${c.x},${c.y}) はマップ ${mapId} の外`));
        }
        if (!Number.isInteger(c.tile) || c.tile < 0 || c.tile > MAX_TILE) return err(invalid(`タイル番号 ${c.tile} は 0〜${MAX_TILE} の整数でなければならない`));
        const at = c.y * map.width + c.x;
        if (tiles[at] !== c.tile) {
          tiles[at] = c.tile;
          changed = true;
        }
      }
      return ok(changed ? withMap(doc, withLayerTiles(map, layer, tiles)) : doc);
    },
    coalesce: (prev) => (isPaint(prev) && prev.mapId === mapId && prev.layer === layer ? paintTiles(mapId, layer, [...prev.cells, ...cells]) : undefined),
  });
  return Object.assign(base, { kind: "paintTiles" as const, mapId, layer, cells });
}

/** `(x, y)` とつながっている同じタイルを `tile` で塗りつぶす（上下左右）。 */
export function fillTiles(mapId: MapId, layer: number, x: number, y: number, tile: number): EditorCommand {
  return defineEdit({
    kind: "fillTiles",
    label: "塗りつぶし",
    maps: [mapId],
    apply(doc) {
      const map = mapOf(doc, mapId);
      if (map === undefined) return err(notFound("マップ", mapId));
      const l = layerOf(map, layer);
      if (!l.ok) return l;
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= map.width || y >= map.height) return err(invalid(`(${x},${y}) はマップ ${mapId} の外`));
      if (!Number.isInteger(tile) || tile < 0 || tile > MAX_TILE) return err(invalid(`タイル番号 ${tile} は 0〜${MAX_TILE} の整数でなければならない`));
      const tiles = Array.from(l.value.tiles);
      const from = tiles[y * map.width + x]!;
      if (from === tile) return ok(doc);
      const stack = [[x, y] as const];
      while (stack.length > 0) {
        const [cx, cy] = stack.pop()!;
        if (cx < 0 || cy < 0 || cx >= map.width || cy >= map.height || tiles[cy * map.width + cx] !== from) continue;
        tiles[cy * map.width + cx] = tile;
        stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
      }
      return ok(withMap(doc, withLayerTiles(map, layer, tiles)));
    },
  });
}

/** リサイズの基準位置：北西・北・北東・西・中央・東・南西・南・南東。 */
export type Anchor = "nw" | "n" | "ne" | "w" | "c" | "e" | "sw" | "s" | "se";

const offsetOf = (delta: number, side: "start" | "middle" | "end"): number => (side === "start" ? 0 : side === "middle" ? Math.floor(delta / 2) : delta);

/**
 * マップの大きさを変える。`anchor` の側を固定して、内容（タイル・イベント）を寄せる。
 * はみ出したイベントは消える（Undo で戻る）。開始位置がこのマップなら、内容と一緒に動かして範囲内に収める。
 */
export function resizeMap(mapId: MapId, width: number, height: number, anchor: Anchor): EditorCommand {
  return defineEdit({
    kind: "resizeMap",
    label: "マップサイズの変更",
    maps: [mapId],
    project: true,
    apply(doc) {
      const map = mapOf(doc, mapId);
      if (map === undefined) return err(notFound("マップ", mapId));
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 1000 || height > 1000) {
        return err(invalid(`マップサイズ ${width}×${height} は 1〜1000 の整数でなければならない`));
      }
      if (width === map.width && height === map.height) return ok(doc);
      const dx = offsetOf(width - map.width, anchor.includes("w") ? "start" : anchor.includes("e") ? "end" : "middle");
      const dy = offsetOf(height - map.height, anchor.includes("n") ? "start" : anchor.includes("s") ? "end" : "middle");
      const layers = map.layers.map((l) => {
        const tiles = new Array<number>(width * height).fill(0);
        for (let y = 0; y < map.height; y++) {
          for (let x = 0; x < map.width; x++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < width && ny < height) tiles[ny * width + nx] = l.tiles[y * map.width + x]!;
          }
        }
        return { ...l, tiles };
      });
      const events = Object.fromEntries(
        Object.entries(map.events)
          .map(([id, e]) => [id, { ...e, x: e.x + dx, y: e.y + dy }] as const)
          .filter(([, e]) => e.x >= 0 && e.y >= 0 && e.x < width && e.y < height),
      );
      const { system } = doc.project;
      const clamp = (v: number, max: number): number => Math.min(Math.max(v, 0), max - 1);
      const project =
        system.startMap === mapId
          ? { ...doc.project, system: { ...system, startX: clamp(system.startX + dx, width), startY: clamp(system.startY + dy, height) } }
          : doc.project;
      return ok({ ...withMap(doc, { ...map, width, height, layers, events }), project });
    },
  });
}

export interface NewMapData extends Partial<Omit<MapData, "id">> {}

/** 空のタイルレイヤを `count` 枚作る。 */
export const blankLayers = (width: number, height: number, names: readonly string[] = ["下層", "上層"]): MapData["layers"] =>
  names.map((name) => ({ name, tiles: new Array<number>(width * height).fill(0) }));

/** マップを追加する。`data` を省略した項目は既定（20×15、レイヤ 2 枚、先頭のタイルセット）。ID は省略すると新しく採番する。 */
export function createMap(meta: Omit<MapMeta, "id">, data: NewMapData = {}, id: MapId = newId<"MapId">("map")): EditorCommand {
  return defineEdit({
    kind: "createMap",
    label: "マップの追加",
    maps: [id],
    project: true,
    apply(doc) {
      if (Object.hasOwn(doc.project.maps, id)) return err({ kind: "duplicate", message: `マップ ${id} は既にある` });
      const tileset: TilesetId | undefined = data.tileset ?? (Object.keys(doc.project.tilesets)[0] as TilesetId | undefined);
      if (tileset === undefined) return err(invalid("タイルセットが 1 つも無いので、マップを作れない"));
      const width = data.width ?? 20;
      const height = data.height ?? 15;
      const map: MapData = { events: {}, layers: blankLayers(width, height), ...data, id, width, height, tileset };
      return ok({
        ...doc,
        project: { ...doc.project, maps: { ...doc.project.maps, [id]: { ...meta, id } } },
        maps: { ...doc.maps, [id]: map },
      });
    },
  });
}

/** マップを削除する。他から参照されていれば（開始マップ・場所移動・親子）`hasReferences`。 */
export function deleteMap(mapId: MapId): EditorCommand {
  return defineEdit({
    kind: "deleteMap",
    label: "マップの削除",
    maps: [mapId],
    project: true,
    removes: [{ kind: "map", id: mapId }],
    apply(doc) {
      if (!Object.hasOwn(doc.project.maps, mapId)) return err(notFound("マップ", mapId));
      const maps = { ...doc.maps };
      delete maps[mapId];
      return ok({ ...doc, project: { ...doc.project, maps: withEntry(doc.project.maps, mapId, undefined) }, maps });
    },
  });
}

/** マップ名・順序・親を変える。親が自分自身か子孫なら `invalid`。 */
export function setMapMeta(mapId: MapId, patch: Partial<Omit<MapMeta, "id" | "parent">> & { parent?: MapId | null }): EditorCommand {
  return defineEdit({
    kind: "setMapMeta",
    label: "マップ情報の変更",
    project: true,
    apply(doc) {
      const meta = Object.hasOwn(doc.project.maps, mapId) ? doc.project.maps[mapId] : undefined;
      if (meta === undefined) return err(notFound("マップ", mapId));
      const { parent, ...rest } = patch;
      if (parent !== undefined && parent !== null) {
        if (!Object.hasOwn(doc.project.maps, parent)) return err(notFound("親マップ", parent));
        for (let p: MapId | undefined = parent; p !== undefined; p = doc.project.maps[p]?.parent) {
          if (p === mapId) return err(invalid("親マップに自分自身か子孫は選べない"));
        }
      }
      const { parent: _old, ...kept } = meta;
      const nextParent = parent === undefined ? meta.parent : (parent ?? undefined);
      const next: MapMeta = { ...kept, ...rest, id: mapId, ...(nextParent === undefined ? {} : { parent: nextParent }) };
      return ok({ ...doc, project: { ...doc.project, maps: { ...doc.project.maps, [mapId]: next } } });
    },
  });
}

/** マップのタイルセット・BGM・エンカウントを変える（`null` は「なし」）。 */
export function setMapProperties(
  mapId: MapId,
  patch: { tileset?: TilesetId; bgm?: AudioRef | null; encounters?: MapData["encounters"] | null },
): EditorCommand {
  return defineEdit({
    kind: "setMapProperties",
    label: "マップ設定の変更",
    maps: [mapId],
    apply(doc) {
      const map = mapOf(doc, mapId);
      if (map === undefined) return err(notFound("マップ", mapId));
      const { bgm: _b, encounters: _e, ...rest } = map;
      const bgm = patch.bgm === undefined ? map.bgm : (patch.bgm ?? undefined);
      const encounters = patch.encounters === undefined ? map.encounters : (patch.encounters ?? undefined);
      return ok(withMap(doc, { ...rest, ...(patch.tileset === undefined ? {} : { tileset: patch.tileset }), ...(bgm === undefined ? {} : { bgm }), ...(encounters === undefined ? {} : { encounters }) }));
    },
  });
}
