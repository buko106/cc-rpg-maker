#!/usr/bin/env node
/**
 * からくり迷宮の鬼ごっこのデモ（fixtures/projects/v1/onigokko）を丸ごと生成する開発用スクリプト。
 * 出力: project.json、maps/<MapId>.json、assets/<AssetId>.<ext>（AssetId = 内容の sha256 先頭 16 桁）。
 * 生成物はコミット済み。部屋の作りや鬼の動きを変えたいときだけ再実行する（何度実行しても同じものができる）。
 *
 *   node tools/make-onigokko-demo.mjs
 *
 * からくり師の屋敷の迷宮で、からくり鬼と鬼ごっこをしながら、奥の「金の鈴」を取りに行く。戦闘は無く、1 画面の部屋の詰め将棋のようなパズルが 4 つ。
 * 「おばけ屋敷の追いかけっこ」（haunted）はリアルタイムの追いかけっこだが、こちらはターン制で、先を読んで解く。見せたいエンジンの機能：
 * 1. ターン制の移動ルート（`moveRoute.pace: "playerStep"`）：鬼は、プレイヤーが 1 手打つ（歩く・岩を押す・決定ボタンで足踏み）たびに、ルートの次の 1 手を行う。
 * 2. 移動ルートの向き：鬼の種類ごとに `move` の `dir` が違う。
 *    追い鬼 = `chase`（通れる道をたどって最短で追う。道がふさがると、近づくだけになる）、
 *    つっこみ鬼 = `toward`（差の大きい方へ近づくだけ。壁や柱に引っかかる）、
 *    見回り鬼 = 決まった巡回（4 方向）、からくり狐 = `away`（逃げる。鍵を持っていて、隅に追いつめてぶつかると鍵が手に入る）。
 *    `wait` を混ぜると、2 手に 1 歩だけ動く「のろま」になる。`random` は手順を検証できないので使わない。
 * 3. イベントから接触（`eventTouch`）：鬼が歩いてきてプレイヤーに触れる、またはプレイヤーが鬼にぶつかると、つかまって部屋の入口に戻される（鬼・岩・鍵・扉は最初から）。
 * 4. 押せる岩（`pushable`）・扉：岩と閉じた扉は、鬼の道をふさぐ（追い鬼の道さがしも、ふさがれた道は通らない）。鍵（スイッチ）を取ると、同じ色の扉が開く。
 * 部屋の手順は、apps/player の onigokko-model.testkit.ts のソルバ（BFS）で求めて、実際のエンジンで再生して確かめている（onigokko-fixture.test.ts）。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blit, canvas, character, HERO, image, lcg, shade, sheet, TILE, writeAssets } from "./pixel-art.mjs";
import { addVar, cmd, entry, event, flash, page, params, setSwitch, sw, text, toJson } from "./demo-lib.mjs";

const ROOT = join(import.meta.dirname, "..", "fixtures", "projects", "v1", "onigokko");

/** 画面は 15×11 タイル。部屋はどれもちょうど 1 画面（スクロールしない）。 */
const SCREEN_W = 15;
const SCREEN_H = 11;
const W = SCREEN_W;
const H = SCREEN_H;
const START = { x: 7, y: 8 };

// ── 部屋 ──────────────────────────────────────────────────────────────
/**
 * 文字の意味：`#` 壁、`.` 板の床、`,` 畳（通れる）、`O` 柱（通れない）、`R` 押せる岩、`<` 入口の階段（下の部屋へ戻る・やり直す）、
 * `X` 出口（壁の中の戸口。1 行目のみ）、`G` からくり師、`1` `2` 金・銀の鍵、`A` `B` 金・銀の扉（同じ色の鍵で開く）、`a`〜`f` 鬼と狐（`movers` の動き）。
 * 入口の階段 `<` の上の (7, 8) が、はじまりの場所。
 *
 * 鬼の動き（`acts`）は、1 手ずつの文字：`C` = 追う（`chase`）、`T` = 近づく（`toward`）、`A` = 逃げる（`away`）、
 * `U` `D` `L` `R` = その向きへ歩く、`.` = 待つ。空白は無視する。ルートはこれの繰り返し。`dir` は最初の向き。
 * `kind` は見た目と名前（`KINDS`）。狐（`fox`）は `key`（1 = 金、2 = 銀）の鍵を持っている。
 * 同じ手の中では、鬼と狐は文字の順（a, b, …。イベントの定義順）に 1 人ずつ動く（あとの鬼は、先に動いた鬼の新しい位置を見る）。
 */
const ROOMS = [
  {
    id: "map_hall",
    name: "からくり屋敷の玄関",
    next: "map_r1",
    plan: [
      "###############",
      "#######X#######",
      "#,,,,,,.,,,,,,#",
      "#,...........,#",
      "#,.....G.....,#",
      "#,...........,#",
      "#,.O.......O.,#",
      "#,...........,#",
      "#,...........,#",
      "#,...........,#",
      "###############",
    ],
  },
  {
    id: "map_r1",
    name: "一の間 つっこみ鬼",
    prev: "map_hall",
    next: "map_r2",
    plan: [
      "###############",
      "#######X#######",
      "#......A......#",
      "#.............#",
      "#..O..O.O..O..#",
      "#......a......#",
      "#..O.......O..#",
      "#1............#",
      "#.............#",
      "#......<......#",
      "###############",
    ],
    movers: { a: { kind: "toward", dir: "down", acts: "T" } },
  },
  {
    id: "map_r2",
    name: "二の間 見回りの廊下",
    prev: "map_r1",
    next: "map_r3",
    plan: [
      "###############",
      "#######X#######",
      "#......A......#",
      "##..###########",
      "#......b......#",
      "#####.##.######",
      "#......c......#",
      "#.............#",
      "#1............#",
      "#......<......#",
      "###############",
    ],
    movers: {
      b: { kind: "patrol", dir: "left", acts: "LLRR" },
      c: { kind: "patrol", dir: "left", acts: "LLRR" },
    },
  },
  {
    id: "map_r3",
    name: "三の間 岩の戸じまり",
    prev: "map_r2",
    next: "map_r4",
    plan: [
      "###############",
      "#######X#######",
      "#######A###1..#",
      "#######.###.###",
      "#######.###.###",
      "#.............#",
      "####..........#",
      "#a...R........#",
      "#####.........#",
      "#......<......#",
      "###############",
    ],
    movers: { a: { kind: "chase", dir: "right", acts: "C" } },
  },
  {
    id: "map_r4",
    name: "四の間 狐の鍵",
    prev: "map_r3",
    final: true,
    plan: [
      "###############",
      "#######X#######",
      "#######B#######",
      "#...........f.#",
      "###.###########",
      "#..b..........#",
      "##.##.####.####",
      "#........R...a#",
      "#O........#####",
      "#......<......#",
      "###############",
    ],
    movers: {
      a: { kind: "chase", dir: "left", acts: "C" },
      b: { kind: "patrol", dir: "left", acts: "L.R." },
      f: { kind: "fox", dir: "right", acts: "A", key: 2 },
    },
  },
];

const T = { floor: 1, tatami: 2, wallTop: 3, wallFace: 4, lantern: 5, scroll: 6, pillar: 7, stairs: 8, gate: 9 };
const CELLS = 10;
/** 通れるのは床・畳・階段・戸口だけ。壁・柱は通れない。 */
const PASSABLE = new Set([0, T.floor, T.tatami, T.stairs, T.gate]);
const PASSAGE = Array.from({ length: CELLS }, (_, id) => (PASSABLE.has(id) ? 15 : 0));

/** 鬼と狐の見た目と名前。`look` は people.png の何体目か。 */
const KINDS = {
  chase: { name: "追い鬼", look: 1 },
  toward: { name: "つっこみ鬼", look: 2 },
  patrol: { name: "見回り鬼", look: 3 },
  fox: { name: "からくり狐", look: 4 },
};
const SHEET = { master: 0 };
const KEYS = { 1: { name: "金の鍵", color: "\\C[6]" }, 2: { name: "銀の鍵", color: "\\C[3]" } };
const DOOR_OF = { A: 1, B: 2 };

const DIRS = { U: "up", D: "down", L: "left", R: "right", C: "chase", T: "toward", A: "away" };
/** 鬼の動きの文字列を、移動ルートの steps にする。 */
function stepsOf(acts) {
  const out = [];
  for (const ch of acts.replace(/\s+/g, "")) {
    if (DIRS[ch] !== undefined) out.push({ kind: "move", dir: DIRS[ch] });
    else if (ch === ".") out.push({ kind: "wait", frames: 1 });
    else throw new Error(`知らない動き: ${ch}`);
  }
  return out;
}

/** 間取りを読む：床の計画と、印の位置。 */
function readPlan(room) {
  const { plan } = room;
  if (plan.length !== H || plan.some((row) => row.length !== W)) throw new Error(`${room.id}: 間取りは ${W}×${H}`);
  const marks = { exit: [], stairs: [], master: [], rock: [], mover: [], key: [], door: [] };
  const rows = plan.map((row, y) =>
    [...row].map((ch, x) => {
      if (ch === "X") marks.exit.push({ x, y, ch });
      else if (ch === "<") marks.stairs.push({ x, y, ch });
      else if (ch === "G") marks.master.push({ x, y, ch });
      else if (ch === "R") marks.rock.push({ x, y, ch });
      else if (ch === "1" || ch === "2") marks.key.push({ x, y, ch });
      else if (ch === "A" || ch === "B") marks.door.push({ x, y, ch });
      else if (/[a-f]/.test(ch)) marks.mover.push({ x, y, ch });
      else if (!"#.,O".includes(ch)) throw new Error(`${room.id}: 知らない文字 ${ch}`);
      return ch;
    }),
  );
  if (marks.exit.length !== 1 || marks.exit[0].y !== 1) throw new Error(`${room.id}: 出口 X は 1 行目に 1 つ`);
  if (room.id !== "map_hall" && (marks.stairs.length !== 1 || marks.stairs[0].x !== START.x || marks.stairs[0].y !== START.y + 1)) throw new Error(`${room.id}: 階段 < は (${START.x}, ${START.y + 1})`);
  if (plan[START.y][START.x] !== "." && plan[START.y][START.x] !== ",") throw new Error(`${room.id}: はじまりの場所 (${START.x}, ${START.y}) が空いていない`);
  for (const m of marks.mover) if (room.movers?.[m.ch] === undefined) throw new Error(`${room.id}: 鬼 ${m.ch} の動きが無い`);
  for (const d of marks.door) if (!marks.key.some((k) => Number(k.ch) === DOOR_OF[d.ch]) && !Object.values(room.movers ?? {}).some((m) => m.key === DOOR_OF[d.ch])) throw new Error(`${room.id}: 扉 ${d.ch} の鍵が無い`);
  // 壁の正面（顔）：床の北にある壁
  const FACE = new Set(["#", "X"]);
  for (let y = 0; y < H - 1; y++) for (let x = 0; x < W; x++) if (rows[y][x] === "#" && y >= 1 && !FACE.has(rows[y + 1][x])) rows[y][x] = "F";
  return { rows, ...marks };
}

function buildLayers(rows, id) {
  const ground = [];
  const objects = [];
  rows.forEach((row, y) =>
    row.forEach((ch, x) => {
      let g = 0;
      let o = 0;
      if (ch === "#") g = T.wallTop;
      else if (ch === "F") g = (x * 5 + y) % 7 === 2 ? T.lantern : (x * 3 + y) % 9 === 4 ? T.scroll : T.wallFace;
      else if (ch === "X") g = T.gate;
      else if (ch === "<") g = T.stairs;
      else if (ch === ",") g = T.tatami;
      else if (/[.RGO12ABa-f]/.test(ch)) g = T.floor;
      else throw new Error(`${id}: 知らない文字 ${ch}`);
      if (ch === "O") o = T.pillar;
      ground.push(g);
      objects.push(o);
    }),
  );
  return [{ name: "ground", tiles: ground }, { name: "objects", tiles: objects }];
}

// ── タイルセット ──────────────────────────────────────────────────────
const WOOD = [150, 104, 64];
const PLASTER = [214, 200, 170];
const BEAM = [86, 56, 40];
const GOLD = [232, 188, 72];
const SILVER = [196, 204, 220];

function tileset() {
  const img = image(TILE * CELLS, TILE);
  const cell = (id) => {
    const set = (x, y, c) => {
      if (x < 0 || y < 0 || x >= TILE || y >= TILE) return;
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

  /** 板の床（横に 4 枚の板）。 */
  const planks = (c, seed) => {
    c.rect(0, 0, TILE, TILE, WOOD);
    const rnd = lcg(seed);
    for (let y = 0; y < TILE; y += 8) {
      c.rect(0, y, TILE, 1, shade(WOOD, -40));
      c.rect(0, y + 1, TILE, 1, shade(WOOD, 16));
      const seam = ((y / 8) * 11 + 5) % TILE;
      c.rect(seam, y, 1, 8, shade(WOOD, -34));
      for (let i = 0; i < 5; i++) c.rect(Math.floor(rnd() * 26), y + 3 + Math.floor(rnd() * 4), 4 + Math.floor(rnd() * 4), 1, shade(WOOD, rnd() < 0.5 ? -14 : 10));
    }
  };
  /** 土壁の正面（漆喰に、梁と腰板）。行灯・掛け軸はこの上に描く。 */
  const wallFace = (c) => {
    c.rect(0, 0, TILE, TILE, PLASTER);
    const rnd = lcg(31);
    for (let i = 0; i < 18; i++) c.set(Math.floor(rnd() * 32), Math.floor(rnd() * 20), shade(PLASTER, -12));
    c.rect(0, 0, TILE, 3, BEAM);
    c.rect(0, 3, TILE, 1, shade(BEAM, -30));
    c.rect(0, 20, TILE, 12, shade(BEAM, 20));
    for (let x = 0; x < TILE; x += 8) c.rect(x, 20, 1, 12, shade(BEAM, -10));
    c.rect(0, 20, TILE, 2, BEAM);
    c.rect(0, 30, TILE, 2, shade(BEAM, -40));
  };

  planks(cell(T.floor), 5);
  // 畳
  {
    const c = cell(T.tatami);
    const straw = [176, 184, 112];
    c.rect(0, 0, TILE, TILE, straw);
    for (let y = 1; y < TILE; y += 2) c.rect(1, y, 30, 1, shade(straw, -10));
    c.rect(0, 0, TILE, 2, [40, 64, 52]);
    c.rect(0, 30, TILE, 2, [40, 64, 52]);
  }
  // 壁の上（黒い瓦の屋根の上から見た形）
  {
    const c = cell(T.wallTop);
    const base = [46, 40, 44];
    c.rect(0, 0, TILE, TILE, base);
    for (let y = 2; y < TILE; y += 6) c.rect(0, y, TILE, 2, shade(base, 16));
    c.rect(0, TILE - 2, TILE, 2, shade(base, -16));
  }
  wallFace(cell(T.wallFace));
  // 行灯
  {
    const c = cell(T.lantern);
    wallFace(c);
    c.rect(11, 6, 10, 13, [255, 236, 190]);
    c.rect(11, 6, 10, 1, BEAM);
    c.rect(11, 18, 10, 1, BEAM);
    c.rect(11, 6, 1, 13, BEAM);
    c.rect(20, 6, 1, 13, BEAM);
    c.disc(16, 12, 3, [255, 200, 110]);
  }
  // 掛け軸（鬼の面の絵）
  {
    const c = cell(T.scroll);
    wallFace(c);
    c.rect(10, 3, 12, 17, [236, 228, 208]);
    c.rect(9, 3, 14, 2, BEAM);
    c.rect(9, 18, 14, 2, BEAM);
    c.disc(16, 11, 4, [200, 64, 52]);
    c.set(14, 10, [30, 20, 20]);
    c.set(18, 10, [30, 20, 20]);
    c.rect(13, 6, 1, 2, GOLD);
    c.rect(19, 6, 1, 2, GOLD);
  }
  // 柱（太い木の柱）
  {
    const c = cell(T.pillar);
    c.ellipse(16, 29, 10, 2, [0, 0, 0, 80]);
    c.rect(9, 26, 14, 4, [110, 106, 100]);
    c.rect(10, 2, 12, 25, shade(BEAM, 30));
    c.rect(10, 2, 3, 25, shade(BEAM, 60));
    c.rect(19, 2, 3, 25, shade(BEAM, 6));
    c.rect(9, 1, 14, 3, BEAM);
    c.rect(9, 12, 14, 2, shade(BEAM, -20));
  }
  // 入口の階段（下へ）
  {
    const c = cell(T.stairs);
    c.rect(0, 0, TILE, TILE, [30, 24, 22]);
    for (let i = 0; i < 4; i++) {
      c.rect(2, 3 + i * 7, 28, 6, shade(WOOD, 10 - i * 14));
      c.rect(2, 3 + i * 7, 28, 1, shade(WOOD, 34 - i * 14));
    }
    c.rect(0, 0, 2, TILE, BEAM);
    c.rect(30, 0, 2, TILE, BEAM);
  }
  // 出口の戸口（壁の中の、明かりのもれる引き戸）
  {
    const c = cell(T.gate);
    wallFace(c);
    c.rect(5, 3, 22, 29, BEAM);
    c.rect(7, 5, 18, 27, [255, 232, 170]);
    for (let y = 8; y < 32; y += 6) c.rect(7, y, 18, 1, shade(BEAM, 40));
    c.rect(15, 5, 2, 27, shade(BEAM, 40));
    c.rect(7, 5, 7, 27, [255, 246, 214]);
  }
  return img;
}

// ── キャラクター・小道具 ──────────────────────────────────────────────
/** からくり鬼（木の人形に鬼の面。1 体 = 3 パターン × 4 方向）。 */
function oni({ body, mask, horn }) {
  const out = image(TILE * 3, TILE * 4);
  ["down", "left", "right", "up"].forEach((dir, row) => {
    for (let p = 0; p < 3; p++) {
      const c = canvas(TILE, TILE);
      const lift = [3, 0, 0][p];
      const liftR = [0, 0, 3][p];
      const dark = shade(body, -60);
      c.ellipse(16, 29, 9, 2, [0, 0, 0, 70]);
      c.rect(10, 22 - lift, 5, 8, dark);
      c.rect(17, 22 - liftR, 5, 8, dark);
      c.rect(8, 13, 16, 10, body);
      c.rect(8, 13, 16, 2, shade(body, 30));
      c.rect(8, 19, 16, 2, [60, 44, 36]);
      c.rect(5, 14, 4, 8, shade(body, -20));
      c.rect(23, 14, 4, 8, shade(body, -20));
      // 角
      c.rect(9, 0, 3, 4, horn);
      c.rect(20, 0, 3, 4, horn);
      c.ellipse(16, 8, 8, 6, dir === "up" ? shade(body, -10) : mask);
      if (dir !== "up") {
        const eye = [255, 240, 120];
        const mouth = [40, 20, 20];
        const ox = dir === "left" ? -3 : dir === "right" ? 3 : 0;
        c.rect(11 + ox, 6, 3, 2, eye);
        if (dir === "down") c.rect(18, 6, 3, 2, eye);
        c.rect(12 + ox, 10, 8 - (dir === "down" ? 0 : 3), 2, mouth);
        c.set(13 + ox, 11, [250, 250, 250]);
        if (dir === "down") c.set(18, 11, [250, 250, 250]);
      } else c.rect(15, 3, 2, 8, shade(body, -40));
      blit(out, c, p * TILE, row * TILE);
    }
  });
  return out;
}

/** からくり狐（白い狐の人形）。 */
function fox() {
  const out = image(TILE * 3, TILE * 4);
  const fur = [244, 240, 230];
  const red = [210, 60, 50];
  ["down", "left", "right", "up"].forEach((dir, row) => {
    for (let p = 0; p < 3; p++) {
      const c = canvas(TILE, TILE);
      const hop = p === 1 ? 0 : 1;
      c.ellipse(16, 29, 8, 2, [0, 0, 0, 70]);
      // しっぽ
      const tx = dir === "left" ? 24 : dir === "right" ? 8 : 16;
      c.ellipse(tx, 22 - hop, 4, 6, fur);
      c.ellipse(tx, 17 - hop, 2, 2, GOLD);
      c.ellipse(16, 22 - hop, 7, 6, fur);
      c.rect(11, 26 - hop, 3, 4, shade(fur, -40));
      c.rect(18, 26 - hop, 3, 4, shade(fur, -40));
      c.ellipse(16, 11 - hop, 7, 6, fur);
      c.rect(9, 2 - hop, 4, 6, fur);
      c.rect(19, 2 - hop, 4, 6, fur);
      c.rect(10, 4 - hop, 2, 3, red);
      c.rect(20, 4 - hop, 2, 3, red);
      if (dir !== "up") {
        const ox = dir === "left" ? -3 : dir === "right" ? 3 : 0;
        c.rect(11 + ox, 10 - hop, 3, 1, red);
        if (dir === "down") c.rect(18, 10 - hop, 3, 1, red);
        c.set(16 + ox, 14 - hop, [40, 30, 30]);
      }
      // 首の鍵
      c.rect(15, 17 - hop, 3, 3, GOLD);
      blit(out, c, p * TILE, row * TILE);
    }
  });
  return out;
}

const still = (draw) => {
  const one = canvas(TILE, TILE);
  draw(one);
  const out = image(TILE * 3, TILE * 4);
  for (let row = 0; row < 4; row++) for (let p = 0; p < 3; p++) blit(out, one, p * TILE, row * TILE);
  return out;
};
/** 押せる岩（漬物石）。 */
const rock = () =>
  still((d) => {
    d.ellipse(16, 28, 12, 3, [0, 0, 0, 80]);
    const stone = [128, 126, 120];
    d.ellipse(16, 18, 12, 10, stone);
    d.ellipse(13, 14, 7, 5, shade(stone, 24));
    d.ellipse(11, 12, 3, 2, shade(stone, 44));
    d.ellipse(19, 24, 7, 3, shade(stone, -26));
    d.line(20, 12, 24, 18, shade(stone, -40));
  });
/** 鍵（金・銀）。床に置いてある。 */
const keyItem = (metal) =>
  still((d) => {
    d.ellipse(16, 27, 8, 2, [0, 0, 0, 60]);
    d.ellipse(11, 16, 6, 6, metal);
    d.ellipse(11, 16, 3, 3, [0, 0, 0, 0]);
    for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) if (i * i + j * j <= 4) d.set(11 + i, 16 + j, [0, 0, 0, 0]);
    d.rect(16, 15, 12, 3, metal);
    d.rect(23, 18, 2, 4, metal);
    d.rect(26, 18, 2, 3, metal);
    d.rect(8, 12, 3, 1, shade(metal, 40));
  });
/** 扉（金・銀の錠前のついた格子戸）。 */
const door = (metal) =>
  still((d) => {
    d.rect(2, 0, 28, 31, BEAM);
    d.rect(4, 2, 24, 27, [70, 46, 34]);
    for (let x = 6; x < 28; x += 5) d.rect(x, 2, 2, 27, shade(BEAM, 30));
    for (let y = 8; y < 29; y += 8) d.rect(4, y, 24, 2, shade(BEAM, 30));
    d.rect(11, 12, 10, 10, metal);
    d.rect(11, 12, 10, 2, shade(metal, 30));
    d.rect(15, 15, 2, 4, [40, 30, 30]);
    d.rect(2, 29, 28, 2, shade(BEAM, -30));
  });
/** 台の上の金の鈴。 */
const bell = () =>
  still((d) => {
    d.ellipse(16, 29, 12, 2, [0, 0, 0, 80]);
    d.rect(7, 22, 18, 7, [140, 40, 40]);
    d.rect(7, 22, 18, 2, [190, 70, 60]);
    d.ellipse(16, 12, 10, 10, [255, 236, 150, 80]);
    d.ellipse(16, 14, 7, 7, GOLD);
    d.ellipse(13, 11, 2, 2, [255, 246, 200]);
    d.rect(10, 15, 13, 1, shade(GOLD, -70));
    d.rect(15, 16, 3, 4, shade(GOLD, -90));
    d.rect(14, 4, 5, 3, [200, 60, 50]);
  });
const PROPS = { rock: 0, key1: 1, key2: 2, door1: 3, door2: 4, bell: 5 };

// ── イベント ──────────────────────────────────────────────────────────
const transfer = (mapId, x, y, dir, indent = 0) => cmd("TransferPlayer", { mapId, x, y, dir, fade: "black" }, indent);
/** 部屋の鍵のスイッチ（鍵の番号ごと）。 */
const keySwitch = (roomId, n) => `sw_${roomId.replace(/^map_/, "")}_key${n}`;
/** 部屋で使う鍵の番号。 */
const keysOf = (room, layout) => [...new Set([...layout.key.map((k) => Number(k.ch)), ...Object.values(room.movers ?? {}).flatMap((m) => (m.key === undefined ? [] : [m.key]))])].sort();

function events(room, layout, assets, rooms) {
  const people = assets["people.png"].id;
  const props = (name) => ({ asset: assets["props.png"].id, index: PROPS[name], direction: "down" });
  const out = [];
  const exit = layout.exit[0];
  const here = room.id;
  // 部屋をはじめからにする：鍵のスイッチを戻して、同じ部屋の入口へ（鬼・岩・狐は、マップに入りなおすと最初の位置に戻る）
  const switches = keysOf(room, layout).map((n) => keySwitch(here, n));
  const restart = (indent = 0) => [...(switches.length > 0 ? [setSwitch(switches, false, indent)] : []), transfer(here, START.x, START.y, "up", indent)];

  // 出口：次の部屋へ（最後の部屋は、金の鈴を取って終わり）
  if (room.final) {
    out.push(
      event("ev_exit", "金の鈴", exit, [
        page({
          trigger: "touch",
          through: true,
          priority: "below",
          graphic: props("bell"),
          commands: [
            flash({ r: 255, g: 230, b: 150, a: 0.7 }, 40),
            text("台の 上で 金色の 鈴が 光っている。\n\\C[6]金の鈴\\C[0]を 手に とった！"),
            text("チリン……。鈴の 音が ひびくと、屋敷じゅうの からくり鬼が\nぴたりと 止まった。鬼ごっこは あなたの 勝ち！\\C[6]おめでとう！\\C[0]"),
            text("つかまった 回数：\\V[var_caught]回"),
            cmd("ReturnToTitle", {}),
          ],
        }),
      ]),
    );
  } else {
    out.push(event("ev_exit", "出口の戸", exit, [page({ trigger: "touch", through: true, priority: "below", commands: [transfer(room.next, START.x, START.y, "up")] })]));
  }

  // 入口の階段：やり直す（一の間だけは、玄関へ戻ることもできる）
  if (layout.stairs.length === 1) {
    const s = layout.stairs[0];
    const back = room.prev === "map_hall";
    const choices = [...(back ? ["玄関へ もどる"] : []), "この 部屋を はじめから やりなおす", "やめる"];
    const cancel = choices.length - 1;
    const branches = [];
    choices.forEach((_, i) => {
      branches.push(cmd("ChoiceBranch", { index: i }));
      if (back && i === 0) branches.push(transfer("map_hall", rooms.find((r) => r.id === "map_hall").exitPos.x, 2, "down", 1));
      else if (i === cancel - 1) branches.push(...restart(1));
    });
    out.push(
      event("ev_stairs", "入口の階段", s, [
        page({ trigger: "touch", commands: [text("下へ おりる 階段だ。"), cmd("ShowChoices", { choices, cancel }), ...branches, cmd("EndBranch", {})] }),
      ]),
    );
  }

  // はじめに一度だけ（玄関）
  if (room.id === "map_hall") {
    out.push(
      event("ev_intro", "はじまり", { x: START.x, y: START.y }, [
        page({
          trigger: "autorun",
          priority: "below",
          through: true,
          commands: [
            text("からくり師の 屋敷に 招かれた。\n奥の 間に ある \\C[6]金の鈴\\C[0]を 取ってきたら、ごほうびが もらえるらしい。"),
            text("ただし 屋敷には からくり鬼が うろついている。\n（まずは からくり師に 話しかけてみよう）"),
            cmd("ControlSelfSwitch", { key: "A", value: true }),
          ],
        }),
        page({ conditions: [{ kind: "selfSwitch", key: "A", value: true }], priority: "below", through: true, commands: [] }),
      ]),
    );
  }

  // からくり師（玄関）
  if (layout.master.length === 1) {
    const tips = [
      ["わしの 鬼は、おまえさんが 1歩 動くたびに 1歩だけ 動く。\nおまえさんが 止まれば 鬼も 止まる。", "鬼に 触れられたら つかまり、部屋の 入口から やりなおしじゃ。\n自分から 鬼に ぶつかっても つかまるぞ。"],
      ["\\C[2]追い鬼\\C[0]は、道を さがして いちばん 近い 道で 追ってくる。\n\\C[2]つっこみ鬼\\C[0]は まっすぐ 近づくだけ。壁や 柱に 引っかかる。", "\\C[2]見回り鬼\\C[0]は 決まった 道を 行ったり 来たり。\n\\C[2]からくり狐\\C[0]は 逃げる。隅に 追いつめて ぶつかると 鍵を くれる。"],
      ["その場で 待ちたいときは \\C[6]決定ボタン\\C[0]。\nおまえさんは 動かず、鬼だけが 1歩 動く。", "\\C[6]岩\\C[0]は 押して 動かせる。閉じた \\C[6]扉\\C[0]と 同じく、鬼の 道を ふさぐ。\n道が ふさがると、追い鬼も 近づくだけに なるんじゃ。"],
      ["\\C[6]金の鍵\\C[0]で 金の 扉が、\\C[3]銀の鍵\\C[0]で 銀の 扉が 開く。\n鍵は 部屋を やりなおすと、もとの 場所に 戻る。", "岩を 動かしすぎて 詰んだら、入口の 階段で \\C[6]やりなおし\\C[0]が できる。"],
    ];
    out.push(
      event("ev_master", "からくり師", layout.master[0], [
        page({
          graphic: { asset: people, index: SHEET.master, direction: "down" },
          commands: [
            text("ほっほっ、よう来た。わしの からくり鬼と 鬼ごっこを しようぞ。\n奥の 間の \\C[6]金の鈴\\C[0]まで たどりつけたら、おまえさんの 勝ちじゃ。"),
            cmd("ShowChoices", { choices: ["鬼の 動き", "鬼の 種類", "待ちかたと 岩", "鍵と 扉", "やめる"], cancel: 4 }),
            ...tips.flatMap(([a, b], i) => [cmd("ChoiceBranch", { index: i }), text(a, 1), text(b, 1)]),
            cmd("ChoiceBranch", { index: 4 }),
            cmd("EndBranch", {}),
            text("つかまった 回数は \\V[var_caught]回 じゃな。\n奥の 戸から 一の間へ 行けるぞ。"),
          ],
        }),
      ]),
    );
  }

  // 押せる岩
  layout.rock.forEach((pos, i) => {
    out.push(event(`ev_rock_${i + 1}`, "岩", pos, [page({ trigger: "touch", graphic: props("rock"), pushable: true, commands: [] })]));
  });

  // 鍵：取ると、同じ色の扉が開く（スイッチ）。取ったあとはページが無くなって消える
  layout.key.forEach((pos, i) => {
    const n = Number(pos.ch);
    out.push(
      event(`ev_key_${i + 1}`, KEYS[n].name, pos, [
        page({
          conditions: [sw(keySwitch(here, n), false)],
          trigger: "touch",
          priority: "below",
          graphic: props(`key${n}`),
          commands: [flash({ r: 255, g: 240, b: 160, a: 0.4 }, 12), setSwitch(keySwitch(here, n), true)],
        }),
      ]),
    );
  });

  // 扉：同じ色の鍵を取るまで閉じている（通常プライオリティなので、鬼も通れない）。ぶつかると、どの鍵が要るか教えてくれる
  layout.door.forEach((pos, i) => {
    const n = DOOR_OF[pos.ch];
    out.push(
      event(`ev_door_${i + 1}`, `${KEYS[n].name.slice(0, 1)}の扉`, pos, [
        page({
          conditions: [sw(keySwitch(here, n), false)],
          trigger: "touch",
          graphic: props(`door${n}`),
          commands: [text(`${KEYS[n].color}${KEYS[n].name}\\C[0]が かかっている。`)],
        }),
      ]),
    );
  });

  // 鬼と狐：ターン制で動く。鬼は触れたら（触れられたら）つかまえる。狐はぶつかると鍵をくれる
  [...layout.mover].sort((p, q) => p.ch.localeCompare(q.ch)).forEach((m) => {
    const spec = room.movers[m.ch];
    const kind = KINDS[spec.kind];
    const graphic = { asset: people, index: kind.look, direction: spec.dir };
    const moveRoute = { repeat: true, skippable: true, pace: "playerStep", steps: stepsOf(spec.acts) };
    if (spec.kind === "fox") {
      const key = KEYS[spec.key];
      out.push(
        event(`ev_fox_${m.ch}`, kind.name, m, [
          page({
            conditions: [sw(keySwitch(here, spec.key), false)],
            graphic,
            trigger: "touch",
            moveRoute,
            commands: [
              flash({ r: 255, g: 240, b: 160, a: 0.4 }, 12),
              text(`からくり狐を つかまえた！\n首に さげていた ${key.color}${key.name}\\C[0]を もらった。`),
              setSwitch(keySwitch(here, spec.key), true),
            ],
          }),
        ]),
      );
      return;
    }
    out.push(
      event(`ev_oni_${m.ch}`, kind.name, m, [
        page({
          graphic,
          trigger: "eventTouch",
          moveRoute,
          commands: [
            flash({ r: 220, g: 40, b: 60, a: 0.55 }, 14),
            cmd("ShakeScreen", { power: 5, duration: 18, wait: false }),
            addVar("var_caught", 1),
            text(`\\C[2]${kind.name}\\C[0]に つかまった！\n部屋の 入口へ 戻される……`),
            ...restart(),
          ],
        }),
      ]),
    );
  });
  return out;
}

// ── 書き出し ──────────────────────────────────────────────────────────

const layouts = ROOMS.map((room) => ({ room, layout: readPlan(room) }));
// 部屋の出口の位置（次の部屋の階段から戻るときに使う）
for (const { room, layout } of layouts) room.exitPos = layout.exit[0];

rmSync(ROOT, { recursive: true, force: true });
const assets = writeAssets(join(ROOT, "assets"), {
  "onigokko_tileset.png": tileset(),
  "hero.png": character(HERO),
  "people.png": sheet(3, [
    character({ shirt: [92, 70, 120], hair: [236, 236, 240], skin: [232, 190, 150] }),
    oni({ body: [150, 60, 50], mask: [222, 70, 56], horn: [250, 236, 200] }),
    oni({ body: [56, 84, 150], mask: [80, 120, 214], horn: [250, 236, 200] }),
    oni({ body: [64, 120, 70], mask: [96, 176, 96], horn: [250, 236, 200] }),
    fox(),
  ]),
  "props.png": sheet(3, [rock(), keyItem(GOLD), keyItem(SILVER), door(GOLD), door(SILVER), bell()]),
});

mkdirSync(join(ROOT, "maps"), { recursive: true });
for (const { room, layout } of layouts) {
  const map = {
    id: room.id,
    width: W,
    height: H,
    tileset: "ts_onigokko",
    layers: buildLayers(layout.rows, room.id),
    events: Object.fromEntries(events(room, layout, assets, ROOMS).map((e) => [e.id, e])),
  };
  writeFileSync(join(ROOT, "maps", `${room.id}.json`), toJson(map));
}

const switches = Object.fromEntries(
  layouts.flatMap(({ room, layout }) => keysOf(room, layout).map((n) => [keySwitch(room.id, n), { name: `${room.name.split(" ")[0]}の${KEYS[n].name}` }])),
);
const project = {
  formatVersion: 1,
  meta: { id: "onigokko", title: "デモ：からくり迷宮の鬼ごっこ", createdAt: "2026-10-18T00:00:00Z", updatedAt: "2026-10-18T00:00:00Z" },
  system: {
    startMap: "map_hall",
    startX: START.x,
    startY: START.y,
    initialParty: ["actor_hero"],
    tileSize: TILE,
    screen: { width: SCREEN_W * TILE, height: SCREEN_H * TILE },
    bgm: {},
    autosave: { onTransfer: true },
    terms: { newGame: "ニューゲーム" },
  },
  maps: Object.fromEntries(ROOMS.map((r, order) => [r.id, { id: r.id, name: r.name, order }])),
  tilesets: { ts_onigokko: { id: "ts_onigokko", name: "からくり屋敷", image: { asset: assets["onigokko_tileset.png"].id }, passage: PASSAGE } },
  database: {
    actors: { actor_hero: { id: "actor_hero", name: "ハル", classId: "class_hero", initialLevel: 1, walk: { asset: assets["hero.png"].id }, equips: {} } },
    classes: { class_hero: { id: "class_hero", name: "旅人", skills: [], params } },
    skills: {},
    items: {},
    enemies: {},
    troops: {},
    states: {},
    commonEvents: {},
  },
  assets: { entries: Object.fromEntries(Object.entries(assets).map(([name, a]) => [a.id, entry(name, a)])) },
  switches,
  variables: { var_caught: { name: "つかまった回数" } },
};
writeFileSync(join(ROOT, "project.json"), toJson(project));
console.log(`\n${ROOMS.length} 部屋：${ROOMS.map((r) => r.name).join(" / ")}`);
