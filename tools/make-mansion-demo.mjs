#!/usr/bin/env node
/**
 * 謎解きの館のデモ（fixtures/projects/v1/mansion）を丸ごと生成する開発用スクリプト。
 * 出力: project.json、maps/<MapId>.json、assets/<AssetId>.<ext>（AssetId = 内容の sha256 先頭 16 桁）。
 * 生成物はコミット済み。部屋や謎を変えたいときだけ再実行する（乱数はシード固定なので、何度実行しても同じものができる）。
 *
 *   node tools/make-mansion-demo.mjs
 *
 * 館から出るまでの謎（戦闘なし。イベントの作り方のお手本）：
 * 1. 玄関ホールの甲冑が書斎の入口をふさいでいる。なぞなぞ（選択肢）に正解すると、甲冑が横へどく。
 * 2. 書斎の家政婦のメモに、食堂のろうそくを灯す順番が書いてある。
 * 3. 食堂の 4 本のろうそくを順番どおりに灯す（変数で何本目まで灯したかを数え、順番を間違えると全部消える）。
 *    灯ったろうそくは「変数が○以上」のページで描き分ける。4 本そろうと食器棚が開き、寝室の鍵が手に入る。
 * 4. 寝室の鍵を持っていると、ホールの奥の扉から寝室へ入れる（アイテムを持っているときのページ）。主の日記に金庫の番号の手がかり。
 * 5. 手がかりは食堂の柱時計の時刻。書斎の金庫に 4 けたの番号を入れる（数値入力）と、玄関の鍵が手に入る。
 * 6. 玄関の扉で、持っている大事なものから玄関の鍵を選ぶ（アイテム選択）と、館から脱出してクリア（タイトルへ戻る）。
 * ホールのネコは、進み具合（変数）に応じたページで次の手がかりをくれる。
 */
import { readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canvas, character, HERO, image, lcg, shade, sheet, TILE, writeAssets } from "./pixel-art.mjs";

const ROOT = join(import.meta.dirname, "..", "fixtures", "projects", "v1", "mansion");
/** ネコの歩行グラフィックは「はじまりの村」のネコ（tools/make-demo-assets.mjs が作った PNG）と同じものを使う。 */
const CAT_PNG = join(import.meta.dirname, "..", "fixtures", "projects", "v1", "demo", "assets", "96d90b7571e30700.png");

const W = 13;
const H = 10;
const ROOMS = { hall: "map_hall", study: "map_study", dining: "map_dining", bedroom: "map_bedroom" };
const START = { x: 6, y: 7, dir: "up" };

/** 謎の答え。 */
const SAFE_CODE = 1047;
const CLOCK_TIME = "10時47分";
/** ろうそくを灯す順（白 → 赤 → 緑 → 青）。 */
const CANDLE_ORDER = ["white", "red", "green", "blue"];
const CANDLE_NAME = { white: "白", red: "赤", green: "緑", blue: "青" };
const CANDLE_ADJ = { white: "白い", red: "赤い", green: "緑の", blue: "青い" };
const CANDLE_COLOR = { white: [236, 232, 220], red: [200, 52, 52], green: [64, 160, 84], blue: [64, 104, 200] };

// ── 小道具のシート（イベントの絵。1 つ = 3 パターン × 4 方向、全コマ同じ絵）────────
function still(draw) {
  const one = canvas(TILE, TILE);
  draw(one);
  const out = image(TILE * 3, TILE * 4);
  for (let row = 0; row < 4; row++) for (let p = 0; p < 3; p++) for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
    const c = one.get(x, y);
    if (c[3] > 0) out.set(p * TILE + x, row * TILE + y, c);
  }
  return out;
}

const candle = (color, lit) =>
  still((d) => {
    if (lit) {
      d.disc(16, 8, 11, [255, 210, 120, 40]);
      d.disc(16, 8, 7, [255, 220, 140, 60]);
    }
    d.ellipse(16, 29, 7, 2, [0, 0, 0, 70]);
    d.rect(11, 27, 11, 2, [176, 146, 62]);
    d.rect(15, 18, 3, 9, [196, 164, 72]);
    d.rect(10, 17, 13, 2, [214, 182, 86]);
    d.rect(13, 9, 7, 8, color);
    d.rect(13, 9, 2, 8, shade(color, 30));
    d.rect(19, 9, 1, 8, shade(color, -30));
    d.rect(16, 6, 1, 3, [60, 50, 40]);
    if (lit) {
      d.disc(16, 4, 2, [255, 150, 40]);
      d.rect(16, 1, 1, 3, [255, 210, 90]);
      d.set(16, 4, [255, 250, 210]);
    }
  });

const armor = () =>
  still((d) => {
    const steel = [168, 172, 184];
    d.ellipse(16, 30, 9, 2, [0, 0, 0, 80]);
    d.symRect(11, 22, 4, 8, shade(steel, -20));
    d.rect(10, 12, 12, 11, steel);
    d.rect(10, 12, 12, 2, shade(steel, 30));
    d.rect(15, 14, 2, 8, shade(steel, -30));
    d.symRect(6, 12, 4, 10, shade(steel, -10));
    d.disc(16, 7, 5, steel);
    d.rect(12, 7, 9, 2, [30, 30, 40]);
    d.rect(15, 1, 2, 3, [180, 40, 40]);
    d.rect(14, 0, 4, 2, [200, 60, 60]);
    d.rect(25, 2, 2, 28, [120, 90, 60]);
    d.rect(24, 1, 4, 3, [210, 210, 220]);
    d.rect(23, 4, 6, 1, [210, 210, 220]);
  });

const cupboard = (open) =>
  still((d) => {
    const wood = [112, 70, 40];
    d.ellipse(16, 30, 13, 2, [0, 0, 0, 70]);
    d.rect(3, 2, 26, 28, wood);
    d.rect(3, 2, 26, 2, shade(wood, 30));
    if (open) {
      d.rect(5, 5, 22, 22, [40, 26, 18]);
      d.rect(5, 15, 22, 1, shade(wood, 20));
      for (const x of [7, 12, 18]) d.disc(x + 2, 12, 2, [230, 230, 236]);
      d.rect(9, 22, 14, 2, [230, 230, 236]);
    } else {
      d.rect(5, 5, 10, 22, shade(wood, 14));
      d.rect(17, 5, 10, 22, shade(wood, 14));
      for (const x of [6, 18]) d.rect(x, 6, 8, 9, [150, 200, 220]);
      d.rect(13, 17, 2, 3, [230, 196, 80]);
      d.rect(17, 17, 2, 3, [230, 196, 80]);
    }
  });

const safe = (open) =>
  still((d) => {
    const iron = [74, 78, 88];
    d.ellipse(16, 30, 12, 2, [0, 0, 0, 80]);
    d.rect(5, 8, 22, 22, iron);
    d.rect(5, 8, 22, 2, shade(iron, 30));
    if (open) {
      d.rect(7, 11, 18, 17, [24, 24, 30]);
      d.rect(25, 10, 4, 19, shade(iron, 10));
    } else {
      d.rect(7, 11, 18, 17, shade(iron, 12));
      d.disc(16, 19, 5, [200, 200, 210]);
      d.disc(16, 19, 3, [120, 124, 136]);
      for (const [x, y] of [[16, 14], [21, 19], [16, 24], [11, 19]]) d.set(x, y, [40, 40, 46]);
      d.rect(22, 17, 2, 5, [210, 180, 70]);
    }
  });

/** シートでの並び（index）。 */
const PROPS = [
  ...CANDLE_ORDER.map((c) => [`candle_${c}`, candle(CANDLE_COLOR[c], false)]),
  ...CANDLE_ORDER.map((c) => [`candle_${c}_lit`, candle(CANDLE_COLOR[c], true)]),
  ["armor", armor()],
  ["cupboard", cupboard(false)],
  ["cupboard_open", cupboard(true)],
  ["safe", safe(false)],
  ["safe_open", safe(true)],
];
const PROP = Object.fromEntries(PROPS.map(([name], i) => [name, i]));

// ── タイルセット ──────────────────────────────────────────────────────
const T = {
  floor: 1,
  rug: 2,
  wallTop: 3,
  wall: 4,
  window: 5,
  doorSide: 6,
  doorTop: 7,
  doorBottom: 8,
  frontDoor: 9,
  bookshelf: 10,
  desk: 11,
  table: 12,
  chair: 13,
  bedHead: 14,
  bedFoot: 15,
  nightstand: 16,
  wardrobe: 17,
  mirror: 18,
  plant: 19,
  clock: 20,
  globe: 21,
  painting: 22,
  roundTable: 23,
  sconce: 24,
};
const CELLS = 25;
/** 通行：床・じゅうたん・扉（玄関以外）は通れる。ほかは通れない。 */
const PASSABLE = new Set([0, T.floor, T.rug, T.doorSide, T.doorTop, T.doorBottom]);
const PASSAGE = Array.from({ length: CELLS }, (_, id) => (PASSABLE.has(id) ? 15 : 0));

const WOOD = [134, 92, 56];
const PAPER = [112, 36, 50];
const GOLD = [214, 176, 80];

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
    /** 今の色に `c` を割合 `a` で重ねる（地面のタイルは不透明のままにする）。 */
    const glow = (cx, cy, r, c, a) => {
      for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
        const x = cx + i;
        const y = cy + j;
        if (i * i + j * j > r * r || x < 0 || y < 0 || x >= TILE || y >= TILE) continue;
        const base = img.get(id * TILE + x, y);
        set(x, y, base.map((v, k) => (k < 3 ? Math.round(v * (1 - a) + c[k] * a) : 255)));
      }
    };
    return { set, rect, disc, ellipse, glow };
  };
  /** 壁紙（金の縦じま）と腰板。 */
  const wallpaper = (c) => {
    c.rect(0, 0, TILE, TILE, PAPER);
    for (const x of [3, 19]) c.rect(x, 0, 2, 22, shade(PAPER, 26));
    for (let y = 2; y < 22; y += 6) for (const x of [11, 27]) c.set(x, y, GOLD);
    c.rect(0, 22, TILE, 10, shade(WOOD, -20));
    c.rect(0, 22, TILE, 2, shade(WOOD, 20));
    for (const x of [0, 16]) c.rect(x, 24, 1, 8, shade(WOOD, -50));
    c.rect(0, TILE - 2, TILE, 2, shade(WOOD, -60));
  };

  // 床：木の板
  {
    const c = cell(T.floor, { wrap: true });
    c.rect(0, 0, TILE, TILE, WOOD);
    const rnd = lcg(1);
    for (let y = 0; y < TILE; y += 8) {
      c.rect(0, y, TILE, 1, shade(WOOD, -36));
      const seam = Math.floor(rnd() * TILE);
      c.rect(seam, y + 1, 1, 7, shade(WOOD, -30));
      for (let i = 0; i < 6; i++) c.set(rnd() * TILE, y + 2 + rnd() * 5, shade(WOOD, rnd() < 0.5 ? 10 : -14));
    }
  }
  // じゅうたん：深い赤に金の模様
  {
    const c = cell(T.rug, { wrap: true });
    const red = [150, 34, 42];
    c.rect(0, 0, TILE, TILE, red);
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const d = Math.abs(x - 15.5) + Math.abs(y - 15.5);
      if (Math.round(d) === 12 || Math.round(d) === 5) c.set(x, y, GOLD);
      else if (Math.round(d) === 8) c.set(x, y, shade(red, -30));
    }
  }
  // 壁の上
  {
    const c = cell(T.wallTop, { wrap: true });
    c.rect(0, 0, TILE, TILE, [44, 30, 30]);
    const rnd = lcg(3);
    for (let i = 0; i < 30; i++) c.set(rnd() * TILE, rnd() * TILE, [56, 40, 40]);
  }
  wallpaper(cell(T.wall));
  // 窓：夜空と月、両わきにカーテン
  {
    const c = cell(T.window);
    wallpaper(c);
    c.rect(7, 3, 18, 19, [60, 44, 30]);
    c.rect(9, 5, 14, 15, [26, 34, 80]);
    c.disc(19, 9, 3, [250, 240, 190]);
    c.disc(20, 8, 2, [26, 34, 80]);
    for (const [x, y] of [[11, 7], [14, 15], [21, 16]]) c.set(x, y, [255, 255, 230]);
    c.rect(15, 5, 2, 15, [60, 44, 30]);
    c.rect(4, 2, 4, 21, [70, 30, 90]);
    c.rect(24, 2, 4, 21, [70, 30, 90]);
    c.rect(3, 1, 26, 2, GOLD);
  }
  // 横の出入口（左右の壁）：暗い通路と木の枠
  {
    const c = cell(T.doorSide);
    c.rect(0, 0, TILE, TILE, [44, 30, 30]);
    c.rect(0, 4, TILE, 24, [20, 14, 14]);
    c.rect(0, 2, TILE, 2, shade(WOOD, -10));
    c.rect(0, 28, TILE, 2, shade(WOOD, -10));
    for (let x = 0; x < TILE; x++) c.set(x, 16, [30, 22, 22]);
  }
  // 奥の扉（壁面の木の扉。通れる：鍵の有無はイベントで決める）
  {
    const c = cell(T.doorTop);
    wallpaper(c);
    c.rect(5, 2, 22, 30, [70, 44, 24]);
    c.rect(7, 4, 18, 28, [112, 70, 36]);
    c.rect(7, 4, 18, 1, [150, 100, 56]);
    c.rect(9, 7, 6, 9, [96, 58, 30]);
    c.rect(17, 7, 6, 9, [96, 58, 30]);
    c.rect(9, 19, 6, 10, [96, 58, 30]);
    c.rect(17, 19, 6, 10, [96, 58, 30]);
    c.disc(22, 18, 1, GOLD);
    c.rect(19, 20, 1, 3, [40, 30, 20]);
  }
  // 手前の出入口（下の壁）
  {
    const c = cell(T.doorBottom);
    c.rect(0, 0, TILE, TILE, [44, 30, 30]);
    c.rect(4, 0, 24, TILE, [20, 14, 14]);
    c.rect(2, 0, 2, TILE, shade(WOOD, -10));
    c.rect(28, 0, 2, TILE, shade(WOOD, -10));
  }
  // 玄関の扉（両開き。通れない）
  {
    const c = cell(T.frontDoor);
    c.rect(0, 0, TILE, TILE, [44, 30, 30]);
    c.rect(1, 0, 30, TILE, [62, 38, 20]);
    for (const x of [3, 17]) {
      c.rect(x, 1, 12, 30, [104, 62, 30]);
      c.rect(x + 2, 4, 8, 10, [88, 52, 26]);
      c.rect(x + 2, 17, 8, 11, [88, 52, 26]);
    }
    c.rect(15, 0, 2, TILE, [40, 24, 12]);
    c.disc(13, 16, 2, GOLD);
    c.disc(19, 16, 2, GOLD);
    c.rect(14, 20, 4, 6, [60, 60, 70]);
    c.rect(15, 21, 2, 2, [20, 20, 24]);
  }
  // 本棚
  {
    const c = cell(T.bookshelf);
    c.rect(1, 1, 30, 30, [86, 52, 28]);
    c.rect(3, 3, 26, 26, [52, 32, 18]);
    for (const y of [10, 19, 28]) c.rect(3, y, 26, 2, [120, 78, 42]);
    const colors = [[150, 40, 40], [40, 80, 140], [60, 120, 60], [140, 110, 40], [100, 50, 120], [220, 210, 190]];
    const rnd = lcg(10);
    for (const y of [3, 12, 21]) for (let x = 4; x < 28; ) {
      const w = 2 + Math.floor(rnd() * 2);
      const h = 5 + Math.floor(rnd() * 3);
      c.rect(x, y + 7 - h, w, h, colors[Math.floor(rnd() * colors.length)]);
      x += w + (rnd() < 0.2 ? 1 : 0);
    }
  }
  // 机（本が開いて置いてある）
  {
    const c = cell(T.desk);
    c.ellipse(16, 29, 15, 2, [0, 0, 0, 70]);
    c.rect(0, 8, TILE, 20, [92, 56, 30]);
    c.rect(0, 8, TILE, 6, [128, 82, 44]);
    c.rect(0, 8, TILE, 1, [164, 112, 64]);
    c.rect(8, 6, 16, 6, [236, 228, 206]);
    c.rect(15, 6, 2, 6, [200, 190, 170]);
    for (const y of [7, 9]) c.rect(9, y, 5, 1, [120, 110, 100]), c.rect(18, y, 5, 1, [120, 110, 100]);
    c.rect(26, 3, 2, 8, [240, 240, 230]);
    c.disc(27, 2, 1, [255, 200, 80]);
  }
  // 食卓（白いテーブルクロスと皿）
  {
    const c = cell(T.table, { wrap: true });
    c.rect(0, 0, TILE, TILE, [240, 236, 226]);
    c.rect(0, 0, TILE, 1, [210, 204, 190]);
    c.ellipse(16, 15, 8, 6, [250, 250, 250]);
    c.ellipse(16, 15, 5, 3, [220, 220, 228]);
    c.rect(6, 10, 1, 10, [190, 190, 200]);
    c.rect(26, 10, 1, 10, [190, 190, 200]);
  }
  // 椅子
  {
    const c = cell(T.chair);
    c.ellipse(16, 29, 9, 2, [0, 0, 0, 70]);
    c.rect(8, 4, 16, 12, [110, 66, 36]);
    c.rect(10, 6, 12, 8, [150, 40, 50]);
    c.rect(8, 16, 16, 8, [128, 80, 44]);
    c.rect(9, 24, 2, 6, [90, 54, 28]);
    c.rect(21, 24, 2, 6, [90, 54, 28]);
  }
  // ベッド（頭・足）
  {
    const c = cell(T.bedHead);
    c.rect(2, 0, 28, 6, [96, 58, 30]);
    c.rect(3, 6, 26, 26, [236, 232, 224]);
    c.rect(6, 9, 20, 9, [250, 250, 250]);
    c.rect(6, 17, 20, 1, [210, 206, 200]);
    c.rect(3, 22, 26, 10, [130, 60, 120]);
  }
  {
    const c = cell(T.bedFoot);
    c.rect(3, 0, 26, 26, [130, 60, 120]);
    c.rect(3, 0, 26, 1, [160, 90, 150]);
    for (let y = 4; y < 26; y += 6) c.rect(3, y, 26, 1, [110, 46, 100]);
    c.rect(2, 26, 28, 5, [96, 58, 30]);
    c.ellipse(16, 31, 14, 1, [0, 0, 0, 60]);
  }
  // 小机（日記）
  {
    const c = cell(T.nightstand);
    c.ellipse(16, 29, 10, 2, [0, 0, 0, 70]);
    c.rect(6, 10, 20, 18, [104, 64, 34]);
    c.rect(6, 10, 20, 4, [140, 92, 50]);
    c.rect(8, 18, 16, 1, [70, 42, 22]);
    c.disc(16, 22, 1, GOLD);
    c.rect(10, 6, 10, 6, [110, 40, 40]);
    c.rect(11, 7, 8, 4, [230, 220, 200]);
  }
  // 衣装だんす
  {
    const c = cell(T.wardrobe);
    c.ellipse(16, 30, 14, 2, [0, 0, 0, 70]);
    c.rect(2, 0, 28, 30, [96, 58, 30]);
    c.rect(4, 3, 11, 26, [120, 74, 40]);
    c.rect(17, 3, 11, 26, [120, 74, 40]);
    c.disc(14, 16, 1, GOLD);
    c.disc(18, 16, 1, GOLD);
  }
  // 姿見
  {
    const c = cell(T.mirror);
    c.ellipse(16, 30, 9, 2, [0, 0, 0, 70]);
    c.ellipse(16, 14, 9, 13, GOLD);
    c.ellipse(16, 14, 7, 11, [150, 180, 200]);
    for (let i = 0; i < 8; i++) c.set(11 + i, 6 + i, [220, 236, 246]);
    c.rect(14, 26, 4, 4, GOLD);
  }
  // 鉢植え
  {
    const c = cell(T.plant);
    c.ellipse(16, 29, 9, 2, [0, 0, 0, 70]);
    c.rect(10, 20, 12, 9, [60, 60, 70]);
    c.rect(9, 19, 14, 2, [90, 90, 100]);
    for (const [x, y, r] of [[16, 10, 6], [11, 14, 4], [21, 14, 4], [16, 5, 3]]) c.disc(x, y, r, [54, 120, 62]);
    for (const [x, y] of [[14, 8], [18, 11], [11, 13], [21, 13]]) c.set(x, y, [110, 180, 100]);
  }
  // 柱時計
  {
    const c = cell(T.clock);
    c.ellipse(16, 30, 9, 2, [0, 0, 0, 80]);
    c.rect(8, 0, 16, 30, [88, 50, 26]);
    c.rect(8, 0, 16, 2, [120, 76, 40]);
    c.disc(16, 8, 6, GOLD);
    c.disc(16, 8, 5, [240, 236, 220]);
    // 10 時 47 分
    c.rect(13, 7, 3, 1, [30, 30, 30]);
    c.rect(14, 6, 1, 1, [30, 30, 30]);
    c.rect(12, 8, 4, 1, [30, 30, 30]);
    c.rect(16, 8, 1, 1, [30, 30, 30]);
    c.rect(12, 16, 8, 12, [40, 24, 14]);
    c.rect(15, 16, 2, 8, [200, 170, 70]);
    c.disc(16, 24, 2, GOLD);
  }
  // 地球儀
  {
    const c = cell(T.globe);
    c.ellipse(16, 29, 8, 2, [0, 0, 0, 70]);
    c.rect(12, 26, 8, 3, [96, 58, 30]);
    c.rect(15, 20, 2, 6, [96, 58, 30]);
    c.disc(16, 12, 8, [70, 120, 190]);
    for (const [x, y, r] of [[13, 9, 3], [19, 14, 2], [12, 15, 2]]) c.disc(x, y, r, [90, 160, 80]);
    for (let a = 0; a < 18; a++) c.set(16 + Math.round(Math.cos(a / 3) * 10), 12 + Math.round(Math.sin(a / 3) * 10), GOLD);
  }
  // 肖像画（壁）
  {
    const c = cell(T.painting);
    wallpaper(c);
    c.rect(7, 2, 18, 20, GOLD);
    c.rect(9, 4, 14, 16, [50, 40, 60]);
    c.disc(16, 10, 3, [230, 196, 166]);
    c.rect(13, 14, 7, 6, [40, 40, 50]);
    c.rect(15, 14, 3, 2, [240, 240, 240]);
    c.rect(13, 6, 7, 2, [180, 180, 186]);
  }
  // 丸テーブル（手紙）
  {
    const c = cell(T.roundTable);
    c.ellipse(16, 29, 10, 2, [0, 0, 0, 70]);
    c.rect(15, 18, 3, 11, [96, 58, 30]);
    c.ellipse(16, 14, 13, 7, [112, 70, 36]);
    c.ellipse(16, 13, 12, 6, [140, 92, 50]);
    c.rect(11, 10, 10, 6, [244, 238, 220]);
    c.rect(11, 10, 10, 1, [200, 190, 170]);
    c.disc(16, 13, 1, [190, 40, 40]);
  }
  // 燭台（壁）
  {
    const c = cell(T.sconce);
    wallpaper(c);
    c.glow(16, 10, 11, [255, 200, 110], 0.18);
    c.glow(16, 9, 7, [255, 210, 130], 0.22);
    c.rect(12, 14, 9, 2, GOLD);
    c.rect(15, 16, 3, 4, GOLD);
    c.rect(14, 9, 5, 5, [240, 236, 220]);
    c.disc(16, 6, 2, [255, 170, 60]);
    c.set(16, 5, [255, 250, 210]);
  }
  return img;
}

// ── 部屋の形（1 文字 = 1 タイル）──────────────────────────────────────
/**
 * `#` 壁の上、`W` 壁、`w` 窓、`P` 肖像画、`s` 燭台、`L`/`R` 左右の出入口、`d` 奥の扉、`v` 手前の出入口、`E` 玄関の扉、
 * `.` 床、`r` じゅうたん、`B` 本棚、`D` 机、`T` 食卓、`c` 椅子、`b`/`f` ベッドの頭・足、`n` 小机、`A` 衣装だんす、
 * `M` 姿見、`p` 鉢植え、`C` 柱時計、`g` 地球儀、`O` 丸テーブル。
 */
const PLANS = {
  hall: [
    "#############",
    "#WwsWPdPWswW#",
    "#p.........p#",
    "#....rrr....#",
    "#....rrr....#",
    "L....rOr....R",
    "#....rrr....#",
    "#p...rrr...p#",
    "#....rrr....#",
    "######E######",
  ],
  study: [
    "#############",
    "#WsWPWwWPWsW#",
    "#BBB..g..BBB#",
    "#...........#",
    "#..D........#",
    "#...........R",
    "#....rrr....#",
    "#p...rrr...p#",
    "#...........#",
    "#############",
  ],
  dining: [
    "#############",
    "#WwWsPWPsWwW#",
    "#C..........#",
    "#...........#",
    "#....ccc....#",
    "L....TTT....#",
    "#....TTT....#",
    "#....ccc....#",
    "#p.........p#",
    "#############",
  ],
  bedroom: [
    "#############",
    "#WWwWsPsWwWW#",
    "#bn.......AM#",
    "#f..........#",
    "#...rrrrr...#",
    "#...rrrrr...#",
    "#...rrrrr...#",
    "#p.........p#",
    "#...........#",
    "######v######",
  ],
};
const LEGEND = {
  "#": [T.wallTop, 0], W: [T.wall, 0], w: [T.window, 0], P: [T.painting, 0], s: [T.sconce, 0],
  L: [T.doorSide, 0], R: [T.doorSide, 0], d: [T.doorTop, 0], v: [T.doorBottom, 0], E: [T.frontDoor, 0],
  ".": [T.floor, 0], r: [T.rug, 0], B: [T.floor, T.bookshelf], D: [T.floor, T.desk], T: [T.floor, T.table], c: [T.floor, T.chair],
  b: [T.floor, T.bedHead], f: [T.floor, T.bedFoot], n: [T.floor, T.nightstand], A: [T.floor, T.wardrobe], M: [T.floor, T.mirror],
  p: [T.floor, T.plant], C: [T.floor, T.clock], g: [T.floor, T.globe], O: [T.rug, T.roundTable],
};

function buildLayers(room) {
  const plan = PLANS[room];
  if (plan.length !== H || plan.some((row) => row.length !== W)) throw new Error(`${room} の形が ${W}×${H} でない`);
  const ground = [];
  const objects = [];
  for (const row of plan) for (const ch of row) {
    const [g, o] = LEGEND[ch] ?? (() => { throw new Error(`知らない文字: ${ch}`); })();
    ground.push(g);
    objects.push(o);
  }
  return [{ name: "ground", tiles: ground }, { name: "objects", tiles: objects }];
}

// ── イベント ──────────────────────────────────────────────────────────
const cmd = (code, params, indent = 0) => ({ code, params, indent });
const text = (t, indent = 0) => cmd("ShowText", { text: t, position: "bottom", background: "window" }, indent);
const transfer = (room, x, y, dir, indent = 0) => cmd("TransferPlayer", { mapId: ROOMS[room], x, y, dir, fade: "black" }, indent);
const page = (p) => ({ conditions: [], trigger: "action", through: false, priority: "same", ...p });
const event = (id, name, [x, y], pages) => ({ id, name, x, y, pages });
const ifVar = (id, op, value, indent = 0) => cmd("ConditionalBranch", { condition: { kind: "variable", id, op, value } }, indent);
const setVar = (id, value, indent = 0) => cmd("ControlVariables", { ids: [id], op: "set", operand: { kind: "constant", value } }, indent);
const endBranch = (indent = 0) => cmd("EndBranch", {}, indent);
/** 進み具合（var_stage）を `stage` まで進める（戻さない）。 */
const advance = (stage, indent = 0) => [ifVar("var_stage", "<=", stage - 1, indent), setVar("var_stage", stage, indent + 1), endBranch(indent)];
const gain = (item, indent = 0) => cmd("ChangeItems", { item, op: "gain", amount: { kind: "constant", value: 1 } }, indent);
const flash = (indent = 0) => cmd("FlashScreen", { color: { r: 255, g: 240, b: 200, a: 0.7 }, duration: 20 }, indent);
const shake = (indent = 0) => cmd("ShakeScreen", { power: 5, duration: 20 }, indent);
/** 通り抜けて場所移動する出入口。 */
const doorway = (id, name, at, to) => event(id, name, at, [page({ trigger: "touch", priority: "below", commands: [transfer(...to)] })]);

/** 大事なもの。`SelectItem` は ID の昇順での番号（1 始まり）を変数に入れる。 */
const ITEMS = { key_bedroom: "寝室の鍵", key_front: "玄関の鍵", key_letter: "招待状" };
/** 一覧に出す説明文（大事なものは効果がないので、自動の説明の代わりに手がかりを書く）。 */
const ITEM_NOTES = {
  key_bedroom: "食器棚の奥にあった小さな鍵。二階のどこかの扉に合いそうだ。",
  key_front: "玄関の錠に合う、重たい鍵。",
  key_letter: "屋敷への招待状。差出人の名前は、にじんで読めない。",
};
const itemNumber = (id) => Object.keys(ITEMS).sort().indexOf(id) + 1;

function hallEvents(props, catAsset) {
  const prop = (name) => ({ asset: props, index: PROP[name], direction: "down" });
  return [
    // はじめに一度だけ：館に閉じこめられる
    event("ev_intro", "はじまり", [0, 9], [
      page({
        trigger: "autorun",
        priority: "below",
        commands: [
          gain("key_letter"),
          text("招待状に さそわれて 古い館に 来たが……"),
          shake(),
          text("ガチャン！\n背後で 玄関の扉が 閉まり、かぎが かかった！"),
          text("……閉じこめられた。\nどこかに 出る手がかりが あるはずだ。\n（まずは テーブルの 手紙を 読んでみよう）"),
          cmd("ControlSelfSwitch", { key: "A", value: true }),
        ],
      }),
      page({ conditions: [{ kind: "selfSwitch", key: "A", value: true }], priority: "below", commands: [] }),
    ]),
    event("ev_letter", "主の手紙", [6, 5], [
      page({
        commands: [
          text("テーブルの 上に 手紙が ある。"),
          text("『ようこそ、わが館へ。\nこの館から 出たければ、館の 謎を 解くがいい。\n玄関の 鍵は、わたしの 金庫の 中だ。』"),
          text("『書斎の 番人は なぞなぞ好き。\n食堂の ろうそくは 気まぐれ。\n寝室には わたしの 秘密が 眠っている。』"),
        ],
      }),
    ]),
    // 書斎の入口をふさぐ甲冑：なぞなぞに正解すると、横（上）へどく
    event("ev_armor", "甲冑の騎士", [1, 5], [
      page({
        graphic: prop("armor"),
        commands: [
          text("甲冑の 騎士が しゃべった！\n「この先は 書斎。なぞを 解かねば 通さぬ。」"),
          text("「朝は 4本足、昼は 2本足、夕は 3本足。\nこれ なーんだ？」"),
          cmd("ShowChoices", { choices: ["犬", "人間", "いす"], cancel: "disallow" }),
          cmd("ChoiceBranch", { index: 1 }),
          flash(1),
          text("「見事！ 赤子は はい、大人は 立ち、\n老いては 杖を つく。通るがよい。」", 1),
          cmd("ControlSwitches", { ids: ["sw_riddle"], value: true }, 1),
          ...advance(1, 1),
          cmd("ChoiceBranch", { index: 0 }),
          shake(1),
          text("「ちがう！ 出直して まいれ。」", 1),
          cmd("ChoiceBranch", { index: 2 }),
          shake(1),
          text("「ちがう！ 出直して まいれ。」", 1),
          endBranch(),
        ],
      }),
      page({ conditions: [{ kind: "switch", id: "sw_riddle", value: true }], through: true, priority: "below", commands: [] }),
    ]),
    event("ev_armor_aside", "どいた甲冑", [1, 4], [
      page({ through: true, priority: "below", commands: [] }),
      page({
        conditions: [{ kind: "switch", id: "sw_riddle", value: true }],
        graphic: prop("armor"),
        commands: [text("「なぞを 解いた者よ、書斎へ 進むがよい。」")],
      }),
    ]),
    doorway("ev_to_study", "書斎へ", [0, 5], ["study", 11, 5, "left"]),
    doorway("ev_to_dining", "食堂へ", [12, 5], ["dining", 1, 5, "right"]),
    // 寝室の扉：寝室の鍵を持っていれば通れる
    event("ev_bedroom_door", "寝室の扉", [6, 1], [
      page({ commands: [text("奥の 扉には かぎが かかっている。\n鍵穴に 月の 模様が ある。")] }),
      page({ conditions: [{ kind: "item", id: "key_bedroom" }], trigger: "touch", priority: "below", commands: [transfer("bedroom", 6, 8, "up")] }),
    ]),
    // 玄関の扉：大事なものから玄関の鍵を選ぶと脱出
    event("ev_front_door", "玄関の扉", [6, 9], [
      page({
        commands: [
          text("大きな 玄関の扉。\nかぎが かかっている。"),
          text("どれを 使う？"),
          cmd("SelectItem", { variable: "var_item", kind: "key" }),
          ifVar("var_item", "==", itemNumber("key_front")),
          text("玄関の鍵を 差しこんで まわすと……\nガチャリ！", 1),
          flash(1),
          text("扉が 開いた！\n外は もう 夜明けだ。", 1),
          text("\\C[6]館から 脱出した！\\C[0]\nクリア おめでとう！", 1),
          cmd("Fadeout", { duration: 40 }, 1),
          cmd("ReturnToTitle", {}, 1),
          cmd("Else", {}),
          ifVar("var_item", ">=", 1, 1),
          text("……合わない。この扉には 使えないようだ。", 2),
          endBranch(1),
          endBranch(),
        ],
      }),
    ]),
    // ネコ：進み具合に応じて次の手がかりをくれる（あとのページほど優先）
    event("ev_cat", "ネコ", [9, 7], [
      ["にゃあ。\n（甲冑の なぞなぞ……朝・昼・夕って、\n人の 一生の ことかも しれない）"],
      ["にゃあ。\n（書斎の 机に 何か 書いてあったよ。\n食堂の ろうそくと 関係が ありそう）"],
      ["にゃあ。\n（食堂の ほうで 何かが 開く 音が したよ）"],
      ["にゃあ。\n（その 月の 模様の 鍵、\nホールの 奥の 扉に 合いそう）"],
      ["にゃあ。\n（日記の 『あの 時刻』……\n食堂の 柱時計を 見てごらん）"],
      ["にゃあ！\n（金庫の 鍵で 玄関の 扉を 開けよう）"],
    ].map(([t], stage) =>
      page({
        conditions: stage === 0 ? [] : [{ kind: "variable", id: "var_stage", op: ">=", value: stage }],
        graphic: { asset: catAsset, index: 0, direction: "down" },
        commands: [text(t)],
      }),
    )),
  ];
}

function studyEvents(props) {
  const prop = (name) => ({ asset: props, index: PROP[name], direction: "down" });
  return [
    doorway("ev_to_hall", "ホールへ", [12, 5], ["hall", 1, 5, "right"]),
    event("ev_memo", "家政婦のメモ", [3, 4], [
      page({
        commands: [
          text("机の 上に メモが 置いてある。"),
          text(`『食堂の ろうそくは、\n\\C[2]${CANDLE_ORDER.map((c) => CANDLE_NAME[c]).join(" → ")}\\C[0] の 順に 灯すこと。\n順番を 間違えると、だんな様の しかけで\n全部 消えて しまいます。』`),
        ],
      }),
    ]),
    event("ev_books", "本棚", [1, 2], [page({ commands: [text("むずかしそうな 本ばかりだ。\n『からくり 仕掛け 大全』という 本も ある。")] })]),
    event("ev_safe", "金庫", [10, 3], [
      page({
        graphic: prop("safe"),
        commands: [
          text("どっしりとした 金庫だ。\n4けたの 番号を 合わせる ダイヤルが ある。"),
          cmd("InputNumber", { variable: "var_code", digits: 4 }),
          ifVar("var_code", "==", SAFE_CODE),
          flash(1),
          text("カチャリ！ 金庫が 開いた。", 1),
          gain("key_front", 1),
          text("\\C[6]玄関の鍵\\C[0]を 手に入れた！", 1),
          ...advance(5, 1),
          cmd("ControlSelfSwitch", { key: "A", value: true }, 1),
          cmd("Else", {}),
          text("……開かない。番号が ちがうようだ。", 1),
          endBranch(),
        ],
      }),
      page({ conditions: [{ kind: "selfSwitch", key: "A", value: true }], graphic: prop("safe_open"), commands: [text("金庫は 空っぽだ。")] }),
    ]),
  ];
}

/** 食堂のろうそくの位置。 */
const CANDLE_AT = { blue: [3, 3], white: [9, 3], red: [3, 7], green: [9, 7] };

function diningEvents(props) {
  const prop = (name) => ({ asset: props, index: PROP[name], direction: "down" });
  const candles = CANDLE_ORDER.map((color, i) => {
    const order = i + 1;
    const name = CANDLE_NAME[color];
    const adj = CANDLE_ADJ[color];
    const lightIt =
      order === CANDLE_ORDER.length
        ? [flash(1), text(`${adj} ろうそくに 火を ともした。`, 1), text("4本の 炎が そろった……！\nカチリ。どこかで 何かが 開く 音が した。", 1), cmd("ControlSwitches", { ids: ["sw_candles"], value: true }, 1), ...advance(2, 1)]
        : [text(`${adj} ろうそくに 火を ともした。`, 1)];
    return event(`ev_candle_${color}`, `${name}のろうそく`, CANDLE_AT[color], [
      page({
        graphic: prop(`candle_${color}`),
        commands: [
          ifVar("var_candle", "==", order - 1),
          setVar("var_candle", order, 1),
          ...lightIt,
          cmd("Else", {}),
          setVar("var_candle", 0, 1),
          shake(1),
          text(`${adj} ろうそくに 火を ともすと……\nふっ！ すべての 炎が 消えてしまった。\n（順番が ちがうようだ）`, 1),
          endBranch(),
        ],
      }),
      page({ conditions: [{ kind: "variable", id: "var_candle", op: ">=", value: order }], graphic: prop(`candle_${color}_lit`), commands: [text("炎が ゆらめいている。")] }),
    ]);
  });
  return [
    doorway("ev_to_hall", "ホールへ", [0, 5], ["hall", 11, 5, "left"]),
    event("ev_clock", "柱時計", [1, 2], [page({ commands: [text(`大きな 柱時計。\n針は \\C[2]${CLOCK_TIME}\\C[0] を 指したまま 止まっている。`)] })]),
    ...candles,
    event("ev_cupboard", "食器棚", [11, 2], [
      page({ graphic: prop("cupboard"), commands: [text("食器棚。\nかぎが かかっていて 開かない。")] }),
      page({
        conditions: [{ kind: "switch", id: "sw_candles", value: true }],
        graphic: prop("cupboard_open"),
        commands: [text("食器棚の 扉が 開いている。\n奥に 小さな 鍵が……"), gain("key_bedroom"), text("\\C[6]寝室の鍵\\C[0]を 手に入れた！"), ...advance(3), cmd("ControlSelfSwitch", { key: "A", value: true })],
      }),
      page({ conditions: [{ kind: "selfSwitch", key: "A", value: true }], graphic: prop("cupboard_open"), commands: [text("お皿が 並んでいる。")] }),
    ]),
  ];
}

function bedroomEvents() {
  return [
    doorway("ev_to_hall", "ホールへ", [6, 9], ["hall", 6, 2, "down"]),
    event("ev_diary", "主の日記", [2, 2], [
      page({
        commands: [
          text("小机の 上に 日記が ある。"),
          text("『妻が 最後に 時計を 見て、\n「もう こんな 時間」と 笑った あの夜……\nあの 柱時計は、それきり 止まった ままだ。』"),
          text("『わたしは 金庫の 番号を、\n\\C[2]あの 時刻\\C[0]に した。\n時と 分を 並べた 4けたの 数だ。』"),
          ...advance(4),
        ],
      }),
    ]),
    event("ev_mirror", "姿見", [11, 2], [page({ commands: [text("姿見に 自分の 顔が うつっている。\n……少し 疲れた 顔だ。")] })]),
    event("ev_wardrobe", "衣装だんす", [10, 2], [page({ commands: [text("古い ドレスが しまってある。\nほのかに 花の 香りが する。")] })]),
  ];
}

// ── 書き出し ──────────────────────────────────────────────────────────
const toJson = (value) => `${JSON.stringify(value, null, 2).replace(/\[\s+([-\d.,\s]+?)\s+\]/g, (_, body) => `[${body.split(/,\s*/).join(", ")}]`)}\n`;

rmSync(ROOT, { recursive: true, force: true });
const catBytes = readFileSync(CAT_PNG);
const assets = writeAssets(join(ROOT, "assets"), {
  "mansion_tileset.png": tileset(),
  "hero.png": character(HERO),
  "props.png": sheet(4, PROPS.map(([, img]) => img)),
  "cat.png": { bytes: catBytes, ext: "png", info: "ネコ（はじまりの村のネコと同じ）", width: catBytes.readUInt32BE(16), height: catBytes.readUInt32BE(20) },
});

const ROOM_EVENTS = {
  hall: () => hallEvents(assets["props.png"].id, assets["cat.png"].id),
  study: () => studyEvents(assets["props.png"].id),
  dining: () => diningEvents(assets["props.png"].id),
  bedroom: () => bedroomEvents(),
};
const ROOM_NAMES = { hall: "玄関ホール", study: "書斎", dining: "食堂", bedroom: "寝室" };
mkdirSync(join(ROOT, "maps"), { recursive: true });
const mapsMeta = {};
Object.entries(ROOMS).forEach(([room, id], order) => {
  const events = Object.fromEntries(ROOM_EVENTS[room]().map((e) => [e.id, e]));
  writeFileSync(join(ROOT, "maps", `${id}.json`), toJson({ id, width: W, height: H, tileset: "ts_mansion", layers: buildLayers(room), events }));
  mapsMeta[id] = { id, name: ROOM_NAMES[room], order };
});

const entry = (name, a) => ({ name, kind: "image", mime: "image/png", size: a.size, width: a.width ?? catBytes.readUInt32BE(16), height: a.height ?? catBytes.readUInt32BE(20) });
const params = Object.fromEntries(["mhp", "mmp", "atk", "def", "mat", "mdf", "agi", "luk"].map((p) => [p, { base: p === "mhp" ? 100 : p === "mmp" ? 20 : 10, growth: 2 }]));
const project = {
  formatVersion: 1,
  meta: { id: "mansion", title: "デモ：謎解きの館", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" },
  system: {
    startMap: ROOMS.hall,
    startX: START.x,
    startY: START.y,
    initialParty: ["actor_hero"],
    tileSize: TILE,
    screen: { width: W * TILE, height: H * TILE },
    bgm: {},
    terms: { newGame: "ニューゲーム" },
  },
  maps: mapsMeta,
  tilesets: { ts_mansion: { id: "ts_mansion", name: "館", image: { asset: assets["mansion_tileset.png"].id }, passage: PASSAGE } },
  database: {
    actors: { actor_hero: { id: "actor_hero", name: "旅人", classId: "class_hero", initialLevel: 1, walk: { asset: assets["hero.png"].id }, equips: {} } },
    classes: { class_hero: { id: "class_hero", name: "旅人", skills: [], params } },
    skills: {},
    items: Object.fromEntries(Object.entries(ITEMS).map(([id, name]) => [id, { id, name, kind: "key", price: 0, effects: [], description: ITEM_NOTES[id] }])),
    enemies: {},
    troops: {},
    states: {},
    commonEvents: {},
  },
  assets: { entries: Object.fromEntries(Object.entries(assets).map(([name, a]) => [a.id, entry(name, a)])) },
  switches: { sw_riddle: { name: "なぞなぞに正解した" }, sw_candles: { name: "ろうそくがそろった" } },
  variables: {
    var_stage: { name: "進み具合（ネコの手がかり）" },
    var_candle: { name: "灯したろうそくの数" },
    var_code: { name: "金庫に入れた番号" },
    var_item: { name: "玄関で選んだ鍵（アイテム番号）" },
  },
};
writeFileSync(join(ROOT, "project.json"), toJson(project));
