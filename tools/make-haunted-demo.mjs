#!/usr/bin/env node
/**
 * おばけ屋敷の追いかけっこのデモ（fixtures/projects/v1/haunted）を丸ごと生成する開発用スクリプト。
 * 出力: project.json、maps/<MapId>.json、assets/<AssetId>.<ext>（AssetId = 内容の sha256 先頭 16 桁）。
 * 生成物はコミット済み。階の作りやおばけの動きを変えたいときだけ再実行する（何度実行しても同じものができる）。
 *
 *   node tools/make-haunted-demo.mjs
 *
 * 屋敷を歩き回るおばけを避けながら、階ごとのろうそくを全部集める。おばけに捕まると、その階の入口へ戻される。戦闘は無い。
 * 絵（館のタイルセット・おばけ）は「おばけ屋敷の鬼ごっこ」（make-ghost-demo.mjs）と同じ描き方。見せたいエンジンの機能：
 * 1. おばけはページの moveRoute（自律移動）で動く。`toward`（近づく）・`away`（離れる）・`random`・決まった向き、`speed` で速さ。
 *    行き止まりで進めない歩みは飛ばす（skippable）。見回りのおばけだけは、飛ばさずに決まった往復を続ける。
 * 2. おばけのページのトリガは「イベントから接触」（eventTouch）。おばけの方からプレイヤーに触れてきたとき（プレイヤーから触れたときも）に
 *    始まり、捕まえた演出のあと、その階の入口へ TransferPlayer する。同じマップへの場所移動なので、おばけも元の位置からやり直す。
 * 3. 「かげろう」は通り抜け（through）のおばけ。壁を抜けて、ゆっくり近づいてくる。
 * 4. 暗い色調：マップごとの並列イベントが TintScreen をかけ続ける（ロードしたあとも 1 秒以内に戻る）。全部の階を終えると玄関ホールが明るくなる。
 * ろうそくは「下」プライオリティの接触イベント（上に乗ると拾う。セルフスイッチ A で消える）。拾った数は階ごとの変数で数え、
 * その階の分がそろうと玄関ホールへ戻り、次の階の扉が開く（変数が○以上）。3 つの階を終えるとエンディング。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blit, canvas, character, HERO, image, lcg, shade, sheet, TILE, writeAssets } from "./pixel-art.mjs";
import { addVar, cmd, endBranch, entry, event, flash, hidden, ifVar, otherwise, page, params, setVar, text, toJson, weatherEvent } from "./demo-lib.mjs";

const ROOT = join(import.meta.dirname, "..", "fixtures", "projects", "v1", "haunted");

/** 画面は 13×10 タイル。階はそれより広く、スクロールする。 */
const SCREEN_W = 13;
const SCREEN_H = 10;
const HALL = "map_hall";
const HALL_START = { x: 6, y: 7 };

// ── おばけの種類 ──────────────────────────────────────────────────────
const toward = { kind: "move", dir: "toward" };
const away = { kind: "move", dir: "away" };
const rand = { kind: "move", dir: "random" };
const wait = (frames) => ({ kind: "wait", frames });
const speed = (value) => ({ kind: "speed", value });
const go = (dir, n) => Array.from({ length: n }, () => ({ kind: "move", dir }));

/** 見た目（おばけの絵の色。`alpha` は半透明）。 */
const LOOKS = {
  white: { index: 0, body: [244, 246, 255] },
  blue: { index: 1, body: [150, 200, 250] },
  pink: { index: 2, body: [250, 190, 214] },
  red: { index: 3, body: [250, 150, 140] },
  violet: { index: 4, body: [206, 186, 255], alpha: 0.74 },
};
const BUTLER_INDEX = 5;
/**
 * おばけの種類。プレイヤーの速さは 4（1 タイル 16 フレーム）。速さ 3 は 32 フレーム、2 は 64 フレーム、5 は 8 フレーム。
 * `route` は繰り返す（repeat）。`skippable` は、壁に当たって進めない歩みを飛ばして次へ進む。
 */
const KINDS = {
  /** 近づいてくる。ときどき迷う。 */
  chaser: { look: "blue", names: ["あおすけ", "しずく", "そらまめ"], route: { skippable: true, steps: [speed(3), toward, toward, toward, rand] } },
  /** うろうろ歩き、たまに近づく。 */
  wanderer: { look: "white", names: ["しろまる", "ふわり"], route: { skippable: true, steps: [speed(3), rand, rand, toward, wait(20)] } },
  /** 廊下を左右に見回る（決まった往復。飛ばさない）。`span` は往復の歩数。 */
  patrol: { look: "pink", names: ["ももこ", "さくら"], route: (span) => ({ skippable: false, steps: [speed(4), ...go("right", span), wait(10), ...go("left", span), wait(10)] }) },
  /** 壁を通り抜けて、ゆっくり近づいてくる。 */
  phantom: { look: "violet", names: ["かげろう"], through: true, route: { skippable: true, steps: [speed(2), toward, wait(12)] } },
  /** すばやく近づいては、さっと離れる。 */
  prankster: { look: "red", names: ["ほむら", "こてつ"], route: { skippable: true, steps: [speed(5), toward, toward, toward, speed(3), away, away, wait(40)] } },
};

// ── キャラクター（おばけ。1 体 = 3 パターン × 4 方向）──────────────────────────
function ghost(kind) {
  const B = LOOKS[kind].body;
  const S = shade(B, -42);
  const OUT = [38, 40, 76];
  const out = image(TILE * 3, TILE * 4);
  ["down", "left", "right", "up"].forEach((dir, row) => {
    for (let p = 0; p < 3; p++) {
      const c = canvas(TILE, TILE);
      const dy = p === 1 ? -1 : 0;
      c.ellipse(16, 29, 9, 2, [0, 0, 0, 56]);
      const body = canvas(TILE, TILE);
      body.ellipse(16, 13 + dy, 9, 9, B);
      // すそ：ゆらゆらした波（パターンごとに位相をずらす）
      for (let x = 7; x <= 25; x++) {
        const bottom = 25 + dy + Math.round(Math.sin(x * 0.95 + p * 2.1) * 1.8);
        for (let y = 13 + dy; y <= bottom; y++) body.set(x, y, B);
      }
      // 腕：パターンで上げ下げ
      const lift = [0, -2, 1][p];
      body.ellipse(6, 18 + dy + lift, 2, 3, B);
      body.ellipse(26, 18 + dy - lift, 2, 3, B);
      // 頭のてっぺんの毛先
      body.rect(15, 3 + dy, 2, 3, B);
      body.set(16, 2 + dy, B);
      // 右がわを少し暗く
      for (let y = 0; y < TILE; y++) for (let x = 22; x < TILE; x++) if (body.get(x, y)[3] === 255) body.set(x, y, S);
      // ふち取り
      const edge = canvas(TILE, TILE);
      for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
        if (body.get(x, y)[3] === 255) continue;
        if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([i, j]) => body.get(x + i, y + j)[3] === 255)) edge.set(x, y, OUT);
      }
      blit(c, edge, 0, 0);
      blit(c, body, 0, 0);
      // 顔
      const eye = (x, y) => {
        c.rect(x, y + dy, 2, 3, [24, 24, 44]);
        c.set(x, y + dy, [255, 255, 255]);
      };
      if (dir === "down") {
        eye(11, 12);
        eye(19, 12);
        c.rect(15, 18 + dy, 3, 2, [150, 50, 70]);
        c.set(9, 17 + dy, [250, 160, 170]);
        c.set(23, 17 + dy, [250, 160, 170]);
      } else if (dir === "left") {
        eye(8, 12);
        eye(14, 12);
        c.rect(10, 18 + dy, 3, 2, [150, 50, 70]);
      } else if (dir === "right") {
        eye(16, 12);
        eye(22, 12);
        c.rect(19, 18 + dy, 3, 2, [150, 50, 70]);
      }
      // 種類ごとの飾り
      if (kind === "pink") {
        for (const [x, y] of [[21, 6], [26, 6]]) c.ellipse(x, y + dy, 2, 2, [230, 70, 120]);
        c.rect(23, 5 + dy, 2, 3, [255, 220, 90]);
      } else if (kind === "blue") {
        c.rect(7, 8 + dy, 18, 3, [40, 80, 160]);
        c.rect(24, 8 + dy, 3, 5, [40, 80, 160]);
      } else if (kind === "red") {
        for (const x of [9, 21]) {
          c.rect(x, 3 + dy, 3, 3, [250, 232, 200]);
          c.rect(x + (x < 16 ? 0 : 1), 1 + dy, 2, 2, [250, 232, 200]);
        }
      }
      // 壁抜けのおばけは半透明
      if (LOOKS[kind].alpha !== undefined) for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
        const px = c.get(x, y);
        if (px[3] > 0) c.set(x, y, [px[0], px[1], px[2], Math.round(px[3] * LOOKS[kind].alpha)]);
      }
      blit(out, c, p * TILE, row * TILE);
    }
  });
  return out;
}

// ── タイルセット ──────────────────────────────────────────────────────
const T = {
  floorWood: 1, floorCarpet: 2, floorStone: 3, rug: 4, wallTop: 5,
  wallA: 6, wallB: 7, wallC: 8,
  windowA: 9, windowB: 10, windowC: 11,
  sconceA: 12, sconceB: 13, sconceC: 14,
  door1: 15, door2: 16, door3: 17,
  table: 18, sofa: 19, plant: 20, clock: 21, shelf: 22, crate: 23, barrel: 24, coffin: 25, cauldron: 26, pumpkin: 27, pillar: 28, board: 29,
  exitA: 30, exitB: 31, exitC: 32,
};
const CELLS = 33;
/** 通れるのは床だけ。壁・家具・柱は通れない。 */
const PASSABLE = new Set([0, T.floorWood, T.floorCarpet, T.floorStone, T.rug]);
const PASSAGE = Array.from({ length: CELLS }, (_, id) => (PASSABLE.has(id) ? 15 : 0));

const WOOD = [104, 74, 56];
const GOLD = [222, 184, 84];
/** 壁の色（A: 青緑の壁紙 / B: 紫の壁紙 / C: 石のレンガ）。 */
const WALL = { A: [50, 88, 98], B: [96, 54, 88], C: [86, 88, 104] };

const DIGITS = { 1: ["010", "110", "010", "010", "111"], 2: ["111", "001", "111", "100", "111"], 3: ["111", "001", "111", "001", "111"] };

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

  /** 壁（A・B は縦じまの壁紙、C は石のレンガ）と腰板。 */
  const wall = (c, theme) => {
    const base = WALL[theme];
    c.rect(0, 0, TILE, TILE, base);
    if (theme === "C") {
      for (let y = 0; y < 22; y += 8) {
        c.rect(0, y, TILE, 1, shade(base, -34));
        const off = (y / 8) % 2 === 0 ? 0 : 8;
        for (let x = off; x < TILE; x += 16) c.rect(x, y, 1, 8, shade(base, -34));
        c.rect(0, y + 1, TILE, 1, shade(base, 14));
      }
    } else {
      for (const x of [3, 19]) c.rect(x, 0, 2, 22, shade(base, 16));
      for (let y = 3; y < 22; y += 7) for (const x of [11, 27]) c.set(x, y, shade(base, 44));
    }
    c.rect(0, 22, TILE, 10, shade(WOOD, -34));
    c.rect(0, 22, TILE, 2, shade(WOOD, 8));
    for (const x of [0, 16]) c.rect(x, 24, 1, 8, shade(WOOD, -58));
    c.rect(0, TILE - 2, TILE, 2, shade(WOOD, -66));
  };

  // 床：木の板 / じゅうたん / 石のタイル
  {
    const c = cell(T.floorWood, { wrap: true });
    c.rect(0, 0, TILE, TILE, WOOD);
    const rnd = lcg(1);
    for (let y = 0; y < TILE; y += 8) {
      c.rect(0, y, TILE, 1, shade(WOOD, -34));
      c.rect(Math.floor(rnd() * TILE), y + 1, 1, 7, shade(WOOD, -28));
      for (let i = 0; i < 6; i++) c.set(rnd() * TILE, y + 2 + rnd() * 5, shade(WOOD, rnd() < 0.5 ? 10 : -14));
    }
  }
  {
    const c = cell(T.floorCarpet, { wrap: true });
    const base = [74, 48, 86];
    c.rect(0, 0, TILE, TILE, base);
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const d = Math.abs(((x + 8) % 16) - 8) + Math.abs(((y + 8) % 16) - 8);
      if (d === 8) c.set(x, y, shade(base, 36));
      else if (d === 3) c.set(x, y, shade(base, 16));
    }
  }
  {
    const c = cell(T.floorStone, { wrap: true });
    const base = [74, 80, 96];
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) c.rect(i * 16, j * 16, 16, 16, (i + j) % 2 === 0 ? base : shade(base, -12));
    c.rect(0, 0, TILE, 1, shade(base, -30));
    c.rect(0, 16, TILE, 1, shade(base, -30));
    c.rect(0, 0, 1, TILE, shade(base, -30));
    c.rect(16, 0, 1, TILE, shade(base, -30));
    const rnd = lcg(5);
    for (let i = 0; i < 10; i++) c.set(rnd() * TILE, rnd() * TILE, shade(base, rnd() < 0.5 ? 12 : -22));
    for (const [x, y] of [[6, 5], [7, 6], [8, 6], [9, 7]]) c.set(x, y, shade(base, -36));
  }
  // 玄関ホールのじゅうたん：青緑に金のふち
  {
    const c = cell(T.rug, { wrap: true });
    const base = [40, 92, 100];
    c.rect(0, 0, TILE, TILE, base);
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const d = Math.abs(x - 15.5) + Math.abs(y - 15.5);
      if (Math.round(d) === 12 || Math.round(d) === 5) c.set(x, y, GOLD);
      else if (Math.round(d) === 8) c.set(x, y, shade(base, -26));
    }
  }
  // 壁の上
  {
    const c = cell(T.wallTop, { wrap: true });
    c.rect(0, 0, TILE, TILE, [34, 32, 48]);
    const rnd = lcg(3);
    for (let i = 0; i < 30; i++) c.set(rnd() * TILE, rnd() * TILE, [46, 44, 62]);
  }
  for (const theme of ["A", "B", "C"]) wall(cell(T[`wall${theme}`]), theme);
  // 窓：月夜（A・B はカーテン付き、C は鉄格子）
  for (const theme of ["A", "B"]) {
    const c = cell(T[`window${theme}`]);
    wall(c, theme);
    c.rect(7, 3, 18, 19, [54, 44, 36]);
    c.rect(9, 5, 14, 15, [22, 30, 76]);
    c.disc(19, 9, 3, [250, 240, 190]);
    c.disc(20, 8, 2, [22, 30, 76]);
    for (const [x, y] of [[11, 7], [14, 15], [21, 16]]) c.set(x, y, [255, 255, 230]);
    c.rect(15, 5, 2, 15, [54, 44, 36]);
    const curtain = theme === "A" ? [150, 60, 70] : [60, 90, 150];
    c.rect(4, 2, 4, 21, curtain);
    c.rect(24, 2, 4, 21, curtain);
    c.rect(3, 1, 26, 2, GOLD);
  }
  {
    const c = cell(T.windowC);
    wall(c, "C");
    c.rect(8, 4, 16, 14, [18, 20, 40]);
    c.rect(10, 6, 12, 10, [24, 34, 84]);
    c.disc(18, 10, 2, [240, 236, 190]);
    for (const x of [12, 16, 20]) c.rect(x, 4, 2, 14, [120, 120, 134]);
    c.rect(8, 10, 16, 2, [120, 120, 134]);
  }
  // 燭台（青白い鬼火）
  for (const theme of ["A", "B", "C"]) {
    const c = cell(T[`sconce${theme}`]);
    wall(c, theme);
    c.glow(16, 10, 11, [140, 240, 230], 0.16);
    c.glow(16, 9, 7, [170, 250, 240], 0.2);
    c.rect(12, 14, 9, 2, GOLD);
    c.rect(15, 16, 3, 4, GOLD);
    c.rect(14, 9, 5, 5, [236, 240, 244]);
    c.disc(16, 6, 2, [110, 230, 220]);
    c.set(16, 5, [230, 255, 250]);
  }
  // 扉 1・2・3（玄関ホールの奥の壁。数字の札つき）
  [1, 2, 3].forEach((n) => {
    const c = cell(T[`door${n}`]);
    wall(c, "A");
    c.rect(5, 12, 22, 20, [62, 40, 26]);
    c.rect(7, 14, 18, 18, [112, 72, 40]);
    c.rect(7, 14, 18, 1, [150, 104, 62]);
    c.rect(9, 17, 6, 12, [96, 60, 32]);
    c.rect(17, 17, 6, 12, [96, 60, 32]);
    c.disc(22, 24, 1, GOLD);
    c.rect(9, 1, 14, 12, GOLD);
    c.rect(10, 2, 12, 10, [60, 40, 20]);
    DIGITS[n].forEach((row, j) => [...row].forEach((bit, i) => {
      if (bit === "1") c.rect(13 + i * 2, 2 + j * 2, 2, 2, GOLD);
    }));
  });
  // 階の入口の扉（玄関ホールへもどる。札は上向きの矢印）
  for (const theme of ["A", "B", "C"]) {
    const c = cell(T[`exit${theme}`]);
    wall(c, theme);
    c.rect(5, 12, 22, 20, [62, 40, 26]);
    c.rect(7, 14, 18, 18, [112, 72, 40]);
    c.rect(7, 14, 18, 1, [150, 104, 62]);
    c.rect(9, 17, 6, 12, [96, 60, 32]);
    c.rect(17, 17, 6, 12, [96, 60, 32]);
    c.disc(22, 24, 1, GOLD);
    c.rect(10, 2, 12, 9, GOLD);
    c.rect(11, 3, 10, 7, [60, 40, 20]);
    for (let j = 0; j < 3; j++) c.rect(16 - j, 4 + j, 1 + j * 2, 1, GOLD);
    c.rect(15, 7, 3, 2, GOLD);
  }
  // 家具
  {
    const c = cell(T.table);
    c.ellipse(16, 29, 12, 2, [0, 0, 0, 70]);
    c.rect(14, 16, 4, 12, [88, 56, 32]);
    c.rect(9, 27, 14, 2, [88, 56, 32]);
    c.ellipse(16, 14, 13, 8, [96, 62, 36]);
    c.ellipse(16, 13, 12, 7, [136, 92, 52]);
    c.rect(13, 6, 6, 5, [236, 240, 244]);
    c.disc(16, 5, 2, [110, 230, 220]);
  }
  {
    const c = cell(T.sofa);
    c.ellipse(16, 29, 13, 2, [0, 0, 0, 70]);
    const cloth = [150, 56, 70];
    c.rect(3, 6, 26, 12, shade(cloth, -26));
    c.rect(3, 6, 26, 2, shade(cloth, 10));
    c.rect(1, 12, 6, 15, cloth);
    c.rect(25, 12, 6, 15, cloth);
    c.rect(7, 16, 18, 11, shade(cloth, 22));
    c.rect(7, 16, 18, 2, shade(cloth, 44));
    c.rect(3, 27, 3, 3, [60, 40, 28]);
    c.rect(26, 27, 3, 3, [60, 40, 28]);
  }
  {
    const c = cell(T.plant);
    c.ellipse(16, 29, 9, 2, [0, 0, 0, 70]);
    c.rect(10, 20, 12, 9, [66, 62, 80]);
    c.rect(9, 19, 14, 2, [96, 92, 112]);
    for (const [x, y, r] of [[16, 10, 6], [11, 14, 4], [21, 14, 4], [16, 5, 3]]) c.disc(x, y, r, [48, 112, 70]);
    for (const [x, y] of [[14, 8], [18, 11], [11, 13], [21, 13]]) c.set(x, y, [110, 180, 110]);
  }
  {
    const c = cell(T.clock);
    c.ellipse(16, 30, 9, 2, [0, 0, 0, 80]);
    c.rect(8, 0, 16, 30, [84, 52, 30]);
    c.rect(8, 0, 16, 2, [116, 78, 44]);
    c.disc(16, 8, 6, GOLD);
    c.disc(16, 8, 5, [236, 236, 224]);
    c.rect(16, 4, 1, 5, [30, 30, 30]);
    c.rect(16, 8, 3, 1, [30, 30, 30]);
    c.rect(12, 16, 8, 12, [36, 24, 16]);
    c.rect(15, 16, 2, 8, GOLD);
    c.disc(16, 24, 2, GOLD);
  }
  {
    const c = cell(T.shelf);
    c.rect(1, 1, 30, 30, [86, 56, 34]);
    c.rect(3, 3, 26, 26, [44, 30, 22]);
    for (const y of [10, 19, 28]) c.rect(3, y, 26, 2, [120, 80, 46]);
    const colors = [[150, 40, 60], [40, 90, 140], [60, 120, 80], [140, 110, 40], [100, 60, 130], [220, 214, 196]];
    const rnd = lcg(10);
    for (const y of [3, 12, 21]) for (let x = 4; x < 28; ) {
      const w = 2 + Math.floor(rnd() * 2);
      const h = 5 + Math.floor(rnd() * 3);
      c.rect(x, y + 7 - h, w, h, colors[Math.floor(rnd() * colors.length)]);
      x += w + (rnd() < 0.2 ? 1 : 0);
    }
  }
  {
    const c = cell(T.crate);
    c.ellipse(16, 29, 13, 2, [0, 0, 0, 70]);
    c.rect(3, 6, 26, 23, [130, 90, 50]);
    c.rect(3, 6, 26, 2, [166, 122, 72]);
    c.rect(3, 6, 3, 23, [96, 62, 34]);
    c.rect(26, 6, 3, 23, [96, 62, 34]);
    for (let i = 0; i < 18; i++) {
      c.set(8 + i, 9 + i, [96, 62, 34]);
      c.set(9 + i, 9 + i, [96, 62, 34]);
      c.set(23 - i, 9 + i, [96, 62, 34]);
      c.set(22 - i, 9 + i, [96, 62, 34]);
    }
  }
  {
    const c = cell(T.barrel);
    c.ellipse(16, 29, 11, 2, [0, 0, 0, 70]);
    c.ellipse(16, 17, 11, 12, [118, 76, 40]);
    c.ellipse(16, 17, 8, 12, [142, 98, 54]);
    for (const y of [8, 24]) c.rect(5, y, 22, 2, [70, 74, 86]);
    c.ellipse(16, 6, 9, 3, [100, 64, 34]);
    c.ellipse(16, 6, 7, 2, [60, 40, 26]);
  }
  {
    const c = cell(T.coffin);
    c.ellipse(16, 29, 10, 2, [0, 0, 0, 80]);
    const wood = [70, 46, 38];
    c.rect(9, 8, 14, 20, wood);
    c.rect(11, 4, 10, 6, wood);
    c.rect(11, 4, 10, 1, shade(wood, 30));
    c.rect(9, 8, 2, 20, shade(wood, 22));
    c.rect(11, 12, 10, 14, shade(wood, -14));
    c.rect(15, 11, 2, 12, [210, 200, 170]);
    c.rect(12, 14, 8, 2, [210, 200, 170]);
  }
  {
    const c = cell(T.cauldron);
    c.ellipse(16, 29, 12, 2, [0, 0, 0, 80]);
    c.rect(6, 27, 3, 3, [30, 30, 36]);
    c.rect(23, 27, 3, 3, [30, 30, 36]);
    c.ellipse(16, 20, 12, 9, [34, 34, 44]);
    c.ellipse(16, 20, 9, 7, [50, 52, 66]);
    c.ellipse(16, 12, 11, 4, [30, 30, 40]);
    c.ellipse(16, 12, 9, 3, [90, 220, 120]);
    for (const [x, y] of [[12, 9], [18, 8], [21, 10]]) c.disc(x, y, 1, [170, 250, 180]);
    c.glow(16, 8, 9, [120, 240, 140], 0.0);
  }
  {
    const c = cell(T.pumpkin);
    c.ellipse(16, 29, 11, 2, [0, 0, 0, 70]);
    c.ellipse(16, 19, 12, 10, [214, 110, 30]);
    c.ellipse(10, 19, 7, 10, [232, 130, 40]);
    c.ellipse(22, 19, 7, 10, [232, 130, 40]);
    c.ellipse(16, 19, 4, 10, [244, 148, 52]);
    c.rect(14, 6, 4, 5, [70, 110, 50]);
    c.rect(18, 7, 3, 2, [70, 110, 50]);
    const glowY = [255, 232, 110];
    for (const [x, y] of [[10, 15], [20, 15]]) {
      c.rect(x, y, 3, 3, glowY);
    }
    c.rect(11, 21, 10, 2, glowY);
    for (const x of [12, 16, 19]) c.rect(x, 21, 1, 3, glowY);
  }
  {
    const c = cell(T.pillar);
    c.ellipse(16, 29, 10, 2, [0, 0, 0, 80]);
    const st = [150, 152, 168];
    c.rect(9, 2, 14, 26, st);
    c.rect(9, 2, 3, 26, shade(st, 26));
    c.rect(20, 2, 3, 26, shade(st, -34));
    c.rect(7, 0, 18, 4, shade(st, 10));
    c.rect(7, 26, 18, 4, shade(st, -10));
  }
  {
    const c = cell(T.board);
    c.ellipse(16, 29, 12, 2, [0, 0, 0, 70]);
    c.rect(5, 4, 22, 17, [96, 62, 34]);
    c.rect(7, 6, 18, 13, [200, 168, 112]);
    c.rect(9, 8, 6, 7, [244, 238, 220]);
    c.rect(17, 8, 6, 5, [244, 238, 220]);
    c.rect(10, 10, 4, 1, [120, 110, 100]);
    c.rect(10, 12, 4, 1, [120, 110, 100]);
    c.rect(18, 10, 4, 1, [120, 110, 100]);
    c.disc(12, 8, 1, [220, 60, 60]);
    c.rect(14, 21, 4, 8, [88, 56, 32]);
  }
  return img;
}

// ── 小道具（イベントの絵）──────────────────────────────────────────────
const still = (draw) => {
  const one = canvas(TILE, TILE);
  draw(one);
  const out = image(TILE * 3, TILE * 4);
  for (let row = 0; row < 4; row++) for (let p = 0; p < 3; p++) blit(out, one, p * TILE, row * TILE);
  return out;
};
const FLAME = [255, 170, 60];
/** 炎（(x, y) が根もと）。 */
const flame = (d, x, y) => {
  d.disc(x, y - 4, 7, [255, 210, 120, 46]);
  d.disc(x, y - 3, 2, FLAME);
  d.rect(x, y - 7, 1, 3, [255, 214, 100]);
  d.set(x, y - 3, [255, 250, 210]);
};
/** 拾うろうそく（皿にのった、灯った白いろうそく）。 */
const candle = () =>
  still((d) => {
    d.disc(16, 16, 13, [255, 220, 140, 34]);
    d.ellipse(16, 28, 9, 2, [0, 0, 0, 80]);
    d.ellipse(16, 26, 9, 3, [176, 146, 62]);
    d.ellipse(16, 25, 7, 2, [214, 182, 86]);
    d.rect(13, 13, 7, 12, [244, 240, 228]);
    d.rect(13, 13, 2, 12, [255, 255, 250]);
    d.rect(19, 13, 1, 12, [200, 196, 184]);
    d.rect(14, 12, 5, 2, [250, 248, 236]);
    d.rect(16, 10, 1, 3, [60, 50, 40]);
    flame(d, 16, 10);
  });
/** 玄関ホールの大燭台。`lit` 本（0〜3）の腕が灯る。 */
const candelabrum = (lit) =>
  still((d) => {
    if (lit > 0) d.disc(16, 9, 9 + lit * 2, [255, 210, 120, 22 + lit * 10]);
    d.ellipse(16, 30, 9, 2, [0, 0, 0, 90]);
    d.rect(10, 27, 13, 3, GOLD);
    d.rect(14, 14, 5, 14, GOLD);
    d.rect(14, 14, 2, 14, shade(GOLD, 30));
    d.rect(5, 15, 23, 2, GOLD);
    for (const x of [5, 16, 26]) {
      d.rect(x - 2, 10, 5, 2, shade(GOLD, -20));
      d.rect(x - 1, 5, 3, 5, [244, 240, 228]);
      d.rect(x, 3, 1, 2, [60, 50, 40]);
    }
    d.rect(5, 12, 2, 4, GOLD);
    d.rect(26, 12, 2, 4, GOLD);
    [16, 5, 26].slice(0, lit).forEach((x) => flame(d, x, 4));
  });
const PROPS = { candle: 0, candelabrum: 1 };


// ── 間取り ────────────────────────────────────────────────────────────
const THEMES = {
  living: { floor: T.floorWood, wall: "A" },
  gallery: { floor: T.floorCarpet, wall: "B" },
  cellar: { floor: T.floorStone, wall: "C" },
};
const FURNITURE = { t: T.table, S: T.sofa, p: T.plant, K: T.clock, B: T.shelf, c: T.crate, b: T.barrel, k: T.coffin, C: T.cauldron, u: T.pumpkin, P: T.pillar };

/**
 * 階。文字の意味：`#` 壁（下が床なら壁の正面で描く）、`w` 窓、`s` 燭台、`E` 入口の扉（玄関ホールへ）、`.` 床、家具は FURNITURE、
 * `@` 入口（スタート。捕まるとここへ戻る）、`*` ろうそく、それ以外の記号はおばけ（`ghosts` の対応。読む順に番号がつく）。
 * `patrol` の往復の歩数は `span`。
 */
const FLOORS = [
  {
    n: 1, id: "map_floor1", name: "客間", theme: "living",
    ghosts: { "%": "chaser", "&": "wanderer" },
    plan: [
      "#################",
      "#w#s#w##E##w#s#w#",
      "#.......@.......#",
      "#.t.*.......*.p.#",
      "#.....#####.....#",
      "#..%..#####..%..#",
      "#.....##s##.....#",
      "#.S...........B.#",
      "####.#######.####",
      "#*......&......*#",
      "#..c...u.u...c..#",
      "#################",
    ],
  },
  {
    n: 2, id: "map_floor2", name: "回廊", theme: "gallery", span: 16,
    ghosts: { "^": "patrol", $: "phantom", "%": "chaser" },
    plan: [
      "#####################",
      "#w#s#w#s##E##s#w#s#w#",
      "#.........@.........#",
      "#.^.................#",
      "###.####.###.####.###",
      "#*..#....#.#....#..*#",
      "#...#.p..#$#..t.#...#",
      "#...#..*.#.#.*..#...#",
      "#...####.###.####...#",
      "#...................#",
      "#.^.................#",
      "#..u..*....%....u...#",
      "#####################",
    ],
  },
  {
    n: 3, id: "map_floor3", name: "地下室", theme: "cellar", span: 16,
    ghosts: { "%": "chaser", "!": "prankster", $: "phantom", "^": "patrol" },
    plan: [
      "#####################",
      "#s#w#s#w##E##w#s#w#s#",
      "#.........@.........#",
      "#.k.....P...P.....k.#",
      "#...*...............#",
      "#..P...%.....%...P..#",
      "######.#######.######",
      "#*...#.........#...*#",
      "#....#..P.!.P..#....#",
      "#..$.#.........#.*..#",
      "#....#####.#####....#",
      "#..........*........#",
      "#.^.................#",
      "#.b..c..*....C..b..c#",
      "#####################",
    ],
  },
];

const HALL_PLAN = [
  "#############",
  "#Ws1Ww2wW3sW#",
  "#N.........p#",
  "#...........#",
  "#....rrr....#",
  "#....rrr....#",
  "#....rrr....#",
  "#...........#",
  "#u.........u#",
  "#############",
];
const DOOR_X = { 1: 3, 2: 6, 3: 9 };
const CANDELABRUM = { x: 6, y: 5 };

/** 間取りを読む：タイルの計画（印を床にしたもの）と、入口・ろうそく・おばけの位置。 */
function readPlan(floor) {
  const W = floor.plan[0].length;
  const H = floor.plan.length;
  if (floor.plan.some((row) => row.length !== W)) throw new Error(`${floor.id}: 行の長さがそろっていない`);
  const marks = { start: undefined, door: undefined, candles: [], ghosts: [] };
  const tiles = floor.plan.map((row, y) =>
    [...row].map((ch, x) => {
      if (ch === "@") marks.start = { x, y };
      else if (ch === "E") marks.door = { x, y };
      else if (ch === "*") marks.candles.push({ x, y });
      else if (floor.ghosts[ch] !== undefined) marks.ghosts.push({ x, y, kind: floor.ghosts[ch] });
      else return ch;
      return ch === "E" ? "E" : ".";
    }),
  );
  // 床の北にある壁は、壁の正面（顔）で描く。そうでない壁は、壁の上
  const WALLS = new Set(["#", "w", "s", "E"]);
  for (let y = 1; y < H - 1; y++) for (let x = 0; x < W; x++) if (tiles[y][x] === "#" && !WALLS.has(tiles[y + 1][x])) tiles[y][x] = "W";
  // 入口からすべてのろうそくへ歩いて行けること（通り抜けのおばけは、壁に閉じこめられていてもよい）
  const walk = new Set([`${marks.start.x},${marks.start.y}`]);
  const queue = [marks.start];
  while (queue.length > 0) {
    const { x, y } = queue.shift();
    for (const [i, j] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = `${x + i},${y + j}`;
      if (tiles[y + j]?.[x + i] === "." && !walk.has(k)) {
        walk.add(k);
        queue.push({ x: x + i, y: y + j });
      }
    }
  }
  for (const c of marks.candles) if (!walk.has(`${c.x},${c.y}`)) throw new Error(`${floor.id}: (${c.x}, ${c.y}) のろうそくに行けない`);
  for (const g of marks.ghosts) if (!KINDS[g.kind].through && !walk.has(`${g.x},${g.y}`)) throw new Error(`${floor.id}: (${g.x}, ${g.y}) のおばけが閉じこめられている`);
  return { W, H, tiles, ...marks };
}

/** 計画（文字）→ [地面のタイル, 物のタイル]。階ごとに壁・床の見た目が変わる。 */
function legend(theme) {
  const t = THEMES[theme];
  const A = t.wall;
  return {
    "#": [T.wallTop, 0], W: [T[`wall${A}`], 0], w: [T[`window${A}`], 0], s: [T[`sconce${A}`], 0], E: [T[`exit${A}`], 0],
    ".": [t.floor, 0], r: [T.rug, 0],
    ...Object.fromEntries(Object.entries(FURNITURE).map(([ch, tile]) => [ch, [t.floor, tile]])),
    1: [T.door1, 0], 2: [T.door2, 0], 3: [T.door3, 0], N: [T.floorWood, T.board],
  };
}
function buildLayers(rows, theme) {
  const map = legend(theme);
  const ground = [];
  const objects = [];
  for (const row of rows) for (const ch of row) {
    const [g, o] = map[ch] ?? (() => { throw new Error(`知らない文字: ${ch}`); })();
    ground.push(g);
    objects.push(o);
  }
  return [{ name: "ground", tiles: ground }, { name: "objects", tiles: objects }];
}

// ── イベント ──────────────────────────────────────────────────────────
const setVarExpr = (id, expr, indent = 0) => cmd("ControlVariables", { ids: [id], op: "set", operand: { kind: "expr", expr } }, indent);
const transfer = (mapId, { x, y }, dir, indent = 0) => cmd("TransferPlayer", { mapId, x, y, dir, fade: "black" }, indent);
const tint = (color, duration = 0, indent = 0) => cmd("TintScreen", { color, duration, wait: false }, indent);

/** 暗い色調（階）と、ろうそくの灯った玄関ホール。全部の階を終えると明るくなる。 */
const DARK = { r: 8, g: 6, b: 36, a: 0.44 };
const DIM = { r: 12, g: 8, b: 30, a: 0.3 };
const CLEAR = { r: 0, g: 0, b: 0, a: 0 };
/** 色調をかけ続ける並列イベント（色調はセーブされないので、ロードしたあとも戻るように 1 秒ごとにかけ直す）。 */
const tintKeeper = (color, conditions = []) => hidden({ conditions, commands: [cmd("Loop", {}), tint(color, 0, 1), cmd("Wait", { frames: 60 }, 1), cmd("EndLoop", {})] });

const TOTAL = FLOORS.reduce((n, f) => n + f.plan.join("").split("*").length - 1, 0);
const doorFront = (n) => ({ x: DOOR_X[n], y: 2 });

function floorEvents(floor, layout, assets) {
  const prop = (name) => ({ asset: assets["props.png"].id, index: PROPS[name], direction: "down" });
  const count = `var_c${floor.n}`;
  const total = layout.candles.length;
  const events = [];

  events.push(event("ev_dark", "暗がり", { x: 0, y: 0 }, [tintKeeper(DARK)]));
  // 入口の扉：玄関ホールへもどる
  events.push(
    event("ev_exit", "入口の扉", layout.door, [
      page({
        trigger: "touch",
        commands: [
          text("玄関ホールに もどる？\n（拾った ろうそくは そのまま）"),
          cmd("ShowChoices", { choices: ["もどる", "もう少し さがす"], cancel: 1 }),
          cmd("ChoiceBranch", { index: 0 }),
          transfer(HALL, doorFront(floor.n), "down", 1),
          cmd("ChoiceBranch", { index: 1 }),
          endBranch(),
        ],
      }),
    ]),
  );

  // ろうそく：上に乗ると拾う。その階の分がそろうと、玄関ホールへもどる
  layout.candles.forEach((pos, i) => {
    events.push(
      event(`ev_candle_${i + 1}`, `ろうそく${i + 1}`, pos, [
        page({
          graphic: prop("candle"),
          trigger: "touch",
          priority: "below",
          through: true,
          commands: [
            cmd("ControlSelfSwitch", { key: "A", value: true }),
            addVar(count, 1),
            addVar("var_total", 1),
            flash({ r: 255, g: 220, b: 150, a: 0.45 }, 10),
            ifVar(count, ">=", total),
            text(`\\C[6]ろうそくを ぜんぶ 集めた！\\C[0]\n${floor.name}の おばけたちが おとなしく なった。`, 1),
            setVarExpr("var_cleared", `max(v("var_cleared"), ${floor.n})`, 1),
            transfer(HALL, doorFront(floor.n), "down", 1),
            otherwise(),
            setVarExpr("var_left", `${total} - v("${count}")`, 1),
            text(`ろうそくを 拾った！\n${floor.name}の ろうそくは あと \\V[var_left]本。`, 1),
            endBranch(),
          ],
        }),
        page({ conditions: [{ kind: "selfSwitch", key: "A", value: true }], priority: "below", through: true, commands: [] }),
      ]),
    );
  });

  // おばけ：「イベントから接触」で捕まえにくる
  const used = {};
  layout.ghosts.forEach((g, i) => {
    const kind = KINDS[g.kind];
    used[g.kind] = (used[g.kind] ?? 0) + 1;
    const name = kind.names[(used[g.kind] - 1) % kind.names.length];
    const route = typeof kind.route === "function" ? kind.route(floor.span) : kind.route;
    events.push(
      event(`ev_ghost_${i + 1}`, name, g, [
        page({
          graphic: { asset: assets["ghosts.png"].id, index: LOOKS[kind.look].index, direction: "down" },
          trigger: "eventTouch",
          through: kind.through === true,
          moveRoute: { repeat: true, ...route },
          commands: [
            flash({ r: 200, g: 40, b: 60, a: 0.6 }, 16),
            cmd("ShakeScreen", { power: 6, duration: 20, wait: false }),
            addVar("var_caught", 1),
            text(`\\C[2]${name}\\C[0]に つかまった！\n入口まで つれもどされる……`),
            transfer(floor.id, layout.start, "down"),
          ],
        }),
      ]),
    );
  });
  return events;
}

function hallEvents(assets) {
  const props = assets["props.png"].id;
  const rules = [
    text("おばけに さわられると、その階の 入口に\nつれもどされる。拾った ろうそくは なくならん。"),
    text("あおい おばけは 近づいてくる。しろい おばけは きまぐれ。\nももいろの おばけは ろうかを 見回っておる。"),
    text("むらさきの おばけは 壁を すりぬける。\nあかい おばけは すばやく 近づいては 逃げていく。気をつけてな。"),
  ];
  const doors = FLOORS.map((floor, i) => {
    const n = floor.n;
    const total = floor.plan.join("").split("*").length - 1;
    const ind = n === 1 ? 0 : 1;
    return event(`ev_door_${n}`, `${n}の扉`, { x: DOOR_X[n], y: 1 }, [
      page({
        trigger: "touch",
        commands: [
          ...(n === 1 ? [] : [ifVar("var_cleared", "<=", n - 2), text(`扉には かぎが かかっている。\n\\C[2]${FLOORS[i - 1].name}\\C[0]の ろうそくを 集めると 開くようだ。`, 1), otherwise()]),
          ifVar("var_cleared", ">=", n, ind),
          text(`${floor.name}の ろうそくは もう ぜんぶ 集めた。`, ind + 1),
          otherwise(ind),
          text(`\\C[6]${floor.name}\\C[0]\nろうそく ${total}本のうち \\V[var_c${n}]本 集めた。入る？`, ind + 1),
          cmd("ShowChoices", { choices: ["入る", "やめておく"], cancel: 1 }, ind + 1),
          cmd("ChoiceBranch", { index: 0 }, ind + 1),
          transfer(floor.id, readPlan(floor).start, "down", ind + 2),
          cmd("ChoiceBranch", { index: 1 }, ind + 1),
          endBranch(ind + 1),
          endBranch(ind),
          ...(n === 1 ? [] : [endBranch()]),
        ],
      }),
    ]);
  });
  return [
    event("ev_dark", "暗がり", { x: 12, y: 0 }, [tintKeeper(DIM), tintKeeper(CLEAR, [{ kind: "variable", id: "var_cleared", op: ">=", value: FLOORS.length }])]),
    // はじめに一度だけ
    event("ev_intro", "はじまり", { x: 0, y: 9 }, [
      page({
        trigger: "autorun",
        priority: "below",
        through: true,
        commands: [
          text("夜の 古いお屋敷。\nろうそくが ぜんぶ 消えて、おばけたちが 目を さました。"),
          text("執事の おばけが 何か 言いたそうに している。\n（話しかけてみよう）"),
          cmd("ControlSelfSwitch", { key: "A", value: true }),
        ],
      }),
      page({ conditions: [{ kind: "selfSwitch", key: "A", value: true }], priority: "below", through: true, commands: [] }),
    ]),
    // 全部の階を終えたら
    event("ev_ending", "エンディング", { x: 12, y: 9 }, [
      page({
        conditions: [{ kind: "variable", id: "var_cleared", op: ">=", value: FLOORS.length }],
        trigger: "autorun",
        priority: "below",
        through: true,
        commands: [
          tint(CLEAR, 60),
          cmd("Wait", { frames: 60 }),
          text(`大燭台に ${TOTAL}本の ろうそくが そろった。\nお屋敷じゅうに あかりが ともる……`),
          text("おばけたちは あかりの中で すやすやと 眠りについた。\n\\C[6]おめでとう！\\C[0]"),
          text("おばけに つかまった 回数：\\V[var_caught]回"),
          cmd("ReturnToTitle", {}),
        ],
      }),
    ]),
    // 執事：進み具合で言うことが変わる。あそびかたも聞ける
    event("ev_butler", "執事", { x: 3, y: 4 }, [
      ["おお、お客さま。屋敷の ろうそくが ぜんぶ 消えて しまいましてな。\nおばけを よけながら 集めて きてくだされ。まずは 1の扉の 客間から。"],
      ["客間が あかるく なりました！\n次は 2の扉の 回廊ですな。"],
      ["さすがです！ 最後は 3の扉、地下室。\nいちばん こわい おばけたちが おりますぞ。"],
      ["ありがとうございました。\nもう 屋敷は こわく ありません。"],
    ].map(([t], progress) =>
      page({
        conditions: progress === 0 ? [] : [{ kind: "variable", id: "var_cleared", op: ">=", value: progress }],
        graphic: { asset: assets["ghosts.png"].id, index: BUTLER_INDEX, direction: "down" },
        commands: [
          text(t),
          text("おばけの ことを 聞きますかな？"),
          cmd("ShowChoices", { choices: ["聞く", "いや、いい"], cancel: 1 }),
          cmd("ChoiceBranch", { index: 0 }),
          ...rules.map((c) => ({ ...c, indent: 1 })),
          cmd("ChoiceBranch", { index: 1 }),
          endBranch(),
        ],
      }),
    )),
    // 大燭台：終えた階の数だけ灯る
    event("ev_candelabrum", "大燭台", CANDELABRUM, [0, 1, 2, 3].map((lit) =>
      page({
        conditions: lit === 0 ? [] : [{ kind: "variable", id: "var_cleared", op: ">=", value: lit }],
        graphic: { asset: props, index: PROPS.candelabrum + lit, direction: "down" },
        commands: [text(`大きな 燭台。\n集めた ろうそく：\\V[var_total] / ${TOTAL}本`)],
      }),
    )),
    // はり紙
    event("ev_board", "はり紙", { x: 1, y: 2 }, [
      page({
        commands: [
          text("『ろうそくの ありか』\n1の扉　客間　　 ……ろうそく 4本\n2の扉　回廊　　 ……ろうそく 5本\n3の扉　地下室　 ……ろうそく 6本"),
          text("おばけに つかまった 回数：\\V[var_caught]回"),
        ],
      }),
    ]),
    ...doors,
  ];
}

// ── 書き出し ──────────────────────────────────────────────────────────

rmSync(ROOT, { recursive: true, force: true });
const assets = writeAssets(join(ROOT, "assets"), {
  "haunted_tileset.png": tileset(),
  "hero.png": character(HERO),
  "ghosts.png": sheet(6, [...["white", "blue", "pink", "red", "violet"].map(ghost), character({ shirt: [40, 40, 54], hair: [228, 228, 234], skin: [214, 220, 236] })]),
  "props.png": sheet(5, [candle(), ...[0, 1, 2, 3].map(candelabrum)]),
});

mkdirSync(join(ROOT, "maps"), { recursive: true });
const mapsMeta = {};
const writeMap = (id, name, order, rows, theme, events) => {
  writeFileSync(join(ROOT, "maps", `${id}.json`), toJson({ id, width: rows[0].length, height: rows.length, tileset: "ts_haunted", layers: buildLayers(rows, theme), events: Object.fromEntries([...events, weatherEvent("fireflies", 5)].map((e) => [e.id, e])) }));
  mapsMeta[id] = { id, name, order };
};
writeMap(HALL, "玄関ホール", 0, HALL_PLAN, "living", hallEvents(assets));
FLOORS.forEach((floor, i) => {
  const layout = readPlan(floor);
  writeMap(floor.id, `${floor.n}の扉：${floor.name}`, i + 1, layout.tiles, floor.theme, floorEvents(floor, layout, assets));
});

const project = {
  formatVersion: 1,
  meta: { id: "haunted", title: "デモ：おばけ屋敷の追いかけっこ", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" },
  system: {
    startMap: HALL,
    startX: HALL_START.x,
    startY: HALL_START.y,
    initialParty: ["actor_hero"],
    tileSize: TILE,
    screen: { width: SCREEN_W * TILE, height: SCREEN_H * TILE },
    bgm: {},
    terms: { newGame: "ニューゲーム" },
  },
  maps: mapsMeta,
  tilesets: { ts_haunted: { id: "ts_haunted", name: "おばけ屋敷", image: { asset: assets["haunted_tileset.png"].id }, passage: PASSAGE } },
  database: {
    actors: { actor_hero: { id: "actor_hero", name: "ゆうき", classId: "class_hero", initialLevel: 1, walk: { asset: assets["hero.png"].id }, equips: {} } },
    classes: { class_hero: { id: "class_hero", name: "探検家", skills: [], params } },
    skills: {},
    items: {},
    enemies: {},
    troops: {},
    states: {},
    commonEvents: {},
  },
  assets: { entries: Object.fromEntries(Object.entries(assets).map(([name, a]) => [a.id, entry(name, a)])) },
  switches: {},
  variables: {
    var_c1: { name: "客間のろうそく" },
    var_c2: { name: "回廊のろうそく" },
    var_c3: { name: "地下室のろうそく" },
    var_total: { name: "集めたろうそく" },
    var_left: { name: "この階ののこり" },
    var_cleared: { name: "終えた階の数" },
    var_caught: { name: "つかまった回数" },
  },
};
writeFileSync(join(ROOT, "project.json"), toJson(project));
// 階の形を確認するための表示
FLOORS.forEach((floor) => {
  const { W, H, candles, ghosts } = readPlan(floor);
  console.log(`\n${floor.n}の扉 ${floor.name} ${W}x${H}：ろうそく ${candles.length}本、おばけ ${ghosts.map((g) => g.kind).join("・")}`);
});
