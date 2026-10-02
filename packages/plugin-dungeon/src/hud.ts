import type { FrameSpec, GameState, UiNode } from "@rpg/plugin-api";
import type { Config } from "./config.js";
import { STAIRS, TREASURE } from "./generate.js";
import { readDungeon } from "./model.js";
import type { DungeonState } from "./model.js";
import { canSee, POPUP_FRAMES } from "./turn.js";

type Layer = FrameSpec["layers"][number];
type Sprite = Extract<Layer, { kind: "sprites" }>["sprites"][number];
type Color = { r: number; g: number; b: number; a: number };

const WHITE: Color = { r: 255, g: 255, b: 255, a: 1 };
const YELLOW: Color = { r: 255, g: 255, b: 160, a: 1 };
const font = (size: number, bold = false) => ({ family: "sans-serif", size, ...(bold ? { bold: true } : {}) });
const text = (x: number, y: number, t: string, color: Color, size = 13, align: "left" | "center" | "right" = "left", bold = false): UiNode => ({ kind: "text", x, y, text: t, font: font(size, bold), color, align });
const gauge = (x: number, y: number, w: number, h: number, ratio: number, color: Color): UiNode => ({ kind: "gauge", x, y, w, h, ratio, color });

const TONE: Record<DungeonState["fx"][number]["tone"], Color> = {
  dmg: { r: 255, g: 255, b: 255, a: 1 },
  hurt: { r: 255, g: 110, b: 110, a: 1 },
  heal: { r: 140, g: 255, b: 160, a: 1 },
  info: { r: 255, g: 235, b: 130, a: 1 },
};

/** 敵が 1 マス動くのにかける時間（フレーム）。プレイヤーの歩く速さ（`speed` 5）と同じ。 */
export const ENEMY_STEP_FRAMES = 8;
/** 階に着いたときの見出しを出しておく長さ（フレーム）。 */
const BANNER_FRAMES = 100;

/** 描き足す内容（敵・物・ミニマップ・ステータス・ログ）。 */
export function dungeonHud(frame: FrameSpec, state: GameState, cfg: Config | undefined): FrameSpec {
  const ds = readDungeon(state);
  if (ds === undefined || cfg === undefined) return frame;
  const tilesLayer = frame.layers.find((l) => l.kind === "tiles");
  if (tilesLayer === undefined || tilesLayer.kind !== "tiles" || tilesLayer.width !== ds.width || tilesLayer.height !== ds.height) return frame;
  const ts = tilesLayer.tileSize;
  const hero = state.party.members[0] === undefined ? undefined : state.actors[state.party.members[0]];

  // 歩いていない場所は描かない（暗いまま）
  const layers: Layer[] = frame.layers.map((l) => (l.kind === "tiles" && l.width === ds.width ? { ...l, tiles: l.tiles.map((t, i) => (ds.seen[i] === "1" ? t : 0)) } : l));
  const at = (x: number, y: number): { x: number; y: number } => ({ x: Math.round(x * ts), y: Math.round(y * ts) });
  const size = cfg.sprites.size;
  const sprite = (s: { sx: number; sy: number }, p: { x: number; y: number }): Sprite => ({ asset: cfg.sprites.asset as Sprite["asset"], sx: s.sx, sy: s.sy, sw: size, sh: size, x: p.x, y: p.y });

  const itemSprites: Sprite[] = [];
  for (const it of ds.items) {
    if (ds.seen[it.y * ds.width + it.x] !== "1") continue;
    const entry = cfg.items.find((e) => e.key === it.key);
    itemSprites.push(sprite(entry?.sprite ?? cfg.sprites.drop, at(it.x, it.y)));
  }
  const enemySprites: Sprite[] = [];
  const bars: UiNode[] = [];
  const cam = frame.camera;
  for (const e of ds.enemies) {
    if (!canSee(ds, e.x, e.y)) continue;
    const entry = cfg.enemies.find((x) => x.enemy === e.kind);
    if (entry === undefined) continue;
    const k = Math.min(1, Math.max(0, (state.tick - e.t) / ENEMY_STEP_FRAMES));
    const p = at(e.fx + (e.x - e.fx) * k, e.fy + (e.y - e.fy) * k);
    const bob = Math.round(Math.sin((state.tick + e.id * 7) / 9) * 1.5);
    enemySprites.push(sprite(entry.sprite, { x: p.x, y: p.y + bob }));
    if (e.hp < e.mhp) bars.push(gauge(p.x - cam.x + 4, p.y - cam.y - 2, ts - 8, 4, e.hp / e.mhp, { r: 230, g: 80, b: 80, a: 1 }));
  }
  // 敵・物は、タイルの上、キャラクター（プレイヤー）の下に描く
  const lastTiles = layers.reduce((n, l, i) => (l.kind === "tiles" ? i : n), -1);
  layers.splice(lastTiles + 1, 0, { kind: "sprites", sprites: itemSprites, z: 90 }, { kind: "sprites", sprites: enemySprites, z: 150 });

  const ui: UiNode[] = [...bars];
  const W = frame.size.width;
  const H = frame.size.height;

  // ステータス（左上）
  const hp = hero?.hp ?? 0;
  const mhp = Math.max(1, ds.mhp);
  const low = hp / mhp <= 0.25;
  ui.push({
    kind: "window",
    x: 8,
    y: 8,
    w: 196,
    h: 64,
    variant: "normal",
    children: [
      text(16, 12, `地下 ${ds.floor} 階`, WHITE, 14, "left", true),
      text(196, 12, `Lv ${hero?.level ?? 1}`, YELLOW, 14, "right", true),
      text(16, 31, "HP", WHITE, 12),
      gauge(50, 34, 92, 8, Math.max(0, hp) / mhp, low ? { r: 240, g: 90, b: 90, a: 1 } : { r: 110, g: 220, b: 130, a: 1 }),
      text(196, 31, `${Math.max(0, hp)}/${mhp}`, WHITE, 12, "right"),
      text(16, 48, "満腹", WHITE, 12),
      gauge(50, 51, 92, 8, ds.belly / Math.max(1, cfg.belly.max), ds.belly <= cfg.belly.weak ? { r: 240, g: 90, b: 90, a: 1 } : { r: 240, g: 190, b: 90, a: 1 }),
      text(196, 48, `${ds.belly}/${cfg.belly.max}`, WHITE, 12, "right"),
    ],
  });

  // ミニマップ（右上）：歩いた場所の床を、3px のマスで描く
  const cell = 3;
  const mw = ds.width * cell;
  const mh = ds.height * cell;
  const mx = W - mw - 12;
  const my = 12;
  const map: UiNode[] = [];
  for (let y = 0; y < ds.height; y++) {
    let run = -1;
    const flush = (end: number): void => {
      if (run >= 0) map.push(gauge(mx + run * cell, my + y * cell, (end - run) * cell, cell, 1, { r: 150, g: 160, b: 190, a: 1 }));
      run = -1;
    };
    for (let x = 0; x < ds.width; x++) {
      const i = y * ds.width + x;
      const ch = ds.grid[i];
      const plain = ds.seen[i] === "1" && ch === ".";
      if (plain) {
        if (run < 0) run = x;
        continue;
      }
      flush(x);
      if (ds.seen[i] === "1" && (ch === STAIRS || ch === TREASURE)) map.push(gauge(mx + x * cell, my + y * cell, cell, cell, 1, { r: 255, g: 220, b: 90, a: 1 }));
    }
    flush(ds.width);
  }
  for (const e of ds.enemies) if (canSee(ds, e.x, e.y)) map.push(gauge(mx + e.x * cell, my + e.y * cell, cell, cell, 1, { r: 240, g: 70, b: 70, a: 1 }));
  map.push(gauge(mx + ds.px * cell - 1, my + ds.py * cell - 1, cell + 2, cell + 2, 1, WHITE));
  ui.push({ kind: "window", x: mx - 4, y: my - 4, w: mw + 8, h: mh + 8, variant: "dim", children: map });

  // ログ（左下）
  const lines = ds.log.slice(-3);
  if (lines.length > 0) {
    const lh = 17;
    ui.push({
      kind: "window",
      x: 8,
      y: H - 16 - lines.length * lh - 8,
      w: 320,
      h: lines.length * lh + 12,
      variant: "dim",
      children: lines.map((l, i) => text(16, H - 16 - lines.length * lh + i * lh, l, i === lines.length - 1 ? WHITE : { r: 200, g: 200, b: 210, a: 1 }, 13)),
    });
  }

  // ダメージなどの数字（その場から浮かんで消える）
  for (const f of ds.fx) {
    const age = state.tick - f.t;
    if (age < 0 || age >= POPUP_FRAMES) continue;
    const c = TONE[f.tone];
    ui.push(text(f.x * ts - cam.x + ts / 2, f.y * ts - cam.y - age * 0.5, f.text, { ...c, a: Math.min(1, (POPUP_FRAMES - age) / 15) }, f.text.length > 4 ? 14 : 18, "center", true));
  }

  // 階に着いたときの見出し
  const since = state.tick - ds.ft;
  if (since >= 0 && since < BANNER_FRAMES) {
    ui.push({
      kind: "window",
      x: W / 2 - 90,
      y: 96,
      w: 180,
      h: 52,
      variant: "dim",
      children: [text(W / 2, 108, `地下 ${ds.floor} 階`, WHITE, 26, "center", true)],
    });
  }

  return { ...frame, layers, ui: [...ui, ...frame.ui] };
}

