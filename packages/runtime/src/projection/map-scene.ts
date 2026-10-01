import { currentMap } from "@rpg/core";
import type { Character, EventRuntime, GameState, ProjectView } from "@rpg/core";
import type { Direction } from "@rpg/schema";
import type { FrameLayer, Sprite } from "../frame-spec.js";

const DIRECTION_ROW: Record<Direction, number> = { down: 0, left: 1, right: 2, up: 3 };
const PATTERNS = 3;

type Priority = "below" | "same" | "above";
const PRIORITY_Z: Record<Priority, number> = { below: 100, same: 200, above: 300 };

interface Drawable {
  readonly priority: Priority;
  readonly y: number;
  readonly order: number;
  readonly sprite: Sprite;
}

/**
 * キャラクターのスプライトシートの規約：1 キャラ = 横 3 パターン × 縦 4 方向（下・左・右・上）で、
 * 1 コマは `tileSize` 四方。`index` 番のキャラは、シートを（3 * tileSize）× （4 * tileSize）のブロックに
 * 区切って左→右、上→下に数える。
 */
function characterSprite(ch: Character, view: ProjectView, tileSize: number): Sprite | null {
  if (ch.graphic === undefined) return null;
  const { asset, index } = ch.graphic;
  const sheetWidth = view.project.assets.entries[asset]?.width ?? PATTERNS * tileSize;
  const blocksPerRow = Math.max(1, Math.floor(sheetWidth / (PATTERNS * tileSize)));
  const col = (index % blocksPerRow) * PATTERNS;
  const row = Math.floor(index / blocksPerRow) * 4;
  // 歩行中は移動の前半・後半で足を替える。止まっているときは中央のパターン。
  const progress = ch.moving ? Math.abs(ch.realX - ch.x) + Math.abs(ch.realY - ch.y) : 0;
  const pattern = ch.moving ? (progress >= 0.5 ? 0 : 2) : 1;
  return {
    asset,
    sx: (col + pattern) * tileSize,
    sy: (row + DIRECTION_ROW[ch.direction]) * tileSize,
    sw: tileSize,
    sh: tileSize,
    x: Math.round(ch.realX * tileSize),
    y: Math.round(ch.realY * tileSize),
  };
}

/** マップ本体のタイルレイヤとキャラクターのスプライトレイヤ。マップが未ロードなら空。 */
export function projectMapLayers(state: GameState, view: ProjectView): { tileSize: number; layers: FrameLayer[] } {
  const tileSize = view.project.system.tileSize;
  const map = currentMap(view, state);
  if (map === undefined) return { tileSize, layers: [] };

  const tileset = view.tileset(map.tileset);
  const layers: FrameLayer[] = map.layers.map((layer, z) => ({
    kind: "tiles",
    tileset: tileset?.image?.asset ?? null,
    tileSize,
    width: map.width,
    height: map.height,
    tiles: Array.from(layer.tiles),
    z,
  }));

  const drawables: Drawable[] = [];
  const events: EventRuntime[] = Object.values(state.map.events).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  events.forEach((ev, order) => {
    if (ev.pageIndex === null) return;
    const sprite = characterSprite(ev, view, tileSize);
    if (sprite) drawables.push({ priority: ev.priority, y: ev.realY, order, sprite });
  });
  const playerSprite = characterSprite(state.map.player, view, tileSize);
  // 同じ高さではプレイヤーを手前（後）に描く
  if (playerSprite) drawables.push({ priority: "same", y: state.map.player.realY, order: events.length, sprite: playerSprite });

  for (const priority of ["below", "same", "above"] as const) {
    const sprites = drawables
      .filter((d) => d.priority === priority)
      .sort((a, b) => a.y - b.y || a.order - b.order)
      .map((d) => d.sprite);
    if (sprites.length > 0) layers.push({ kind: "sprites", sprites, z: PRIORITY_Z[priority] });
  }
  return { tileSize, layers };
}
