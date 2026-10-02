#!/usr/bin/env node
/**
 * 工場のベルトコンベアのデモ（fixtures/projects/v1/conveyor）を丸ごと生成する開発用スクリプト。
 * 出力: project.json、maps/<MapId>.json、assets/<AssetId>.<ext>（AssetId = 内容の sha256 先頭 16 桁）。
 * 生成物はコミット済み。部屋の作りを変えたいときだけ再実行する（何度実行しても同じものができる）。
 *
 *   node tools/make-conveyor-demo.mjs
 *
 * 止まった「からくり工房」の出荷ラインを動かして、最後の注文品「金のネジ」を出荷台まで届ける。戦闘は無く、ベルトの床を使う空間パズルだけ。
 * 見せたいエンジンの機能：
 * 1. ベルトコンベア（`Tileset.conveyor`）：矢印の床。歩いて着いたプレイヤーと、その上にある押せる箱（`pushable`）が、矢印の向きに運ばれる。
 *    プレイヤーが 1 歩を歩き出す（押す）たびに、ベルトの上の箱が 1 タイル進む。ベルトに着いたプレイヤーは、ベルトに着き続ける限り
 *    運ばれる（その間は操作できない）。箱とプレイヤーはいっせいに動き、同じタイルを目指したらイベントの定義順で先のものが動く。
 * 2. ベルトの向きの切り替え：新しいしくみは無く、レバーのイベントが `ChangeMapTile` でタイルを矢印の向きの違うものに入れ替えるだけ。
 * 3. 出荷口：並列イベントが毎フレーム、箱が出荷口のタイルに載ったかを `evx()` / `evy()` で調べて、箱を出荷して（消して）スイッチを入れる。
 *    すべての出荷口にとどけると、出口のシャッターが開く。
 * 4. 詰みとやり直し：箱を出荷口に届けられない位置へ動かした（隅に押しこんだ、同じ出荷口に 2 つ送った、など）ときは、入口の階段から
 *    「やりなおす」で、箱もレバーもスイッチも最初に戻る。
 * 部屋の手順は、apps/player の conveyor-model.testkit.ts のソルバ（BFS）で求めて、実際のエンジンで再生して確かめている（conveyor-fixture.test.ts）。
 * このデモはダッシュ（`system.dash`）を使わない。ベルトの速さ = 歩く速さ。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blit, canvas, character, HERO, image, lcg, shade, sheet, TILE, writeAssets } from "./pixel-art.mjs";

const ROOT = join(import.meta.dirname, "..", "fixtures", "projects", "v1", "conveyor");

/** 画面は 15×11 タイル。部屋はどれもちょうど 1 画面（スクロールしない）。 */
const SCREEN_W = 15;
const SCREEN_H = 11;
const W = SCREEN_W;
const H = SCREEN_H;
const START = { x: 7, y: 8 };

// ── 部屋 ──────────────────────────────────────────────────────────────
/**
 * 文字の意味：`#` 壁、`.` 床、`:` 奈落（通れない）、`→ ← ↑ ↓` ベルト、`B` 床の上の箱、`e w n s` ベルト（→ ← ↑ ↓）の上の箱、
 * `D` 出荷口（ただの床。箱が載ると出荷される）、`1` `2` レバー、`G` 案内人、`<` 入口の階段（下の部屋へ戻る・やり直す）、`X` 出口（壁の中。1 行目のみ）。
 * 入口の階段 `<` の上の (7, 8) が、はじまりの場所。レバー `n` の `flip` は、引くと矢印が逆向きになるベルトの範囲。
 */
const ROOMS = [
  {
    id: "map_hall",
    name: "工房のロビー",
    next: "map_r1",
    plan: [
      "###############",
      "#######X#######",
      "#.............#",
      "#.............#",
      "#......G......#",
      "#.............#",
      "#..→→→........#",
      "#.............#",
      "#.............#",
      "#.............#",
      "###############",
    ],
  },
  {
    id: "map_r1",
    name: "第一工区 乗りつぎ",
    prev: "map_hall",
    next: "map_r2",
    hint: ["ベルトの 上に 着くと、勝手に 運ばれる。運ばれている間は 動けない。", "橋は ベルトだけ。乗る場所と、降りる場所を 考えよう。"],
    plan: [
      "###############",
      "#######X#######",
      "######...::...#",
      "######...::...#",
      "######↑↓:::↓↑↑#",
      "######...::...#",
      "######...←←...#",
      "######↓::::::↑#",
      "######...→→...#",
      "######.<.::...#",
      "###############",
    ],
  },
  {
    id: "map_r2",
    name: "第二工区 積み出し",
    prev: "map_r1",
    next: "map_r3",
    hint: ["箱は 押して ベルトに のせる。歩くたびに、ベルトの上の 箱が 1タイル 進む。", "出荷口は 奥の 壁ぎわ。箱が 着くと、シャッターが 開く。"],
    plan: [
      "###############",
      "#######X#######",
      "#.............#",
      "#..##.D←←←←←←##",
      "#.....######↑##",
      "#..........#↑##",
      "#..........#↑##",
      "#..B.......#↑##",
      "#...........↑##",
      "#......<....###",
      "###############",
    ],
  },
  {
    id: "map_r3",
    name: "第三工区 仕分けのレバー",
    prev: "map_r2",
    next: "map_r4",
    hint: ["出荷口は 左右に ひとつずつ。どちらにも 箱が 1つ ずつ 要る。", "分かれ道の ベルトは、レバーで 向きが 入れかわる。"],
    levers: { 1: { flip: [{ x: 9, y: 4, w: 1, h: 1 }] } },
    plan: [
      "###############",
      "#######X#######",
      "#.............#",
      "#..#########..#",
      "#.D←←←←←←←→→D.#",
      "#.#######↑###.#",
      "#.........1...#",
      "#....B...↑....#",
      "#........↑..B.#",
      "#......<......#",
      "###############",
    ],
  },
  {
    id: "map_r4",
    name: "第四工区 最終ライン",
    prev: "map_r3",
    final: true,
    hint: ["レバーは 2つ。ひとつは 分かれ道、もうひとつは 右の ベルトの 向き。", "引く 順番を まちがえると、2つの箱が 同じ 出荷口に 入って 詰む。"],
    levers: { 1: { flip: [{ x: 9, y: 4, w: 1, h: 1 }] }, 2: { flip: [{ x: 10, y: 7, w: 4, h: 1 }] } },
    plan: [
      "###############",
      "#######X#######",
      "#.............#",
      "#..#########..#",
      "#.D←←←←←←←→→D.#",
      "#.#######↑###.#",
      "#......B..#..2#",
      "#.....#..↑→→e→#",
      "#1.......↑....#",
      "#......<......#",
      "###############",
    ],
  },
];

const T = { floor: 1, plate: 2, wallTop: 3, wallFace: 4, right: 5, left: 6, down: 7, up: 8, dock: 9, stairs: 10, door: 11, pit: 12 };
const CELLS = 13;
const BELT_TILE = { "→": T.right, "←": T.left, "↓": T.down, "↑": T.up };
const BELT_DIR = { [T.right]: "right", [T.left]: "left", [T.down]: "down", [T.up]: "up" };
const OPPOSITE = { "→": "←", "←": "→", "↑": "↓", "↓": "↑" };
/** 箱が載ったベルト。 */
const BOX_ON_BELT = { e: "→", w: "←", n: "↑", s: "↓" };
/** 通れないのは、壁・奈落だけ。 */
const IMPASSABLE = new Set([T.wallTop, T.wallFace, T.pit]);
const PASSAGE = Array.from({ length: CELLS }, (_, id) => (IMPASSABLE.has(id) ? 0 : 15));

/** 間取りを読む：床の計画と、印の位置。 */
function readPlan(room) {
  const { plan } = room;
  if (plan.length !== H || plan.some((row) => row.length !== W)) throw new Error(`${room.id}: 間取りは ${W}×${H}`);
  const marks = { exit: [], stairs: [], guide: [], box: [], dock: [], lever: {} };
  const rows = plan.map((row, y) =>
    [...row].map((ch, x) => {
      if (ch === "X") marks.exit.push({ x, y });
      else if (ch === "<") marks.stairs.push({ x, y });
      else if (ch === "G") marks.guide.push({ x, y });
      else if (ch === "B") marks.box.push({ x, y });
      else if (ch in BOX_ON_BELT) marks.box.push({ x, y });
      else if (ch === "D") marks.dock.push({ x, y });
      else if (ch === "1" || ch === "2") marks.lever[ch] = { x, y };
      else if (!"#.:→←↑↓".includes(ch)) throw new Error(`${room.id}: 知らない文字 ${ch}`);
      return BOX_ON_BELT[ch] ?? ch;
    }),
  );
  if (marks.exit.length !== 1 || marks.exit[0].y !== 1) throw new Error(`${room.id}: 出口 X は 1 行目に 1 つ`);
  if (room.id !== "map_hall" && (marks.stairs.length !== 1 || marks.stairs[0].x !== START.x || marks.stairs[0].y !== START.y + 1)) throw new Error(`${room.id}: 階段 < は (${START.x}, ${START.y + 1})`);
  if (!".".includes(plan[START.y][START.x])) throw new Error(`${room.id}: はじまりの場所 (${START.x}, ${START.y}) が空いていない`);
  const levers = Object.keys(marks.lever).sort();
  for (const k of Object.keys(room.levers ?? {})) if (marks.lever[k] === undefined) throw new Error(`${room.id}: レバー ${k} が間取りに無い`);
  if (marks.dock.length > 0 && marks.box.length < marks.dock.length) throw new Error(`${room.id}: 箱が出荷口より少ない`);
  // レバーが切り替えるベルト：範囲はすべてベルト
  const flips = {};
  for (const k of levers) {
    const cells = [];
    for (const r of room.levers?.[k]?.flip ?? []) {
      for (let j = 0; j < r.h; j++) for (let i = 0; i < r.w; i++) {
        const ch = rows[r.y + j][r.x + i];
        if (!(ch in OPPOSITE)) throw new Error(`${room.id}: レバー ${k} の範囲 (${r.x + i}, ${r.y + j}) がベルトでない`);
        cells.push({ x: r.x + i, y: r.y + j, from: BELT_TILE[ch], to: BELT_TILE[OPPOSITE[ch]] });
      }
    }
    flips[k] = cells;
  }
  const cellsOf = Object.values(flips).flat().map((c) => `${c.x},${c.y}`);
  if (new Set(cellsOf).size !== cellsOf.length) throw new Error(`${room.id}: レバーの範囲が重なっている（モデルはレバーの範囲が重ならないことを前提にする）`);
  // 壁の正面（顔）：床の北にある壁
  const FACE = new Set(["#", "X"]);
  for (let y = 0; y < H - 1; y++) for (let x = 0; x < W; x++) if (rows[y][x] === "#" && y >= 1 && !FACE.has(rows[y + 1][x])) rows[y][x] = "F";
  return { rows, ...marks, flips, leverKeys: levers };
}

function buildLayers(rows, id, hall) {
  const ground = rows.flatMap((row, y) =>
    row.map((ch, x) => {
      if (ch === "#") return T.wallTop;
      if (ch === "F") return T.wallFace;
      if (ch === "X") return T.door;
      if (ch === "<") return T.stairs;
      if (ch === ":") return T.pit;
      if (ch === "D") return T.dock;
      if (ch in BELT_TILE) return BELT_TILE[ch];
      // 床（ロビーは市松に模様）
      return hall && (x + y) % 2 === 0 ? T.plate : T.floor;
    }),
  );
  if (ground.length !== W * H) throw new Error(`${id}: 床のタイルの数`);
  return [{ name: "ground", tiles: ground }];
}

// ── タイルセット ──────────────────────────────────────────────────────
const STEEL = [74, 82, 98];
const RUBBER = [38, 40, 48];
const SAFETY = [236, 170, 48];
const WALL = [62, 68, 84];

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
    return { set, rect, disc };
  };

  /** 鉄板の床（リベット付き）。 */
  const plate = (c, seed, tone = 0) => {
    const base = shade(STEEL, tone);
    c.rect(0, 0, TILE, TILE, base);
    c.rect(0, 0, TILE, 1, shade(base, 20));
    c.rect(0, 0, 1, TILE, shade(base, 12));
    c.rect(0, TILE - 1, TILE, 1, shade(base, -22));
    c.rect(TILE - 1, 0, 1, TILE, shade(base, -16));
    for (const [x, y] of [[3, 3], [28, 3], [3, 28], [28, 28]]) {
      c.disc(x, y, 1, shade(base, -34));
      c.set(x - 1, y - 1, shade(base, 28));
    }
    const rnd = lcg(seed);
    for (let i = 0; i < 12; i++) c.set(5 + rnd() * 22, 5 + rnd() * 22, shade(base, rnd() < 0.5 ? 7 : -9));
  };
  plate(cell(T.floor), 11);
  plate(cell(T.plate), 12, 10);

  // 壁の上・正面（波板に黄色の帯）
  {
    const c = cell(T.wallTop);
    const base = [30, 34, 46];
    c.rect(0, 0, TILE, TILE, base);
    c.rect(0, 0, TILE, 3, shade(base, 20));
    c.rect(0, TILE - 3, TILE, 3, shade(base, -8));
    const rnd = lcg(14);
    for (let i = 0; i < 12; i++) c.set(3 + rnd() * 26, 4 + rnd() * 24, shade(base, rnd() < 0.5 ? 9 : -7));
  }
  /** 壁の正面。扉・シャッターの穴はこの上に描く。 */
  const wallFace = (c) => {
    c.rect(0, 0, TILE, TILE, WALL);
    for (let x = 0; x < TILE; x += 4) {
      c.rect(x, 0, 1, 24, shade(WALL, -22));
      c.rect(x + 1, 0, 1, 24, shade(WALL, 12));
    }
    c.rect(0, 24, TILE, 8, shade(WALL, -34));
    for (let x = -8; x < TILE; x += 8) for (let y = 0; y < 6; y++) c.rect(x + y, 24 + y, 4, 1, y % 2 === 0 ? SAFETY : [30, 30, 30]);
    c.rect(0, 30, TILE, 2, shade(WALL, -50));
  };
  wallFace(cell(T.wallFace));

  // ベルト：右向きを描いて、回して 4 方向にする
  {
    const right = image(TILE, TILE);
    right.rect(0, 0, TILE, TILE, RUBBER);
    // 長い辺の黄色いレール
    right.rect(0, 0, TILE, 4, shade(SAFETY, -40));
    right.rect(0, 4, TILE, 1, shade(SAFETY, -90));
    right.rect(0, TILE - 4, TILE, 4, shade(SAFETY, -40));
    right.rect(0, TILE - 5, TILE, 1, shade(SAFETY, -90));
    right.rect(0, 0, TILE, 1, SAFETY);
    right.rect(0, TILE - 1, TILE, 1, SAFETY);
    // ゴムの溝
    for (let x = 1; x < TILE; x += 8) right.rect(x, 5, 1, TILE - 10, shade(RUBBER, 12));
    // 矢印（>）
    for (const x0 of [3, 17]) {
      for (let k = 0; k < 7; k++) {
        right.rect(x0 + k, 8 + k, 3, 2, [168, 176, 190]);
        right.rect(x0 + k, 22 - k, 3, 2, [168, 176, 190]);
      }
      right.rect(x0 + 7, 15, 3, 2, [168, 176, 190]);
    }
    const out = (id, map) => {
      for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
        const [sx, sy] = map(x, y);
        const col = right.get(sx, sy);
        if (col[3] > 0) img.set(id * TILE + x, y, col);
      }
    };
    out(T.right, (x, y) => [x, y]);
    out(T.left, (x, y) => [TILE - 1 - x, y]);
    // 下向き: 右向きを時計回りに 90° 回す（出力 (x, y) は元の (y, TILE-1-x)）
    out(T.down, (x, y) => [y, TILE - 1 - x]);
    out(T.up, (x, y) => [TILE - 1 - y, x]);
  }

  // 出荷口：黄黒のふちの穴（箱が落ちる）
  {
    const c = cell(T.dock);
    plate(c, 17, -6);
    // ふち（斜めの黄黒）
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const edge = x < 4 || y < 4 || x >= TILE - 4 || y >= TILE - 4;
      if (edge) c.set(x, y, Math.floor((x + y) / 4) % 2 === 0 ? SAFETY : [28, 28, 28]);
    }
    c.rect(4, 4, 24, 24, [14, 14, 20]);
    c.rect(4, 4, 24, 2, [30, 30, 40]);
    // 中の下向きの矢印
    for (let k = 0; k < 6; k++) {
      c.rect(10 + k, 16 + k, 2, 2, [236, 170, 48]);
      c.rect(21 - k, 16 + k, 2, 2, [236, 170, 48]);
    }
    c.rect(15, 8, 2, 12, [236, 170, 48]);
  }

  // 入口の階段（下へ）
  {
    const c = cell(T.stairs);
    c.rect(0, 0, TILE, TILE, [22, 24, 32]);
    for (let i = 0; i < 4; i++) {
      c.rect(2, 3 + i * 7, 28, 6, shade(STEEL, 14 - i * 10));
      c.rect(2, 3 + i * 7, 28, 1, shade(STEEL, 34 - i * 10));
    }
    c.rect(0, 0, 2, TILE, SAFETY);
    c.rect(30, 0, 2, TILE, SAFETY);
  }

  // 出口（壁の中の、開いた出荷口のアーチ）
  {
    const c = cell(T.door);
    wallFace(c);
    c.rect(6, 4, 20, 28, [22, 24, 32]);
    c.rect(8, 6, 16, 26, [16, 16, 22]);
    c.rect(10, 8, 12, 24, [236, 208, 128]);
    c.rect(15, 8, 2, 24, [255, 240, 190]);
    c.rect(4, 4, 2, 28, SAFETY);
    c.rect(26, 4, 2, 28, SAFETY);
    c.rect(4, 2, 24, 3, SAFETY);
  }

  // 奈落：暗い底に、うっすらと格子
  {
    const c = cell(T.pit);
    c.rect(0, 0, TILE, TILE, [10, 12, 18]);
    for (let i = 0; i < TILE; i += 8) {
      c.rect(i, 0, 1, TILE, [20, 24, 34]);
      c.rect(0, i, TILE, 1, [20, 24, 34]);
    }
    c.rect(0, 0, TILE, 2, [4, 4, 8]);
    const rnd = lcg(21);
    for (let i = 0; i < 8; i++) c.set(2 + rnd() * 28, 2 + rnd() * 28, [28, 34, 48]);
  }
  return img;
}

// ── キャラクター・小道具 ──────────────────────────────────────────────
const still = (draw) => {
  const one = canvas(TILE, TILE);
  draw(one);
  const out = image(TILE * 3, TILE * 4);
  for (let row = 0; row < 4; row++) for (let p = 0; p < 3; p++) blit(out, one, p * TILE, row * TILE);
  return out;
};
/** 押せる木箱。 */
const crate = () =>
  still((d) => {
    d.ellipse(16, 29, 12, 2, [0, 0, 0, 80]);
    const wood = [176, 128, 74];
    d.rect(4, 5, 24, 24, wood);
    d.rect(4, 5, 24, 3, shade(wood, 28));
    d.rect(4, 27, 24, 2, shade(wood, -50));
    for (let x = 4; x < 28; x += 6) d.rect(x, 8, 1, 19, shade(wood, -26));
    // 金具の帯と角
    d.rect(4, 15, 24, 3, [88, 94, 110]);
    d.rect(4, 15, 24, 1, [150, 158, 176]);
    for (const [x, y] of [[4, 5], [25, 5], [4, 26], [25, 26]]) d.rect(x, y, 3, 3, [88, 94, 110]);
    d.rect(13, 12, 6, 9, [236, 170, 48]);
    d.rect(14, 13, 4, 7, [30, 30, 30]);
  });
/** レバー（台座から生えた棒）。`on` は引いたあと。 */
const lever = (on) =>
  still((d) => {
    d.ellipse(16, 29, 11, 2, [0, 0, 0, 80]);
    d.rect(7, 20, 18, 9, [96, 104, 122]);
    d.rect(7, 20, 18, 2, [160, 168, 188]);
    d.rect(9, 27, 14, 1, [50, 54, 68]);
    d.rect(12, 21, 8, 2, [30, 32, 42]);
    // 棒
    const tipX = on ? 24 : 8;
    d.line(16, 21, tipX, 9, [190, 196, 210], 1);
    d.disc(tipX, 9, 3, on ? [90, 214, 120] : [230, 80, 70]);
    d.disc(tipX - 1, 8, 1, [255, 255, 255, 140]);
    d.disc(16, 21, 2, [60, 64, 80]);
  });
/** 閉じた出荷口のシャッター（出口の上にかぶせる）。 */
const shutter = () =>
  still((d) => {
    d.rect(5, 3, 22, 29, [22, 24, 32]);
    for (let y = 5; y < 31; y += 4) {
      d.rect(6, y, 20, 3, [128, 136, 154]);
      d.rect(6, y, 20, 1, [180, 188, 206]);
      d.rect(6, y + 2, 20, 1, [76, 82, 100]);
    }
    d.rect(5, 3, 22, 2, SAFETY);
    d.rect(13, 27, 6, 3, [230, 80, 70]);
  });
/** 出荷台の上の金のネジ。 */
const goldScrew = () =>
  still((d) => {
    d.ellipse(16, 29, 12, 2, [0, 0, 0, 80]);
    d.rect(7, 21, 18, 8, [120, 128, 146]);
    d.rect(7, 21, 18, 2, [186, 194, 212]);
    d.ellipse(16, 12, 9, 9, [255, 224, 130, 80]);
    d.rect(10, 6, 12, 4, [236, 190, 70]);
    d.rect(10, 6, 12, 1, [255, 240, 170]);
    d.rect(14, 10, 4, 12, [214, 164, 48]);
    for (let y = 11; y < 21; y += 3) d.rect(13, y, 6, 1, [255, 224, 130]);
    d.rect(15, 7, 2, 2, [150, 100, 20]);
  });
const PROPS = { crate: 0, leverOff: 1, leverOn: 2, shutter: 3, screw: 4 };

// ── イベント ──────────────────────────────────────────────────────────
const cmd = (code, params, indent = 0) => ({ code, params, indent });
const text = (t, indent = 0) => cmd("ShowText", { text: t, position: "bottom", background: "window" }, indent);
const page = (p) => ({ conditions: [], trigger: "action", through: false, priority: "same", ...p });
const hidden = (p) => page({ trigger: "parallel", through: true, priority: "below", ...p });
const event = (id, name, { x, y }, pages) => ({ id, name, x, y, pages });
const sw = (id, value = true) => ({ kind: "switch", id, value });
const setSwitch = (ids, value, indent = 0) => cmd("ControlSwitches", { ids: [].concat(ids), value }, indent);
const ifExpr = (expr, indent = 0) => cmd("ConditionalBranch", { condition: expr }, indent);
const endBranch = (indent = 0) => cmd("EndBranch", {}, indent);
const flash = (color, duration, indent = 0) => cmd("FlashScreen", { color, duration }, indent);
const shake = (power, duration, indent = 0) => cmd("ShakeScreen", { power, duration, wait: false }, indent);
const transfer = (mapId, x, y, dir, indent = 0) => cmd("TransferPlayer", { mapId, x, y, dir, fade: "black" }, indent);
const FLASH_STEEL = { r: 200, g: 220, b: 255, a: 0.5 };
const FLASH_GOLD = { r: 255, g: 224, b: 130, a: 0.7 };

const LEVER = (room, k) => `sw_lever_${room.id}_${k}`;
const DOCK = (room, n) => `sw_dock_${room.id}_${n}`;
const GONE = (room, n) => `sw_gone_${room.id}_${n}`;
const OPEN = (room) => `sw_open_${room.id}`;
/** ChangeMapTile で、同じ行に続く同じタイルをまとめる。 */
function retile(cells, pick) {
  const out = [];
  const sorted = [...cells].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const c of sorted) {
    const last = out.at(-1);
    if (last !== undefined && last.y === c.y && last.x + last.w === c.x && last.tile === pick(c)) last.w += 1;
    else out.push({ x: c.x, y: c.y, w: 1, tile: pick(c) });
  }
  return out.map((r) => cmd("ChangeMapTile", { map: "this", layer: 0, x: r.x, y: r.y, width: r.w, height: 1, tile: r.tile }));
}

function events(room, layout, assets) {
  const people = assets["people.png"].id;
  const props = (name) => ({ asset: assets["props.png"].id, index: PROPS[name], direction: "down" });
  const out = [];
  const exit = layout.exit[0];
  const here = room.id;
  const docks = layout.dock;
  const boxes = layout.box;
  const locked = docks.length > 0;

  // 出口：次の部屋へ（最後の部屋は、金のネジを出荷台に置いて終わり）
  const enter = room.final
    ? [
        flash(FLASH_GOLD, 40),
        shake(3, 30),
        text("出荷台の 上で 金のネジが 光っている。\n\\C[6]金のネジ\\C[0]を 出荷口へ のせた！"),
        text("ガタン、ゴトン……。止まっていた 出荷ラインが すべて 動きはじめた。\n工房に 活気が もどる。\\C[6]おめでとう！\\C[0]"),
        cmd("ReturnToTitle", {}),
      ]
    : [transfer(room.next, START.x, START.y, "up")];
  const openPage = page({ conditions: locked ? [sw(OPEN(room))] : [], trigger: "touch", through: true, priority: "below", ...(room.final ? { graphic: props("screw") } : {}), commands: enter });
  out.push(
    event(
      "ev_exit",
      room.final ? "出荷台" : "出口",
      exit,
      locked
        ? [page({ conditions: [sw(OPEN(room), false)], graphic: props("shutter"), commands: [text("出荷口の シャッターが 閉じている。\n全部の 出荷口に 積み荷を 届けると、開くようだ。")] }), openPage]
        : [openPage],
    ),
  );

  // 入口の階段：やり直す（第一工区だけは、ロビーへ戻ることもできる）
  if (layout.stairs.length === 1) {
    const s = layout.stairs[0];
    const back = room.prev === "map_hall";
    const choices = [...(back ? ["ロビーへ もどる"] : []), "この 工区を はじめから やりなおす", "ヒントを 読む", "やめる"];
    const redo = back ? 1 : 0;
    const resetCmds = [
      ...layout.leverKeys.flatMap((k) => [setSwitch(LEVER(room, k), false, 1), ...retile(layout.flips[k], (c) => c.from).map((c) => ({ ...c, indent: 1 }))]),
      ...docks.map((_, n) => setSwitch([DOCK(room, n + 1)], false, 1)),
      ...boxes.map((_, n) => setSwitch(GONE(room, n + 1), false, 1)),
      ...(locked ? [setSwitch(OPEN(room), false, 1)] : []),
    ];
    const branches = [];
    choices.forEach((_, i) => {
      branches.push(cmd("ChoiceBranch", { index: i }));
      if (back && i === 0) branches.push(transfer("map_hall", 7, 2, "down", 1));
      else if (i === redo) branches.push(...resetCmds, transfer(here, START.x, START.y, "up", 1));
      else if (i === redo + 1) branches.push(...room.hint.map((t) => text(t, 1)));
    });
    out.push(
      event("ev_stairs", "入口の階段", s, [
        page({ trigger: "touch", commands: [text("下へ おりる 階段だ。"), cmd("ShowChoices", { choices, cancel: choices.length - 1 }), ...branches, cmd("EndBranch", {})] }),
      ]),
    );
  }

  // ロビー：はじめに一度だけ、あらすじ
  if (room.id === "map_hall") {
    out.push(
      event("ev_intro", "はじまり", START, [
        page({
          trigger: "autorun",
          priority: "below",
          through: true,
          commands: [
            text("からくり工房の 出荷ラインが 止まってしまった。\n最後の 注文品、\\C[6]金のネジ\\C[0]を 出荷台まで 届けよう。"),
            text("工房は ベルトコンベアだらけ。まずは 整備士に 話しかけてみよう。"),
            cmd("ControlSelfSwitch", { key: "A", value: true }),
          ],
        }),
        page({ conditions: [{ kind: "selfSwitch", key: "A", value: true }], priority: "below", through: true, commands: [] }),
      ]),
    );
  }

  // 整備士（ロビー）
  if (layout.guide.length === 1) {
    const tips = [
      ["矢印の 床が ベルトコンベアじゃ。歩いて ベルトに 着くと、\n矢印の 向きに 勝手に 運ばれる。", "運ばれている 間は 動けん。ベルトを 出た 最初の 床か、\n壁の 手前で 止まる。そこから また 歩ける。"],
      ["\\C[6]木箱\\C[0]は 押して 動かせる。ベルトの 上の 木箱は、\nあんたが 1歩 歩くたびに、矢印の 向きに 1マス 進む。", "ベルトに 乗って 運ばれる ときも 同じじゃ。\nあんたと 木箱は、いっせいに 動く。"],
      ["奥の 壁ぎわの \\C[6]出荷口\\C[0]に 木箱が 着くと、出荷されて 消える。\n出荷口を 全部 埋めれば、出口の シャッターが 開く。", "出荷口は ただの 床じゃ。箱を のせられない 所に 入れて しまったら、詰みじゃな。"],
      ["\\C[6]レバー\\C[0]を 引くと、ベルトの 向きが 入れかわる。\n分かれ道を 切り替えて、箱を 別の 出荷口へ 送るんじゃ。", "引く 順番は 大事じゃぞ。2つの 箱が 同じ 出荷口に 入ったら、もう 片方は 空いたままじゃ。"],
      ["詰んだら、各工区の 入口の 階段に ぶつかるんじゃ。\n\\C[6]やりなおす\\C[0]で 箱も レバーも 最初に もどる。", "ベルトは 輪に ならんよう 作ってある。\n安心して 乗るがよい。"],
    ];
    out.push(
      event("ev_guide", "整備士マリ", layout.guide[0], [
        page({
          graphic: { asset: people, index: 0, direction: "down" },
          commands: [
            text("おお、来てくれたか。止まった ラインを 動かしておくれ。\n奥の 扉から、4つの 工区を 抜けて 出荷台まで じゃ。"),
            cmd("ShowChoices", { choices: ["ベルトの 床", "木箱", "出荷口", "レバー", "つまったら", "やめる"], cancel: 5 }),
            ...tips.flatMap(([a, b], i) => [cmd("ChoiceBranch", { index: i }), text(a, 1), text(b, 1)]),
            cmd("ChoiceBranch", { index: 5 }),
            cmd("EndBranch", {}),
            text("きばって いっておいで。ベルトに 乗る ときは、\n降りる 場所を よく 考えるんじゃぞ。"),
          ],
        }),
      ]),
    );
  }

  // 木箱（押せる）：出荷されたら、消える
  boxes.forEach((pos, n) => {
    out.push(
      event(`ev_box_${n + 1}`, "木箱", pos, [
        page({
          conditions: [sw(GONE(room, n + 1), false)],
          graphic: props("crate"),
          pushable: true,
          commands: [text("木箱だ。正面から 押せば 動かせそうだ。\nベルトの 上に のせると、勝手に 運ばれる。")],
        }),
        page({ conditions: [sw(GONE(room, n + 1))], priority: "below", through: true, commands: [] }),
      ]),
    );
  });

  // 出荷口：箱が載ったら（少し落ちるのを待って）出荷する
  docks.forEach((pos, n) => {
    out.push(
      event(`ev_dock_${n + 1}`, "出荷口", pos, [
        hidden({
          commands: boxes.flatMap((_, i) => [
            ifExpr(`!s("${GONE(room, i + 1)}") && evx("ev_box_${i + 1}") == ${pos.x} && evy("ev_box_${i + 1}") == ${pos.y}`),
            cmd("Wait", { frames: 6 }, 1),
            setSwitch(GONE(room, i + 1), true, 1),
            setSwitch(DOCK(room, n + 1), true, 1),
            endBranch(),
          ]),
        }),
      ]),
    );
  });

  // 出荷口がぜんぶ埋まったら、シャッターが開く
  if (locked) {
    out.push(
      event("ev_logic", "しかけ", { x: 0, y: 0 }, [
        hidden({
          conditions: [sw(OPEN(room), false)],
          commands: [
            ifExpr(docks.map((_, n) => `s("${DOCK(room, n + 1)}")`).join(" && ")),
            setSwitch(OPEN(room), true, 1),
            flash(FLASH_STEEL, 18, 1),
            shake(3, 24, 1),
            endBranch(),
          ],
        }),
      ]),
    );
  }

  // レバー：引くたびに、ベルトの向きが入れかわる（引く前のページが、向きを変える側）
  layout.leverKeys.forEach((k) => {
    const cells = layout.flips[k];
    out.push(
      event(`ev_lever_${k}`, `ベルトのレバー${k}`, layout.lever[k], [
        page({
          conditions: [sw(LEVER(room, k), false)],
          graphic: props("leverOff"),
          commands: [...retile(cells, (c) => c.to), setSwitch(LEVER(room, k), true), flash(FLASH_STEEL, 10), text("ガコン！ レバーを 倒した。\nベルトの 向きが 入れかわった。")],
        }),
        page({
          conditions: [sw(LEVER(room, k))],
          graphic: props("leverOn"),
          commands: [...retile(cells, (c) => c.from), setSwitch(LEVER(room, k), false), flash(FLASH_STEEL, 10), text("ガコン！ レバーを もどした。\nベルトの 向きが もとに もどった。")],
        }),
      ]),
    );
  });
  return out;
}

// ── 書き出し ──────────────────────────────────────────────────────────
const toJson = (value) => `${JSON.stringify(value, null, 2).replace(/\[\s+([-\d.,\s]+?)\s+\]/g, (_, body) => `[${body.split(/,\s*/).join(", ")}]`)}\n`;

const layouts = ROOMS.map((room) => ({ room, layout: readPlan(room) }));

rmSync(ROOT, { recursive: true, force: true });
const assets = writeAssets(join(ROOT, "assets"), {
  "conveyor_tileset.png": tileset(),
  "hero.png": character(HERO),
  "people.png": sheet(1, [character({ shirt: [226, 140, 54], hair: [60, 52, 56], skin: [236, 196, 160] })]),
  "props.png": sheet(5, [crate(), lever(false), lever(true), shutter(), goldScrew()]),
});

mkdirSync(join(ROOT, "maps"), { recursive: true });
for (const { room, layout } of layouts) {
  const map = {
    id: room.id,
    width: W,
    height: H,
    tileset: "ts_conveyor",
    layers: buildLayers(layout.rows, room.id, room.id === "map_hall"),
    events: Object.fromEntries(events(room, layout, assets).map((e) => [e.id, e])),
  };
  writeFileSync(join(ROOT, "maps", `${room.id}.json`), toJson(map));
}

const entry = (name, a) => ({ name, kind: "image", mime: "image/png", size: a.size, width: a.width, height: a.height });
const params = Object.fromEntries(["mhp", "mmp", "atk", "def", "mat", "mdf", "agi", "luk"].map((p) => [p, { base: p === "mhp" ? 100 : p === "mmp" ? 20 : 10, growth: 2 }]));
const switches = {};
for (const { room, layout } of layouts) {
  for (const k of layout.leverKeys) switches[LEVER(room, k)] = { name: `${room.name}のレバー${k}を倒した` };
  layout.dock.forEach((_, n) => (switches[DOCK(room, n + 1)] = { name: `${room.name}の出荷口${n + 1}が埋まった` }));
  layout.box.forEach((_, n) => (switches[GONE(room, n + 1)] = { name: `${room.name}の木箱${n + 1}を出荷した` }));
  if (layout.dock.length > 0) switches[OPEN(room)] = { name: `${room.name}のシャッターが開いた` };
}
const project = {
  formatVersion: 1,
  meta: { id: "conveyor", title: "デモ：工場のベルトコンベア", createdAt: "2026-10-03T00:00:00Z", updatedAt: "2026-10-03T00:00:00Z" },
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
  tilesets: {
    ts_conveyor: {
      id: "ts_conveyor",
      name: "からくり工房",
      image: { asset: assets["conveyor_tileset.png"].id },
      passage: PASSAGE,
      conveyor: Object.fromEntries(Object.entries(BELT_DIR).map(([tile, dir]) => [tile, dir])),
    },
  },
  database: {
    actors: { actor_hero: { id: "actor_hero", name: "コウ", classId: "class_hero", initialLevel: 1, walk: { asset: assets["hero.png"].id }, equips: {} } },
    classes: { class_hero: { id: "class_hero", name: "運び屋", skills: [], params } },
    skills: {},
    items: {},
    enemies: {},
    troops: {},
    states: {},
    commonEvents: {},
  },
  assets: { entries: Object.fromEntries(Object.entries(assets).map(([name, a]) => [a.id, entry(name, a)])) },
  switches,
  variables: {},
};
writeFileSync(join(ROOT, "project.json"), toJson(project));
console.log(`\n${ROOMS.length} 部屋：${ROOMS.map((r) => r.name).join(" / ")}`);
