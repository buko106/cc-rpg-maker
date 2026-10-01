#!/usr/bin/env node
/**
 * バトルタワーのデモ（fixtures/projects/v1/tower）を丸ごと生成する開発用スクリプト。
 * 出力: project.json、maps/<MapId>.json、assets/<AssetId>.<ext>（AssetId = 内容の sha256 先頭 16 桁）。
 * 生成物はコミット済み。階の並びや絵・敵の強さを変えたいときだけ再実行する（乱数はシード固定なので、何度実行しても同じものができる）。
 *
 *   node tools/make-tower-demo.mjs
 *
 * 塔のしくみ：
 * - 1F はエントランス。受付（説明と支度金）、よろず屋、回復の泉（記録もできる）、訓練用のかかし（何度でも戦える）がある。
 * - 2F〜5F と屋上には番人がいて、上り階段の前をふさいでいる。話しかけて「挑む」と戦闘。勝つと番人が消えて上へ進める。
 *   2F ゴブリン兄弟、3F 大グモ（毒）、4F ストーンゴーレム（守りが固い）、5F 闇の魔術師と骸骨兵（眠り・全体魔法）、屋上 炎の竜。
 * - 3F の大グモを倒すと、捕らわれていた僧侶が仲間になる（回復・蘇生の魔法）。
 * - 各階の下り階段のそばに回復の魔法陣がある。負けても（敗北可の戦闘）入口に戻されて HP/MP が戻るだけで、何度でも挑める。
 * - 屋上の炎の竜を倒すとクリア（タイトルへ戻る）。
 * - 画面は 13×12 タイル（416×384）で、どの階も 1 画面に収まる。
 */
import { readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { character, HERO, image, lcg, shade, TILE, writeAssets } from "./pixel-art.mjs";

const ROOT = join(import.meta.dirname, "..", "fixtures", "projects", "v1", "tower");
/** 戦闘 BGM は「はじまりの村」と同じもの（tools/make-demo-assets.mjs が作った WAV）を使う。 */
const BATTLE_WAV = join(import.meta.dirname, "..", "fixtures", "projects", "v1", "demo", "assets", "87073bd84cdaced6.wav");

const W = 13;
const H = 12;
/** 階の数（1F〜5F と屋上）。 */
const FLOORS = 6;
const mapId = (n) => `map_f${n}`;
/** 上り階段・下り階段・番人・着いたときの位置（どの階も同じ）。 */
const UP = [6, 1];
const DOWN = [6, 10];
const GUARD = [6, 2];
const BOSS = [6, 4];
const ARRIVE_UP = { x: 6, y: 9, dir: "up" };
const ARRIVE_DOWN = { x: 6, y: 2, dir: "down" };
const START = ARRIVE_UP;

// ── 描画の小道具 ──────────────────────────────────────────────────────
/** `image()` に楕円・線・左右対称の描画を足したもの。 */
function canvas(w, h) {
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
function blit(dst, src, dx, dy) {
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const c = src.get(x, y);
      if (c[3] > 0) dst.set(dx + x, dy + y, c);
    }
  }
}

/** 最近傍で `k` 倍に拡大する（戦闘画面の敵の絵）。 */
function scale(src, k) {
  const out = image(src.width * k, src.height * k);
  for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) {
    const c = src.get(Math.floor(x / k), Math.floor(y / k));
    if (c[3] > 0) out.set(x, y, c);
  }
  return out;
}

/** キャラクターを `perRow` 体ずつ並べたシート（1 体 = 3 パターン × 4 方向）。 */
function sheet(perRow, chars) {
  const rows = Math.ceil(chars.length / perRow);
  const out = image(TILE * 3 * perRow, TILE * 4 * rows);
  chars.forEach((ch, i) => blit(out, ch, (i % perRow) * TILE * 3, Math.floor(i / perRow) * TILE * 4));
  return out;
}

// ── 魔物（32×32 で描く。マップでは等倍、戦闘では拡大）──────────────
const SKIN_GREEN = [104, 160, 72];
const MONSTERS = {
  /** 訓練用のかかし。 */
  scarecrow() {
    const d = canvas(32, 32);
    const wood = [124, 86, 50];
    d.rect(15, 9, 3, 22, wood);
    d.rect(15, 9, 1, 22, shade(wood, 24));
    d.rect(3, 14, 26, 3, wood);
    d.rect(3, 14, 26, 1, shade(wood, 24));
    for (const x of [1, 27]) {
      d.rect(x, 12, 4, 7, [222, 190, 92]);
      d.rect(x + 1, 13, 1, 5, [180, 150, 64]);
    }
    d.rect(10, 15, 12, 10, [150, 112, 74]);
    d.rect(12, 18, 4, 4, [188, 146, 92]);
    d.rect(10, 24, 12, 1, [110, 80, 50]);
    d.disc(16, 10, 5, [226, 206, 160]);
    for (const [x, y] of [[13, 8], [14, 9], [13, 10], [15, 8], [15, 10], [17, 8], [18, 9], [19, 8], [17, 10], [19, 10]]) d.set(x, y, [70, 50, 40]);
    d.rect(14, 13, 5, 1, [140, 90, 60]);
    d.rect(8, 5, 16, 2, [204, 172, 84]);
    d.rect(11, 1, 10, 5, [192, 160, 72]);
    d.rect(11, 4, 10, 1, [170, 60, 50]);
    return d;
  },
  goblin() {
    const d = canvas(32, 32);
    const skin = SKIN_GREEN;
    const rag = [128, 92, 54];
    d.symRect(11, 24, 4, 7, [92, 70, 42]);
    d.symRect(10, 30, 5, 1, [60, 44, 28]);
    d.rect(10, 15, 12, 10, rag);
    d.rect(10, 21, 12, 2, [72, 50, 30]);
    d.rect(10, 15, 12, 1, shade(rag, 20));
    d.symRect(7, 16, 3, 8, shade(skin, -20));
    d.disc(16, 10, 6, skin);
    d.disc(15, 8, 2, shade(skin, 26));
    for (let i = 0; i < 4; i++) d.sym(9 - i, 7 + i, skin), d.sym(9 - i, 8 + i, skin), d.sym(8 - i, 8 + i, skin);
    d.symRect(12, 9, 3, 2, [250, 220, 70]);
    d.symRect(13, 10, 1, 1, [40, 20, 10]);
    d.rect(13, 13, 6, 1, [60, 30, 20]);
    d.sym(14, 14, [240, 240, 220]);
    d.rect(25, 9, 3, 15, [132, 92, 52]);
    d.disc(26, 8, 3, [150, 104, 60]);
    d.set(25, 6, [190, 140, 90]);
    return d;
  },
  spider() {
    const d = canvas(32, 32);
    const body = [64, 52, 76];
    const leg = [52, 42, 62];
    for (const [ax, ay, bx, by, cx, cy] of [
      [12, 15, 5, 8, 2, 20], [12, 17, 4, 14, 1, 26], [13, 20, 6, 21, 3, 30], [14, 21, 9, 25, 8, 31],
    ]) {
      d.line(ax, ay, bx, by, leg, 1);
      d.line(bx, by, cx, cy, leg, 1);
      d.line(31 - ax, ay, 31 - bx, by, leg, 1);
      d.line(31 - bx, by, 31 - cx, cy, leg, 1);
    }
    d.ellipse(16, 20, 8, 8, body);
    d.ellipse(14, 17, 4, 3, shade(body, 22));
    d.rect(15, 18, 2, 6, [200, 40, 44]);
    d.rect(14, 20, 4, 2, [200, 40, 44]);
    d.disc(16, 10, 5, shade(body, 10));
    for (const x of [13, 15, 17, 19]) d.set(x, 9, [255, 60, 60]);
    d.symRect(13, 11, 2, 1, [255, 90, 90]);
    d.symRect(14, 14, 1, 3, [230, 230, 210]);
    return d;
  },
  golem() {
    const d = canvas(32, 32);
    const rock = [128, 124, 114];
    d.symRect(9, 24, 6, 7, shade(rock, -20));
    d.rect(7, 11, 18, 14, rock);
    d.rect(7, 11, 18, 2, shade(rock, 24));
    d.symRect(2, 12, 5, 13, shade(rock, -10));
    d.symRect(2, 12, 5, 1, shade(rock, 18));
    d.symRect(1, 24, 7, 4, shade(rock, -26));
    d.rect(11, 2, 10, 9, rock);
    d.rect(11, 2, 10, 1, shade(rock, 24));
    d.symRect(13, 6, 2, 2, [120, 240, 255]);
    d.rect(14, 9, 4, 1, shade(rock, -40));
    for (const [x, y] of [[10, 14], [11, 15], [12, 16], [12, 17], [20, 19], [21, 20], [19, 21]]) d.set(x, y, shade(rock, -46));
    for (const [x, y] of [[8, 12], [9, 12], [22, 11], [12, 3], [23, 13], [3, 13]]) d.set(x, y, [90, 150, 70]);
    d.disc(16, 17, 2, [100, 220, 250]);
    return d;
  },
  sorcerer() {
    const d = canvas(32, 32);
    const robe = [84, 44, 116];
    for (let y = 11; y <= 30; y++) {
      const half = 4 + Math.round(((y - 11) / 19) * 7);
      d.rect(16 - half, y, half * 2, 1, robe);
      d.set(16 - half, y, shade(robe, 30));
    }
    d.rect(15, 14, 2, 17, shade(robe, -24));
    d.rect(9, 20, 14, 2, [200, 170, 70]);
    d.disc(16, 9, 7, shade(robe, -10));
    d.disc(16, 10, 4, [24, 12, 32]);
    d.symRect(14, 10, 1, 1, [255, 80, 60]);
    d.set(16, 2, shade(robe, 30));
    d.rect(26, 4, 2, 27, [104, 72, 42]);
    d.disc(27, 4, 4, [120, 220, 255, 90]);
    d.disc(27, 4, 2, [140, 230, 255]);
    d.set(26, 3, [240, 255, 255]);
    d.symRect(8, 16, 3, 5, shade(robe, -16));
    d.rect(23, 16, 3, 3, [210, 190, 170]);
    return d;
  },
  skeleton() {
    const d = canvas(32, 32);
    const bone = [232, 228, 212];
    d.disc(16, 8, 5, bone);
    d.symRect(13, 7, 2, 2, [30, 24, 30]);
    d.rect(15, 10, 2, 1, [30, 24, 30]);
    d.rect(13, 12, 6, 1, bone);
    d.rect(15, 13, 2, 10, bone);
    for (const [y, x, w] of [[14, 11, 10], [16, 11, 10], [18, 12, 8]]) d.rect(x, y, w, 1, bone);
    d.rect(12, 22, 8, 2, bone);
    d.symRect(12, 24, 2, 7, bone);
    d.symRect(9, 14, 2, 9, bone);
    d.rect(23, 9, 2, 14, [196, 198, 210]);
    d.rect(23, 9, 1, 14, [240, 240, 250]);
    d.rect(21, 21, 6, 2, [124, 92, 44]);
    d.rect(5, 15, 5, 8, [110, 80, 48]);
    d.rect(6, 16, 3, 6, [140, 104, 60]);
    return d;
  },
  dragon() {
    const d = canvas(32, 32);
    const red = [196, 54, 42];
    const dark = [136, 32, 30];
    // 翼（後ろ）
    for (let y = 3; y <= 20; y++) {
      const reach = Math.round(12 - Math.abs(y - 9) * 0.9);
      for (let x = 0; x < reach; x++) d.sym(Math.max(0, 11 - x), y, x === reach - 1 || y === 3 ? red : dark);
    }
    for (const [x, y] of [[3, 5], [5, 4], [7, 4]]) d.line(x, y, 10, 13, shade(dark, -20)), d.line(31 - x, y, 21, 13, shade(dark, -20));
    // 尾
    for (const [x, y, r] of [[22, 27, 3], [25, 25, 2], [27, 22, 2], [28, 19, 1]]) d.disc(x, y, r, red);
    d.set(29, 17, [250, 210, 120]);
    // 体・腹
    d.ellipse(16, 21, 8, 8, red);
    d.ellipse(16, 23, 4, 6, [236, 176, 96]);
    for (const y of [19, 22, 25]) d.rect(13, y, 7, 1, [210, 146, 76]);
    d.symRect(9, 26, 4, 5, dark);
    d.symRect(8, 30, 6, 1, [240, 230, 210]);
    // 首・頭
    d.rect(13, 9, 7, 8, red);
    d.disc(16, 7, 5, red);
    d.rect(13, 9, 7, 4, red);
    d.rect(14, 11, 5, 2, [236, 176, 96]);
    d.symRect(12, 1, 2, 4, [240, 228, 200]);
    d.symRect(11, 0, 1, 2, [240, 228, 200]);
    d.symRect(13, 6, 2, 2, [255, 230, 60]);
    d.symRect(14, 7, 1, 1, [40, 10, 10]);
    d.symRect(15, 12, 1, 1, [70, 20, 20]);
    d.disc(16, 6, 1, shade(red, 30));
    return d;
  },
};

/** 魔物の歩行シート用：全方向・全パターン同じ絵に影を付ける。 */
function monsterWalk(sprite) {
  const out = image(TILE * 3, TILE * 4);
  for (let row = 0; row < 4; row++) {
    for (let pattern = 0; pattern < 3; pattern++) {
      const ox = pattern * TILE;
      const oy = row * TILE;
      for (let j = -2; j <= 2; j++) for (let i = -10; i <= 10; i++) if ((i * i) / 100 + (j * j) / 4 <= 1) out.set(ox + 16 + i, oy + 29 + j, [0, 0, 0, 70]);
      blit(out, sprite, ox, oy + (pattern === 1 ? 0 : -1));
    }
  }
  return out;
}

/** 歩行シート（monsters.png）での並び。 */
const MONSTER_INDEX = { scarecrow: 0, goblin: 1, spider: 2, golem: 3, sorcerer: 4, skeleton: 5, dragon: 6 };
/** 人のシート（people.png）での並び。 */
const PEOPLE = {
  receptionist: { index: 0, look: { shirt: [196, 76, 112], hair: [70, 44, 32], skin: [244, 210, 176] } },
  merchant: { index: 1, look: { shirt: [92, 140, 64], hair: [150, 100, 52], skin: [236, 196, 156] } },
  cleric: { index: 2, look: { shirt: [236, 236, 244], hair: [232, 200, 96], skin: [246, 214, 182] } },
};

// ── タイルセット ──────────────────────────────────────────────────────
/** 階ごとの床・じゅうたん・壁の色（1F〜5F）。 */
const ZONES = [
  { name: "エントランス", floor: [190, 166, 126], carpet: [170, 42, 50], wall: [150, 122, 92] },
  { name: "ゴブリンのねぐら", floor: [118, 118, 126], carpet: [150, 44, 46], wall: [98, 98, 110] },
  { name: "クモの巣の間", floor: [98, 114, 88], carpet: [62, 112, 72], wall: [72, 88, 64] },
  { name: "石像の回廊", floor: [106, 122, 148], carpet: [52, 82, 152], wall: [72, 86, 114] },
  { name: "魔術師の書斎", floor: [94, 78, 114], carpet: [112, 52, 142], wall: [62, 48, 82] },
];
const PER_ZONE = 6;
const Z = (z, k) => 1 + z * PER_ZONE + k;
const T = {
  floor: (z) => Z(z, 0),
  carpet: (z) => Z(z, 1),
  wallTop: (z) => Z(z, 2),
  wallFace: (z) => Z(z, 3),
  window: (z) => Z(z, 4),
  stairsUp: (z) => Z(z, 5),
  stairsDown: 31,
  door: 32,
  roof: 33,
  parapet: 34,
  sky: 35,
  pillar: 36,
  fountain: 37,
  counter: 38,
  shelf: 39,
  bookshelf: 40,
  plant: 41,
  cobweb: 42,
  bones: 43,
  torch: 44,
  banner: 45,
  crate: 46,
  circle: 47,
  candle: 48,
  flag: 49,
  brazier: 50,
};
const CELLS = 51;
/** 通行：床・じゅうたん・階段・屋上の床と、クモの巣・骨・魔法陣は通れる。ほかは通れない。 */
const PASSABLE = new Set([0, T.stairsDown, T.roof, T.cobweb, T.bones, T.circle]);
for (let z = 0; z < ZONES.length; z++) for (const k of ["floor", "carpet", "stairsUp"]) PASSABLE.add(T[k](z));
const PASSAGE = Array.from({ length: CELLS }, (_, id) => (PASSABLE.has(id) ? 15 : 0));

function tileset() {
  const img = image(TILE * CELLS, TILE);
  const cell = (id, { wrap = false } = {}) => {
    const set = (x, y, c) => {
      if (wrap) {
        x = ((Math.round(x) % TILE) + TILE) % TILE;
        y = ((Math.round(y) % TILE) + TILE) % TILE;
      } else if (x < 0 || y < 0 || x >= TILE || y >= TILE) return;
      img.set(id * TILE + x, y, c);
    };
    const rect = (x, y, w, h, c) => {
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) set(x + i, y + j, c);
    };
    const disc = (cx, cy, r, c) => {
      for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) if (i * i + j * j <= r * r) set(cx + i, cy + j, c);
    };
    const ellipse = (cx, cy, rx, ry, c) => {
      for (let j = -ry; j <= ry; j++) for (let i = -rx; i <= rx; i++) if ((i * i) / (rx * rx) + (j * j) / (ry * ry) <= 1) set(cx + i, cy + j, c);
    };
    return { set, rect, disc, ellipse };
  };
  /** レンガの壁面（上端は明るく、下端は影）。 */
  const bricks = (c, wall, seed) => {
    c.rect(0, 0, TILE, TILE, wall);
    const rnd = lcg(seed);
    for (let row = 0; row < 4; row++) {
      const y = row * 8;
      c.rect(0, y + 7, TILE, 1, shade(wall, -34));
      for (let x = (row % 2) * 8; x < TILE; x += 16) c.rect(x, y, 1, 7, shade(wall, -30));
      for (let x = 0; x < TILE; x++) if (rnd() < 0.2) c.set(x, y + 1 + Math.floor(rnd() * 5), shade(wall, rnd() < 0.5 ? 10 : -10));
      c.rect(0, y, TILE, 1, shade(wall, 14));
    }
    c.rect(0, TILE - 2, TILE, 2, shade(wall, -46));
  };

  ZONES.forEach(({ floor, carpet, wall }, z) => {
    // 床：16px の石畳
    {
      const c = cell(T.floor(z), { wrap: true });
      c.rect(0, 0, TILE, TILE, floor);
      const rnd = lcg(10 + z);
      for (let i = 0; i < 70; i++) c.set(rnd() * TILE, rnd() * TILE, shade(floor, rnd() < 0.5 ? 9 : -11));
      for (const y of [0, 16]) c.rect(0, y, TILE, 1, shade(floor, -30));
      for (const [x, y] of [[0, 0], [16, 16]]) c.rect(x, y, 1, 16, shade(floor, -30));
      for (const y of [1, 17]) c.rect(0, y, TILE, 1, shade(floor, 12));
    }
    // じゅうたん：ひし形の模様
    {
      const c = cell(T.carpet(z), { wrap: true });
      c.rect(0, 0, TILE, TILE, carpet);
      for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
        const d = Math.abs(x - 15.5) + Math.abs(y - 15.5);
        if (Math.round(d) === 10) c.set(x, y, shade(carpet, 40));
        else if (Math.round(d) === 4) c.set(x, y, [214, 176, 80]);
        else if ((x + y) % 4 === 0) c.set(x, y, shade(carpet, -12));
      }
    }
    // 壁の上（奥行き）：暗い石
    {
      const c = cell(T.wallTop(z), { wrap: true });
      c.rect(0, 0, TILE, TILE, shade(wall, -58));
      const rnd = lcg(20 + z);
      for (let i = 0; i < 40; i++) c.set(rnd() * TILE, rnd() * TILE, shade(wall, -44));
      c.rect(0, 0, TILE, 1, shade(wall, -36));
    }
    // 壁面：レンガ
    bricks(cell(T.wallFace(z)), wall, 30 + z);
    // 窓：アーチの向こうに夜空
    {
      const c = cell(T.window(z));
      bricks(c, wall, 40 + z);
      for (let y = 6; y < 26; y++) for (let x = 9; x < 23; x++) {
        if (y < 13 && (x - 15.5) ** 2 + (y - 13) ** 2 > 49) continue;
        c.set(x, y, y < 16 ? [30, 40, 92] : [44, 58, 118]);
      }
      for (const [x, y] of [[12, 10], [19, 14], [14, 19], [20, 22]]) c.set(x, y, [255, 250, 220]);
      c.rect(15, 6, 2, 20, shade(wall, -40));
      c.rect(9, 16, 14, 1, shade(wall, -40));
      c.rect(8, 26, 16, 2, shade(wall, 24));
    }
    // 上り階段：壁のアーチの奥へ上る段
    {
      const c = cell(T.stairsUp(z));
      bricks(c, wall, 50 + z);
      for (let y = 4; y < TILE; y++) for (let x = 6; x < 26; x++) {
        if (y < 11 && (x - 15.5) ** 2 + (y - 11) ** 2 > 90) continue;
        c.set(x, y, shade(floor, -80));
      }
      for (let k = 0; k < 5; k++) {
        const y = TILE - 1 - k * 5;
        c.rect(7 + k, y - 3, 18 - k * 2, 3, shade(floor, -10 - k * 12));
        c.rect(7 + k, y - 4, 18 - k * 2, 1, shade(floor, 18 - k * 10));
      }
    }
  });

  // 下り階段：床に開いた穴へ下りる段
  {
    const c = cell(T.stairsDown);
    const stone = [118, 112, 104];
    c.rect(0, 0, TILE, TILE, shade(stone, -10));
    c.rect(2, 2, 28, 28, [24, 20, 22]);
    for (let k = 0; k < 5; k++) {
      c.rect(3 + k, 3 + k * 5, 26 - k * 2, 3, shade(stone, 20 - k * 22));
      c.rect(3 + k, 3 + k * 5, 26 - k * 2, 1, shade(stone, 40 - k * 22));
    }
    c.rect(0, 0, TILE, 2, shade(stone, 20));
  }
  // 入口の扉（1F の下の壁）
  {
    const c = cell(T.door);
    c.rect(0, 0, TILE, TILE, shade(ZONES[0].wall, -58));
    c.rect(3, 0, 26, TILE, [92, 58, 30]);
    c.rect(5, 0, 10, TILE, [128, 84, 44]);
    c.rect(17, 0, 10, TILE, [128, 84, 44]);
    for (const y of [6, 24]) c.rect(5, y, 22, 2, [70, 70, 78]);
    c.rect(13, 14, 2, 3, [236, 196, 70]);
    c.rect(17, 14, 2, 3, [236, 196, 70]);
  }
  // 屋上の床：大きな石板
  {
    const c = cell(T.roof, { wrap: true });
    const stone = [148, 140, 128];
    c.rect(0, 0, TILE, TILE, stone);
    const rnd = lcg(60);
    for (let i = 0; i < 60; i++) c.set(rnd() * TILE, rnd() * TILE, shade(stone, rnd() < 0.5 ? 8 : -10));
    c.rect(0, 0, TILE, 1, shade(stone, -34));
    c.rect(0, 0, 1, TILE, shade(stone, -34));
    c.rect(0, 1, TILE, 1, shade(stone, 14));
    for (const [x, y] of [[20, 9], [21, 10], [22, 10], [8, 22], [9, 23]]) c.set(x, y, shade(stone, -30));
  }
  // 胸壁（屋上の縁）：凸凹のある石の壁
  {
    const c = cell(T.parapet);
    const stone = [120, 112, 104];
    c.rect(0, 0, TILE, TILE, shade(stone, -10));
    for (const x of [0, 16]) {
      c.rect(x + 1, 2, 14, 28, stone);
      c.rect(x + 1, 2, 14, 2, shade(stone, 30));
      c.rect(x + 1, 28, 14, 2, shade(stone, -34));
      c.rect(x + 13, 4, 2, 24, shade(stone, -20));
    }
  }
  // 空（屋上の外）：夜空と星
  {
    const c = cell(T.sky, { wrap: true });
    for (let y = 0; y < TILE; y++) c.rect(0, y, TILE, 1, [24 + y / 2, 30 + y / 2, 76 + y]);
    const rnd = lcg(70);
    for (let i = 0; i < 6; i++) c.set(rnd() * TILE, rnd() * TILE, [255, 250, 220]);
  }
  // 柱：太い円柱（上から見下ろし、少し側面も見える）
  {
    const c = cell(T.pillar);
    const stone = [196, 190, 176];
    c.ellipse(16, 29, 12, 3, [0, 0, 0, 80]);
    c.rect(6, 25, 20, 5, shade(stone, -24));
    c.rect(9, 6, 14, 20, stone);
    for (let x = 9; x < 23; x++) if ((x - 9) % 4 === 3) c.rect(x, 6, 1, 20, shade(stone, -30));
    c.rect(9, 6, 3, 20, shade(stone, 24));
    c.rect(6, 2, 20, 5, shade(stone, 10));
    c.rect(6, 2, 20, 1, shade(stone, 40));
  }
  // 泉：丸い石の水盤と水
  {
    const c = cell(T.fountain);
    c.ellipse(16, 18, 15, 12, [140, 136, 128]);
    c.ellipse(16, 17, 13, 10, [176, 172, 164]);
    c.ellipse(16, 18, 11, 8, [52, 112, 188]);
    c.ellipse(14, 16, 5, 3, [104, 168, 232]);
    c.rect(15, 4, 3, 13, [176, 172, 164]);
    c.disc(16, 5, 3, [150, 210, 255]);
    c.disc(16, 4, 1, [230, 250, 255]);
    for (const [x, y] of [[11, 9], [21, 9], [9, 13], [23, 13]]) c.set(x, y, [170, 220, 255]);
  }
  // 受付の机
  {
    const c = cell(T.counter);
    c.ellipse(16, 29, 15, 3, [0, 0, 0, 70]);
    c.rect(0, 8, TILE, 22, [120, 76, 40]);
    c.rect(0, 8, TILE, 6, [164, 112, 62]);
    c.rect(0, 8, TILE, 1, [196, 144, 86]);
    c.rect(0, 14, TILE, 1, [80, 50, 26]);
    c.rect(4, 4, 8, 5, [240, 236, 220]);
    c.rect(20, 3, 3, 6, [70, 110, 190]);
  }
  // 棚（薬の瓶）
  const shelf = (id, goods) => {
    const c = cell(id);
    c.rect(1, 2, 30, 28, [104, 66, 34]);
    c.rect(3, 4, 26, 24, [70, 42, 22]);
    for (const y of [11, 19, 27]) c.rect(3, y, 26, 2, [140, 92, 50]);
    goods(c);
  };
  shelf(T.shelf, (c) => {
    const colors = [[220, 70, 70], [80, 150, 230], [90, 200, 110], [230, 200, 80]];
    for (const [row, y] of [[0, 5], [1, 13], [2, 21]]) {
      for (let k = 0; k < 4; k++) {
        const x = 5 + k * 6;
        const col = colors[(k + row) % 4];
        c.rect(x, y + 2, 4, 4, col);
        c.rect(x + 1, y, 2, 2, [220, 220, 220]);
        c.set(x, y + 2, shade(col, 50));
      }
    }
  });
  shelf(T.bookshelf, (c) => {
    const colors = [[150, 40, 40], [40, 80, 140], [60, 120, 60], [140, 110, 40], [100, 50, 120]];
    const rnd = lcg(80);
    for (const y of [4, 12, 20]) {
      for (let x = 4; x < 28; ) {
        const w = 2 + Math.floor(rnd() * 2);
        const h = 5 + Math.floor(rnd() * 3);
        c.rect(x, y + 7 - h, w, h, colors[Math.floor(rnd() * colors.length)]);
        x += w + (rnd() < 0.2 ? 1 : 0);
      }
    }
  });
  // 鉢植え
  {
    const c = cell(T.plant);
    c.ellipse(16, 29, 9, 2, [0, 0, 0, 70]);
    c.rect(10, 20, 12, 9, [176, 96, 56]);
    c.rect(9, 19, 14, 2, [200, 116, 70]);
    for (const [x, y, r] of [[16, 10, 6], [11, 14, 4], [21, 14, 4], [16, 5, 3]]) c.disc(x, y, r, [62, 140, 70]);
    for (const [x, y] of [[14, 8], [18, 11], [11, 13], [21, 13], [16, 4]]) c.set(x, y, [120, 200, 110]);
  }
  // クモの巣（通れる）
  {
    const c = cell(T.cobweb);
    const web = [230, 230, 240, 150];
    for (const [dx, dy] of [[1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1]]) for (let i = -15; i <= 15; i++) c.set(16 + Math.round(i * dx), 16 + Math.round(i * dy), web);
    for (const r of [5, 10, 14]) for (let a = 0; a < 360; a += 6) c.set(16 + Math.round(Math.cos((a * Math.PI) / 180) * r), 16 + Math.round(Math.sin((a * Math.PI) / 180) * r), web);
  }
  // 骨（通れる）
  {
    const c = cell(T.bones);
    const bone = [226, 220, 200];
    c.disc(12, 14, 4, bone);
    c.rect(10, 13, 2, 2, [40, 34, 30]);
    c.rect(14, 13, 2, 2, [40, 34, 30]);
    c.rect(11, 18, 4, 1, bone);
    for (let i = 0; i < 12; i++) c.set(16 + i, 24 - Math.round(i / 2), bone), c.set(16 + i, 25 - Math.round(i / 2), shade(bone, -30));
    c.disc(16, 24, 1, bone);
    c.disc(27, 18, 1, bone);
  }
  // たいまつ（壁に掛ける）
  {
    const c = cell(T.torch);
    c.disc(16, 12, 12, [255, 170, 60, 50]);
    c.disc(16, 12, 8, [255, 190, 80, 60]);
    c.rect(15, 14, 3, 12, [96, 64, 36]);
    c.rect(12, 24, 9, 2, [70, 70, 76]);
    c.disc(16, 11, 4, [255, 140, 30]);
    c.disc(16, 9, 3, [255, 210, 80]);
    c.disc(16, 8, 1, [255, 250, 210]);
  }
  // 旗（壁に掛ける。塔の紋章）
  {
    const c = cell(T.banner);
    c.rect(5, 2, 22, 2, [196, 160, 64]);
    c.rect(8, 4, 16, 22, [160, 30, 40]);
    for (let i = 0; i < 4; i++) c.rect(8 + i, 26 + i, 16 - i * 2, 1, [160, 30, 40]);
    c.rect(9, 4, 1, 22, [200, 60, 66]);
    // 紋章：塔
    const gold = [236, 200, 80];
    c.rect(13, 11, 6, 12, gold);
    for (const x of [12, 14, 16, 18]) c.rect(x, 8, 2, 3, gold);
    c.rect(12, 10, 8, 1, gold);
    c.rect(15, 18, 2, 5, [160, 30, 40]);
    c.rect(15, 13, 2, 2, [160, 30, 40]);
  }
  // 木箱
  {
    const c = cell(T.crate);
    c.ellipse(16, 29, 13, 2, [0, 0, 0, 70]);
    c.rect(4, 6, 24, 23, [150, 104, 56]);
    c.rect(4, 6, 24, 2, [188, 140, 84]);
    c.rect(4, 6, 2, 23, [110, 72, 36]);
    c.rect(26, 6, 2, 23, [110, 72, 36]);
    c.rect(4, 27, 24, 2, [110, 72, 36]);
    for (let i = 0; i < 20; i++) c.rect(6 + i, 8 + i, 2, 1, [110, 72, 36]);
  }
  // 回復の魔法陣（通れる）
  {
    const c = cell(T.circle);
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const d = Math.hypot(x - 15.5, y - 15.5);
      if (d <= 14 && d >= 12.5) c.set(x, y, [120, 255, 230, 220]);
      else if (d <= 9 && d >= 8) c.set(x, y, [120, 255, 230, 200]);
      else if (d < 14) c.set(x, y, [120, 255, 230, 40]);
    }
    for (let a = 0; a < 6; a++) {
      const t = (a * Math.PI) / 3;
      const u = ((a + 2) * Math.PI) / 3;
      const [x0, y0, x1, y1] = [15.5 + Math.cos(t) * 12, 15.5 + Math.sin(t) * 12, 15.5 + Math.cos(u) * 12, 15.5 + Math.sin(u) * 12];
      for (let i = 0; i <= 24; i++) c.set(x0 + ((x1 - x0) * i) / 24, y0 + ((y1 - y0) * i) / 24, [180, 255, 240, 200]);
    }
  }
  // 燭台
  {
    const c = cell(T.candle);
    c.disc(16, 9, 10, [255, 200, 90, 40]);
    c.ellipse(16, 29, 7, 2, [0, 0, 0, 70]);
    c.rect(13, 26, 7, 3, [190, 160, 70]);
    c.rect(15, 14, 3, 13, [190, 160, 70]);
    c.rect(9, 14, 15, 2, [190, 160, 70]);
    for (const x of [9, 16, 23]) {
      c.rect(x - 1, 9, 3, 5, [240, 236, 220]);
      c.disc(x, 7, 1, [255, 200, 70]);
      c.set(x, 5, [255, 250, 210]);
    }
  }
  // 屋上の旗
  {
    const c = cell(T.flag);
    c.ellipse(16, 29, 6, 2, [0, 0, 0, 80]);
    c.rect(9, 2, 2, 27, [180, 180, 190]);
    c.rect(11, 3, 15, 10, [170, 30, 40]);
    for (let y = 3; y < 13; y++) c.set(26 + ((y % 3) - 1), y, [170, 30, 40]);
    c.rect(16, 6, 4, 4, [236, 200, 80]);
    c.disc(10, 2, 1, [236, 200, 80]);
  }
  // かがり火（屋上）
  {
    const c = cell(T.brazier);
    c.disc(16, 10, 13, [255, 150, 50, 45]);
    c.ellipse(16, 29, 8, 2, [0, 0, 0, 80]);
    c.rect(14, 18, 4, 10, [84, 80, 88]);
    c.rect(10, 27, 12, 2, [84, 80, 88]);
    c.ellipse(16, 16, 10, 4, [110, 106, 116]);
    c.ellipse(16, 15, 9, 2, [60, 40, 30]);
    c.disc(16, 11, 5, [255, 120, 30]);
    c.disc(15, 9, 4, [255, 180, 60]);
    c.disc(16, 7, 2, [255, 240, 180]);
    c.set(12, 6, [255, 200, 90]);
    c.set(20, 5, [255, 200, 90]);
  }
  return img;
}

// ── 階の形（1 文字 = 1 タイル）──────────────────────────────────────
/**
 * `#` 壁の上、`W` 壁面、`w` 窓、`^` 上り階段、`t` たいまつ、`b` 旗、`.` 床、`c` じゅうたん、`v` 下り階段、`D` 入口の扉、
 * `I` 柱、`F` 泉、`=` 受付の机、`S` 薬の棚、`B` 本棚、`p` 鉢植え、`x` クモの巣、`k` 骨、`G` 木箱、`M` 回復の魔法陣、`n` 燭台、
 * 屋上は `s` 空、`P` 胸壁、`f` 旗、`y` かがり火、`h` 下り階段（床は屋上の石板）。
 */
const FLOOR_PLANS = {
  1: [
    "#############",
    "#WtWwb^bwWtW#",
    "#SSp.ccc.p==#",
    "#....ccc....#",
    "#....ccc....#",
    "#.I..ccc..I.#",
    "#....ccc....#",
    "#....ccc....#",
    "#.F..ccc....#",
    "#p...ccc...p#",
    "#....ccc....#",
    "######D######",
  ],
  2: [
    "#############",
    "#WtWWb^bWWtW#",
    "#G...ccc...G#",
    "#GG..ccc..kG#",
    "#....ccc....#",
    "#.I..ccc..I.#",
    "#....ccc....#",
    "#k...ccc....#",
    "#.I..ccc..I.#",
    "#..M.ccc...G#",
    "#....cvc..GG#",
    "#############",
  ],
  3: [
    "#############",
    "#WtWwb^bwWtW#",
    "#x...ccc..xx#",
    "#....ccc...x#",
    "#..k.ccc..xx#",
    "#.I..ccc..I.#",
    "#x...ccc....#",
    "#....ccc..k.#",
    "#.I..ccc..I.#",
    "#x.M.ccc...x#",
    "#....cvc....#",
    "#############",
  ],
  4: [
    "#############",
    "#WtWwb^bwWtW#",
    "#.I..ccc..I.#",
    "#....ccc....#",
    "#.I..ccc..I.#",
    "#....ccc....#",
    "#.I..ccc..I.#",
    "#....ccc....#",
    "#.I..ccc..I.#",
    "#..M.ccc...p#",
    "#p...cvc....#",
    "#############",
  ],
  5: [
    "#############",
    "#WtWwb^bwWtW#",
    "#BBn.ccc.nBB#",
    "#....ccc....#",
    "#n...ccc...n#",
    "#.I..ccc..I.#",
    "#....ccc....#",
    "#k...ccc...k#",
    "#.I..ccc..I.#",
    "#n.M.ccc...n#",
    "#....cvc....#",
    "#############",
  ],
  6: [
    "sssssssssssss",
    "PPPPPPPPPPPPP",
    "Pf.........fP",
    "P...........P",
    "P...y...y...P",
    "P...........P",
    "P...........P",
    "Pk.........kP",
    "P...........P",
    "P..M........P",
    "P.....h.....P",
    "PPPPPPPPPPPPP",
  ],
};
/** 回復の魔法陣の位置（2F〜屋上）。 */
const CIRCLE = [3, 9];

/** 1 文字 → [地面, 物]。 */
function legend(ch, floorNo) {
  const z = Math.min(floorNo, ZONES.length) - 1;
  const ground = floorNo === FLOORS ? T.roof : T.floor(z);
  const on = (obj) => [ground, obj];
  const face = (obj) => [T.wallFace(z), obj];
  switch (ch) {
    case "#": return [T.wallTop(z), 0];
    case "W": return face(0);
    case "w": return [T.window(z), 0];
    case "^": return [T.stairsUp(z), 0];
    case "t": return face(T.torch);
    case "b": return face(T.banner);
    case ".": return on(0);
    case "c": return [T.carpet(z), 0];
    case "v": case "h": return [T.stairsDown, 0];
    case "D": return [T.door, 0];
    case "I": return on(T.pillar);
    case "F": return on(T.fountain);
    case "=": return on(T.counter);
    case "S": return on(T.shelf);
    case "B": return on(T.bookshelf);
    case "p": return on(T.plant);
    case "x": return on(T.cobweb);
    case "k": return on(T.bones);
    case "G": return on(T.crate);
    case "M": return on(T.circle);
    case "n": return on(T.candle);
    case "s": return [T.sky, 0];
    case "P": return [T.parapet, 0];
    case "f": return on(T.flag);
    case "y": return on(T.brazier);
    default: throw new Error(`知らない文字: ${ch}`);
  }
}

function buildLayers(floorNo) {
  const plan = FLOOR_PLANS[floorNo];
  if (plan.length !== H || plan.some((row) => row.length !== W)) throw new Error(`${floorNo}F の形が ${W}×${H} でない`);
  const ground = [];
  const objects = [];
  for (const row of plan) for (const ch of row) {
    const [g, o] = legend(ch, floorNo);
    ground.push(g);
    objects.push(o);
  }
  return [{ name: "ground", tiles: ground }, { name: "objects", tiles: objects }];
}

// ── イベント ──────────────────────────────────────────────────────────
const cmd = (code, params, indent = 0) => ({ code, params, indent });
const text = (t, indent = 0) => cmd("ShowText", { text: t, position: "bottom", background: "window" }, indent);
const transfer = (to, { x, y, dir }, indent = 0) => cmd("TransferPlayer", { mapId: mapId(to), x, y, dir, fade: "black" }, indent);
const healAll = (indent = 0) => [
  cmd("ChangeHp", { target: "party", op: "gain", amount: { kind: "constant", value: 9999 }, allowDeath: false }, indent),
  cmd("ChangeMp", { target: "party", op: "gain", amount: { kind: "constant", value: 9999 } }, indent),
];
const page = (p) => ({ conditions: [], trigger: "action", through: false, priority: "same", ...p });
const event = (id, name, [x, y], pages) => ({ id, name, x, y, pages });

function stairsEvents(floorNo) {
  const events = [];
  if (floorNo < FLOORS) events.push(event("ev_up", "上り階段", UP, [page({ trigger: "touch", priority: "below", commands: [transfer(floorNo + 1, ARRIVE_UP)] })]));
  if (floorNo > 1) events.push(event("ev_down", "下り階段", DOWN, [page({ trigger: "touch", priority: "below", commands: [transfer(floorNo - 1, ARRIVE_DOWN)] })]));
  return events;
}

function healCircle() {
  return event("ev_circle", "回復の魔法陣", CIRCLE, [
    page({
      trigger: "touch",
      priority: "below",
      commands: [
        cmd("FlashScreen", { color: { r: 120, g: 255, b: 230, a: 0.6 }, duration: 20 }),
        ...healAll(),
        text("魔法陣が 光った。\nHP と MP が 回復した！"),
      ],
    }),
  ]);
}

/** 番人ごとの台詞と、勝ったときの追加のコマンド。 */
const GUARDIANS = {
  2: {
    name: "ゴブリン兄弟",
    monster: "goblin",
    troop: "tr_goblins",
    intro: ["ゲヘヘ……！ 2Fの 番人、ゴブリン兄弟 さまだ！\nここから 先へは 通さねえぜ！"],
    win: [],
  },
  3: {
    name: "大グモ",
    monster: "spider",
    troop: "tr_spider",
    intro: ["シュルルル……", "（大グモが 糸を 張って 待ちかまえている。\n\\C[2]毒の牙\\C[0]に 気をつけよう）"],
    win: [cmd("ControlSwitches", { ids: ["sw_spider"], value: true }, 2), text("糸に 捕らわれていた 人が いる……！", 2)],
  },
  4: {
    name: "ストーンゴーレム",
    monster: "golem",
    troop: "tr_golem",
    intro: ["……シンニュウシャ…… ハイジョ スル……", "（岩のように 固そうだ。\n\\C[4]魔法\\C[0]なら 効くかもしれない）"],
    win: [],
  },
  5: {
    name: "闇の魔術師",
    monster: "sorcerer",
    troop: "tr_sorcerer",
    intro: ["ククク…… よくぞ ここまで 来た。\nだが この先へは 行かせぬ。", "骸骨兵ども、かかれ！\n眠りの魔法で 永遠に 眠るがいい！"],
    win: [],
  },
  6: {
    name: "炎の竜",
    monster: "dragon",
    troop: "tr_dragon",
    intro: ["グオオオオオ……！", "（塔の 頂上に すむ 炎の竜が 翼を 広げた！\nこれが 最後の 戦いだ）"],
    win: [
      cmd("FlashScreen", { color: { r: 255, g: 240, b: 200, a: 1 }, duration: 40 }, 2),
      text("炎の竜は 空の かなたへ 飛び去っていった……", 2),
      text("\\C[6]バトルタワー 制覇！\\C[0]\nおめでとう！ \\N[actor_hero]たちは\n塔の 頂上に たどり着いた！", 2),
      cmd("Fadeout", { duration: 40 }, 2),
      cmd("ReturnToTitle", {}, 2),
    ],
  },
};

/** 番人：話しかけて「挑む」と戦闘。勝てばセルフスイッチ A で消える。負ければ入口に戻されて回復する。 */
function guardianEvent(floorNo, sheetAsset) {
  const g = GUARDIANS[floorNo];
  const commands = [
    ...g.intro.map((t) => text(t)),
    cmd("ShowChoices", { choices: ["挑む", "やめておく"], cancel: 1 }),
    cmd("ChoiceBranch", { index: 0 }),
    cmd("BattleProcessing", { troop: g.troop, canEscape: floorNo < FLOORS, canLose: true }, 1),
    cmd("ChoiceBranch", { index: 0 }, 1),
    text(`\\C[6]${g.name}を たおした！\\C[0]`, 2),
    cmd("ControlVariables", { ids: ["var_cleared"], op: "add", operand: { kind: "constant", value: 1 } }, 2),
    cmd("ControlSelfSwitch", { key: "A", value: true }, 2),
    ...g.win,
    cmd("ChoiceBranch", { index: 1 }, 1),
    text("いったん 退いて、体勢を 立て直そう。", 2),
    cmd("ChoiceBranch", { index: 2 }, 1),
    text("\\N[actor_hero]たちは 力尽きた……", 2),
    ...healAll(2),
    transfer(1, START, 2),
    text("……気がつくと、塔の 入口に 運ばれていた。\n（番人は 何度でも 挑戦を 受けてくれる）", 2),
    cmd("EndBranch", {}, 1),
    cmd("ChoiceBranch", { index: 1 }),
    text("準備を してから 出直そう。", 1),
    cmd("EndBranch", {}),
  ];
  return event("ev_guardian", g.name, floorNo === FLOORS ? BOSS : GUARD, [
    page({ graphic: { asset: sheetAsset, index: MONSTER_INDEX[g.monster], direction: "down" }, commands }),
    page({ conditions: [{ kind: "selfSwitch", key: "A", value: true }], through: true, priority: "below", commands: [] }),
  ]);
}

function lobbyEvents(assets) {
  const people = assets["people.png"].id;
  const npc = (who) => ({ asset: people, index: PEOPLE[who].index, direction: "down" });
  return [
    event("ev_reception", "受付", [10, 3], [
      page({
        graphic: npc("receptionist"),
        commands: [
          text("ようこそ、\\C[6]バトルタワー\\C[0]へ！\n各階の 番人を 倒して、\n屋上を 目指してください。"),
          text("負けても 入口に 戻されるだけ。\n何度でも 挑戦できます。\n各階の \\C[3]魔法陣\\C[0]で 回復も できますよ。"),
          text("泉で 回復と 記録、よろず屋で 買い物、\nかかしで 腕だめしが できます。"),
          text("こちらは 挑戦者への 支度金と\nポーションです。 がんばって！"),
          cmd("ChangeGold", { op: "gain", amount: { kind: "constant", value: 100 } }),
          cmd("ChangeItems", { item: "item_potion", op: "gain", amount: { kind: "constant", value: 3 } }),
          text("\\C[6]100G\\C[0] と ポーション 3個を 受け取った！"),
          cmd("ControlSelfSwitch", { key: "A", value: true }),
        ],
      }),
      page({
        conditions: [{ kind: "selfSwitch", key: "A", value: true }],
        graphic: npc("receptionist"),
        commands: [
          text("いままでに 倒した 番人は \\C[2]\\V[var_cleared]\\C[0] 体。\n屋上の 竜を 倒せば 制覇です！"),
          text("ゴーレムは 守りが 固いので 魔法が おすすめ。\n魔術師の 眠りの 魔法は、\n僧侶の キュアで 目を 覚ませます。"),
        ],
      }),
    ]),
    event("ev_merchant", "よろず屋", [2, 3], [
      page({
        graphic: npc("merchant"),
        commands: [text("いらっしゃい！ 塔に 挑むなら\n薬は 多めに 持っていきな。"), cmd("ShopProcessing", { goods: ["item_potion", "item_hipotion", "item_ether", "item_antidote", "item_waker"], canSell: true }), text("気をつけてな！")],
      }),
    ]),
    event("ev_fountain", "回復の泉", [2, 8], [
      page({
        commands: [
          cmd("FlashScreen", { color: { r: 150, g: 210, b: 255, a: 0.6 }, duration: 20 }),
          ...healAll(),
          text("泉の 水を 飲んだ。\nHP と MP が 回復した！"),
          text("ここまでの 冒険を 記録しますか？"),
          cmd("ShowChoices", { choices: ["記録する", "しない"], cancel: 1 }),
          cmd("ChoiceBranch", { index: 0 }),
          cmd("SaveGame", {}, 1),
          cmd("ChoiceBranch", { index: 1 }),
          cmd("EndBranch", {}),
        ],
      }),
    ]),
    event("ev_dummy", "訓練用のかかし", [10, 8], [
      page({
        graphic: { asset: assets["monsters.png"].id, index: MONSTER_INDEX.scarecrow, direction: "down" },
        commands: [
          text("訓練用の かかしだ。\n「何度でも 打ちこんで よし！」と 書いてある。"),
          cmd("ShowChoices", { choices: ["打ちこむ", "やめておく"], cancel: 1 }),
          cmd("ChoiceBranch", { index: 0 }),
          cmd("BattleProcessing", { troop: "tr_dummy", canEscape: true, canLose: true }, 1),
          cmd("ChoiceBranch", { index: 0 }, 1),
          text("いい 手ごたえだ！", 2),
          cmd("ChoiceBranch", { index: 1 }, 1),
          cmd("ChoiceBranch", { index: 2 }, 1),
          cmd("EndBranch", {}, 1),
          cmd("ChoiceBranch", { index: 1 }),
          cmd("EndBranch", {}),
        ],
      }),
    ]),
  ];
}

/** 3F の僧侶：大グモを倒すと話せるようになり、仲間に加わる。 */
function clericEvent(assets) {
  const graphic = { asset: assets["people.png"].id, index: PEOPLE.cleric.index, direction: "down" };
  return event("ev_cleric", "僧侶", [10, 3], [
    page({ graphic, commands: [text("たすけて……！\n糸に からまって 動けないの。\n番人の 大グモを 倒して ください……！")] }),
    page({
      conditions: [{ kind: "switch", id: "sw_spider", value: true }],
      graphic,
      commands: [
        text("助けてくれて ありがとう！\nわたしも 屋上を 目指していたの。\nいっしょに 行かせて ください！"),
        cmd("ChangeParty", { actor: "actor_cleric", op: "add" }),
        text("\\C[6]\\N[actor_cleric]\\C[0]が 仲間に なった！\n（回復の魔法 \\C[3]ヒール\\C[0]、目覚めの魔法 \\C[3]キュア\\C[0]が 使える）"),
        cmd("ControlSelfSwitch", { key: "A", value: true }),
      ],
    }),
    page({ conditions: [{ kind: "selfSwitch", key: "A", value: true }], through: true, priority: "below", commands: [] }),
  ]);
}

// ── データベース ──────────────────────────────────────────────────────
const curve = (base, growth) => ({ base, growth });
const skill = (id, name, mpCost, scope, formula, effects = []) => ({ id, name, mpCost, scope, formula, effects });
const item = (id, name, kind, price, effects, extra = {}) => ({ id, name, kind, price, effects, ...extra });
const stats = (mhp, mmp, atk, def, mat, mdf, agi, luk) => ({ mhp, mmp, atk, def, mat, mdf, agi, luk });

function database(assets) {
  const battler = (name) => ({ asset: assets[`${name}.png`].id });
  return {
    actors: {
      actor_hero: { id: "actor_hero", name: "勇者", classId: "class_warrior", initialLevel: 1, walk: { asset: assets["hero.png"].id }, equips: { weapon: "wp_sword", armor: "ar_leather" } },
      actor_mage: { id: "actor_mage", name: "魔法使い", classId: "class_mage", initialLevel: 1, equips: { weapon: "wp_rod", armor: "ar_robe" } },
      actor_cleric: { id: "actor_cleric", name: "僧侶", classId: "class_cleric", initialLevel: 4, equips: { weapon: "wp_staff", armor: "ar_robe" } },
    },
    classes: {
      class_warrior: {
        id: "class_warrior",
        name: "戦士",
        params: { mhp: curve(64, 14), mmp: curve(8, 2), atk: curve(14, 3), def: curve(10, 2), mat: curve(4, 1), mdf: curve(6, 1), agi: curve(9, 2), luk: curve(8, 1) },
        skills: [{ level: 1, skill: "sk_smash" }, { level: 4, skill: "sk_break" }],
      },
      class_mage: {
        id: "class_mage",
        name: "魔法使い",
        params: { mhp: curve(42, 8), mmp: curve(24, 5), atk: curve(6, 1), def: curve(6, 1), mat: curve(15, 3), mdf: curve(10, 2), agi: curve(11, 2), luk: curve(8, 1) },
        skills: [{ level: 1, skill: "sk_fire" }, { level: 2, skill: "sk_flame" }, { level: 4, skill: "sk_thunder" }],
      },
      class_cleric: {
        id: "class_cleric",
        name: "僧侶",
        params: { mhp: curve(48, 10), mmp: curve(26, 5), atk: curve(8, 2), def: curve(9, 2), mat: curve(12, 3), mdf: curve(14, 2), agi: curve(8, 1), luk: curve(10, 1) },
        skills: [{ level: 1, skill: "sk_heal" }, { level: 1, skill: "sk_cure" }, { level: 3, skill: "sk_protect" }, { level: 4, skill: "sk_raise" }, { level: 5, skill: "sk_healall" }],
      },
    },
    skills: Object.fromEntries(
      [
        // 味方の技
        skill("sk_smash", "強打", 4, "one-enemy", "a.atk * 6 - b.def * 2"),
        skill("sk_break", "かぶと割り", 6, "one-enemy", "a.atk * 4 - b.def", [{ kind: "buff", param: "def", level: -1 }]),
        skill("sk_fire", "ファイア", 4, "one-enemy", "a.mat * 4 - b.mdf * 2"),
        skill("sk_flame", "フレイム", 8, "all-enemies", "a.mat * 3 - b.mdf * 2"),
        skill("sk_thunder", "サンダー", 10, "one-enemy", "a.mat * 6 - b.mdf * 2"),
        skill("sk_heal", "ヒール", 3, "one-ally", "-(a.mat * 3 + 30)"),
        skill("sk_cure", "キュア", 2, "one-ally", "", [{ kind: "removeState", state: "st_poison" }, { kind: "removeState", state: "st_sleep" }]),
        skill("sk_protect", "プロテクト", 5, "all-allies", "", [{ kind: "buff", param: "def", level: 1 }]),
        skill("sk_raise", "リザレク", 10, "one-dead-ally", "", [{ kind: "recoverHp", value: 60 }]),
        skill("sk_healall", "ヒールオール", 9, "all-allies", "-(a.mat * 2 + 30)"),
        // 敵の技
        skill("sk_sway", "ゆらゆら揺れる", 0, "none", ""),
        skill("sk_club", "こん棒", 0, "one-enemy", "a.atk * 4 - b.def * 2"),
        skill("sk_bite", "かみつく", 0, "one-enemy", "a.atk * 4 - b.def * 2"),
        skill("sk_fang", "毒の牙", 0, "one-enemy", "a.atk * 3 - b.def * 2", [{ kind: "addState", state: "st_poison", chance: 0.6 }]),
        skill("sk_web", "糸を吐く", 0, "all-enemies", "a.atk * 2 - b.def * 2", [{ kind: "buff", param: "agi", level: -1 }]),
        skill("sk_punch", "岩の拳", 0, "one-enemy", "a.atk * 4 - b.def * 2"),
        skill("sk_rocks", "岩投げ", 0, "all-enemies", "a.atk * 3 - b.def * 2"),
        skill("sk_harden", "かたくなる", 0, "self", "", [{ kind: "buff", param: "def", level: 1 }]),
        skill("sk_darkfire", "ダークファイア", 4, "one-enemy", "a.mat * 4 - b.mdf * 2"),
        skill("sk_sleep", "スリープ", 6, "all-enemies", "", [{ kind: "addState", state: "st_sleep", chance: 0.4 }]),
        skill("sk_darkflame", "ダークフレイム", 10, "all-enemies", "a.mat * 3 - b.mdf * 2"),
        skill("sk_slash", "斬りつける", 0, "one-enemy", "a.atk * 4 - b.def * 2"),
        skill("sk_breath", "火の息", 0, "all-enemies", "a.mat * 3 - b.mdf * 2"),
        skill("sk_roar", "咆哮", 0, "self", "", [{ kind: "buff", param: "atk", level: 1 }]),
        skill("sk_inferno", "業火", 0, "all-enemies", "a.mat * 4 - b.mdf * 2"),
      ].map((s) => [s.id, s]),
    ),
    items: Object.fromEntries(
      [
        item("item_potion", "ポーション", "consumable", 20, [{ kind: "recoverHp", value: 60 }]),
        item("item_hipotion", "ハイポーション", "consumable", 80, [{ kind: "recoverHp", value: 200 }]),
        item("item_ether", "エーテル", "consumable", 100, [{ kind: "recoverMp", value: 30 }]),
        item("item_antidote", "毒消し草", "consumable", 10, [{ kind: "removeState", state: "st_poison" }]),
        item("item_waker", "目覚まし鈴", "consumable", 10, [{ kind: "removeState", state: "st_sleep" }]),
        item("wp_sword", "銅の剣", "weapon", 100, [], { params: { atk: 5 } }),
        item("wp_rod", "樫の杖", "weapon", 80, [], { params: { mat: 4 } }),
        item("wp_staff", "聖なる杖", "weapon", 120, [], { params: { mat: 3, mdf: 3 } }),
        item("ar_leather", "革の鎧", "armor", 60, [], { params: { def: 4 } }),
        item("ar_robe", "旅のローブ", "armor", 50, [], { params: { def: 2, mdf: 2 } }),
      ].map((i) => [i.id, i]),
    ),
    enemies: {
      en_scarecrow: { id: "en_scarecrow", name: "かかし", graphic: battler("scarecrow"), params: stats(40, 0, 1, 4, 0, 2, 1, 0), actions: [{ skill: "sk_sway", rating: 5 }], drops: [], exp: 8, gold: 3 },
      en_goblin: { id: "en_goblin", name: "ゴブリン", graphic: battler("goblin"), params: stats(110, 0, 11, 8, 0, 4, 8, 5), actions: [{ skill: "sk_club", rating: 5 }], drops: [{ item: "item_potion", rate: 0.5 }], exp: 20, gold: 15 },
      en_spider: {
        id: "en_spider",
        name: "大グモ",
        graphic: battler("spider"),
        params: stats(450, 0, 13, 12, 0, 8, 12, 6),
        actions: [{ skill: "sk_bite", rating: 5 }, { skill: "sk_fang", rating: 5 }, { skill: "sk_web", rating: 3 }],
        drops: [{ item: "item_antidote", rate: 1 }],
        exp: 80,
        gold: 60,
      },
      en_golem: {
        id: "en_golem",
        name: "ストーンゴーレム",
        graphic: battler("golem"),
        params: stats(500, 0, 18, 34, 0, 8, 4, 4),
        actions: [{ skill: "sk_punch", rating: 5 }, { skill: "sk_rocks", rating: 4, condition: "turn % 3 == 2" }, { skill: "sk_harden", rating: 3 }],
        drops: [{ item: "item_hipotion", rate: 1 }],
        exp: 150,
        gold: 120,
      },
      en_sorcerer: {
        id: "en_sorcerer",
        name: "闇の魔術師",
        graphic: battler("sorcerer"),
        params: stats(280, 120, 10, 14, 24, 20, 14, 10),
        actions: [{ skill: "sk_darkfire", rating: 5 }, { skill: "sk_sleep", rating: 4 }, { skill: "sk_darkflame", rating: 4, condition: "turn >= 2" }],
        drops: [{ item: "item_ether", rate: 1 }],
        exp: 170,
        gold: 150,
      },
      en_skeleton: { id: "en_skeleton", name: "骸骨兵", graphic: battler("skeleton"), params: stats(120, 0, 18, 14, 0, 6, 10, 4), actions: [{ skill: "sk_slash", rating: 5 }], drops: [], exp: 30, gold: 20 },
      en_dragon: {
        id: "en_dragon",
        name: "炎の竜",
        graphic: battler("dragon"),
        params: stats(1100, 0, 26, 24, 26, 18, 16, 10),
        actions: [
          { skill: "sk_bite", rating: 5 },
          { skill: "sk_breath", rating: 4, condition: "turn >= 2" },
          { skill: "sk_roar", rating: 3 },
          { skill: "sk_inferno", rating: 8, condition: "a.hp * 2 < a.mhp && turn % 3 == 0" },
        ],
        drops: [],
        exp: 500,
        gold: 500,
      },
    },
    troops: {
      tr_dummy: { id: "tr_dummy", name: "かかし", members: [{ enemy: "en_scarecrow", x: 208, y: 150 }], pages: [] },
      tr_goblins: { id: "tr_goblins", name: "ゴブリン兄弟", members: [{ enemy: "en_goblin", x: 150, y: 150 }, { enemy: "en_goblin", x: 266, y: 150 }], pages: [] },
      tr_spider: { id: "tr_spider", name: "大グモ", members: [{ enemy: "en_spider", x: 208, y: 150 }], pages: [] },
      tr_golem: { id: "tr_golem", name: "ストーンゴーレム", members: [{ enemy: "en_golem", x: 208, y: 146 }], pages: [] },
      tr_sorcerer: {
        id: "tr_sorcerer",
        name: "闇の魔術師と骸骨兵",
        members: [{ enemy: "en_skeleton", x: 100, y: 156 }, { enemy: "en_sorcerer", x: 208, y: 146 }, { enemy: "en_skeleton", x: 316, y: 156 }],
        pages: [],
      },
      tr_dragon: { id: "tr_dragon", name: "炎の竜", members: [{ enemy: "en_dragon", x: 208, y: 144 }], pages: [] },
    },
    states: {
      st_poison: { id: "st_poison", name: "毒", restriction: "none", turns: 5, paramRates: {}, hpRegen: -0.08 },
      st_sleep: { id: "st_sleep", name: "眠り", restriction: "cannotAct", turns: 2, paramRates: {}, hpRegen: 0 },
    },
    commonEvents: {},
  };
}

// ── 書き出し ──────────────────────────────────────────────────────────
const toJson = (value) => `${JSON.stringify(value, null, 2).replace(/\[\s+([-\d.,\s]+?)\s+\]/g, (_, body) => `[${body.split(/,\s*/).join(", ")}]`)}\n`;

const monsterSprites = Object.fromEntries(Object.keys(MONSTER_INDEX).map((name) => [name, MONSTERS[name]()]));
const battlerImages = Object.fromEntries(
  Object.entries(monsterSprites).map(([name, sprite]) => [`${name}.png`, scale(sprite, name === "dragon" ? 3 : 2)]),
);
const walkSheets = Object.entries(MONSTER_INDEX)
  .sort((a, b) => a[1] - b[1])
  .map(([name]) => monsterWalk(monsterSprites[name]));
const peopleSheets = Object.values(PEOPLE)
  .sort((a, b) => a.index - b.index)
  .map((p) => character(p.look));

rmSync(ROOT, { recursive: true, force: true });
const assets = writeAssets(join(ROOT, "assets"), {
  "tower_tileset.png": tileset(),
  "hero.png": character(HERO),
  "people.png": sheet(3, peopleSheets),
  "monsters.png": sheet(4, walkSheets),
  ...battlerImages,
  "battle.wav": { bytes: readFileSync(BATTLE_WAV), ext: "wav", info: "戦闘 BGM（はじまりの村と同じ）" },
});

const FLOOR_NAMES = { 1: "1F エントランス", 2: "2F ゴブリンのねぐら", 3: "3F クモの巣の間", 4: "4F 石像の回廊", 5: "5F 魔術師の書斎", 6: "屋上" };
mkdirSync(join(ROOT, "maps"), { recursive: true });
const mapsMeta = {};
for (let n = 1; n <= FLOORS; n++) {
  const list = [...stairsEvents(n)];
  if (n === 1) list.push(...lobbyEvents(assets));
  else {
    list.push(healCircle(), guardianEvent(n, assets["monsters.png"].id));
    if (n === 3) list.push(clericEvent(assets));
  }
  const events = Object.fromEntries(list.map((e) => [e.id, e]));
  const id = mapId(n);
  writeFileSync(join(ROOT, "maps", `${id}.json`), toJson({ id, width: W, height: H, tileset: "ts_tower", layers: buildLayers(n), events }));
  mapsMeta[id] = { id, name: FLOOR_NAMES[n], order: n - 1 };
}

const entry = (name, a) =>
  name.endsWith(".wav")
    ? { name, kind: "audio", mime: "audio/wav", size: a.size }
    : { name, kind: "image", mime: "image/png", size: a.size, width: a.width, height: a.height };
const project = {
  formatVersion: 1,
  meta: { id: "tower", title: "デモ：バトルタワー", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" },
  system: {
    startMap: mapId(1),
    startX: START.x,
    startY: START.y,
    initialParty: ["actor_hero", "actor_mage"],
    tileSize: TILE,
    screen: { width: W * TILE, height: H * TILE },
    bgm: { battle: { asset: assets["battle.wav"].id, volume: 0.6, pitch: 1, loop: true } },
    terms: { newGame: "ニューゲーム", attack: "攻撃", skill: "スキル", guard: "防御", escape: "逃げる" },
  },
  maps: mapsMeta,
  tilesets: { ts_tower: { id: "ts_tower", name: "塔", image: { asset: assets["tower_tileset.png"].id }, passage: PASSAGE } },
  database: database(assets),
  assets: { entries: Object.fromEntries(Object.entries(assets).map(([name, a]) => [a.id, entry(name, a)])) },
  switches: { sw_spider: { name: "大グモを倒した" } },
  variables: { var_cleared: { name: "倒した番人の数" } },
};
writeFileSync(join(ROOT, "project.json"), toJson(project));
