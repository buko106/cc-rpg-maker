#!/usr/bin/env node
/**
 * デモプロジェクト（fixtures/projects/v1/demo）用の PNG アセットを生成する開発用スクリプト。
 * 出力: fixtures/projects/v1/demo/assets/<AssetId>.png（AssetId = 内容の sha256 先頭 16 桁）
 * 生成物はコミット済み。絵を変えたいときだけ再実行し、表示された AssetId で project.json を更新する。
 *
 *   node tools/make-demo-assets.mjs
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const OUT = join(import.meta.dirname, "..", "fixtures", "projects", "v1", "demo", "assets");
const TILE = 32;

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
function image(width, height) {
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
  return { set, rect, disc, png, width, height };
}

/** 決定論的な擬似乱数（LCG）。 */
const lcg = (seed) => {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
};

const shade = ([r, g, b], d) => [r + d, g + d, b + d].map((v) => Math.max(0, Math.min(255, v)));

// ── タイルセット：セル 0 は空（透明）。セル N = タイル ID N。────────────────
function tileset() {
  const cells = 7;
  const img = image(TILE * cells, TILE);
  const cell = (id, draw) => draw((x, y, c) => img.set(id * TILE + x, y, c), (x, y, w, h, c) => img.rect(id * TILE + x, y, w, h, c));
  const fillSpecks = (id, base, seed, n, d) =>
    cell(id, (set, rect) => {
      rect(0, 0, TILE, TILE, base);
      const rnd = lcg(seed);
      for (let i = 0; i < n; i++) set(Math.floor(rnd() * TILE), Math.floor(rnd() * TILE), shade(base, d * (rnd() < 0.5 ? 1 : -1)));
    });

  fillSpecks(1, [96, 168, 80], 1, 60, 22); // 草
  cell(2, (set, rect) => {
    // 石壁
    rect(0, 0, TILE, TILE, [120, 120, 130]);
    for (let row = 0; row < 4; row++) {
      rect(0, row * 8 + 7, TILE, 1, [70, 70, 80]);
      for (let x = (row % 2) * 8; x < TILE; x += 16) rect(x, row * 8, 1, 8, [70, 70, 80]);
    }
  });
  fillSpecks(3, [200, 176, 120], 3, 40, 18); // 道
  cell(4, (_set, rect) => {
    // 木の床
    rect(0, 0, TILE, TILE, [170, 120, 70]);
    for (let y = 0; y < TILE; y += 8) rect(0, y, TILE, 1, [120, 80, 45]);
    for (let y = 0; y < TILE; y += 16) rect(10 + (y % 32), y + 1, 1, 7, [140, 95, 55]);
  });
  cell(5, (set, rect) => {
    // 花
    rect(0, 0, TILE, TILE, [96, 168, 80]);
    const rnd = lcg(5);
    for (let i = 0; i < 40; i++) set(Math.floor(rnd() * TILE), Math.floor(rnd() * TILE), [78, 146, 64]);
    for (const [x, y, c] of [[8, 9, [230, 70, 90]], [22, 20, [250, 220, 80]], [12, 24, [240, 240, 250]]]) {
      rect(x - 1, y, 3, 1, c);
      rect(x, y - 1, 1, 3, c);
    }
  });
  cell(6, (_set, rect) => {
    // 扉
    rect(0, 0, TILE, TILE, [120, 120, 130]);
    rect(6, 4, 20, 28, [100, 62, 30]);
    rect(8, 6, 16, 26, [130, 84, 42]);
    rect(20, 18, 3, 3, [240, 200, 60]);
  });
  return img;
}

// ── キャラクターシート：3 パターン × 4 方向（下・左・右・上）、コマは 32x32 ─────
function character({ shirt, hair, skin }) {
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

const assets = {
  "tileset.png": tileset(),
  "hero.png": character({ shirt: [58, 110, 165], hair: [110, 70, 40], skin: [240, 200, 160] }),
  "npc.png": character({ shirt: [192, 80, 58], hair: [150, 150, 150], skin: [235, 190, 150] }),
};

mkdirSync(OUT, { recursive: true });
for (const [name, img] of Object.entries(assets)) {
  const bytes = img.png();
  const id = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  writeFileSync(join(OUT, `${id}.png`), bytes);
  console.log(`${name}\t${id}\t${bytes.length} bytes\t${img.width}x${img.height}`);
}
