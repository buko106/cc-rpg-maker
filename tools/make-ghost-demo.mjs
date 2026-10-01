#!/usr/bin/env node
/**
 * おばけ屋敷の鬼ごっこのデモ（fixtures/projects/v1/ghosts）を丸ごと生成する開発用スクリプト。
 * 出力: project.json、maps/<MapId>.json、assets/<AssetId>.<ext>（AssetId = 内容の sha256 先頭 16 桁）。
 * 生成物はコミット済み。階の作りや時間を変えたいときだけ再実行する（乱数はシード固定なので、何度実行しても同じものができる）。
 *
 *   node tools/make-ghost-demo.mjs
 *
 * プレイヤーが「鬼」になって、逃げ回るおばけを制限時間内に全員つかまえる（ぶつかるとつかまる）。戦闘は無い。
 * 自律移動（ページの moveRoute）と、時間制限（ControlTimer の表示 + 並列イベントの数え）の作り方のお手本：
 * 1. おばけはプレイヤーから逃げる（move away）。行き止まりでは進めないので、次の歩み（random など）へ移る（skippable）。
 *    おばけの種類は、歩く速さ（speed）と歩み方の違いだけ。
 * 2. おばけのイベントは 3 ページ。「待機（動かない）」→「遊び中（スイッチ。逃げる。触れるとつかまる）」→「つかまった（おばけごとのスイッチ。消える）」。
 * 3. 時間は、並列イベント（遊び中だけ有効）が 1 秒ごとに変数を減らして数える。0 になるとスイッチを立て、自動実行のイベントが結果を出す。
 *    画面右上の数字は ControlTimer（同じ秒数で開始）。
 * 4. 全員つかまえると、のこり時間の記録（変数）を更新して次の階の鍵を開ける（変数が○以上のとき）。
 * 階は、部屋を格子に並べて通路（戸口）でつなぐ手続き的な生成（シード固定）。家具は、通路をふさがないところにだけ置く。
 * 管理人（玄関ホール）の話しかけ、3 つの扉（突き当たりで始まる接触イベント）、くつ（拾うとプレイヤーの足が速くなる）も入れてある。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blit, canvas, character, image, lcg, shade, sheet, TILE, writeAssets } from "./pixel-art.mjs";

const ROOT = join(import.meta.dirname, "..", "fixtures", "projects", "v1", "ghosts");

/** 画面は 13×10 タイル。階はそれより広く、スクロールする。 */
const SCREEN_W = 13;
const SCREEN_H = 10;
const LOBBY = "map_lobby";
const LOBBY_START = { x: 6, y: 7, dir: "up" };

// ── おばけの種類 ──────────────────────────────────────────────────────
const away = { kind: "move", dir: "away" };
const rand = { kind: "move", dir: "random" };
const wait = (frames) => ({ kind: "wait", frames });
const speed = (value) => ({ kind: "speed", value });
/**
 * 種類ごとの色・名前・動き方。プレイヤー（速さ 4）が追いつけるかは、速さと「逃げない間」で決まる。
 * 動き方は繰り返す（repeat）。逃げられない（壁に当たった）歩みは飛ばして、次の歩みへ（skippable）。
 */
const KINDS = {
  white: { index: 0, body: [244, 246, 255], names: ["しろまる", "ふわり", "もちこ"], steps: [speed(4), away, rand, away, rand, rand] },
  blue: { index: 1, body: [150, 200, 250], names: ["あおすけ", "しずく", "そらまめ"], steps: [speed(5), away, away, rand, rand, wait(6)] },
  pink: { index: 2, body: [250, 190, 214], names: ["ももこ", "さくら"], steps: [speed(3), away, wait(16), rand, rand] },
  red: { index: 3, body: [250, 150, 140], names: ["あかね", "こてつ", "ほむら"], steps: [speed(4), wait(60), speed(6), away, away, away, away, speed(4), rand, rand, rand] },
};
const BUTLER_INDEX = 4;

// ── キャラクター（おばけ。1 体 = 3 パターン × 4 方向）──────────────────────────
function ghost(kind) {
  const B = KINDS[kind].body;
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
      blit(out, c, p * TILE, row * TILE);
    }
  });
  return out;
}

// ── 小道具（イベントの絵）──────────────────────────────────────────────
const still = (draw) => {
  const one = canvas(TILE, TILE);
  draw(one);
  const out = image(TILE * 3, TILE * 4);
  for (let row = 0; row < 4; row++) for (let p = 0; p < 3; p++) blit(out, one, p * TILE, row * TILE);
  return out;
};
/** はやあしのくつ。 */
const boots = () =>
  still((d) => {
    d.disc(16, 16, 14, [255, 240, 150, 36]);
    d.disc(16, 16, 10, [255, 240, 150, 52]);
    d.ellipse(16, 28, 10, 2, [0, 0, 0, 70]);
    const leather = [184, 92, 48];
    d.rect(10, 8, 8, 14, leather);
    d.rect(10, 8, 8, 2, shade(leather, 40));
    d.rect(10, 20, 15, 6, leather);
    d.rect(10, 26, 15, 2, [70, 40, 30]);
    d.rect(10, 12, 8, 2, [240, 200, 90]);
    for (const [x, y] of [[26, 6], [5, 12], [24, 14]]) {
      d.set(x, y, [255, 255, 220]);
      d.set(x - 1, y, [255, 255, 220, 140]);
      d.set(x + 1, y, [255, 255, 220, 140]);
      d.set(x, y - 1, [255, 255, 220, 140]);
      d.set(x, y + 1, [255, 255, 220, 140]);
    }
    d.rect(3, 22, 5, 1, [255, 255, 255, 140]);
    d.rect(1, 25, 7, 1, [255, 255, 255, 110]);
  });
const PROPS = { boots: 0 };

// ── タイルセット ──────────────────────────────────────────────────────
const T = {
  floorWood: 1, floorCarpet: 2, floorStone: 3, rug: 4, wallTop: 5,
  wallA: 6, wallB: 7, wallC: 8,
  windowA: 9, windowB: 10, windowC: 11,
  sconceA: 12, sconceB: 13, sconceC: 14,
  door1: 15, door2: 16, door3: 17,
  table: 18, sofa: 19, plant: 20, clock: 21, shelf: 22, crate: 23, barrel: 24, coffin: 25, cauldron: 26, pumpkin: 27, pillar: 28, board: 29,
};
const CELLS = 30;
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

// ── 階の生成（部屋を格子に並べて、戸口でつなぐ）────────────────────────────
const THEMES = {
  living: { floor: T.floorWood, wall: "A", furniture: ["t", "S", "p", "K", "B"] },
  gallery: { floor: T.floorCarpet, wall: "B", furniture: ["t", "B", "p", "c", "u", "P"] },
  cellar: { floor: T.floorStone, wall: "C", furniture: ["k", "b", "c", "C", "u", "P"] },
};
const FURNITURE = { t: T.table, S: T.sofa, p: T.plant, K: T.clock, B: T.shelf, c: T.crate, b: T.barrel, k: T.coffin, C: T.cauldron, u: T.pumpkin, P: T.pillar };

/**
 * 階の設定。`time` は制限時間（秒）。`ghosts` はおばけの種類。部屋は `cols`×`rows` 個で、広さは `w`×`h`。
 * `loops` は、部屋をぐるっと回れる戸口（通路の輪）を足す割合。`density` は 1 部屋あたりの家具の数。
 */
const STAGES = [
  { n: 1, id: "map_floor1", name: "リビング", theme: "living", cols: 2, rows: 2, w: 8, h: 5, seed: 7, loops: 1, density: 3, time: 50, ghosts: ["white", "white", "pink", "blue"] },
  { n: 2, id: "map_floor2", name: "ろうか", theme: "gallery", cols: 3, rows: 2, w: 6, h: 5, seed: 21, loops: 0.6, density: 3, time: 60, ghosts: ["white", "blue", "blue", "pink", "red"] },
  { n: 3, id: "map_floor3", name: "ちか室", theme: "cellar", cols: 3, rows: 3, w: 6, h: 4, seed: 33, loops: 0.5, density: 3, time: 75, ghosts: ["white", "blue", "blue", "red", "red", "pink"] },
];

function generateStage(cfg) {
  const rnd = lcg(cfg.seed);
  const { cols, rows, w, h } = cfg;
  const W = 1 + cols * (w + 1);
  const H = 2 + rows * (h + 1);
  const g = Array.from({ length: H }, () => Array(W).fill("#"));
  const x0 = (c) => 1 + c * (w + 1);
  const y0 = (r) => 2 + r * (h + 1);
  for (let x = 1; x < W - 1; x++) g[1][x] = x % 6 === 2 ? "w" : x % 6 === 5 ? "s" : "W";
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) for (let y = y0(r); y < y0(r) + h; y++) for (let x = x0(c); x < x0(c) + w; x++) g[y][x] = ".";

  // 部屋のつながり：ランダムな深さ優先で全部の部屋をつなぎ（輪にならない）、さらに戸口を足して輪を作る
  const inside = (c, r) => c >= 0 && r >= 0 && c < cols && r < rows;
  const edgeKey = (a, b) => [a, b].sort().join("|");
  const edges = new Map();
  const seen = new Set(["0,0"]);
  const stack = [[0, 0]];
  while (stack.length > 0) {
    const [c, r] = stack[stack.length - 1];
    const next = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dc, dr]) => [c + dc, r + dr]).filter(([nc, nr]) => inside(nc, nr) && !seen.has(`${nc},${nr}`));
    if (next.length === 0) {
      stack.pop();
      continue;
    }
    const [nc, nr] = next[Math.floor(rnd() * next.length)];
    seen.add(`${nc},${nr}`);
    edges.set(edgeKey(`${c},${r}`, `${nc},${nr}`), [c, r, nc, nr]);
    stack.push([nc, nr]);
  }
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) for (const [dc, dr] of [[1, 0], [0, 1]]) {
    const [nc, nr] = [c + dc, r + dr];
    if (!inside(nc, nr)) continue;
    const k = edgeKey(`${c},${r}`, `${nc},${nr}`);
    if (!edges.has(k) && rnd() < cfg.loops) edges.set(k, [c, r, nc, nr]);
  }
  const doors = [];
  for (const [c, r, nc, nr] of edges.values()) {
    const door = nc !== c ? { x: x0(Math.min(c, nc)) + w, y: y0(r) + 1 + Math.floor(rnd() * (h - 2)) } : { x: x0(c) + 1 + Math.floor(rnd() * (w - 2)), y: y0(Math.min(r, nr)) + h };
    g[door.y][door.x] = ".";
    doors.push(door);
  }

  // 家具：戸口のまわりには置かない。置いても、床が全部つながったままのときだけ
  const reserved = new Set();
  for (const d of doors) for (const [i, j] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) reserved.add(`${d.x + i},${d.y + j}`);
  const floorCount = () => g.reduce((n, row) => n + row.filter((ch) => ch === ".").length, 0);
  const connected = () => {
    const start = g.flatMap((row, y) => row.map((ch, x) => (ch === "." ? [x, y] : null))).find(Boolean);
    const seenTiles = new Set([`${start[0]},${start[1]}`]);
    const queue = [start];
    while (queue.length > 0) {
      const [x, y] = queue.shift();
      for (const [i, j] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const k = `${x + i},${y + j}`;
        if (g[y + j]?.[x + i] === "." && !seenTiles.has(k)) {
          seenTiles.add(k);
          queue.push([x + i, y + j]);
        }
      }
    }
    return seenTiles.size === floorCount();
  };
  const furniture = THEMES[cfg.theme].furniture;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    let placed = 0;
    for (let tries = 0; tries < 40 && placed < cfg.density; tries++) {
      const x = x0(c) + Math.floor(rnd() * w);
      const y = y0(r) + Math.floor(rnd() * h);
      if (g[y][x] !== "." || reserved.has(`${x},${y}`)) continue;
      g[y][x] = furniture[Math.floor(rnd() * furniture.length)];
      if (connected()) placed++;
      else g[y][x] = ".";
    }
  }

  // 床の北にある壁は、壁の正面（顔）で描く。そうでない壁は、壁の上
  for (let y = 2; y < H - 1; y++) for (let x = 0; x < W; x++) if (g[y][x] === "#" && g[y + 1][x] !== "#") g[y][x] = "W";

  // 距離（スタートから歩いた歩数）
  const startRoom = [cols - 1, rows - 1];
  const center = [x0(startRoom[0]) + Math.floor(w / 2), y0(startRoom[1]) + Math.floor(h / 2)];
  const free = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (g[y][x] === "." && !reserved.has(`${x},${y}`)) free.push({ x, y });
  const roomOf = ({ x, y }) => [Math.floor((x - 1) / (w + 1)), Math.floor((y - 2) / (h + 1))];
  const start = free.filter((t) => roomOf(t).join() === startRoom.join()).sort((a, b) => Math.hypot(a.x - center[0], a.y - center[1]) - Math.hypot(b.x - center[0], b.y - center[1]))[0];
  const dist = new Map([[`${start.x},${start.y}`, 0]]);
  const queue = [[start.x, start.y]];
  while (queue.length > 0) {
    const [x, y] = queue.shift();
    for (const [i, j] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = `${x + i},${y + j}`;
      if (g[y + j]?.[x + i] === "." && !dist.has(k)) {
        dist.set(k, dist.get(`${x},${y}`) + 1);
        queue.push([x + i, y + j]);
      }
    }
  }
  const d = (t) => dist.get(`${t.x},${t.y}`);

  // おばけは、スタートの部屋以外の部屋にばらけて置く。くつは、そのどれでもない部屋に
  const roomsFar = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (`${c},${r}` !== startRoom.join()) roomsFar.push([c, r]);
  const order = roomsFar.map((room) => [rnd(), room]).sort((a, b) => a[0] - b[0]).map((e) => e[1]);
  const taken = [start];
  const choose = (room, minApart) => {
    const candidates = free.filter((t) => roomOf(t).join() === room.join() && d(t) >= 5 && taken.every((o) => Math.hypot(o.x - t.x, o.y - t.y) >= minApart));
    const t = candidates[Math.floor(rnd() * candidates.length)] ?? free.find((f) => d(f) >= 5 && taken.every((o) => Math.hypot(o.x - f.x, o.y - f.y) >= 2));
    taken.push(t);
    return t;
  };
  const ghosts = cfg.ghosts.map((_, i) => choose(order[i % order.length], 3));
  const boots = choose(order[cfg.ghosts.length % order.length], 3);
  return { W, H, plan: g.map((row) => row.join("")), start, ghosts, boots };
}

const LOBBY_PLAN = [
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

/** 計画（文字）→ [地面のタイル, 物のタイル]。階ごとに壁・床の見た目が変わる。 */
function legend(theme) {
  const t = THEMES[theme];
  const A = t.wall;
  return {
    "#": [T.wallTop, 0], W: [T[`wall${A}`], 0], w: [T[`window${A}`], 0], s: [T[`sconce${A}`], 0],
    ".": [t.floor, 0], r: [T.rug, 0],
    ...Object.fromEntries(Object.entries(FURNITURE).map(([ch, tile]) => [ch, [t.floor, tile]])),
    1: [T.door1, 0], 2: [T.door2, 0], 3: [T.door3, 0], N: [T.floorWood, T.board],
  };
}
function buildLayers(plan, theme, W, H) {
  if (plan.length !== H || plan.some((row) => row.length !== W)) throw new Error(`計画の形が ${W}×${H} でない`);
  const map = legend(theme);
  const ground = [];
  const objects = [];
  for (const row of plan) for (const ch of row) {
    const [g, o] = map[ch] ?? (() => { throw new Error(`知らない文字: ${ch}`); })();
    ground.push(g);
    objects.push(o);
  }
  return [{ name: "ground", tiles: ground }, { name: "objects", tiles: objects }];
}

// ── イベント ──────────────────────────────────────────────────────────
const cmd = (code, params, indent = 0) => ({ code, params, indent });
const text = (t, indent = 0) => cmd("ShowText", { text: t, position: "bottom", background: "window" }, indent);
const page = (p) => ({ conditions: [], trigger: "action", through: false, priority: "same", ...p });
const event = (id, name, [x, y], pages) => ({ id, name, x, y, pages });
const ifVar = (id, op, value, indent = 0) => cmd("ConditionalBranch", { condition: { kind: "variable", id, op, value } }, indent);
const ifExpr = (expr, indent = 0) => cmd("ConditionalBranch", { condition: expr }, indent);
const ifSwitch = (id, value, indent = 0) => cmd("ConditionalBranch", { condition: { kind: "switch", id, value } }, indent);
const otherwise = (indent = 0) => cmd("Else", {}, indent);
const endBranch = (indent = 0) => cmd("EndBranch", {}, indent);
const setVar = (id, value, indent = 0) => cmd("ControlVariables", { ids: [id], op: "set", operand: { kind: "constant", value } }, indent);
const setVarExpr = (id, expr, indent = 0) => cmd("ControlVariables", { ids: [id], op: "set", operand: { kind: "expr", expr } }, indent);
const subVar = (id, value, indent = 0) => cmd("ControlVariables", { ids: [id], op: "sub", operand: { kind: "constant", value } }, indent);
const switches = (ids, value, indent = 0) => cmd("ControlSwitches", { ids, value }, indent);
const transfer = (mapId, x, y, dir, indent = 0) => cmd("TransferPlayer", { mapId, x, y, dir, fade: "black" }, indent);
const flash = (color, duration, indent = 0) => cmd("FlashScreen", { color, duration }, indent);
const heroSpeed = (value, indent = 0) => cmd("SetMoveRoute", { target: "player", route: { repeat: false, skippable: false, steps: [{ kind: "speed", value }] }, wait: true }, indent);
/** 全部の階のおばけの「つかまった」スイッチ。 */
const caughtSwitch = (stage, i) => `sw_g${stage.n}_${i + 1}`;
const allCaught = STAGES.flatMap((stage) => stage.ghosts.map((_, i) => caughtSwitch(stage, i)));
const STATE_SWITCHES = ["sw_ready", "sw_playing", "sw_clear", "sw_timeup"];

/** 記録が 3 つ星になるのこり時間（制限時間の半分）と、2 つ星（4 分の 1）。 */
const starLine = (stage) => ({ three: Math.ceil(stage.time / 2), two: Math.ceil(stage.time / 4) });

function stageEvents(stage, layout, assets) {
  const props = (name) => ({ asset: assets["props.png"].id, index: PROPS[name], direction: "down" });
  const used = {};
  const pos = (t) => [t.x, t.y];
  const events = [];

  // ふだんの位置（スタート）にある、目に見えない世話役のイベント
  const at = pos(layout.start);
  const sys = (id, name, pages) => events.push(event(id, name, at, pages));
  const stageTime = stage.time;
  const { three, two } = starLine(stage);

  sys("ev_ready", "よーい、スタート", [
    page({
      conditions: [{ kind: "switch", id: "sw_ready", value: true }],
      trigger: "autorun",
      through: true,
      priority: "below",
      commands: [
        heroSpeed(4),
        text(`\\C[6]${stage.n}かい：${stage.name}\\C[0]\nおばけを ぜんいん つかまえよう！\n制限時間は ${stageTime}びょう。よーい……`),
        switches(["sw_ready"], false),
        switches(["sw_playing"], true),
        cmd("ControlTimer", { op: "start", seconds: stageTime }),
        text("\\C[6]スタート！\\C[0]"),
      ],
    }),
  ]);
  // 1 秒ごとにのこり時間を減らす。0 になったら時間切れ（つかまえきったあとは、その結果が優先）
  sys("ev_clock", "時計", [
    page({
      conditions: [{ kind: "switch", id: "sw_playing", value: true }],
      trigger: "parallel",
      through: true,
      priority: "below",
      commands: [
        cmd("Loop", {}),
        cmd("Wait", { frames: 59 }, 1),
        subVar("var_time", 1, 1),
        ifVar("var_time", "<=", 0, 1),
        switches(["sw_timeup"], true, 2),
        switches(["sw_playing"], false, 2),
        endBranch(1),
        cmd("EndLoop", {}),
      ],
    }),
  ]);
  sys("ev_win", "クリア", [
    page({
      conditions: [{ kind: "switch", id: "sw_clear", value: true }],
      trigger: "autorun",
      through: true,
      priority: "below",
      commands: [
        text(`\\C[6]ぜんいん つかまえた！\\C[0]\nのこり \\V[var_time]びょう！`),
        ifVar("var_time", ">=", three),
        text("\\C[6]★★★\\C[0] すごい 足の はやさだ！", 1),
        otherwise(),
        ifVar("var_time", ">=", two, 1),
        text("\\C[6]★★☆\\C[0] なかなか やるな！", 2),
        otherwise(1),
        text("\\C[6]★☆☆\\C[0] ぎりぎり セーフ！", 2),
        endBranch(1),
        endBranch(),
        ifExpr(`v("var_time") > v("var_best${stage.n}")`),
        text("\\C[2]ベストきろく こうしん！\\C[0]", 1),
        setVarExpr(`var_best${stage.n}`, 'v("var_time")', 1),
        endBranch(),
        ...(stage.n < STAGES.length
          ? [ifVar("var_cleared", "<=", stage.n - 1), text(`\\C[3]${stage.n + 1}かいへの 扉が 開いた！\\C[0]`, 1), endBranch()]
          : [ifVar("var_cleared", "<=", stage.n - 1), text("おばけたちは すっかり 満足した ようだ。\n\\C[6]おめでとう！ 鬼ごっこの 名人だ！\\C[0]", 1), endBranch()]),
        setVarExpr("var_cleared", `max(v("var_cleared"), ${stage.n})`),
        heroSpeed(4),
        transfer(LOBBY, DOOR_X[stage.n], 2, "down"),
      ],
    }),
  ]);
  sys("ev_timeup", "時間切れ", [
    page({
      conditions: [{ kind: "switch", id: "sw_timeup", value: true }],
      trigger: "autorun",
      through: true,
      priority: "below",
      commands: [
        flash({ r: 255, g: 255, b: 255, a: 0.6 }, 12),
        text(`\\C[2]じかんぎれ！\\C[0]\nおばけは あと \\V[var_left]ひき 残っている。\nおばけたちは 逃げていった……`),
        switches(["sw_timeup"], false),
        heroSpeed(4),
        transfer(LOBBY, DOOR_X[stage.n], 2, "down"),
      ],
    }),
  ]);

  // おばけ
  stage.ghosts.forEach((kind, i) => {
    used[kind] = (used[kind] ?? 0) + 1;
    const def = KINDS[kind];
    const name = def.names[(used[kind] - 1) % def.names.length];
    const sw = caughtSwitch(stage, i);
    const graphic = { asset: assets["ghosts.png"].id, index: def.index, direction: "down" };
    events.push(
      event(`ev_ghost_${i + 1}`, name, pos(layout.ghosts[i]), [
        // まだ始まっていない（動かない）
        page({ graphic, commands: [] }),
        // 遊び中：逃げる。ぶつかるとつかまる
        page({
          conditions: [{ kind: "switch", id: "sw_playing", value: true }],
          graphic,
          trigger: "touch",
          moveRoute: { repeat: true, skippable: true, steps: def.steps },
          commands: [
            flash({ r: 255, g: 230, b: 250, a: 0.55 }, 10),
            switches([sw], true),
            subVar("var_left", 1),
            ifVar("var_left", "<=", 0),
            switches(["sw_clear"], true, 1),
            switches(["sw_playing"], false, 1),
            cmd("ControlTimer", { op: "stop" }, 1),
            otherwise(),
            text(`\\C[3]${name}\\C[0]を つかまえた！\nのこり \\V[var_left]ひき`, 1),
            endBranch(),
          ],
        }),
        // つかまった：消える
        page({ conditions: [{ kind: "switch", id: sw, value: true }], through: true, priority: "below", commands: [] }),
      ]),
    );
  });

  // くつ：拾うと、この階の間、足が速くなる
  events.push(
    event("ev_boots", "はやあしのくつ", pos(layout.boots), [
      page({
        graphic: props("boots"),
        trigger: "touch",
        priority: "below",
        through: true,
        commands: [
          flash({ r: 255, g: 240, b: 160, a: 0.5 }, 12),
          text("\\C[6]はやあしのくつ\\C[0]を 見つけた！\nこの階の 間、足が はやくなる！"),
          heroSpeed(5),
          cmd("ControlSelfSwitch", { key: "A", value: true }),
        ],
      }),
      page({ conditions: [{ kind: "selfSwitch", key: "A", value: true }], priority: "below", through: true, commands: [] }),
    ]),
  );
  return events;
}

/** 階のはじめかた（玄関ホールの扉から）。 */
function startStage(stage, layout, indent) {
  return [
    switches([...allCaught, ...STATE_SWITCHES], false, indent),
    switches(["sw_ready"], true, indent),
    setVar("var_left", stage.ghosts.length, indent),
    setVar("var_time", stage.time, indent),
    transfer(stage.id, layout.start.x, layout.start.y, "up", indent),
  ];
}

function lobbyEvents(assets, layouts) {
  const ghosts = assets["ghosts.png"].id;
  const doors = STAGES.map((stage, i) => {
    const n = stage.n;
    return event(`ev_door_${n}`, `${n}かいの扉`, [DOOR_X[n], 1], [
      page({
        trigger: "touch",
        commands: [
          ...(n === 1
            ? []
            : [
                ifVar("var_cleared", "<=", n - 2),
                text(`${n}かいへの 扉には かぎが かかっている。\n\\C[2]${n - 1}かい\\C[0]の おばけを ぜんいん つかまえると 開くようだ。`, 1),
                otherwise(),
              ]),
          text(`\\C[6]${n}かい：${stage.name}\\C[0]\nおばけ ${stage.ghosts.length}ひき・制限時間 ${stage.time}びょう`, n === 1 ? 0 : 1),
          ifVar(`var_best${n}`, ">=", 1, n === 1 ? 0 : 1),
          text(`ベストきろく：のこり \\V[var_best${n}]びょう`, n === 1 ? 1 : 2),
          endBranch(n === 1 ? 0 : 1),
          text("はじめる？", n === 1 ? 0 : 1),
          cmd("ShowChoices", { choices: ["はじめる", "やめておく"], cancel: 1 }, n === 1 ? 0 : 1),
          cmd("ChoiceBranch", { index: 0 }, n === 1 ? 0 : 1),
          ...startStage(stage, layouts[i], n === 1 ? 1 : 2),
          cmd("ChoiceBranch", { index: 1 }, n === 1 ? 0 : 1),
          endBranch(n === 1 ? 0 : 1),
          ...(n === 1 ? [] : [endBranch()]),
        ],
      }),
    ]);
  });
  const rules = [
    text("おばけに ぶつかると、つかまえられる。\n制限時間の 間に、ぜんいん つかまえれば クリアだ。"),
    text("おばけは あなたから 逃げていく。\nすみっこや 家具の かげに 追いこもう！"),
    text("のこり時間は 画面の 右上に 出ている。\n階の どこかに ある くつを 拾うと、足が はやくなるぞ。"),
  ];
  return [
    // はじめに一度だけ
    event("ev_intro", "はじまり", [0, 9], [
      page({
        trigger: "autorun",
        priority: "below",
        through: true,
        commands: [
          text("古いお屋敷の 夜。\nおばけの 子どもたちが 部屋じゅうを 逃げまわって いる。"),
          text("管理人の じいさんが あなたを 呼んでいる。\n（まんなかの じいさんに 話しかけてみよう）"),
          cmd("ControlSelfSwitch", { key: "A", value: true }),
        ],
      }),
      page({ conditions: [{ kind: "selfSwitch", key: "A", value: true }], priority: "below", through: true, commands: [] }),
    ]),
    // 管理人：進み具合で言うことが変わる。あそびかたも聞ける
    event("ev_keeper", "管理人", [6, 5], [
      ["おお、よく来てくれた！\nおばけの 子らが 夜になると 逃げまわって こまって おる。"],
      ["おみごと！ 1かいは すっかり しずかに なった。\n奥の 2の扉が 開いたぞ。"],
      ["さすがじゃ！ 次は 地下の 3の扉へ。\nちか室の おばけは すばしこいぞ。"],
      ["すべての おばけを つかまえて くれた！\nもっと はやく つかまえられるか、きろくに ちょうせんじゃ。"],
    ].map(([t], progress) =>
      page({
        conditions: progress === 0 ? [] : [{ kind: "variable", id: "var_cleared", op: ">=", value: progress }],
        graphic: { asset: ghosts, index: BUTLER_INDEX, direction: "down" },
        commands: [
          text(t),
          text("あそびかたを 聞くかね？"),
          cmd("ShowChoices", { choices: ["聞く", "いや、いい"], cancel: 1 }),
          cmd("ChoiceBranch", { index: 0 }),
          ...rules.map((c) => ({ ...c, indent: 1 })),
          cmd("ChoiceBranch", { index: 1 }),
          endBranch(),
        ],
      }),
    )),
    // きろく
    event("ev_board", "きろく", [1, 2], [
      page({
        commands: [
          text("【ベストきろく】\n（つかまえたとき、のこり時間が 多いほど いい）"),
          ...STAGES.flatMap((stage) => [
            ifVar(`var_best${stage.n}`, ">=", 1),
            text(`${stage.n}かい：のこり \\V[var_best${stage.n}]びょう`, 1),
            otherwise(),
            text(`${stage.n}かい：まだ`, 1),
            endBranch(),
          ]),
        ],
      }),
    ]),
    ...doors,
  ];
}

// ── 書き出し ──────────────────────────────────────────────────────────
const toJson = (value) => `${JSON.stringify(value, null, 2).replace(/\[\s+([-\d.,\s]+?)\s+\]/g, (_, body) => `[${body.split(/,\s*/).join(", ")}]`)}\n`;

rmSync(ROOT, { recursive: true, force: true });
const assets = writeAssets(join(ROOT, "assets"), {
  "ghosts_tileset.png": tileset(),
  "hero.png": character({ shirt: [58, 110, 165], hair: [110, 70, 40], skin: [240, 200, 160] }),
  "ghosts.png": sheet(5, [...["white", "blue", "pink", "red"].map(ghost), character({ shirt: [40, 40, 54], hair: [228, 228, 234], skin: [240, 200, 160] })]),
  "props.png": sheet(1, [boots()]),
});

const layouts = STAGES.map(generateStage);
mkdirSync(join(ROOT, "maps"), { recursive: true });
const mapsMeta = {};
const writeMap = (id, name, order, W, H, theme, plan, events) => {
  writeFileSync(join(ROOT, "maps", `${id}.json`), toJson({ id, width: W, height: H, tileset: "ts_ghosts", layers: buildLayers(plan, theme, W, H), events: Object.fromEntries(events.map((e) => [e.id, e])) }));
  mapsMeta[id] = { id, name, order };
};
writeMap(LOBBY, "玄関ホール", 0, SCREEN_W, SCREEN_H, "living", LOBBY_PLAN, lobbyEvents(assets, layouts));
STAGES.forEach((stage, i) => writeMap(stage.id, `${stage.n}かい：${stage.name}`, i + 1, layouts[i].W, layouts[i].H, stage.theme, layouts[i].plan, stageEvents(stage, layouts[i], assets)));

const entry = (name, a) => ({ name, kind: "image", mime: "image/png", size: a.size, width: a.width, height: a.height });
const params = Object.fromEntries(["mhp", "mmp", "atk", "def", "mat", "mdf", "agi", "luk"].map((p) => [p, { base: p === "mhp" ? 100 : p === "mmp" ? 20 : 10, growth: 2 }]));
const project = {
  formatVersion: 1,
  meta: { id: "ghosts", title: "デモ：おばけ屋敷の鬼ごっこ", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" },
  system: {
    startMap: LOBBY,
    startX: LOBBY_START.x,
    startY: LOBBY_START.y,
    initialParty: ["actor_hero"],
    tileSize: TILE,
    screen: { width: SCREEN_W * TILE, height: SCREEN_H * TILE },
    bgm: {},
    terms: { newGame: "ニューゲーム" },
  },
  maps: mapsMeta,
  tilesets: { ts_ghosts: { id: "ts_ghosts", name: "おばけ屋敷", image: { asset: assets["ghosts_tileset.png"].id }, passage: PASSAGE } },
  database: {
    actors: { actor_hero: { id: "actor_hero", name: "鬼", classId: "class_hero", initialLevel: 1, walk: { asset: assets["hero.png"].id }, equips: {} } },
    classes: { class_hero: { id: "class_hero", name: "鬼", skills: [], params } },
    skills: {},
    items: {},
    enemies: {},
    troops: {},
    states: {},
    commonEvents: {},
  },
  assets: { entries: Object.fromEntries(Object.entries(assets).map(([name, a]) => [a.id, entry(name, a)])) },
  switches: {
    sw_ready: { name: "階のはじめ（よーい）" },
    sw_playing: { name: "鬼ごっこ中" },
    sw_clear: { name: "ぜんいんつかまえた" },
    sw_timeup: { name: "時間切れ" },
    ...Object.fromEntries(STAGES.flatMap((stage) => stage.ghosts.map((_, i) => [caughtSwitch(stage, i), { name: `${stage.n}かいの ${i + 1}ひき目をつかまえた` }]))),
  },
  variables: {
    var_left: { name: "のこりのおばけ" },
    var_time: { name: "のこり時間（秒）" },
    var_cleared: { name: "クリアした階の数" },
    ...Object.fromEntries(STAGES.map((stage) => [`var_best${stage.n}`, { name: `${stage.n}かいのベスト（のこり秒）` }])),
  },
};
writeFileSync(join(ROOT, "project.json"), toJson(project));
// 階の形を確認するための表示
STAGES.forEach((stage, i) => {
  const { plan, start, ghosts, boots } = layouts[i];
  const rows = plan.map((r) => [...r]);
  ghosts.forEach((g, k) => (rows[g.y][g.x] = String(k + 1)));
  rows[start.y][start.x] = "@";
  rows[boots.y][boots.x] = "b";
  console.log(`\n${stage.n}かい ${plan[0].length}x${plan.length}\n${rows.map((r) => r.join("")).join("\n")}`);
});
