#!/usr/bin/env node
/**
 * 時の番人の回廊のデモ（fixtures/projects/v1/clock）を丸ごと生成する開発用スクリプト。
 * 出力: project.json、maps/<MapId>.json、assets/<AssetId>.<ext>（AssetId = 内容の sha256 先頭 16 桁）。
 * 生成物はコミット済み。部屋の作りや番人の動きを変えたいときだけ再実行する（何度実行しても同じものができる）。
 *
 *   node tools/make-clock-demo.mjs
 *
 * 止まった大時計の塔を登り、最上階の「時の歯車」を取り戻す。戦闘は無く、番人の目をかいくぐる 4 つの部屋のパズルだけ。見せたいエンジンの機能：
 * 1. ターン制の移動ルート（`moveRoute.pace: "playerStep"`）：番人は、時間では動かない。プレイヤーが 1 手打つ（歩く・岩を押す・決定ボタンで足踏み）たびに、
 *    ルートの次の 1 手を行う。`move` は 1 手で 1 歩、`wait` の `frames` は待つ手数、`turn` は時間がかからない（待ったすぐあとに置く）。
 *    番人の速さはプレイヤーと同じ（4）で、みんなが歩き終わるまで、プレイヤーは次の手を打てない。
 * 2. 視界（`eventSight`）：番人は、向いている方向のまっすぐ数タイルが見える。壁・柱・岩のかげは見えない。
 *    プレイヤーが手を打ち終えたとき、視界に入っていたら（あるいは番人の歩く先に居たら）つかまって、部屋の入口に戻される。番人も岩も、最初の位置からやり直す。
 * 3. 押せる岩（`pushable`）：押して動かして、番人の視界をさえぎる。押した手も 1 手。
 * 4. 足踏み：決定ボタンを押して、何も起こらなければ「その場で 1 手」（番人が 1 歩動く）。パズルは、歩く・待つ・岩を押す、の手順だけで解ける。
 * 部屋の手順は、apps/player の clock-model.testkit.ts のソルバ（BFS）で求めて、実際のエンジンで再生して確かめている（clock-fixture.test.ts）。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blit, canvas, character, HERO, image, lcg, shade, sheet, TILE, writeAssets } from "./pixel-art.mjs";
import { addVar, cmd, entry, event, flash, page, params, text, toJson } from "./demo-lib.mjs";

const ROOT = join(import.meta.dirname, "..", "fixtures", "projects", "v1", "clock");

/** 画面は 15×11 タイル。部屋はどれもちょうど 1 画面（スクロールしない）。 */
const SCREEN_W = 15;
const SCREEN_H = 11;
const W = SCREEN_W;
const H = SCREEN_H;
const START = { x: 7, y: 8 };

// ── 部屋 ──────────────────────────────────────────────────────────────
/**
 * 文字の意味：`#` 壁、`.` 石の床、`,` 時計の文様の床（通れる）、`O` 柱（通れない）、`R` 押せる岩、`<` 入口の階段（下の部屋へ戻る・やり直す）、
 * `X` 出口（壁の中の扉。1 行目のみ）、`G` 時計守、`a`〜`e` 番人（`guards` の動き）。入口の階段 `<` の上の (7, 8) が、はじまりの場所。
 *
 * 番人の動き（`acts`）は、1 手ずつの文字：`U` `D` `L` `R` = 歩く、`.` = 待つ、`u` `d` `l` `r` = その向きを向いて待つ。
 * 空白は無視する。ルートはこれの繰り返し。`dir` は最初の向き（`acts` が向きを変えて待つ番人は、最後の向きにそろえる）。`sight` は視界の長さ（タイル数）。
 */
const ROOMS = [
  {
    id: "map_hall",
    name: "時計塔のロビー",
    next: "map_r1",
    plan: [
      "###############",
      "#######X#######",
      "#,,,,,,,,,,,,,#",
      "#,............#",
      "#,.....G......#",
      "#,............#",
      "#,.O.......O.,#",
      "#,............#",
      "#,............#",
      "#,............#",
      "###############",
    ],
  },
  {
    id: "map_r1",
    name: "第一の間 ふりこの廊下",
    prev: "map_hall",
    next: "map_r2",
    plan: [
      "###############",
      "#######X#######",
      "#.............#",
      "#.............#",
      "#.OOO.....OOO.#",
      "#a............#",
      "#.OOO.....OOO.#",
      "#.............#",
      "#.............#",
      "#......<......#",
      "###############",
    ],
    guards: { a: { kind: "pendulum", dir: "right", sight: 5, acts: "RRRRRRRRRRRR LLLLLLLLLLLL" } },
  },
  {
    id: "map_r2",
    name: "第二の間 すれちがい",
    prev: "map_r1",
    next: "map_r3",
    plan: [
      "###############",
      "###########X###",
      "#...........b.#",
      "#.......O....O#",
      "#.......O.....#",
      "#......a......#",
      "#.............#",
      "#.....O.......#",
      "#.O...........#",
      "#......<......#",
      "###############",
    ],
    guards: {
      a: { kind: "pendulum", dir: "right", sight: 3, acts: "RRLL" },
      b: { kind: "pendulum", dir: "left", sight: 4, acts: "LLLRRR" },
    },
  },
  {
    id: "map_r3",
    name: "第三の間 石かげの見張り",
    prev: "map_r2",
    next: "map_r4",
    plan: [
      "###############",
      "###########X###",
      "#............a#",
      "#.##.##########",
      "#.............#",
      "#...R.........#",
      "#.............#",
      "#.O.........O.#",
      "#.............#",
      "#......<......#",
      "###############",
    ],
    guards: { a: { kind: "sentry", dir: "left", sight: 12, acts: "l" } },
  },
  {
    id: "map_r4",
    name: "第四の間 大時計の心臓",
    prev: "map_r3",
    final: true,
    plan: [
      "###############",
      "###X###########",
      "#b......R....##",
      "###########.###",
      "#............a#",
      "#.##.##########",
      "#.............#",
      "#...R.......c.#",
      "#.............#",
      "#......<......#",
      "###############",
    ],
    guards: {
      a: { kind: "sentry", dir: "left", sight: 12, acts: "l" },
      b: { kind: "sentry", dir: "right", sight: 12, acts: "r" },
      c: { kind: "pendulum", dir: "left", sight: 4, acts: "LLLLL.RRRRR." },
    },
  },
];

const T = { floor: 1, ring: 2, wallTop: 3, wallFace: 4, clock: 5, lamp: 6, pillar: 7, stairs: 8, door: 9 };
const CELLS = 10;
/** 通れるのは床・階段・扉だけ。壁・柱は通れない。 */
const PASSABLE = new Set([0, T.floor, T.ring, T.stairs, T.door]);
const PASSAGE = Array.from({ length: CELLS }, (_, id) => (PASSABLE.has(id) ? 15 : 0));

const KINDS = {
  pendulum: { name: "ふりこ兵", look: 1 },
  sentry: { name: "石の見張り", look: 2 },
};
const SHEET = { master: 0, soldier: 1, sentry: 2 };

const DIRS = { U: "up", D: "down", L: "left", R: "right" };
const FACES = { u: "up", d: "down", l: "left", r: "right" };
/** 番人の動きの文字列を、移動ルートの steps にする。向きを変えて待つ `u d l r` は「待つ → 向きを変える」（`turn` は待ったすぐあとに置く）。 */
function stepsOf(acts) {
  const out = [];
  for (const ch of acts.replace(/\s+/g, "")) {
    if (DIRS[ch] !== undefined) out.push({ kind: "move", dir: DIRS[ch] });
    else if (ch === ".") out.push({ kind: "wait", frames: 1 });
    else if (FACES[ch] !== undefined) out.push({ kind: "wait", frames: 1 }, { kind: "turn", dir: FACES[ch] });
    else throw new Error(`知らない動き: ${ch}`);
  }
  return out;
}

/** 間取りを読む：床の計画と、印の位置。 */
function readPlan(room) {
  const { plan } = room;
  if (plan.length !== H || plan.some((row) => row.length !== W)) throw new Error(`${room.id}: 間取りは ${W}×${H}`);
  const marks = { exit: [], stairs: [], master: [], rock: [], guard: [] };
  const rows = plan.map((row, y) =>
    [...row].map((ch, x) => {
      if (ch === "X") marks.exit.push({ x, y, ch });
      else if (ch === "<") marks.stairs.push({ x, y, ch });
      else if (ch === "G") marks.master.push({ x, y, ch });
      else if (ch === "R") marks.rock.push({ x, y, ch });
      else if (/[a-e]/.test(ch)) marks.guard.push({ x, y, ch });
      else if (!"#.,O".includes(ch)) throw new Error(`${room.id}: 知らない文字 ${ch}`);
      return ch;
    }),
  );
  if (marks.exit.length !== 1 || marks.exit[0].y !== 1) throw new Error(`${room.id}: 出口 X は 1 行目に 1 つ`);
  if (room.id !== "map_hall" && (marks.stairs.length !== 1 || marks.stairs[0].x !== START.x || marks.stairs[0].y !== START.y + 1)) throw new Error(`${room.id}: 階段 < は (${START.x}, ${START.y + 1})`);
  if (plan[START.y][START.x] !== "." && plan[START.y][START.x] !== ",") throw new Error(`${room.id}: はじまりの場所 (${START.x}, ${START.y}) が空いていない`);
  for (const g of marks.guard) if (room.guards?.[g.ch] === undefined) throw new Error(`${room.id}: 番人 ${g.ch} の動きが無い`);
  // 壁の正面（顔）：床の北にある壁
  const FACE = new Set(["#", "X"]);
  for (let y = 0; y < H - 1; y++) for (let x = 0; x < W; x++) if (rows[y][x] === "#" && y >= 1 && !FACE.has(rows[y + 1][x])) rows[y][x] = "F";
  return { rows, ...marks };
}

const FLOOR_CHARS = new Set([".", ",", "R", "<", "G", "a", "b", "c", "d", "e", "X", "O"]);

function buildLayers(rows, id) {
  const ground = [];
  const objects = [];
  rows.forEach((row, y) =>
    row.forEach((ch, x) => {
      let g = 0;
      let o = 0;
      if (ch === "#") g = T.wallTop;
      else if (ch === "F") g = y === 1 && (x + y) % 7 === 3 ? T.clock : (x * 3 + y) % 6 === 1 ? T.lamp : T.wallFace;
      else if (ch === "X") g = T.door;
      else if (ch === "<") g = T.stairs;
      else if (ch === ",") g = T.ring;
      else if (FLOOR_CHARS.has(ch)) g = T.floor;
      else throw new Error(`${id}: 知らない文字 ${ch}`);
      if (ch === "O") o = T.pillar;
      ground.push(g);
      objects.push(o);
    }),
  );
  return [{ name: "ground", tiles: ground }, { name: "objects", tiles: objects }];
}

// ── タイルセット ──────────────────────────────────────────────────────
const SLATE = [60, 64, 88];
const BRASS = [204, 156, 72];
const WALL = [74, 70, 96];

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
    const ring = (cx, cy, r0, r1, c) => {
      for (let j = -r1; j <= r1; j++) for (let i = -r1; i <= r1; i++) {
        const d = i * i + j * j;
        if (d <= r1 * r1 && d >= r0 * r0) set(cx + i, cy + j, c);
      }
    };
    const ellipse = (cx, cy, rx, ry, c) => {
      for (let j = -ry; j <= ry; j++) for (let i = -rx; i <= rx; i++) if ((i * i) / (rx * rx) + (j * j) / (ry * ry) <= 1) set(cx + i, cy + j, c);
    };
    return { set, rect, disc, ring, ellipse };
  };

  const slab = (c, seed) => {
    c.rect(0, 0, TILE, TILE, SLATE);
    c.rect(0, 0, TILE, 1, shade(SLATE, 22));
    c.rect(0, 0, 1, TILE, shade(SLATE, 14));
    c.rect(0, TILE - 1, TILE, 1, shade(SLATE, -22));
    c.rect(TILE - 1, 0, 1, TILE, shade(SLATE, -16));
    const rnd = lcg(seed);
    for (let i = 0; i < 14; i++) c.set(2 + rnd() * 28, 2 + rnd() * 28, shade(SLATE, rnd() < 0.5 ? 9 : -10));
  };
  /** 壁の正面（レンガに真鍮の帯）。時計・燭台・扉はこの上に描く。 */
  const wallFace = (c) => {
    c.rect(0, 0, TILE, TILE, WALL);
    for (let y = 0; y < 24; y += 8) {
      c.rect(0, y, TILE, 1, shade(WALL, -30));
      const off = (y / 8) % 2 === 0 ? 0 : 8;
      for (let x = off; x < TILE; x += 16) c.rect(x, y, 1, 8, shade(WALL, -30));
      c.rect(0, y + 1, TILE, 1, shade(WALL, 12));
    }
    c.rect(0, 24, TILE, 8, shade(WALL, -40));
    c.rect(0, 24, TILE, 2, BRASS);
    c.rect(0, 26, TILE, 1, shade(BRASS, -70));
  };

  slab(cell(T.floor), 5);
  // 時計の文様の床
  {
    const c = cell(T.ring);
    slab(c, 6);
    c.ring(16, 16, 11, 13, shade(BRASS, -55));
    c.ring(16, 16, 5, 6, shade(BRASS, -75));
    for (let h = 0; h < 12; h++) {
      const a = (h * Math.PI) / 6;
      c.disc(Math.round(16 + Math.sin(a) * 9), Math.round(16 - Math.cos(a) * 9), 1, shade(BRASS, -40));
    }
    c.rect(16, 9, 1, 8, shade(BRASS, -30));
    c.rect(16, 16, 5, 1, shade(BRASS, -30));
  }
  // 壁の上
  {
    const c = cell(T.wallTop);
    const base = [34, 32, 48];
    c.rect(0, 0, TILE, TILE, base);
    c.rect(0, 0, TILE, 3, shade(base, 22));
    c.rect(0, TILE - 3, TILE, 3, shade(base, -10));
    const rnd = lcg(8);
    for (let i = 0; i < 12; i++) c.set(3 + rnd() * 26, 4 + rnd() * 24, shade(base, rnd() < 0.5 ? 10 : -8));
  }
  wallFace(cell(T.wallFace));
  // 壁の時計
  {
    const c = cell(T.clock);
    wallFace(c);
    c.disc(16, 12, 9, shade(BRASS, -20));
    c.disc(16, 12, 7, [226, 220, 196]);
    for (let h = 0; h < 12; h++) {
      const a = (h * Math.PI) / 6;
      c.set(Math.round(16 + Math.sin(a) * 6), Math.round(12 - Math.cos(a) * 6), [60, 50, 44]);
    }
    c.rect(16, 7, 1, 6, [40, 34, 40]);
    c.rect(16, 12, 4, 1, [40, 34, 40]);
    c.set(16, 12, [200, 60, 60]);
  }
  // 燭台
  {
    const c = cell(T.lamp);
    wallFace(c);
    c.rect(15, 14, 2, 6, [60, 50, 44]);
    c.rect(11, 19, 10, 2, BRASS);
    c.disc(16, 11, 3, [255, 190, 90]);
    c.rect(16, 6, 1, 4, [255, 224, 130]);
    c.set(16, 11, [255, 252, 220]);
  }
  // 柱
  {
    const c = cell(T.pillar);
    c.ellipse(16, 29, 10, 2, [0, 0, 0, 80]);
    c.rect(8, 25, 16, 5, shade(BRASS, -60));
    c.rect(11, 5, 10, 21, [150, 148, 170]);
    c.rect(11, 5, 3, 21, [190, 188, 208]);
    c.rect(19, 5, 2, 21, [112, 110, 134]);
    c.rect(8, 2, 16, 4, shade(BRASS, -30));
    c.rect(8, 2, 16, 1, BRASS);
  }
  // 入口の階段（下へ）
  {
    const c = cell(T.stairs);
    c.rect(0, 0, TILE, TILE, [26, 26, 38]);
    for (let i = 0; i < 4; i++) {
      c.rect(2, 3 + i * 7, 28, 6, shade(SLATE, 14 - i * 10));
      c.rect(2, 3 + i * 7, 28, 1, shade(SLATE, 34 - i * 10));
    }
    c.rect(0, 0, 2, TILE, shade(BRASS, -50));
    c.rect(30, 0, 2, TILE, shade(BRASS, -50));
  }
  // 出口の扉（壁の中の、光るアーチ）
  {
    const c = cell(T.door);
    wallFace(c);
    c.rect(6, 4, 20, 28, [22, 22, 32]);
    c.ellipse(16, 8, 10, 6, [22, 22, 32]);
    c.rect(8, 10, 16, 22, [86, 70, 40]);
    c.ellipse(16, 10, 8, 5, [86, 70, 40]);
    c.rect(10, 12, 12, 20, [236, 208, 128]);
    c.ellipse(16, 12, 6, 4, [236, 208, 128]);
    c.rect(15, 12, 2, 20, [255, 240, 190]);
    c.rect(4, 4, 2, 28, BRASS);
    c.rect(26, 4, 2, 28, BRASS);
  }
  return img;
}

// ── キャラクター・小道具 ──────────────────────────────────────────────
/** 時の番人（からくり人形。1 体 = 3 パターン × 4 方向）。 */
function automaton({ body, eye }) {
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
      c.rect(8, 12, 16, 11, body);
      c.rect(8, 12, 16, 2, shade(body, 30));
      c.rect(8, 21, 16, 2, shade(body, -40));
      c.rect(5, 13, 4, 9, shade(body, -20));
      c.rect(23, 13, 4, 9, shade(body, -20));
      if (dir === "down") {
        c.ellipse(16, 17, 3, 3, BRASS);
        c.set(16, 17, shade(BRASS, -80));
      }
      c.ellipse(16, 8, 7, 7, shade(body, 10));
      c.rect(9, 1, 14, 3, shade(body, 28));
      const slit = [18, 18, 28];
      if (dir === "down") {
        c.rect(10, 8, 12, 3, slit);
        c.rect(11, 9, 3, 1, eye);
        c.rect(18, 9, 3, 1, eye);
      } else if (dir === "left") {
        c.rect(9, 8, 7, 3, slit);
        c.rect(10, 9, 3, 1, eye);
      } else if (dir === "right") {
        c.rect(16, 8, 7, 3, slit);
        c.rect(19, 9, 3, 1, eye);
      } else {
        c.rect(15, 4, 2, 8, shade(body, -30));
        c.set(11, 8, BRASS);
        c.set(21, 8, BRASS);
      }
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
/** 押せる石の箱。 */
const block = () =>
  still((d) => {
    d.ellipse(16, 29, 12, 2, [0, 0, 0, 80]);
    const stone = [132, 130, 150];
    d.rect(4, 6, 24, 23, stone);
    d.rect(4, 6, 24, 3, shade(stone, 30));
    d.rect(4, 6, 2, 23, shade(stone, 14));
    d.rect(26, 6, 2, 23, shade(stone, -34));
    d.rect(4, 27, 24, 2, shade(stone, -50));
    d.ellipse(16, 17, 6, 6, shade(stone, -34));
    d.ellipse(16, 17, 4, 4, BRASS);
    d.ellipse(16, 17, 1, 1, shade(BRASS, -80));
    for (const [x, y] of [[7, 9], [24, 9], [7, 25], [24, 25]]) d.set(x, y, shade(BRASS, -20));
  });
/** 台座の上の時の歯車。 */
const gearPedestal = () =>
  still((d) => {
    d.ellipse(16, 29, 12, 2, [0, 0, 0, 80]);
    d.rect(8, 20, 16, 9, [120, 118, 140]);
    d.rect(8, 20, 16, 2, [176, 174, 196]);
    d.rect(10, 28, 12, 1, [70, 68, 90]);
    d.ellipse(16, 12, 9, 9, [255, 224, 130, 90]);
    d.ellipse(16, 12, 7, 7, BRASS);
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      d.ellipse(Math.round(16 + Math.sin(a) * 8), Math.round(12 - Math.cos(a) * 8), 2, 2, BRASS);
    }
    d.ellipse(16, 12, 3, 3, [60, 50, 44]);
    d.ellipse(16, 12, 1, 1, [255, 240, 190]);
  });
const PROPS = { block: 0, gear: 1 };

// ── イベント ──────────────────────────────────────────────────────────
const transfer = (mapId, x, y, dir, indent = 0) => cmd("TransferPlayer", { mapId, x, y, dir, fade: "black" }, indent);

function events(room, layout, assets, rooms) {
  const people = assets["people.png"].id;
  const props = (name) => ({ asset: assets["props.png"].id, index: PROPS[name], direction: "down" });
  const out = [];
  const exit = layout.exit[0];
  const next = room.next;
  const here = room.id;

  // 出口：次の部屋へ（最後の部屋は、歯車を取って終わり）
  if (room.final) {
    out.push(
      event("ev_exit", "時の歯車", exit, [
        page({
          trigger: "touch",
          through: true,
          priority: "below",
          graphic: props("gear"),
          commands: [
            flash({ r: 255, g: 230, b: 150, a: 0.7 }, 40),
            text("台座の 上で 金色の 歯車が かすかに 回っている。\n\\C[6]時の歯車\\C[0]を 手に とった！"),
            text("カチ、コチ、コチ……。塔の 底から 大時計の 音が ひびきはじめた。\n町の 時が 動き出す。\\C[6]おめでとう！\\C[0]"),
            text("つかまった 回数：\\V[var_caught]回"),
            cmd("ReturnToTitle", {}),
          ],
        }),
      ]),
    );
  } else {
    out.push(
      event("ev_exit", "出口の扉", exit, [
        page({ trigger: "touch", through: true, priority: "below", commands: [transfer(next, START.x, START.y, "up")] }),
      ]),
    );
  }

  // 入口の階段：やり直す（第一の間だけは、ロビーへ戻ることもできる）
  if (layout.stairs.length === 1) {
    const s = layout.stairs[0];
    const back = room.prev === "map_hall";
    const choices = [...(back ? ["ロビーへ もどる"] : []), "この 部屋を はじめから やりなおす", "やめる"];
    const cancel = choices.length - 1;
    const branches = [];
    choices.forEach((_, i) => {
      branches.push(cmd("ChoiceBranch", { index: i }));
      if (back && i === 0) branches.push(transfer("map_hall", rooms.find((r) => r.id === "map_hall").exitPos.x, 2, "down", 1));
      else if (i === cancel - 1) branches.push(transfer(here, START.x, START.y, "up", 1));
    });
    out.push(
      event("ev_stairs", "入口の階段", s, [
        page({
          trigger: "touch",
          commands: [text("下へ おりる 階段だ。"), cmd("ShowChoices", { choices, cancel }), ...branches, cmd("EndBranch", {})],
        }),
      ]),
    );
  }

  // はじめに一度だけ（ロビー）
  if (room.id === "map_hall") {
    out.push(
      event("ev_intro", "はじまり", { x: START.x, y: START.y }, [
        page({
          trigger: "autorun",
          priority: "below",
          through: true,
          commands: [
            text("止まった 大時計の 塔。町じゅうの 時が 止まったままだ。\n塔の てっぺんに ある \\C[6]時の歯車\\C[0]を 取りもどそう。"),
            text("ここの 番人は、あなたが 動いたときだけ 動くらしい。\n（まずは 時計守に 話しかけてみよう）"),
            cmd("ControlSelfSwitch", { key: "A", value: true }),
          ],
        }),
        page({ conditions: [{ kind: "selfSwitch", key: "A", value: true }], priority: "below", through: true, commands: [] }),
      ]),
    );
  }

  // 時計守（ロビー）
  if (layout.master.length === 1) {
    const tips = [
      ["塔の 番人は 時の とまった からくり人形じゃ。\nあなたが 1歩 歩くたびに、番人も 1歩 だけ 動く。", "足を とめれば 番人も とまる。\n時間では 動かん。あなたの 手が 時を 進めるんじゃ。"],
      ["その場で 待ちたいときは \\C[6]決定ボタン\\C[0]。\n1回 押すと、あなたは 動かず 番人だけが 1歩 動く。", "番人の 動きの 順番は 決まっておる。\nしばらく 見て、通りぬける すきを 見つけるんじゃ。"],
      ["番人の 視界は むいている 方向の まっすぐ 数マス。\n柱や 壁の かげには 入らん。うしろも 見えん。", "\\C[6]石の箱\\C[0]は 押して 動かせる。\n番人の 視界を さえぎるのに つかえるぞ。ただし 引くことは できん。"],
      ["見つかっても 命までは とられん。部屋の 入口に 戻されるだけじゃ。\n番人も 箱も 最初の 位置から やり直しになる。", "箱を 動かしすぎて 詰んだら、入口の 階段で \\C[6]やりなおし\\C[0]が できる。"],
    ];
    out.push(
      event("ev_master", "時計守", layout.master[0], [
        page({
          graphic: { asset: people, index: SHEET.master, direction: "down" },
          commands: [
            text("おお、よく 来てくれた。\n大時計が 止まってから、町じゅうの 時が 止まったままじゃ。"),
            text("原因は 塔の さいじょうかい、\\C[6]時の歯車\\C[0]が 取られたこと。\n番人の 目を かいくぐって、4つの 部屋を のぼっておくれ。"),
            cmd("ShowChoices", { choices: ["番人の 動き", "待ちかた", "視界と 箱", "つかまったら", "やめる"], cancel: 4 }),
            ...tips.flatMap(([a, b], i) => [cmd("ChoiceBranch", { index: i }), text(a, 1), text(b, 1)]),
            cmd("ChoiceBranch", { index: 4 }),
            cmd("EndBranch", {}),
            text("つかまった 回数は \\V[var_caught]回 じゃな。\n奥の 扉から 塔へ 入れるぞ。気を つけてな。"),
          ],
        }),
      ]),
    );
  }

  // 石の箱（押せる）
  layout.rock.forEach((pos, i) => {
    out.push(
      event(`ev_rock_${i + 1}`, "石の箱", pos, [
        page({
          trigger: "touch",
          graphic: props("block"),
          pushable: true,
          commands: [],
        }),
      ]),
    );
  });

  // 番人：視界に入ったら、あるいは歩く先に居たら、つかまって部屋の入口へ
  layout.guard.forEach((g) => {
    const spec = room.guards[g.ch];
    const kind = KINDS[spec.kind];
    const graphic = { asset: people, index: kind.look, direction: spec.dir };
    out.push(
      event(`ev_guard_${g.ch}`, kind.name, g, [
        page({
          graphic,
          trigger: "eventSight",
          sightRange: spec.sight,
          moveRoute: { repeat: true, skippable: true, pace: "playerStep", steps: stepsOf(spec.acts) },
          commands: [
            flash({ r: 220, g: 40, b: 60, a: 0.55 }, 14),
            cmd("ShakeScreen", { power: 5, duration: 18, wait: false }),
            addVar("var_caught", 1),
            text(`\\C[2]${kind.name}\\C[0]に 見つかった！\n部屋の 入口へ 戻される……`),
            transfer(here, START.x, START.y, "up"),
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
  "clock_tileset.png": tileset(),
  "hero.png": character(HERO),
  "people.png": sheet(3, [
    character({ shirt: [168, 140, 96], hair: [236, 236, 240], skin: [232, 190, 150] }),
    automaton({ body: [96, 118, 150], eye: [120, 230, 255] }),
    automaton({ body: [150, 112, 70], eye: [255, 170, 80] }),
  ]),
  "props.png": sheet(2, [block(), gearPedestal()]),
});

mkdirSync(join(ROOT, "maps"), { recursive: true });
for (const { room, layout } of layouts) {
  const map = {
    id: room.id,
    width: W,
    height: H,
    tileset: "ts_clock",
    layers: buildLayers(layout.rows, room.id),
    events: Object.fromEntries(events(room, layout, assets, ROOMS).map((e) => [e.id, e])),
  };
  writeFileSync(join(ROOT, "maps", `${room.id}.json`), toJson(map));
}

const project = {
  formatVersion: 1,
  meta: { id: "clock", title: "デモ：時の番人の回廊", createdAt: "2026-10-02T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z" },
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
  tilesets: { ts_clock: { id: "ts_clock", name: "時計塔", image: { asset: assets["clock_tileset.png"].id }, passage: PASSAGE } },
  database: {
    actors: { actor_hero: { id: "actor_hero", name: "ミナ", classId: "class_hero", initialLevel: 1, walk: { asset: assets["hero.png"].id }, equips: {} } },
    classes: { class_hero: { id: "class_hero", name: "旅人", skills: [], params } },
    skills: {},
    items: {},
    enemies: {},
    troops: {},
    states: {},
    commonEvents: {},
  },
  assets: { entries: Object.fromEntries(Object.entries(assets).map(([name, a]) => [a.id, entry(name, a)])) },
  switches: {},
  variables: { var_caught: { name: "つかまった回数" } },
};
writeFileSync(join(ROOT, "project.json"), toJson(project));
console.log(`\n${ROOMS.length} 部屋：${ROOMS.map((r) => r.name).join(" / ")}`);
