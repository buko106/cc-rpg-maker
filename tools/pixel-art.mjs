/**
 * デモ用アセットを作る開発用スクリプト（tools/make-*-demo*.mjs）が共有する、ドット絵の小道具。
 * 画像は RGBA のメモリ上のピクセル列で、`png()` で PNG のバイト列にする（依存なし）。
 * 出力を変えると既存のアセットのハッシュ（= AssetId）が変わるので、描き方を変えるときは新しい関数を足す。
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

/** 1 コマの大きさ（px）。 */
export const TILE = 32;

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/** RGBA の画像。`set` は範囲外を無視する。 */
export function image(width, height) {
  const px = new Uint8Array(width * height * 4);
  const set = (x, y, [r, g, b, a = 255]) => {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    px.set([r, g, b, a], (y * width + x) * 4);
  };
  const rect = (x, y, w, h, color) => {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) set(x + i, y + j, color);
  };
  const disc = (cx, cy, r, color) => {
    for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) if (i * i + j * j <= r * r) set(cx + i, cy + j, color);
  };
  const png = () => {
    const raw = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) {
      raw[y * (width * 4 + 1)] = 0; // filter: none
      Buffer.from(px.buffer, y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr.set([8, 6, 0, 0, 0], 8); // 8bit RGBA
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw, { level: 9 })),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  };
  /** (x, y) の色（範囲外は透明）。 */
  const get = (x, y) => (x < 0 || y < 0 || x >= width || y >= height ? [0, 0, 0, 0] : [...px.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)]);
  return { set, rect, disc, png, get, width, height };
}

/** 決定論的な擬似乱数（LCG）。 */
export const lcg = (seed) => {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
};

export const shade = ([r, g, b], d) => [r + d, g + d, b + d].map((v) => Math.max(0, Math.min(255, v)));

// ── 描き足し・合成 ────────────────────────────────────────────────────
/** `image()` に楕円・線・左右対称の描画を足したもの。 */
export function canvas(w, h) {
  const img = image(w, h);
  const ellipse = (cx, cy, rx, ry, c) => {
    for (let j = -ry; j <= ry; j++) for (let i = -rx; i <= rx; i++) if ((i * i) / (rx * rx || 1) + (j * j) / (ry * ry || 1) <= 1) img.set(cx + i, cy + j, c);
  };
  const line = (x0, y0, x1, y1, c, r = 0) => {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= n; i++) {
      const x = x0 + ((x1 - x0) * i) / n;
      const y = y0 + ((y1 - y0) * i) / n;
      if (r === 0) img.set(x, y, c);
      else img.disc(Math.round(x), Math.round(y), r, c);
    }
  };
  /** 左右対称に点を打つ（`x` と `w - 1 - x`）。 */
  const sym = (x, y, c) => {
    img.set(x, y, c);
    img.set(w - 1 - x, y, c);
  };
  const symRect = (x, y, rw, rh, c) => {
    img.rect(x, y, rw, rh, c);
    img.rect(w - x - rw, y, rw, rh, c);
  };
  return { ...img, ellipse, line, sym, symRect };
}

/** `src` を `dst` の (dx, dy) に重ねる（透明な画素は飛ばす）。 */
export function blit(dst, src, dx, dy) {
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const c = src.get(x, y);
      if (c[3] > 0) dst.set(dx + x, dy + y, c);
    }
  }
}

/** 最近傍で `k` 倍に拡大する（戦闘画面の敵の絵）。 */
export function scale(src, k) {
  const out = image(src.width * k, src.height * k);
  for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) {
    const c = src.get(Math.floor(x / k), Math.floor(y / k));
    if (c[3] > 0) out.set(x, y, c);
  }
  return out;
}

/** キャラクターを `perRow` 体ずつ並べたシート（1 体 = 3 パターン × 4 方向）。 */
export function sheet(perRow, chars) {
  const rows = Math.ceil(chars.length / perRow);
  const out = image(TILE * 3 * perRow, TILE * 4 * rows);
  chars.forEach((ch, i) => blit(out, ch, (i % perRow) * TILE * 3, Math.floor(i / perRow) * TILE * 4));
  return out;
}

// ── キャラクターシート：3 パターン × 4 方向（下・左・右・上）、コマは 32x32 ─────
export function character({ shirt, hair, skin }) {
  const img = image(TILE * 3, TILE * 4);
  const dirs = ["down", "left", "right", "up"];
  dirs.forEach((dir, row) => {
    for (let pattern = 0; pattern < 3; pattern++) {
      const ox = pattern * TILE;
      const oy = row * TILE;
      const R = (x, y, w, h, c) => img.rect(ox + x, oy + y, w, h, c);
      const D = (x, y, r, c) => img.disc(ox + x, oy + y, r, c);
      D(16, 29, 8, [0, 0, 0, 60]); // 影
      const lift = [3, 0, 0][pattern];
      const liftR = [0, 0, 3][pattern];
      R(10, 22 - lift, 5, 8, shade(shirt, -70));
      R(17, 22 - liftR, 5, 8, shade(shirt, -70));
      R(9, 12, 14, 11, shirt);
      R(7, 13, 3, 8, shade(shirt, -25)); // 腕
      R(22, 13, 3, 8, shade(shirt, -25));
      D(16, 9, 7, skin);
      if (dir === "up") D(16, 9, 7, hair);
      else {
        R(9, 2, 14, 5, hair); // 前髪
        const eye = [20, 20, 30];
        if (dir === "down") {
          R(12, 9, 2, 2, eye);
          R(18, 9, 2, 2, eye);
        } else if (dir === "left") R(11, 9, 2, 2, eye);
        else R(19, 9, 2, 2, eye);
      }
    }
  });
  return img;
}

/** 勇者（デモ・迷宮で共通の歩行グラフィック）。 */
export const HERO = { shirt: [58, 110, 165], hair: [110, 70, 40], skin: [240, 200, 160] };

/**
 * `assets`（名前 → `image()` か `{ bytes, ext, info }`）を `<out>/<AssetId>.<ext>` に書き出す。
 * AssetId は内容の sha256 先頭 16 桁。名前 → `{ id, size, width?, height? }` を返し、結果を表示する。
 */
export function writeAssets(out, assets) {
  mkdirSync(out, { recursive: true });
  const written = {};
  for (const [name, asset] of Object.entries(assets)) {
    const isImage = typeof asset.png === "function";
    const bytes = isImage ? asset.png() : asset.bytes;
    const ext = isImage ? "png" : asset.ext;
    const id = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    writeFileSync(join(out, `${id}.${ext}`), bytes);
    written[name] = { id, size: bytes.length, ...(isImage ? { width: asset.width, height: asset.height } : {}) };
    console.log(`${name}\t${id}\t${bytes.length} bytes\t${isImage ? `${asset.width}x${asset.height}` : asset.info}`);
  }
  return written;
}
