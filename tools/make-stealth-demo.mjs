#!/usr/bin/env node
/**
 * 忍び込みのデモ（fixtures/projects/v1/stealth）を丸ごと生成する開発用スクリプト。
 * 出力: project.json、maps/<MapId>.json、assets/<AssetId>.<ext>（AssetId = 内容の sha256 先頭 16 桁）。
 * 生成物はコミット済み。屋敷の作りや見張りの動きを変えたいときだけ再実行する（何度実行しても同じものができる）。
 *
 *   node tools/make-stealth-demo.mjs
 *
 * 夜の屋敷に忍び込み、見張りの目をかいくぐって、宝物庫の宝を 3 つ盗んで門から逃げる。戦闘は無い。見せたいエンジンの機能：
 * 1. 視界（トリガ eventSight）：見張りは、向いている方向のまっすぐ数タイル（sightRange）が見える。柱・木箱・茂み・閉じた扉・壁のかげは見えず、
 *    うしろも見えない。見張りの動きは moveRoute：見回り（往復）、立ち番（turn で向きを変えるだけ）、うろつく番犬。
 * 2. 見つかる：見つけた見張りのスイッチ（sw_seen_<番号>）が入り、そのイベントのページが切り替わる（視界のページ → おいかけるページ）。
 *    おいかけるページの moveRoute は `chase`（通れる道を探して最短で追う）。壁や木箱の向こうにいても、道をたどって追ってくる。
 *    つかまると（イベントから接触）、盗んだものを取り上げられて門へ戻され、見張りも元の位置から始まる。
 * 3. 最後の宝を取ると警報（sw_alert）が鳴る：番犬のほか全員がおいかけてくる中を、門まで逃げる。
 * 4. 色調：夜は青く、警報のあいだは赤い（並列イベントの TintScreen）。
 * 宝物庫のかぎ（兵舎の宝箱）、宝物庫の扉（かぎがあると開く）、宝箱 3 つ、門（宝がそろうとエンディング）は、スイッチと変数だけで組んでいる。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blit, canvas, character, HERO, image, lcg, shade, sheet, TILE, writeAssets } from "./pixel-art.mjs";
import { addVar, cmd, endBranch, entry, event, flash, hidden, ifVar, otherwise, page, params, setSwitch, setVar, sw, text, toJson } from "./demo-lib.mjs";

const ROOT = join(import.meta.dirname, "..", "fixtures", "projects", "v1", "stealth");

/** 画面は 15×11 タイル。屋敷（25×19）はそれより広く、スクロールする。 */
const SCREEN_W = 15;
const SCREEN_H = 11;
const MAP = "map_manor";

// ── 間取り ────────────────────────────────────────────────────────────
/**
 * 文字の意味：`#` 壁（下が床なら壁の正面で描く）、`w` 窓、`s` 燭台、`G` 門、
 * `.` 木の床、`_` 宝物庫の床、`=` じゅうたん、`,` 草。
 * 家具：`c` 木箱 / `b` たる / `t` テーブル / `B` 棚（木の床）、`P` 柱（じゅうたん）、`p` 茂み / `q` 木箱 / `r` たる（草）。
 * `@` 侵入口（はじまり。つかまるとここへ戻る）、`a` 相棒、`V` 宝物庫の扉、`$` 宝箱、`k` かぎの宝箱、
 * `1`〜`5` 見張り（GUARDS）。
 */
const PLAN = [
  "#########################",
  "#w#s#w#s#w#s#w#s#w#s#w#s#",
  "#.......#_______#......k#",
  "#.B....t#_$_$_$_#...3...#",
  "#...2...#_______#.......#",
  "#.......####V####.c...c.#",
  "#.......#5======#.......#",
  "#.c...b.#=P===P=#.t...t.#",
  "#.......=========.......#",
  "#.......#=P===P=#.......#",
  "#.b...c.#=======#.b...b.#",
  "############.############",
  "#,,,,,,,,,,,,,,,,,,,,,,,#",
  "#,,p,,,,,,,,,,,,,,,p,,,,#",
  "#,1,,,,,,,,,,,,,,,,,,,,,#",
  "#,,,,,q,,,,,,,,,,q,,,,,,#",
  "#,,r,,,,,4,,,,,,,,,,r,,,#",
  "#,,,,,,,,,a,@,,,,,,,,,,,#",
  "############G############",
];
const W = PLAN[0].length;
const H = PLAN.length;
const START = { x: 12, y: 17 };

const T = {
  grass: 1, wood: 2, vault: 3, carpet: 4, wallTop: 5, wallFace: 6, window: 7, sconce: 8, gate: 9,
  pillar: 10, crate: 11, barrel: 12, table: 13, shelf: 14, bush: 15,
};
const CELLS = 16;
/** 通れるのは床だけ。壁・家具・茂みは通れない。 */
const PASSABLE = new Set([0, T.grass, T.wood, T.vault, T.carpet]);
const PASSAGE = Array.from({ length: CELLS }, (_, id) => (PASSABLE.has(id) ? 15 : 0));

// ── 見張りの種類 ──────────────────────────────────────────────────────
const speed = (value) => ({ kind: "speed", value });
const wait = (frames) => ({ kind: "wait", frames });
const go = (dir, n) => Array.from({ length: n }, () => ({ kind: "move", dir }));
const turn = (dir) => ({ kind: "turn", dir });
const rand = { kind: "move", dir: "random" };
/** 向きを順に変えるだけの立ち番。 */
const lookAround = (dirs, frames) => dirs.flatMap((d) => [turn(d), wait(frames)]);

/**
 * `sight` は視界の長さ（タイル数）。`route` は見つかる前の動き（repeat）。`chase` はおいかけるときの速さ。
 * `alarm` が偽の見張り（番犬）は、最後の宝の警報には加わらない（自分が見つけたときだけ追う）。
 * プレイヤーの速さは 4（1 タイル 16 フレーム）。速さ 3 は 32 フレーム、5 は 8 フレーム。
 */
const GUARDS = {
  1: { name: "見回りの兵", look: 0, dir: "right", sight: 5, route: { skippable: false, steps: [speed(3), ...go("right", 16), wait(30), ...go("left", 16), wait(30)] }, chase: 3 },
  2: { name: "兵舎の見張り", look: 1, dir: "down", sight: 4, route: { skippable: false, steps: lookAround(["left", "down", "right", "down"], 70) }, chase: 3 },
  3: { name: "隊長", look: 2, dir: "down", sight: 6, route: { skippable: false, steps: lookAround(["down", "left", "down", "right"], 90) }, chase: 4 },
  4: { name: "番犬", look: 3, dir: "down", sight: 3, route: { skippable: true, steps: [speed(4), rand, rand, rand, wait(40)] }, chase: 5, alarm: false },
  5: { name: "広間の見張り", look: 1, dir: "up", sight: 5, route: { skippable: false, steps: lookAround(["up", "right", "down", "left"], 80) }, chase: 3 },
};

const MARKS = { "@": "start", a: "partner", V: "vaultDoor", $: "chest", k: "keyChest", G: "gate", ...Object.fromEntries(Object.keys(GUARDS).map((k) => [k, "guard"])) };
const FLOOR_OF = { "@": "grass", a: "grass", 1: "grass", 4: "grass", 2: "wood", 3: "wood", 5: "carpet", V: "carpet", $: "vault", k: "wood" };
const LEGEND = {
  "#": [T.wallTop, 0], W: [T.wallFace, 0], w: [T.window, 0], s: [T.sconce, 0], G: [T.gate, 0],
  ".": [T.wood, 0], _: [T.vault, 0], "=": [T.carpet, 0], ",": [T.grass, 0],
  c: [T.wood, T.crate], b: [T.wood, T.barrel], t: [T.wood, T.table], B: [T.wood, T.shelf], P: [T.carpet, T.pillar],
  p: [T.grass, T.bush], q: [T.grass, T.crate], r: [T.grass, T.barrel],
  ...Object.fromEntries(Object.entries(FLOOR_OF).map(([ch, f]) => [ch, [T[f], 0]])),
};

/** 間取りを読む：床の計画（壁の正面の判定つき）と、印の位置。 */
function readPlan() {
  if (PLAN.some((row) => row.length !== W)) throw new Error("行の長さがそろっていない");
  const marks = { start: [], partner: [], vaultDoor: [], chest: [], keyChest: [], gate: [], guard: [] };
  const rows = PLAN.map((row, y) =>
    [...row].map((ch, x) => {
      if (MARKS[ch] !== undefined) marks[MARKS[ch]].push({ x, y, ch });
      return ch;
    }),
  );
  // 床の北にある壁は、壁の正面（顔）で描く。そうでない壁は、壁の上
  const FACES = new Set(["#", "w", "s", "G"]);
  for (let y = 1; y < H - 1; y++) for (let x = 0; x < W; x++) if (rows[y][x] === "#" && !FACES.has(rows[y + 1][x])) rows[y][x] = "W";
  if (marks.start.length !== 1 || marks.start[0].x !== START.x || marks.start[0].y !== START.y) throw new Error("侵入口の位置が START と合わない");
  // 侵入口から、すべての印（宝箱・かぎ・扉・見張り）へ歩いて行けること（扉は開けるものとする）
  const FLOOR = new Set([".", "_", "=", ",", ...Object.keys(MARKS).filter((c) => c !== "G")]);
  const walk = new Set([`${START.x},${START.y}`]);
  const queue = [START];
  while (queue.length > 0) {
    const { x, y } = queue.shift();
    for (const [i, j] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = `${x + i},${y + j}`;
      if (!walk.has(k) && FLOOR.has(rows[y + j]?.[x + i] ?? "#")) {
        walk.add(k);
        queue.push({ x: x + i, y: y + j });
      }
    }
  }
  for (const list of Object.values(marks)) for (const m of list) if (m.ch !== "G" && !walk.has(`${m.x},${m.y}`)) throw new Error(`(${m.x}, ${m.y}) の ${m.ch} へ行けない`);
  if (marks.chest.length !== 3) throw new Error("宝箱は 3 つ");
  return { rows, ...marks };
}

function buildLayers(rows) {
  const ground = [];
  const objects = [];
  for (const row of rows) for (const ch of row) {
    const [g, o] = LEGEND[ch] ?? (() => { throw new Error(`知らない文字: ${ch}`); })();
    ground.push(g);
    objects.push(o);
  }
  return [{ name: "ground", tiles: ground }, { name: "objects", tiles: objects }];
}

// ── タイルセット ──────────────────────────────────────────────────────
const WOOD = [112, 80, 58];
const GOLD = [222, 184, 84];
const STONE_WALL = [88, 82, 104];

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

  /** 石の壁の正面（レンガ）。窓・燭台・門はこの上に描く。 */
  const wallFace = (c) => {
    c.rect(0, 0, TILE, TILE, STONE_WALL);
    for (let y = 0; y < 24; y += 8) {
      c.rect(0, y, TILE, 1, shade(STONE_WALL, -30));
      const off = (y / 8) % 2 === 0 ? 0 : 8;
      for (let x = off; x < TILE; x += 16) c.rect(x, y, 1, 8, shade(STONE_WALL, -30));
      c.rect(0, y + 1, TILE, 1, shade(STONE_WALL, 12));
    }
    c.rect(0, 24, TILE, 8, shade(STONE_WALL, -40));
    c.rect(0, 24, TILE, 2, shade(STONE_WALL, -10));
  };

  // 草
  {
    const c = cell(T.grass, { wrap: true });
    const base = [52, 94, 62];
    c.rect(0, 0, TILE, TILE, base);
    const rnd = lcg(11);
    for (let i = 0; i < 38; i++) {
      const x = rnd() * TILE;
      const y = rnd() * TILE;
      const col = shade(base, rnd() < 0.5 ? 14 : -16);
      c.set(x, y, col);
      c.set(x, y - 1, col);
    }
  }
  // 木の床
  {
    const c = cell(T.wood, { wrap: true });
    c.rect(0, 0, TILE, TILE, WOOD);
    const rnd = lcg(2);
    for (let y = 0; y < TILE; y += 8) {
      c.rect(0, y, TILE, 1, shade(WOOD, -34));
      c.rect(Math.floor(rnd() * TILE), y + 1, 1, 7, shade(WOOD, -26));
      for (let i = 0; i < 5; i++) c.set(rnd() * TILE, y + 2 + rnd() * 5, shade(WOOD, rnd() < 0.5 ? 10 : -14));
    }
  }
  // 宝物庫の床：暗い石に金の線
  {
    const c = cell(T.vault, { wrap: true });
    const base = [46, 48, 66];
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) c.rect(i * 16, j * 16, 16, 16, (i + j) % 2 === 0 ? base : shade(base, -8));
    c.rect(0, 0, TILE, 1, shade(GOLD, -90));
    c.rect(0, 16, TILE, 1, shade(GOLD, -90));
    c.rect(0, 0, 1, TILE, shade(GOLD, -90));
    c.rect(16, 0, 1, TILE, shade(GOLD, -90));
    c.set(8, 8, shade(GOLD, -40));
    c.set(24, 24, shade(GOLD, -40));
  }
  // 広間のじゅうたん：赤に金のふち
  {
    const c = cell(T.carpet, { wrap: true });
    const base = [118, 40, 52];
    c.rect(0, 0, TILE, TILE, base);
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const d = Math.abs(((x + 8) % 16) - 8) + Math.abs(((y + 8) % 16) - 8);
      if (d === 8) c.set(x, y, shade(GOLD, -70));
      else if (d === 3) c.set(x, y, shade(base, 18));
    }
  }
  // 壁の上
  {
    const c = cell(T.wallTop);
    const base = [34, 32, 46];
    c.rect(0, 0, TILE, TILE, base);
    c.rect(0, 0, TILE, 3, shade(base, 22));
    c.rect(0, TILE - 3, TILE, 3, shade(base, -10));
    const rnd = lcg(7);
    for (let i = 0; i < 12; i++) c.set(3 + rnd() * 26, 4 + rnd() * 24, shade(base, rnd() < 0.5 ? 10 : -8));
  }
  wallFace(cell(T.wallFace));
  // 窓：月明かりが差す
  {
    const c = cell(T.window);
    wallFace(c);
    c.rect(9, 4, 14, 17, [30, 30, 44]);
    c.rect(10, 5, 12, 15, [110, 140, 200]);
    c.rect(10, 5, 12, 4, [150, 178, 226]);
    c.rect(15, 5, 2, 15, [30, 30, 44]);
    c.rect(10, 12, 12, 2, [30, 30, 44]);
    c.rect(8, 21, 16, 2, shade(STONE_WALL, 26));
  }
  // 燭台：壁の炎
  {
    const c = cell(T.sconce);
    wallFace(c);
    c.rect(15, 14, 2, 6, [60, 50, 44]);
    c.rect(11, 19, 10, 2, GOLD);
    c.disc(16, 11, 3, [255, 160, 50]);
    c.rect(16, 6, 1, 4, [255, 214, 100]);
    c.set(16, 11, [255, 250, 210]);
  }
  // 門：石のアーチに鉄格子
  {
    const c = cell(T.gate);
    wallFace(c);
    c.rect(5, 6, 22, 26, [24, 24, 34]);
    c.ellipse(16, 8, 11, 6, [24, 24, 34]);
    for (const x of [8, 12, 16, 20, 24]) c.rect(x, 3, 2, 29, [96, 98, 112]);
    c.rect(5, 16, 22, 2, [96, 98, 112]);
    c.rect(14, 20, 5, 5, GOLD);
    c.rect(15, 18, 3, 3, shade(GOLD, -40));
  }
  // 柱
  {
    const c = cell(T.pillar);
    c.ellipse(16, 29, 10, 2, [0, 0, 0, 80]);
    c.rect(8, 25, 16, 5, [120, 118, 134]);
    c.rect(11, 5, 10, 21, [150, 148, 164]);
    c.rect(11, 5, 3, 21, [184, 182, 198]);
    c.rect(19, 5, 2, 21, [112, 110, 128]);
    c.rect(8, 2, 16, 4, [120, 118, 134]);
  }
  // 木箱
  {
    const c = cell(T.crate);
    c.ellipse(16, 29, 12, 2, [0, 0, 0, 70]);
    const box = [150, 108, 64];
    c.rect(4, 6, 24, 23, box);
    c.rect(4, 6, 24, 3, shade(box, 22));
    for (const x of [4, 14, 26]) c.rect(x, 6, 2, 23, shade(box, -44));
    c.rect(4, 17, 24, 2, shade(box, -44));
    c.rect(4, 27, 24, 2, shade(box, -56));
  }
  // たる
  {
    const c = cell(T.barrel);
    c.ellipse(16, 29, 10, 2, [0, 0, 0, 70]);
    c.ellipse(16, 17, 10, 12, [132, 90, 52]);
    c.rect(6, 10, 20, 2, [70, 70, 84]);
    c.rect(6, 22, 20, 2, [70, 70, 84]);
    c.rect(11, 6, 3, 22, [166, 120, 72]);
    c.ellipse(16, 6, 9, 3, [170, 124, 76]);
  }
  // テーブル
  {
    const c = cell(T.table);
    c.ellipse(16, 29, 13, 2, [0, 0, 0, 70]);
    c.rect(4, 12, 24, 5, [150, 108, 66]);
    c.rect(4, 12, 24, 1, [190, 148, 100]);
    for (const x of [6, 24]) c.rect(x, 17, 3, 12, [96, 66, 42]);
    c.disc(11, 9, 3, [220, 220, 230]);
    c.rect(20, 7, 5, 5, [190, 70, 70]);
  }
  // 棚
  {
    const c = cell(T.shelf);
    c.ellipse(16, 29, 12, 2, [0, 0, 0, 70]);
    c.rect(4, 2, 24, 27, [96, 66, 42]);
    c.rect(6, 4, 20, 23, [60, 42, 30]);
    for (const y of [4, 12, 20]) c.rect(6, y + 6, 20, 2, [130, 92, 58]);
    const rnd = lcg(3);
    for (const y of [4, 12, 20]) for (let x = 7; x < 25; x += 4) c.rect(x, y + 1 + Math.floor(rnd() * 2), 3, 6, [[170, 60, 60], [60, 100, 160], [70, 140, 90], [200, 170, 70]][Math.floor(rnd() * 4)]);
  }
  // 茂み
  {
    const c = cell(T.bush);
    c.ellipse(16, 29, 12, 2, [0, 0, 0, 60]);
    c.ellipse(16, 19, 13, 10, [36, 84, 50]);
    c.ellipse(10, 15, 8, 8, [44, 100, 58]);
    c.ellipse(22, 14, 8, 8, [48, 108, 62]);
    c.ellipse(16, 11, 7, 6, [58, 122, 72]);
    const rnd = lcg(9);
    for (let i = 0; i < 16; i++) c.set(5 + rnd() * 22, 7 + rnd() * 18, [72, 140, 84]);
  }
  return img;
}

// ── キャラクター ──────────────────────────────────────────────────────
/** 番犬（1 体 = 3 パターン × 4 方向）。 */
function hound() {
  const BODY = [128, 88, 56];
  const DARK = shade(BODY, -40);
  const out = image(TILE * 3, TILE * 4);
  ["down", "left", "right", "up"].forEach((dir, row) => {
    for (let p = 0; p < 3; p++) {
      const c = canvas(TILE, TILE);
      const bob = p === 1 ? -1 : 0;
      c.ellipse(16, 28, 10, 2, [0, 0, 0, 56]);
      if (dir === "left" || dir === "right") {
        const f = dir === "right" ? 1 : -1; // 顔の向き
        const x = (v) => (f === 1 ? v : TILE - 1 - v);
        const leg = p === 0 ? 2 : p === 2 ? -2 : 0;
        c.ellipse(x(15), 19 + bob, 9, 5, BODY);
        for (const [lx, d] of [[9, leg], [12, -leg], [20, -leg], [23, leg]]) c.rect(x(lx) - 1, 22 + bob, 3, 6 + (d > 0 ? -1 : 0), DARK);
        c.ellipse(x(25), 14 + bob, 5, 5, BODY);
        c.rect(x(27), 14 + bob, 4 * f > 0 ? 4 : -4, 3, DARK);
        c.rect(x(23) - 1, 8 + bob, 3, 5, DARK);
        c.rect(x(26), 12 + bob, 2, 2, [20, 20, 30]);
        for (let i = 0; i < 5; i++) c.set(x(6 - i), 14 + bob + Math.round(i * 0.4) + (p === 1 ? 1 : 0), BODY);
      } else {
        const leg = p === 0 ? 2 : p === 2 ? -2 : 0;
        c.ellipse(16, 20 + bob, 8, 7, BODY);
        for (const [lx, d] of [[9, leg], [21, -leg]]) c.rect(lx, 23 + bob, 3, 6 + (d > 0 ? -1 : 0), DARK);
        if (dir === "down") {
          c.ellipse(16, 12 + bob, 6, 6, BODY);
          c.rect(9, 7 + bob, 3, 7, DARK);
          c.rect(20, 7 + bob, 3, 7, DARK);
          c.rect(12, 11 + bob, 2, 2, [20, 20, 30]);
          c.rect(18, 11 + bob, 2, 2, [20, 20, 30]);
          c.rect(14, 15 + bob, 4, 3, [30, 24, 28]);
        } else {
          c.ellipse(16, 12 + bob, 6, 6, shade(BODY, -12));
          c.rect(9, 7 + bob, 3, 6, DARK);
          c.rect(20, 7 + bob, 3, 6, DARK);
          c.rect(15, 24 + bob, 2, 4, BODY);
        }
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
const chest = (open) =>
  still((d) => {
    d.ellipse(16, 28, 11, 2, [0, 0, 0, 80]);
    const wood = [140, 92, 52];
    d.rect(5, 16, 22, 12, wood);
    d.rect(5, 16, 22, 2, shade(wood, 26));
    d.rect(5, 26, 22, 2, shade(wood, -50));
    for (const x of [5, 25]) d.rect(x, 16, 2, 12, GOLD);
    if (open) {
      d.rect(6, 17, 20, 5, [30, 24, 30]);
      for (const [x, y, c] of [[9, 15, GOLD], [14, 13, [240, 80, 110]], [18, 15, [110, 190, 250]], [22, 14, GOLD]]) d.disc(x, y, 2, c);
      d.rect(5, 6, 22, 5, shade(wood, 10));
      d.rect(5, 6, 22, 1, shade(wood, 36));
      for (const x of [5, 25]) d.rect(x, 6, 2, 5, GOLD);
    } else {
      d.ellipse(16, 15, 11, 5, wood);
      d.rect(5, 14, 22, 3, wood);
      d.rect(5, 12, 22, 1, shade(wood, 30));
      for (const x of [5, 25]) d.rect(x, 12, 2, 4, GOLD);
      d.rect(14, 15, 5, 5, GOLD);
      d.rect(15, 17, 3, 2, shade(GOLD, -70));
    }
  });
/** 宝物庫の扉（鉄の扉と大きな錠）。 */
const vaultDoor = () =>
  still((d) => {
    d.rect(1, 0, 30, 32, [52, 54, 70]);
    d.rect(3, 2, 26, 30, [78, 80, 100]);
    d.rect(3, 2, 26, 2, [118, 120, 142]);
    for (const [x, y] of [[6, 5], [25, 5], [6, 28], [25, 28]]) d.disc(x, y, 1, [150, 152, 170]);
    d.rect(15, 2, 2, 30, [52, 54, 70]);
    d.disc(16, 17, 5, GOLD);
    d.disc(16, 17, 3, shade(GOLD, -60));
    d.rect(15, 18, 2, 6, shade(GOLD, -60));
  });
const PROPS = { chestClosed: 0, chestOpen: 1, vaultDoor: 2 };
const SHEET = { soldier: 0, sentry: 1, captain: 2, hound: 3, partner: 4 };

// ── イベント ──────────────────────────────────────────────────────────
const ifSwitch = (id, value, indent = 0) => cmd("ConditionalBranch", { condition: { kind: "switch", id, value } }, indent);
const setVarExpr = (id, expr, indent = 0) => cmd("ControlVariables", { ids: [id], op: "set", operand: { kind: "expr", expr } }, indent);
const tint = (color, duration = 0, indent = 0) => cmd("TintScreen", { color, duration, wait: false }, indent);
const NIGHT = { r: 6, g: 12, b: 44, a: 0.4 };
const ALARM = { r: 90, g: 0, b: 10, a: 0.3 };
const CLEAR = { r: 0, g: 0, b: 0, a: 0 };
/** 色調をかけ続ける並列イベント（色調はセーブされないので、ロードしたあとも戻るように 1 秒ごとにかけ直す）。 */
const tintKeeper = (color, conditions = []) => hidden({ conditions, commands: [cmd("Loop", {}), tint(color, 0, 1), cmd("Wait", { frames: 60 }, 1), cmd("EndLoop", {})] });

const LOOT = 3;
const CHEST_SWITCH = (n) => `sw_got${n}`;
const GOT_ALL = [1, 2, 3].map(CHEST_SWITCH);
const SEEN = Object.keys(GUARDS).map((ch) => `sw_seen_${ch}`);

function events(layout, assets) {
  const props = (name) => ({ asset: assets["props.png"].id, index: PROPS[name], direction: "down" });
  const people = assets["people.png"].id;
  const out = [];

  out.push(event("ev_tint", "夜の色", { x: 0, y: 0 }, [tintKeeper(NIGHT, [sw("sw_alert", false)]), tintKeeper(ALARM, [sw("sw_alert")])]));

  // はじめに一度だけ
  out.push(
    event("ev_intro", "はじまり", { x: 11, y: 17 }, [
      page({
        trigger: "autorun",
        priority: "below",
        through: true,
        commands: [
          text("夜。大富豪の屋敷の裏庭。\nねらうのは、宝物庫の宝 \\C[6]3つ\\C[0]。"),
          text("相棒が 小声で 何か 言いたそうに している。\n（話しかけてみよう）"),
          cmd("ControlSelfSwitch", { key: "A", value: true }),
        ],
      }),
      page({ conditions: [{ kind: "selfSwitch", key: "A", value: true }], priority: "below", through: true, commands: [] }),
    ]),
  );

  // 相棒：見張りの見え方と、段取りを教えてくれる
  const partner = layout.partner[0];
  const tips = [
    ["見張りには 「視界」が ある。むいている 方向の\nまっすぐ 数マスが 見えて、見つかると 警報だ。", "見えるのは 見張りの 正面だけ。うしろや よこは 見えん。\n見回りの うしろから ついていけば 気づかれない。"],
    ["柱・木箱・たる・茂みの かげは 見えない。\nとびらや 壁の むこうも 見えないぞ。", "見張りの 向きは 決まった リズムで かわる。\n向きが かわるのを 待って、すきを つくんだ。"],
    ["警報が 鳴ると、見張りは ぜんいん 道を さがして\n追ってくる。つかまると 盗んだ物は とりあげだ。", "番犬は 足が 速い。見つかるなよ。\n追いつかれるまえに 門まで 走れ！"],
    ["宝物庫の かぎは 右の 兵舎の 宝箱。\n隊長が 見張っているから 気をつけろ。", "宝は 3つ。さいごの 1つを 取ると、\n警報が 鳴りひびく。そこからが 本番だ。"],
  ];
  out.push(
    event("ev_partner", "相棒", partner, [
      page({
        graphic: { asset: people, index: SHEET.partner, direction: "up" },
        commands: [
          text("よう、相棒。作戦の 確認か？"),
          cmd("ShowChoices", { choices: ["見張りの 視界", "かくれ方", "警報のこと", "段取り", "やめる"], cancel: 4 }),
          ...tips.flatMap(([a, b], i) => [cmd("ChoiceBranch", { index: i }), text(a, 1), text(b, 1)]),
          cmd("ChoiceBranch", { index: 4 }),
          endBranch(),
          text("いまの 戦果：宝 \\V[var_loot] / 3つ、つかまった 回数 \\V[var_caught]回。"),
        ],
      }),
    ]),
  );

  // 門：宝が 3つ そろうとエンディング
  out.push(
    event("ev_gate", "門", layout.gate[0], [
      page({
        trigger: "touch",
        commands: [
          ifVar("var_loot", ">=", LOOT),
          setSwitch("sw_alert", false, 1),
          tint(CLEAR, 60, 1),
          cmd("Wait", { frames: 60 }, 1),
          text("門を くぐりぬけ、闇に まぎれた。\n宝は ぜんぶ 無事だ！\\C[6]おめでとう！\\C[0]", 1),
          text("つかまった 回数：\\V[var_caught]回", 1),
          cmd("ReturnToTitle", {}, 1),
          otherwise(),
          setVarExpr("var_left", `${LOOT} - v("var_loot")`, 1),
          text("まだ 手ぶらでは 帰れない。宝物庫の 宝は あと \\V[var_left]つ。", 1),
          endBranch(),
        ],
      }),
    ]),
  );

  // 兵舎の宝箱：宝物庫のかぎ
  out.push(
    event("ev_key", "かぎの宝箱", layout.keyChest[0], [
      page({
        conditions: [sw("sw_key", false)],
        graphic: props("chestClosed"),
        commands: [setSwitch("sw_key", true), text("宝箱を あけた！\n\\C[6]宝物庫の かぎ\\C[0]を 手に入れた！")],
      }),
      page({ conditions: [sw("sw_key")], graphic: props("chestOpen"), commands: [text("宝箱は からっぽだ。")] }),
    ]),
  );

  // 宝物庫の扉：かぎがあると開く（閉じているあいだは視界をさえぎる）
  out.push(
    event("ev_vault", "宝物庫の扉", layout.vaultDoor[0], [
      page({
        conditions: [sw("sw_vault", false)],
        graphic: props("vaultDoor"),
        commands: [
          ifSwitch("sw_key", true),
          text("かぎを まわす。重い 鉄の扉が ゆっくりと 開いた……", 1),
          setSwitch("sw_vault", true, 1),
          otherwise(),
          text("鉄の扉。かぎが かかっている。\nかぎは 兵舎の 宝箱に ありそうだ。", 1),
          endBranch(),
        ],
      }),
      page({ conditions: [sw("sw_vault")], priority: "below", through: true, commands: [] }),
    ]),
  );

  // 宝箱 3 つ：最後の 1 つで警報が鳴る
  layout.chest.forEach((pos, i) => {
    const n = i + 1;
    out.push(
      event(`ev_chest_${n}`, `宝箱${n}`, pos, [
        page({
          conditions: [sw(CHEST_SWITCH(n), false)],
          graphic: props("chestClosed"),
          commands: [
            setSwitch(CHEST_SWITCH(n), true),
            addVar("var_loot", 1),
            flash({ r: 255, g: 230, b: 150, a: 0.5 }, 12),
            ifVar("var_loot", ">=", LOOT),
            text("さいごの 宝を 手に入れた！ 宝は ぜんぶで \\C[6]3つ\\C[0]。", 1),
            setSwitch("sw_alert", true, 1),
            flash({ r: 220, g: 30, b: 50, a: 0.6 }, 20, 1),
            cmd("ShakeScreen", { power: 5, duration: 30, wait: false }, 1),
            text("\\C[2]ジリリリリ――！\\C[0] 警報が 鳴りひびいた！\n見張りが いっせいに 動きだした。\\C[6]門まで 走れ！\\C[0]", 1),
            otherwise(),
            setVarExpr("var_left", `${LOOT} - v("var_loot")`, 1),
            text("宝を 手に入れた！ のこりは あと \\V[var_left]つ。", 1),
            endBranch(),
          ],
        }),
        page({ conditions: [sw(CHEST_SWITCH(n))], graphic: props("chestOpen"), commands: [text("宝箱は からっぽだ。")] }),
      ]),
    );
  });

  // 見張り：見つかる前（視界）／おいかけて つかまえる。見つけた見張りだけが追ってくる（`sw_seen_<番号>`）。
  // 最後の宝の警報（`sw_alert`）では、番犬のほかの全員が追ってくる
  const used = {};
  layout.guard.forEach((g) => {
    const kind = GUARDS[g.ch];
    used[g.ch] = (used[g.ch] ?? 0) + 1;
    const id = `ev_guard_${g.ch}_${used[g.ch]}`;
    const seen = `sw_seen_${g.ch}`;
    const graphic = (direction) => ({ asset: people, index: kind.look, direction });
    const chasing = (conditions) =>
      page({
        conditions,
        graphic: graphic(kind.dir),
        trigger: "eventTouch",
        moveRoute: { repeat: true, skippable: true, steps: [speed(kind.chase), { kind: "move", dir: "chase" }] },
        commands: [
          flash({ r: 200, g: 40, b: 60, a: 0.6 }, 16),
          cmd("ShakeScreen", { power: 6, duration: 20, wait: false }),
          addVar("var_caught", 1),
          text(`\\C[2]${kind.name}\\C[0]に つかまった！\n盗んだ 宝は とりあげられ、門の外へ 放り出される……`),
          setSwitch(["sw_alert", ...SEEN, ...GOT_ALL], false),
          setVar("var_loot", 0),
          cmd("TransferPlayer", { mapId: MAP, x: START.x, y: START.y, dir: "up", fade: "black" }),
        ],
      });
    out.push(
      event(id, kind.name, g, [
        page({
          conditions: [sw("sw_alert", false), sw(seen, false)],
          graphic: graphic(kind.dir),
          trigger: "eventSight",
          sightRange: kind.sight,
          moveRoute: { repeat: true, ...kind.route },
          commands: [
            setSwitch(seen, true),
            flash({ r: 220, g: 30, b: 50, a: 0.5 }, 14),
            text(`\\C[2]${kind.name}\\C[0]に 見つかった！\n「だれだ、そこに いるのは！ 賊だ！」`),
            text("見張りが 道を さがして 追ってくる……！\n（かべや 木箱を ぐるっと まわって 引き離せ）"),
          ],
        }),
        chasing([sw(seen)]),
        ...(kind.alarm === false ? [] : [chasing([sw("sw_alert")])]),
      ]),
    );
  });
  return out;
}

// ── 書き出し ──────────────────────────────────────────────────────────

const layout = readPlan();
rmSync(ROOT, { recursive: true, force: true });
const assets = writeAssets(join(ROOT, "assets"), {
  "stealth_tileset.png": tileset(),
  "hero.png": character(HERO),
  "people.png": sheet(5, [
    character({ shirt: [156, 44, 44], hair: [70, 70, 84], skin: [232, 190, 150] }),
    character({ shirt: [66, 96, 152], hair: [60, 44, 36], skin: [232, 190, 150] }),
    character({ shirt: [40, 40, 56], hair: [226, 192, 76], skin: [222, 180, 140] }),
    hound(),
    character({ shirt: [54, 124, 84], hair: [34, 30, 40], skin: [240, 200, 160] }),
  ]),
  "props.png": sheet(3, [chest(false), chest(true), vaultDoor()]),
});

mkdirSync(join(ROOT, "maps"), { recursive: true });
const manor = { id: MAP, width: W, height: H, tileset: "ts_stealth", layers: buildLayers(layout.rows), events: Object.fromEntries(events(layout, assets).map((e) => [e.id, e])) };
writeFileSync(join(ROOT, "maps", `${MAP}.json`), toJson(manor));

const project = {
  formatVersion: 1,
  meta: { id: "stealth", title: "デモ：忍び込み！月影の宝物庫", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" },
  system: {
    startMap: MAP,
    startX: START.x,
    startY: START.y,
    initialParty: ["actor_thief"],
    tileSize: TILE,
    screen: { width: SCREEN_W * TILE, height: SCREEN_H * TILE },
    bgm: {},
    terms: { newGame: "ニューゲーム" },
  },
  maps: { [MAP]: { id: MAP, name: "月影の屋敷", order: 0 } },
  tilesets: { ts_stealth: { id: "ts_stealth", name: "夜の屋敷", image: { asset: assets["stealth_tileset.png"].id }, passage: PASSAGE } },
  database: {
    actors: { actor_thief: { id: "actor_thief", name: "カゲ", classId: "class_thief", initialLevel: 1, walk: { asset: assets["hero.png"].id }, equips: {} } },
    classes: { class_thief: { id: "class_thief", name: "怪盗", skills: [], params } },
    skills: {},
    items: {},
    enemies: {},
    troops: {},
    states: {},
    commonEvents: {},
  },
  assets: { entries: Object.fromEntries(Object.entries(assets).map(([name, a]) => [a.id, entry(name, a)])) },
  switches: {
    sw_alert: { name: "警報（最後の宝）" },
    ...Object.fromEntries(Object.entries(GUARDS).map(([ch, g]) => [`sw_seen_${ch}`, { name: `${g.name}に見つかった` }])),
    sw_key: { name: "宝物庫のかぎを持っている" },
    sw_vault: { name: "宝物庫の扉が開いた" },
    sw_got1: { name: "宝箱1を取った" },
    sw_got2: { name: "宝箱2を取った" },
    sw_got3: { name: "宝箱3を取った" },
  },
  variables: {
    var_loot: { name: "盗んだ宝の数" },
    var_left: { name: "のこりの宝" },
    var_caught: { name: "つかまった回数" },
  },
};
writeFileSync(join(ROOT, "project.json"), toJson(project));
console.log(`\n${W}x${H}：見張り ${layout.guard.map((g) => GUARDS[g.ch].name).join("・")}、宝箱 ${layout.chest.length}つ`);
