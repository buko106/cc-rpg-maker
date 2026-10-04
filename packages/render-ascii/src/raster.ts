/**
 * `FrameSpec` を文字のマス目に落とす（純関数。DOM に依存しない）。
 * 画像はマスの大きさごとの平均色にして、明るさで文字を選ぶ。`FrameSpec` に意味情報（壁・人物）は無いので、絵から推す。
 */
import type { AssetId, FrameSpec, RGBA, UiNode } from "@rpg/runtime";

export type RGB = readonly [number, number, number];

export interface Cell {
  /** 空文字は「何も描かない」（空白として出す）。全角文字の 2 マス目は `tail`。 */
  ch: string;
  fg: RGB | undefined;
  bg: RGB | undefined;
  /** 背景の不透明度（0〜1）。省略は 1。UI の層で、下の絵を透かすのに使う。 */
  bgA?: number;
  tail: boolean;
}

export interface Grid {
  readonly cols: number;
  readonly rows: number;
  /** 1 マスの大きさ（ゲームのピクセル）。 */
  readonly cw: number;
  readonly ch: number;
  readonly cells: Cell[];
}

/** 絵の層（`world`、細かいマス）と UI の層（`ui`、粗いマス）。UI の文字を読めるように、層ごとにマスの大きさを変える。 */
export interface Rasterized {
  readonly world: Grid;
  readonly ui: Grid;
}

/** 画像の矩形の平均色。`a` は 0〜1、rgb は α で割り戻した 0〜255。透明なら `undefined`。 */
export interface ImageSampler {
  readonly width: number;
  readonly height: number;
  avg(x: number, y: number, w: number, h: number): { r: number; g: number; b: number; a: number } | undefined;
}

export interface RasterOptions {
  /** UI の 1 マスの大きさ（ゲームのピクセル）。 */
  cellW: number;
  cellH: number;
  /** 絵の層の細かさ。1 マスを縦横 `res` 分割する。既定 3。 */
  res?: number;
  /** 読み込み済みの画像だけ返す。未ロードは `undefined`（そのフレームは描かない）。 */
  sampler(id: AssetId): ImageSampler | undefined;
}

const TILE_RAMP = ".:-=+*#%@";
const SPRITE_RAMP = "ao&8@";
const BLACK: RGB = [0, 0, 0];
const WHITE: RGB = [255, 255, 255];

const num = (v: number): number => (Number.isFinite(v) ? v : 0);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const mix = (a: RGB, b: RGB, t: number): RGB => {
  const k = clamp(num(t), 0, 1);
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
};
const rgbOf = (c: RGBA): RGB => [clamp(num(c.r), 0, 255), clamp(num(c.g), 0, 255), clamp(num(c.b), 0, 255)];

/** 全角（2 マス）で出す文字。 */
export function isWide(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6));
}

export function createGrid(cols: number, rows: number, cw: number, ch: number): Grid {
  const c = Math.max(0, Math.floor(cols));
  const r = Math.max(0, Math.floor(rows));
  return { cols: c, rows: r, cw, ch, cells: Array.from({ length: c * r }, () => ({ ch: "", fg: undefined, bg: undefined, tail: false })) };
}

const at = (g: Grid, cx: number, cy: number): Cell | undefined => (cx < 0 || cy < 0 || cx >= g.cols || cy >= g.rows ? undefined : g.cells[cy * g.cols + cx]);

/** 画像 `ImageData` の平均色を O(1) で返す積分画像。 */
export function createSampler(width: number, height: number, rgba: ArrayLike<number>): ImageSampler {
  const w1 = width + 1;
  const sum = new Float64Array(w1 * (height + 1) * 4); // premultiplied r, g, b と α
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = (rgba[i + 3] ?? 0) / 255;
      const o = ((y + 1) * w1 + (x + 1)) * 4;
      const up = (y * w1 + (x + 1)) * 4;
      const left = ((y + 1) * w1 + x) * 4;
      const diag = (y * w1 + x) * 4;
      for (let c = 0; c < 3; c++) sum[o + c] = (rgba[i + c] ?? 0) * a + sum[up + c]! + sum[left + c]! - sum[diag + c]!;
      sum[o + 3] = a + sum[up + 3]! + sum[left + 3]! - sum[diag + 3]!;
    }
  }
  return {
    width,
    height,
    avg(x, y, w, h) {
      // 浮動小数点の誤差で隣のピクセルを巻き込まないように、わずかに内側へ寄せる
      const e = 1e-6;
      const x0 = clamp(Math.floor(x + e), 0, width - 1);
      const y0 = clamp(Math.floor(y + e), 0, height - 1);
      const x1 = clamp(Math.max(Math.ceil(x + w - e), x0 + 1), x0 + 1, width);
      const y1 = clamp(Math.max(Math.ceil(y + h - e), y0 + 1), y0 + 1, height);
      const get = (px: number, py: number, c: number): number => sum[(py * w1 + px) * 4 + c]!;
      const total = (c: number): number => get(x1, y1, c) - get(x0, y1, c) - get(x1, y0, c) + get(x0, y0, c);
      const area = (x1 - x0) * (y1 - y0);
      const a = total(3);
      if (!(a > 0)) return undefined;
      return { r: total(0) / a, g: total(1) / a, b: total(2) / a, a: a / area };
    },
  };
}

interface Blit {
  sampler: ImageSampler;
  /** 画像の切り出し。 */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** 画面上の左上と倍率。 */
  dx: number;
  dy: number;
  scale: number;
  flipX?: boolean;
  alpha?: number;
  ramp: string;
  /** 背景色も塗る（地形）。 */
  paintBg: boolean;
}

function blit(g: Grid, b: Blit): void {
  const { cw, ch } = g;
  const s = b.scale > 0 ? b.scale : 1;
  const dw = b.sw * s;
  const dh = b.sh * s;
  if (!(dw > 0) || !(dh > 0)) return;
  const cx0 = Math.max(0, Math.floor(b.dx / cw));
  const cx1 = Math.min(g.cols - 1, Math.ceil((b.dx + dw) / cw));
  const cy0 = Math.max(0, Math.floor(b.dy / ch));
  const cy1 = Math.min(g.rows - 1, Math.ceil((b.dy + dh) / ch));
  const bw = Math.min(b.sw, cw / s);
  const bh = Math.min(b.sh, ch / s);
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const px = (cx + 0.5) * cw;
      const py = (cy + 0.5) * ch;
      // マスの中心が画像の範囲に入るときだけ、そのマスを描く（隣の画像と重ならない）
      if (px < b.dx || py < b.dy || px >= b.dx + dw || py >= b.dy + dh) continue;
      let lx = (px - b.dx) / s;
      if (b.flipX === true) lx = b.sw - lx;
      const ly = (py - b.dy) / s;
      const x = b.sx + clamp(lx - bw / 2, 0, Math.max(0, b.sw - bw));
      const y = b.sy + clamp(ly - bh / 2, 0, Math.max(0, b.sh - bh));
      const a = b.sampler.avg(x, y, bw, bh);
      const alpha = (a?.a ?? 0) * (b.alpha ?? 1);
      if (a === undefined || alpha < 0.3) continue;
      const cell = at(g, cx, cy)!;
      const color: RGB = [a.r, a.g, a.b];
      const lum = (0.299 * a.r + 0.587 * a.g + 0.114 * a.b) / 255;
      cell.ch = b.ramp[Math.min(b.ramp.length - 1, Math.floor(lum * b.ramp.length))]!;
      cell.tail = false;
      cell.fg = mix(color, WHITE, 0.2);
      if (b.paintBg) cell.bg = mix(BLACK, color, 0.4);
    }
  }
}

function textCells(g: Grid, x: number, y: number, runs: readonly { text: string; color: RGBA }[], align: "left" | "center" | "right", maxWidth: number | undefined, size: number): void {
  const { cw, ch: chh } = g;
  const widthOf = (s: string): number => [...s].reduce((n, c) => n + (isWide(c) ? 2 : 1), 0);
  // 1 文字ずつ行に分ける（`maxWidth` を超えたら折り返す）
  const lines: { text: string; color: RGBA }[][] = [[]];
  let used = 0;
  const limit = maxWidth !== undefined && maxWidth > 0 ? Math.max(1, Math.floor(maxWidth / cw)) : Infinity;
  for (const run of runs) {
    for (const c of run.text) {
      const w = isWide(c) ? 2 : 1;
      if (used + w > limit && used > 0) {
        lines.push([]);
        used = 0;
      }
      const line = lines[lines.length - 1]!;
      const last = line[line.length - 1];
      if (last !== undefined && last.color === run.color) last.text += c;
      else line.push({ text: c, color: run.color });
      used += w;
    }
  }
  const rowStep = Math.max(1, Math.round((size * 1.25) / chh));
  const row0 = Math.floor((y + Math.min(size, chh) / 2) / chh);
  lines.forEach((line, li) => {
    const total = line.reduce((n, r) => n + widthOf(r.text), 0);
    let col = Math.round(x / cw) - (align === "center" ? Math.floor(total / 2) : align === "right" ? total : 0);
    const row = row0 + li * rowStep;
    for (const run of line) {
      const fg = rgbOf(run.color);
      for (const c of run.text) {
        const cell = at(g, col, row);
        if (cell !== undefined) {
          cell.ch = c;
          cell.fg = fg;
          cell.tail = false;
        }
        if (isWide(c)) {
          const tail = at(g, col + 1, row);
          if (tail !== undefined) {
            tail.ch = "";
            tail.tail = true;
          }
          col += 2;
        } else col += 1;
      }
    }
  });
}

function drawUi(g: Grid, o: RasterOptions, node: UiNode): void {
  const { cw, ch } = g;
  const rect = (x: number, y: number, w: number, h: number): { x0: number; y0: number; x1: number; y1: number } => ({
    x0: Math.round(x / cw),
    y0: Math.round(y / ch),
    x1: Math.max(Math.round(x / cw), Math.round((x + w) / cw) - 1),
    y1: Math.max(Math.round(y / ch), Math.round((y + h) / ch) - 1),
  });
  switch (node.kind) {
    case "window": {
      const r = rect(node.x, node.y, node.w, node.h);
      for (let cy = r.y0; cy <= r.y1; cy++) {
        for (let cx = r.x0; cx <= r.x1; cx++) {
          const cell = at(g, cx, cy);
          if (cell === undefined) continue;
          if (node.variant === "dim") {
            // 下の絵を透かす（UI の層は絵の層の上に重なる）
            cell.bg = BLACK;
            cell.bgA = 0.6;
            continue;
          }
          // 枠の文字は、窓の中の文字（座標が近い）とぶつかるので描かない。背景を塗るだけにする
          cell.ch = "";
          cell.fg = undefined;
          cell.tail = false;
          cell.bg = [40, 40, 110];
          cell.bgA = 0.9;
        }
      }
      for (const child of node.children) drawUi(g, o, child);
      break;
    }
    case "text":
      textCells(g, node.x, node.y, node.runs ?? [{ text: node.text, color: node.color }], node.align ?? "left", node.maxWidth, node.font.size);
      break;
    case "gauge": {
      const r = rect(node.x, node.y + node.h / 2 - ch / 2, node.w, ch);
      const n = r.x1 - r.x0 + 1;
      const filled = Math.round(clamp(num(node.ratio), 0, 1) * n);
      const fg = rgbOf(node.color);
      for (let i = 0; i < n; i++) {
        const cell = at(g, r.x0 + i, r.y0);
        if (cell === undefined) continue;
        cell.ch = i < filled ? "#" : ".";
        cell.fg = i < filled ? fg : mix(fg, BLACK, 0.6);
        cell.tail = false;
      }
      break;
    }
    case "cursor": {
      const r = rect(node.x, node.y, node.w, node.h);
      for (let cy = r.y0; cy <= r.y1; cy++) {
        for (let cx = r.x0; cx <= r.x1; cx++) {
          const cell = at(g, cx, cy);
          if (cell === undefined) continue;
          if (cell.bg === undefined) {
            cell.bg = WHITE;
            cell.bgA = 0.3;
          } else cell.bg = mix(cell.bg, WHITE, 0.3);
        }
      }
      break;
    }
    case "image": {
      const sampler = o.sampler(node.asset);
      if (sampler === undefined) break;
      const sw = node.sw ?? sampler.width;
      const sh = node.sh ?? sampler.height;
      const s = node.scale ?? 1;
      const dx = node.origin === "center" ? node.x - (sw * s) / 2 : node.x;
      const dy = node.origin === "center" ? node.y - (sh * s) / 2 : node.y;
      blit(g, { sampler, sx: node.sx ?? 0, sy: node.sy ?? 0, sw, sh, dx, dy, scale: s, alpha: node.alpha ?? 1, ramp: SPRITE_RAMP, paintBg: false });
      break;
    }
  }
}

export function rasterize(frame: FrameSpec, o: RasterOptions): Rasterized {
  const res = Math.max(1, Math.floor(o.res ?? 3));
  const ui = createGrid(Math.floor(frame.size.width / o.cellW), Math.floor(frame.size.height / o.cellH), o.cellW, o.cellH);
  // 絵の層は UI の層を縦横 res 分割した細かいマス
  const world = createGrid(ui.cols * res, ui.rows * res, o.cellW / res, o.cellH / res);
  const ox = -frame.camera.x + frame.overlay.shake.dx;
  const oy = -frame.camera.y + frame.overlay.shake.dy;

  for (const layer of frame.layers) {
    if (layer.kind === "tiles") {
      const { tileSize: ts, width, height, tiles } = layer;
      if (layer.tileset === null || !(ts > 0) || tiles.length < width * height) continue;
      const sampler = o.sampler(layer.tileset);
      if (sampler === undefined) continue;
      const cols = Math.floor(sampler.width / ts);
      if (cols <= 0) continue;
      const x0 = Math.max(0, Math.floor(-ox / ts));
      const x1 = Math.min(width - 1, Math.floor((-ox + frame.size.width - 1) / ts));
      const y0 = Math.max(0, Math.floor(-oy / ts));
      const y1 = Math.min(height - 1, Math.floor((-oy + frame.size.height - 1) / ts));
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          const id = tiles[ty * width + tx] ?? 0;
          if (id <= 0) continue;
          const sy = Math.floor(id / cols) * ts;
          if (sy + ts > sampler.height) continue;
          blit(world, { sampler, sx: (id % cols) * ts, sy, sw: ts, sh: ts, dx: tx * ts + ox, dy: ty * ts + oy, scale: 1, ramp: TILE_RAMP, paintBg: true });
        }
      }
    } else {
      for (const s of layer.sprites) {
        const sampler = o.sampler(s.asset);
        if (sampler === undefined) continue;
        blit(world, { sampler, sx: s.sx, sy: s.sy, sw: s.sw, sh: s.sh, dx: s.x + ox, dy: s.y + oy, scale: 1, flipX: s.flipX === true, alpha: s.alpha ?? 1, ramp: SPRITE_RAMP, paintBg: false });
      }
    }
  }

  // overlay の順序: tint → flash → fade（何も無いマスは黒として混ぜる）。UI には掛けない（canvas2d と同じ）
  const { tint, flash, fade, fadeColor } = frame.overlay;
  const wash = (color: RGB, t: number): void => {
    if (!(t > 0)) return;
    for (const c of world.cells) {
      c.bg = mix(c.bg ?? BLACK, color, t);
      if (c.fg !== undefined) c.fg = mix(c.fg, color, t);
    }
  };
  if (tint.a > 0) wash(rgbOf(tint), tint.a);
  if (flash !== undefined && flash.alpha > 0) wash(rgbOf(flash.color), flash.color.a * flash.alpha);
  if (fade > 0) wash(fadeColor === undefined ? BLACK : rgbOf(fadeColor), Math.min(1, fade));

  for (const node of frame.ui) drawUi(ui, o, node);
  return { world, ui };
}

/** 色を無視した文字だけの出力（テストと端末向け）。全角の 2 マス目は出さない。 */
export function gridToText(g: Grid): string {
  const lines: string[] = [];
  for (let y = 0; y < g.rows; y++) {
    let line = "";
    for (let x = 0; x < g.cols; x++) {
      const c = g.cells[y * g.cols + x]!;
      if (!c.tail) line += c.ch === "" ? " " : c.ch;
    }
    lines.push(line.trimEnd());
  }
  return lines.join("\n");
}
