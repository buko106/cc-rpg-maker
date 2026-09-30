import type { AssetId, EventId, MapData, MapEvent, MapId, Project } from "@rpg/schema";
import type { FrameLayer, FrameSpec, Sprite } from "@rpg/runtime";

/** キャラクターのスプライトシートの規約（runtime の投影と同じ）：1 キャラ = 横 3 パターン × 縦 4 方向。 */
const PATTERNS = 3;
const DIRECTION_ROW = { down: 0, left: 1, right: 2, up: 3 } as const;

/** イベントの見た目：最初にグラフィックを持つページの、止まっているときの絵。 */
function eventSprite(ev: MapEvent, project: Project, tileSize: number): Sprite | undefined {
  const graphic = ev.pages.find((p) => p.graphic !== undefined)?.graphic;
  if (graphic === undefined) return undefined;
  const sheetWidth = project.assets.entries[graphic.asset]?.width ?? PATTERNS * tileSize;
  const blocksPerRow = Math.max(1, Math.floor(sheetWidth / (PATTERNS * tileSize)));
  const col = (graphic.index % blocksPerRow) * PATTERNS;
  const row = Math.floor(graphic.index / blocksPerRow) * 4;
  return {
    asset: graphic.asset,
    sx: (col + 1) * tileSize,
    sy: (row + DIRECTION_ROW[graphic.direction]) * tileSize,
    sw: tileSize,
    sh: tileSize,
    x: ev.x * tileSize,
    y: ev.y * tileSize,
  };
}

/**
 * エディタのマップ表示用の `FrameSpec`。ゲームと同じ `Renderer` で描く：
 * タイルレイヤ（`MapData` のまま）とイベントのスプライト。グリッド・枠・選択はオーバーレイ（`overlay.ts`）が描く。
 */
export function projectMapForEditor(project: Project, map: MapData): FrameSpec {
  const tileSize = project.system.tileSize;
  const tileset = project.tilesets[map.tileset];
  const layers: FrameLayer[] = map.layers.map((layer, z) => ({
    kind: "tiles",
    tileset: tileset?.image?.asset ?? null,
    tileSize,
    width: map.width,
    height: map.height,
    tiles: Array.from(layer.tiles),
    z,
  }));
  const sprites = Object.values(map.events)
    .map((ev) => eventSprite(ev, project, tileSize))
    .filter((s): s is Sprite => s !== undefined)
    .sort((a, b) => a.y - b.y || a.x - b.x);
  if (sprites.length > 0) layers.push({ kind: "sprites", sprites, z: layers.length });
  return {
    size: { width: map.width * tileSize, height: map.height * tileSize },
    camera: { x: 0, y: 0 },
    layers,
    overlay: { fade: 0, tint: { r: 0, g: 0, b: 0, a: 0 }, shake: { dx: 0, dy: 0 } },
    ui: [],
  };
}

/** フレームに現れる画像アセット（読み込みの完了を待って描き直すため）。 */
export function assetsOf(frame: FrameSpec): AssetId[] {
  const ids = new Set<AssetId>();
  for (const layer of frame.layers) {
    if (layer.kind === "tiles") {
      if (layer.tileset !== null) ids.add(layer.tileset);
    } else {
      for (const s of layer.sprites) ids.add(s.asset);
    }
  }
  return [...ids];
}

export interface Cell {
  x: number;
  y: number;
}

/**
 * 画面上の位置（要素の左上からの CSS ピクセル）を、マップのセルにする。範囲外は `undefined`。
 * `shownWidth` / `shownHeight` は画面に出ている大きさ（拡大率込み）。
 */
export function cellAt(map: Pick<MapData, "width" | "height">, offsetX: number, offsetY: number, shownWidth: number, shownHeight: number): Cell | undefined {
  if (!(shownWidth > 0) || !(shownHeight > 0)) return undefined;
  const x = Math.floor((offsetX / shownWidth) * map.width);
  const y = Math.floor((offsetY / shownHeight) * map.height);
  return x >= 0 && y >= 0 && x < map.width && y < map.height ? { x, y } : undefined;
}

/** `(x, y)` にいるイベント（複数いれば ID 順で先頭）。 */
export function eventAt(map: MapData, x: number, y: number): MapEvent | undefined {
  return Object.values(map.events)
    .filter((e) => e.x === x && e.y === y)
    .sort((a, b) => (a.id < b.id ? -1 : 1))[0];
}

/** 2 つのセルの間を結ぶセル（両端を含む。ブレゼンハム）。速いドラッグで途切れないようにする。 */
export function cellsOnLine(from: Cell, to: Cell): Cell[] {
  const cells: Cell[] = [];
  let { x, y } = from;
  const dx = Math.abs(to.x - x);
  const dy = Math.abs(to.y - y);
  const sx = x < to.x ? 1 : -1;
  const sy = y < to.y ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    cells.push({ x, y });
    if (x === to.x && y === to.y) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
  return cells;
}

export interface OverlayModel {
  /** マップの大きさ（ピクセル） */
  width: number;
  height: number;
  tileSize: number;
  grid: boolean;
  events: { id: EventId; x: number; y: number; name: string; selected: boolean }[];
  hover: Cell | undefined;
  /** 選んでいる位置（場所の選択の移動先など）。太い枠で示す */
  marker?: Cell | undefined;
  mapId: MapId;
}

export function overlayModel(project: Project, map: MapData, opts: { selected: EventId | undefined; hover: Cell | undefined; grid: boolean; marker?: Cell | undefined }): OverlayModel {
  const tileSize = project.system.tileSize;
  return {
    mapId: map.id,
    width: map.width * tileSize,
    height: map.height * tileSize,
    tileSize,
    grid: opts.grid,
    events: Object.values(map.events).map((e) => ({ id: e.id, x: e.x, y: e.y, name: e.name, selected: e.id === opts.selected })),
    hover: opts.hover,
    ...(opts.marker === undefined ? {} : { marker: opts.marker }),
  };
}

/** `drawOverlay` が使う 2D コンテキストの一部。 */
export type OverlayContext = Pick<CanvasRenderingContext2D, "clearRect" | "beginPath" | "moveTo" | "lineTo" | "stroke" | "fillRect" | "strokeRect" | "fillText" | "save" | "restore"> & {
  strokeStyle: CanvasRenderingContext2D["strokeStyle"];
  fillStyle: CanvasRenderingContext2D["fillStyle"];
  lineWidth: CanvasRenderingContext2D["lineWidth"];
  font: CanvasRenderingContext2D["font"];
  textBaseline: CanvasRenderingContext2D["textBaseline"];
};

/** グリッド・イベントの枠と名前・選択・ホバーを描く。 */
export function drawOverlay(ctx: OverlayContext, model: OverlayModel): void {
  const { width, height, tileSize: ts } = model;
  ctx.clearRect(0, 0, width, height);
  if (model.grid) {
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= width; x += ts) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, height);
    }
    for (let y = 0; y <= height; y += ts) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(width, y + 0.5);
    }
    ctx.stroke();
  }
  if (model.hover !== undefined) {
    ctx.fillStyle = "rgba(255,255,255,0.28)";
    ctx.fillRect(model.hover.x * ts, model.hover.y * ts, ts, ts);
  }
  ctx.font = "11px sans-serif";
  ctx.textBaseline = "top";
  for (const ev of model.events) {
    ctx.fillStyle = ev.selected ? "rgba(80,200,255,0.30)" : "rgba(255,170,60,0.22)";
    ctx.fillRect(ev.x * ts + 1, ev.y * ts + 1, ts - 2, ts - 2);
    ctx.strokeStyle = ev.selected ? "rgb(80,200,255)" : "rgb(255,170,60)";
    ctx.lineWidth = ev.selected ? 3 : 2;
    ctx.strokeRect(ev.x * ts + 1.5, ev.y * ts + 1.5, ts - 3, ts - 3);
    ctx.fillStyle = "#fff";
    ctx.fillText(ev.name, ev.x * ts + 3, ev.y * ts + 3);
  }
  if (model.marker !== undefined) {
    const { x, y } = model.marker;
    // どのタイルの上でも見えるように、黒の縁取りに黄色の枠
    ctx.fillStyle = "rgba(255,221,0,0.35)";
    ctx.fillRect(x * ts, y * ts, ts, ts);
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 5;
    ctx.strokeRect(x * ts + 2.5, y * ts + 2.5, ts - 5, ts - 5);
    ctx.strokeStyle = "rgb(255,221,0)";
    ctx.lineWidth = 3;
    ctx.strokeRect(x * ts + 2.5, y * ts + 2.5, ts - 5, ts - 5);
  }
}
