import type { AssetId, FrameLayer, FrameSpec, RGBA, UiNode } from "@rpg/runtime";

/** 矩形に貼るもの：単色（白い 1×1）、画像（アセット）、文字（白で描いたものを頂点色で染める）。 */
export type TextureRef = { kind: "white" } | { kind: "asset"; id: AssetId } | { kind: "text"; text: string; font: string; width: number; height: number };

/** 画面座標（論理ピクセル）の矩形 1 枚。`u` `v` は 0〜1 のテクスチャ座標。色は 0〜1（頂点色として掛ける）。 */
export interface Quad {
  tex: TextureRef;
  x: number;
  y: number;
  w: number;
  h: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

/** 描画リストを作るのに必要な、外の情報。 */
export interface DrawEnv {
  /** ロード済みならサイズ。未ロードなら `undefined`（そのアセットは描かず、非同期ロードを始める）。 */
  image(id: AssetId): { width: number; height: number } | undefined;
  /** 文字列の幅（`font` は CSS の font 指定）。 */
  measure(font: string, text: string): number;
}

// Canvas2D レンダラと同じ見た目の定数
const WINDOW_FILL: RGBA = { r: 16, g: 16, b: 64, a: 0.88 };
const WINDOW_BORDER: RGBA = { r: 255, g: 255, b: 255, a: 0.9 };
const DIM_FILL: RGBA = { r: 0, g: 0, b: 0, a: 0.6 };
const CURSOR_FILL: RGBA = { r: 255, g: 255, b: 255, a: 0.18 };
const GAUGE_BACK: RGBA = { r: 0, g: 0, b: 0, a: 0.6 };

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
/** 色を 0〜1 に。Canvas2D の `css()` と同じく、r/g/b は整数に丸める。 */
const norm = (c: RGBA): { r: number; g: number; b: number; a: number } => ({
  r: Math.round(clamp(c.r, 0, 255)) / 255,
  g: Math.round(clamp(c.g, 0, 255)) / 255,
  b: Math.round(clamp(c.b, 0, 255)) / 255,
  a: clamp(c.a, 0, 1),
});

/** 文字のテクスチャの余白（縁の欠けを防ぐ）。 */
export const TEXT_PAD = 1;
/** 行の高さの倍率（Canvas2D レンダラの折り返し行の間隔と同じ）。 */
export const LINE_HEIGHT = 1.25;

export const fontOf = (f: { family: string; size: number; bold?: boolean }): string => `${f.bold === true ? "bold " : ""}${f.size}px ${f.family}`;

const WHITE: TextureRef = { kind: "white" };

export function solid(x: number, y: number, w: number, h: number, color: RGBA): Quad {
  const c = norm(color);
  return { tex: WHITE, x, y, w, h, u0: 0, v0: 0, u1: 1, v1: 1, ...c };
}

/** 枠線を矩形 4 枚（重ならない）で表す。`x0..x1` `y0..y1` は外側の矩形、`t` は太さ。 */
function border(x0: number, y0: number, x1: number, y1: number, t: number, color: RGBA): Quad[] {
  return [
    solid(x0, y0, x1 - x0, t, color),
    solid(x0, y1 - t, x1 - x0, t, color),
    solid(x0, y0 + t, t, y1 - y0 - 2 * t, color),
    solid(x1 - t, y0 + t, t, y1 - y0 - 2 * t, color),
  ];
}

/** `maxWidth` を超えないように 1 文字ずつ折り返す（Canvas2D レンダラと同じ方式）。 */
export function wrapText(env: DrawEnv, font: string, text: string, maxWidth: number | undefined): string[] {
  if (maxWidth === undefined || !(maxWidth > 0)) return [text];
  const lines: string[] = [];
  let line = "";
  for (const ch of text) {
    if (line !== "" && env.measure(font, line + ch) > maxWidth) {
      lines.push(line);
      line = ch;
    } else {
      line += ch;
    }
  }
  lines.push(line);
  return lines;
}

function textQuad(env: DrawEnv, text: string, font: string, size: number, x: number, y: number, color: RGBA): Quad | undefined {
  if (text === "") return undefined;
  const width = Math.ceil(env.measure(font, text)) + TEXT_PAD * 2;
  const height = Math.ceil(size * LINE_HEIGHT) + TEXT_PAD * 2;
  return { tex: { kind: "text", text, font, width, height }, x: x - TEXT_PAD, y: y - TEXT_PAD, w: width, h: height, u0: 0, v0: 0, u1: 1, v1: 1, ...norm(color) };
}

function tiles(out: Quad[], layer: Extract<FrameLayer, { kind: "tiles" }>, frame: FrameSpec, ox: number, oy: number, env: DrawEnv): void {
  const { tileSize: ts, width, height, tiles: ids } = layer;
  if (layer.tileset === null || !(ts > 0) || ids.length < width * height) return;
  const img = env.image(layer.tileset);
  if (img === undefined) return;
  const cols = Math.floor(img.width / ts);
  if (cols <= 0) return;
  const left = -ox;
  const top = -oy;
  const x0 = Math.max(0, Math.floor(left / ts));
  const x1 = Math.min(width - 1, Math.floor((left + frame.size.width - 1) / ts));
  const y0 = Math.max(0, Math.floor(top / ts));
  const y1 = Math.min(height - 1, Math.floor((top + frame.size.height - 1) / ts));
  const tex: TextureRef = { kind: "asset", id: layer.tileset };
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const id = ids[ty * width + tx] ?? 0;
      if (id <= 0) continue;
      const sx = (id % cols) * ts;
      const sy = Math.floor(id / cols) * ts;
      if (sy + ts > img.height) continue;
      out.push({ tex, x: tx * ts + ox, y: ty * ts + oy, w: ts, h: ts, u0: sx / img.width, v0: sy / img.height, u1: (sx + ts) / img.width, v1: (sy + ts) / img.height, r: 1, g: 1, b: 1, a: 1 });
    }
  }
}

function sprites(out: Quad[], layer: Extract<FrameLayer, { kind: "sprites" }>, ox: number, oy: number, env: DrawEnv): void {
  for (const s of layer.sprites) {
    const img = env.image(s.asset);
    if (img === undefined) continue;
    const u0 = s.sx / img.width;
    const u1 = (s.sx + s.sw) / img.width;
    out.push({
      tex: { kind: "asset", id: s.asset },
      x: s.x + ox,
      y: s.y + oy,
      w: s.sw,
      h: s.sh,
      u0: s.flipX === true ? u1 : u0,
      u1: s.flipX === true ? u0 : u1,
      v0: s.sy / img.height,
      v1: (s.sy + s.sh) / img.height,
      r: 1,
      g: 1,
      b: 1,
      a: clamp(s.alpha ?? 1, 0, 1),
    });
  }
}

function ui(out: Quad[], node: UiNode, env: DrawEnv): void {
  switch (node.kind) {
    case "window":
      if (node.variant === "dim") out.push(solid(node.x, node.y, node.w, node.h, DIM_FILL));
      else {
        out.push(solid(node.x, node.y, node.w, node.h, WINDOW_FILL));
        out.push(...border(node.x, node.y, node.x + node.w, node.y + node.h, 2, WINDOW_BORDER));
      }
      for (const child of node.children) ui(out, child, env);
      break;
    case "text": {
      const font = fontOf(node.font);
      if (node.runs !== undefined) {
        let x = node.x;
        for (const run of node.runs) {
          const q = textQuad(env, run.text, font, node.font.size, x, node.y, run.color);
          if (q !== undefined) out.push(q);
          x += env.measure(font, run.text);
        }
        break;
      }
      wrapText(env, font, node.text, node.maxWidth).forEach((line, i) => {
        const width = env.measure(font, line);
        const x = node.align === "center" ? node.x - width / 2 : node.align === "right" ? node.x - width : node.x;
        const q = textQuad(env, line, font, node.font.size, x, node.y + i * node.font.size * LINE_HEIGHT, node.color);
        if (q !== undefined) out.push(q);
      });
      break;
    }
    case "gauge":
      out.push(solid(node.x, node.y, node.w, node.h, GAUGE_BACK));
      out.push(solid(node.x, node.y, node.w * clamp(node.ratio, 0, 1), node.h, node.color));
      break;
    case "cursor":
      out.push(solid(node.x, node.y, node.w, node.h, CURSOR_FILL));
      // Canvas2D の strokeRect(lineWidth 2) は線が矩形の縁をまたぐ：外側 1px、内側 1px
      out.push(...border(node.x - 1, node.y - 1, node.x + node.w + 1, node.y + node.h + 1, 2, WINDOW_BORDER));
      break;
    case "image": {
      const img = env.image(node.asset);
      if (img === undefined) break;
      const sx = node.sx ?? 0;
      const sy = node.sy ?? 0;
      const sw = node.sw ?? img.width;
      const sh = node.sh ?? img.height;
      const dw = sw * (node.scale ?? 1);
      const dh = sh * (node.scale ?? 1);
      const dx = node.origin === "center" ? node.x - dw / 2 : node.x;
      const dy = node.origin === "center" ? node.y - dh / 2 : node.y;
      const a = clamp(node.alpha ?? 1, 0, 1);
      if (a <= 0) break;
      out.push({ tex: { kind: "asset", id: node.asset }, x: dx, y: dy, w: dw, h: dh, u0: sx / img.width, v0: sy / img.height, u1: (sx + sw) / img.width, v1: (sy + sh) / img.height, r: 1, g: 1, b: 1, a });
      break;
    }
  }
}

/**
 * `FrameSpec` を、描く順に並べた矩形のリストにする（純粋な関数）。順序は Canvas2D レンダラと同じ：
 * レイヤ → 色調 → フラッシュ → 暗転 → UI。シェイクは全レイヤへのカメラオフセット。
 * 未ロードの画像は飛ばす（`env.image` が `undefined` を返したもの）。
 */
export function buildDrawList(frame: FrameSpec, env: DrawEnv): Quad[] {
  const out: Quad[] = [];
  const ox = -frame.camera.x + frame.overlay.shake.dx;
  const oy = -frame.camera.y + frame.overlay.shake.dy;
  for (const layer of frame.layers) {
    if (layer.kind === "tiles") tiles(out, layer, frame, ox, oy, env);
    else sprites(out, layer, ox, oy, env);
  }
  const { tint, flash, fade, fadeColor } = frame.overlay;
  const { width, height } = frame.size;
  if (tint.a > 0) out.push(solid(0, 0, width, height, tint));
  if (flash !== undefined && flash.alpha > 0) out.push(solid(0, 0, width, height, { ...flash.color, a: flash.color.a * flash.alpha }));
  if (fade > 0) {
    const c = fadeColor ?? { r: 0, g: 0, b: 0 };
    out.push(solid(0, 0, width, height, { r: c.r, g: c.g, b: c.b, a: Math.min(1, fade) }));
  }
  for (const node of frame.ui) ui(out, node, env);
  return out;
}
