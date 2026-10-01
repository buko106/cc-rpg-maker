#!/usr/bin/env node
/**
 * 水門の遺跡のデモ（fixtures/projects/v1/water）を丸ごと生成する開発用スクリプト。
 * 出力: project.json、maps/<MapId>.json、assets/<AssetId>.<ext>（AssetId = 内容の sha256 先頭 16 桁）。
 * 生成物はコミット済み。遺跡の作りを変えたいときだけ再実行する（何度実行しても同じものができる）。
 *
 *   node tools/make-water-demo.mjs
 *
 * 水没した遺跡の奥にある「水神の宝珠」を取りにいく。戦闘は無く、水位を切り替えて進む仕掛けだけを解いていく。見せたいエンジンの機能：
 * 1. マップのタイルの書き換え（`ChangeMapTile`）：レバーを引くと、部屋の水路（`~`）と堰（`^`）のタイルが入れ替わる。
 *    水位が高いとき：水路は水に沈んで通れず、堰は水の下で浅瀬になって歩ける。水位が低いとき：水路は水が引いて歩け、堰は石の壁が立ちはだかる。
 *    通行判定は書き換えたタイルを見るので、水位を変えると歩ける所が変わる。
 * 2. 書き換えは残る：部屋を出ても、セーブして遊びなおしても、水位はそのまま（`GameState.mapTiles`）。
 * 3. 別のマップの書き換え：最後の「大水門」のレバーは、まだ入っていない（読み込んでもいない）入口の間の水路を干上がらせる。
 *    入口の間にもどると、案内人の話も変わる。
 * パズルは、tools の外で探索して決めた（水位 × 位置の BFS。apps/player の fixture テストが、同じ規則のモデルで最短の手順を求めて、
 * 実際のエンジンで再生する）：水路の間 9 手（レバー 1 回）、浮き橋の間 39 手（レバー 3 回）、大水門の間 51 手（水位のレバー 3 回と、最後の大水門のレバー）。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blit, canvas, character, HERO, image, lcg, shade, sheet, TILE, writeAssets } from "./pixel-art.mjs";

const ROOT = join(import.meta.dirname, "..", "fixtures", "projects", "v1", "water");

/** 画面は 15×11 タイル。部屋はどれもちょうど 1 画面（スクロールしない）。 */
const SCREEN_W = 15;
const SCREEN_H = 11;
const START = { x: 7, y: 8 };

// ── 部屋 ──────────────────────────────────────────────────────────────
/**
 * 文字の意味：`#` 壁、`.` 床、`O` 石柱（通れない）、`~` 水路（水位が高いと水で通れない。低いと干上がって歩ける）、
 * `^` 堰（水位が高いと水に沈んで歩ける。低いと石の壁で通れない）、`L` 水門のレバー、`M` 大水門のレバー、`>` 奥への階段、`<` 戻る階段、
 * `E` 入口の間から水路の間へ下りる階段、`G` 案内人、`T` 祭壇。
 * 階段 `<` の上の (7, 8) が入口（プレイヤーが着く所）。`<` は通れない（下へ歩いて突き当たると前の部屋へ戻る）。`>` は通れて、上に着くと次の部屋へ進む。
 * どの部屋も、水位は高い（水路は水の下）ところから始まる。レバーのまわりは、水路や堰ではなく床（レバーを引いたとき、足元が水になって動けなくならないように）。
 */
const ROOMS = [
  {
    id: "map_hall",
    name: "入口の間",
    plan: [
      "###############",
      "###############",
      "#......>......#",
      "#~~~~~~~~~~~~~#",
      "#.............#",
      "#......G......#",
      "#.............#",
      "#.O.........O.#",
      "#...........E.#",
      "#......<......#",
      "###############",
    ],
  },
  {
    id: "map_canal",
    name: "水路の間",
    plan: [
      "###############",
      "###############",
      "#......>......#",
      "#~~~~~~~~~~~~~#",
      "#.............#",
      "#.O.........O.#",
      "#.............#",
      "#.............#",
      "#........L....#",
      "#......<......#",
      "###############",
    ],
  },
  {
    id: "map_float",
    name: "浮き橋の間",
    plan: [
      "###############",
      "###############",
      "#......>......#",
      "####~~~~~~~####",
      "#L............#",
      "###^^^^########",
      "#............L#",
      "#O~~~~~~~~~~~O#",
      "#L...........##",
      "#######<#######",
      "###############",
    ],
  },
  {
    id: "map_sluice",
    name: "大水門の間",
    plan: [
      "###############",
      "###############",
      "#......M......#",
      "##########~~~##",
      "#L............#",
      "##^^^##########",
      "#............L#",
      "##~~~##########",
      "#............L#",
      "#######<#######",
      "###############",
    ],
  },
  {
    id: "map_shrine",
    name: "水神の間",
    plan: [
      "###############",
      "###############",
      "#.............#",
      "#.............#",
      "#......T......#",
      "#.............#",
      "#..O.......O..#",
      "#.............#",
      "#.............#",
      "#......<......#",
      "###############",
    ],
  },
];
const W = ROOMS[0].plan[0].length;
const H = ROOMS[0].plan.length;
const ROOM_IDS = ROOMS.map((r) => r.id);

/** 水路・堰のタイルの組み合わせ。`high` は水位が高いとき、`low` は低いとき。 */
const T = { floor: 1, water: 2, bed: 3, shallow: 4, barrier: 5, wallTop: 6, wallFace: 7, pillar: 8, moss: 9 };
const CELLS = 10;
/** 通れるのは、床・干上がった水路の底・水の下の浅瀬だけ。水・石の堰・壁・石柱は通れない。 */
const PASSAGE = [15, 15, 0, 15, 15, 0, 0, 0, 0, 0];
const GATE = { "~": { high: T.water, low: T.bed }, "^": { high: T.shallow, low: T.barrier } };

/** 部屋の見取り図を読む：床の種類、柱、各印の位置。 */
function readRoom(room) {
  const { plan } = room;
  if (plan.length !== H || plan.some((row) => row.length !== W)) throw new Error(`${room.id}: 部屋は ${W}x${H} でなければならない`);
  const marks = { lever: [], master: [], up: [], down: [], side: [], guide: [], altar: [] };
  const KIND = { L: "lever", M: "master", ">": "up", "<": "down", E: "side", G: "guide", T: "altar" };
  const ground = [];
  const objects = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const ch = plan[y][x];
      if (KIND[ch] !== undefined) marks[KIND[ch]].push({ x, y, ch });
      let g = T.floor;
      let o = 0;
      if (ch === "#") {
        // 床の北にある壁は壁の正面（レンガ）、そうでない壁は壁の上。壁の正面には、ところどころ苔の飾りを付ける
        const below = plan[y + 1]?.[x];
        const wallLike = below === undefined || below === "#";
        g = wallLike ? T.wallTop : T.wallFace;
        if (!wallLike && y === 1 && x % 4 === 2) o = T.moss;
      } else if (ch === "~" || ch === "^") g = GATE[ch].high;
      else if (ch === "O") o = T.pillar;
      ground.push(g);
      objects.push(o);
    }
  }
  if (plan[START.y][START.x] !== "." || plan[START.y + 1][START.x] !== "<") throw new Error(`${room.id}: 入口 (${START.x}, ${START.y}) は床で、その下が階段でなければならない`);
  if (marks.down.length !== 1) throw new Error(`${room.id}: 戻る階段は 1 つ`);
  // レバーのまわりに水路・堰があると、そこに立ってレバーを引いたとき、足元が水になって動けなくなる
  for (const p of [...marks.lever, ...marks.master]) {
    for (const [dx, dy] of [[0, 1], [-1, 0], [1, 0], [0, -1]]) {
      const c = plan[p.y + dy]?.[p.x + dx];
      if ((c === "~" || c === "^") && p.ch === "L") throw new Error(`${room.id}: レバー (${p.x}, ${p.y}) のとなりに水路・堰がある`);
    }
  }
  // 同じ種類のタイルが横に続くところ（ChangeMapTile で 1 度に書き換える）
  const runs = { "~": [], "^": [] };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const ch = plan[y][x];
      if (ch !== "~" && ch !== "^") continue;
      const last = runs[ch].at(-1);
      if (last !== undefined && last.y === y && last.x + last.w === x) last.w++;
      else runs[ch].push({ x, y, w: 1 });
    }
  }
  return { ground, objects, marks, runs };
}

// ── タイルセット ──────────────────────────────────────────────────────
const STONE = [118, 132, 134];
const WATER = [36, 98, 170];
const SAND = [200, 180, 132];
const WALL = [44, 70, 78];

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
    const line = (x0, y0, x1, y1, c) => {
      const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
      for (let i = 0; i <= n; i++) set(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, c);
    };
    const ellipse = (cx, cy, rx, ry, c) => {
      for (let j = -ry; j <= ry; j++) for (let i = -rx; i <= rx; i++) if ((i * i) / (rx * rx) + (j * j) / (ry * ry) <= 1) set(cx + i, cy + j, c);
    };
    return { set, rect, line, ellipse };
  };
  /** 水面（波の筋）。水と浅瀬で共通。 */
  const waves = (c, base, seed, n) => {
    c.rect(0, 0, TILE, TILE, base);
    const rnd = lcg(seed);
    for (let i = 0; i < n; i++) c.set(rnd() * TILE, rnd() * TILE, shade(base, rnd() < 0.5 ? 12 : -12));
    for (const [x, y, len] of [[2, 6, 9], [16, 12, 10], [6, 20, 8], [20, 26, 9], [-4, 28, 8]]) {
      c.line(x, y, x + len, y, shade(base, 38));
      c.line(x + 2, y + 1, x + len - 2, y + 1, shade(base, -16));
    }
  };

  // 床：苔のついた石畳
  {
    const c = cell(T.floor, { wrap: true });
    c.rect(0, 0, TILE, TILE, STONE);
    const rnd = lcg(11);
    for (let i = 0; i < 44; i++) c.set(rnd() * TILE, rnd() * TILE, shade(STONE, rnd() < 0.5 ? 12 : -12));
    for (let i = 0; i < 16; i++) c.set(rnd() * TILE, rnd() * TILE, [92, 132, 96]);
    c.rect(0, 0, TILE, 1, shade(STONE, -28));
    c.rect(0, 0, 1, TILE, shade(STONE, -28));
    c.rect(1, 1, TILE - 1, 1, shade(STONE, 16));
    c.rect(1, 1, 1, TILE - 1, shade(STONE, 16));
  }
  // 水：深い水（通れない）
  {
    const c = cell(T.water, { wrap: true });
    waves(c, WATER, 7, 36);
    c.rect(0, 0, TILE, 2, shade(WATER, -28));
  }
  // 干上がった水路の底：湿った砂に、水たまりと波の跡が残る
  {
    const c = cell(T.bed, { wrap: true });
    c.rect(0, 0, TILE, TILE, SAND);
    const rnd = lcg(19);
    for (let i = 0; i < 40; i++) c.set(rnd() * TILE, rnd() * TILE, shade(SAND, rnd() < 0.5 ? 14 : -14));
    for (const [x, y, w, h] of [[5, 7, 7, 3], [19, 18, 8, 4], [8, 24, 5, 2]]) {
      c.ellipse(x + 3, y + 1, w >> 1, h >> 1, shade(WATER, 40));
      c.ellipse(x + 3, y + 1, (w >> 1) - 1, (h >> 1) - 1 || 1, [86, 150, 204]);
    }
    for (const y of [4, 13, 29]) c.line(1, y, 30, y + 1, shade(SAND, -24));
    c.rect(0, 0, TILE, 1, shade(SAND, -40));
  }
  // 水の下の浅瀬：水に飛び石が沈んでいる（歩ける）
  {
    const c = cell(T.shallow, { wrap: true });
    waves(c, [60, 138, 196], 23, 28);
    for (const [x, y] of [[3, 3], [17, 3], [10, 15], [3, 21], [20, 20]]) {
      c.rect(x, y, 10, 8, [96, 124, 130]);
      c.rect(x, y, 10, 2, [150, 184, 188]);
      c.rect(x, y + 7, 10, 1, [58, 84, 92]);
      c.rect(x, y, 1, 8, [124, 152, 156]);
    }
  }
  // 石の堰：水をせきとめる、鉄格子つきの石壁（通れない）
  {
    const c = cell(T.barrier);
    c.rect(0, 0, TILE, TILE, [88, 100, 108]);
    c.rect(0, 0, TILE, 4, [150, 164, 170]);
    c.rect(0, 28, TILE, 4, [52, 62, 72]);
    for (let x = 3; x < TILE; x += 6) {
      c.rect(x, 5, 3, 22, [50, 56, 68]);
      c.rect(x, 5, 1, 22, [120, 128, 142]);
    }
    c.rect(0, 12, TILE, 2, [72, 80, 94]);
    c.rect(0, 22, TILE, 2, [72, 80, 94]);
    // 水がしみだした跡
    for (const x of [6, 15, 26]) c.rect(x, 24, 1, 8, [70, 128, 176]);
  }
  // 壁の上
  {
    const c = cell(T.wallTop);
    c.rect(0, 0, TILE, TILE, shade(WALL, -22));
    const rnd = lcg(5);
    for (let i = 0; i < 30; i++) c.set(rnd() * TILE, rnd() * TILE, shade(WALL, -22 + (rnd() < 0.5 ? 8 : -8)));
    c.rect(0, TILE - 2, TILE, 2, shade(WALL, -34));
  }
  // 壁の正面：苔むしたレンガ
  {
    const c = cell(T.wallFace);
    c.rect(0, 0, TILE, TILE, WALL);
    for (let y = 0; y < 24; y += 8) {
      c.rect(0, y, TILE, 1, shade(WALL, -26));
      const off = (y / 8) % 2 === 0 ? 0 : 8;
      for (let x = off; x < TILE; x += 16) c.rect(x, y, 1, 8, shade(WALL, -26));
      c.rect(0, y + 1, TILE, 1, shade(WALL, 18));
    }
    c.rect(0, 24, TILE, 8, shade(WALL, -18));
    c.rect(0, 24, TILE, 2, shade(WALL, 6));
    const rnd = lcg(31);
    for (let i = 0; i < 22; i++) c.set(rnd() * TILE, 24 + rnd() * 8, [64, 106, 76]);
  }
  // 石柱：床の上に立つ、通れない柱（背景は透明）
  {
    const c = cell(T.pillar);
    c.ellipse(16, 28, 10, 3, [10, 30, 40, 80]);
    c.rect(8, 22, 16, 6, [104, 116, 120]);
    c.rect(8, 22, 16, 2, [160, 172, 176]);
    c.rect(11, 5, 10, 18, [128, 142, 146]);
    c.rect(11, 5, 3, 18, [170, 184, 186]);
    c.rect(18, 5, 3, 18, [92, 104, 110]);
    c.rect(9, 2, 14, 4, [104, 116, 120]);
    c.rect(9, 2, 14, 1, [170, 184, 186]);
    c.rect(11, 12, 3, 4, [78, 120, 88]);
    c.rect(12, 16, 2, 3, [78, 120, 88]);
  }
  // 壁の飾り：壁の正面に垂れる苔と水草（背景は透明）
  {
    const c = cell(T.moss);
    for (const [x, h] of [[8, 12], [14, 18], [20, 10], [25, 15]]) {
      for (let j = 0; j < h; j++) c.set(x + (j % 3 === 0 ? 1 : 0), 24 - j + 8 - h + 4, j % 2 ? [76, 130, 90] : [58, 104, 72]);
    }
  }
  return img;
}

// ── 絵：物（レバー・階段・祭壇）と人 ──────────────────────────────────
const still = (draw) => {
  const one = canvas(TILE, TILE);
  draw(one);
  const out = image(TILE * 3, TILE * 4);
  for (let row = 0; row < 4; row++) for (let p = 0; p < 3; p++) blit(out, one, p * TILE, row * TILE);
  return out;
};
const GOLD = [236, 200, 96];
/** 水門のレバー：石の台座から生えた鉄のレバー。`low` は水が引いている（レバーが下がっている）。 */
const lever = (low, big = false) =>
  still((d) => {
    const base = big ? GOLD : [150, 164, 172];
    d.ellipse(16, 28, 12, 3, [10, 30, 40, 100]);
    d.rect(7, 19, 18, 9, [96, 108, 116]);
    d.rect(7, 19, 18, 2, [164, 176, 182]);
    d.rect(7, 26, 18, 2, [60, 70, 80]);
    d.rect(10, 15, 12, 5, [124, 138, 146]);
    d.rect(10, 15, 12, 1, [182, 194, 198]);
    d.rect(13, 21, 6, 2, [40, 48, 58]); // レバーの通る溝
    const [x1, y1] = low ? [8, 17] : [24, 5];
    d.line(16, 18, x1, y1, [44, 52, 64]);
    d.line(17, 18, x1 + 1, y1, [44, 52, 64]);
    d.line(16, 17, x1, y1 - 1, shade(base, big ? 0 : -30));
    d.disc(x1, y1, 3, low ? [226, 120, 60] : [80, 160, 236]);
    d.disc(x1, y1 - 1, 2, low ? [255, 190, 120] : [168, 220, 255]);
    if (big) {
      d.rect(9, 20, 14, 2, GOLD);
      d.set(16, 17, [255, 244, 190]);
    }
  });
/** 階段：`up` は上へのぼる（段の幅が上へ向かって狭くなる）、そうでなければ下へおりる。 */
const stairs = (up) =>
  still((d) => {
    d.rect(0, 0, 32, 32, [0, 0, 0, 0]);
    for (let i = 0; i < 5; i++) {
      const y = up ? 24 - i * 5 : 4 + i * 5;
      const inset = up ? i * 2 : 8 - i * 2;
      d.rect(3 + inset, y, 26 - inset * 2, 5, shade([164, 178, 184], up ? -i * 8 : -i * 26));
      d.rect(3 + inset, y, 26 - inset * 2, 1, [226, 236, 238]);
      d.rect(3 + inset, y + 4, 26 - inset * 2, 1, [58, 74, 86]);
    }
    d.rect(2, up ? 0 : 4, 1, 26, [58, 74, 86]);
    d.rect(29, up ? 0 : 4, 1, 26, [58, 74, 86]);
  });
const altar = (withOrb) =>
  still((d) => {
    d.ellipse(16, 28, 11, 3, [10, 30, 50, 90]);
    d.rect(7, 20, 18, 8, [100, 124, 130]);
    d.rect(7, 20, 18, 2, [184, 206, 210]);
    d.rect(9, 14, 14, 7, [128, 154, 160]);
    d.rect(9, 14, 14, 2, [200, 220, 224]);
    if (withOrb) {
      d.disc(16, 9, 7, [20, 84, 150]);
      d.disc(16, 9, 6, [60, 150, 230]);
      d.disc(16, 8, 4, [130, 206, 255]);
      d.disc(14, 6, 2, [236, 250, 255]);
    }
  });
const PROPS = { leverHigh: 0, leverLow: 1, masterHigh: 2, masterLow: 3, stairsUp: 4, stairsDown: 5, orb: 6, altar: 7 };

// ── イベント ──────────────────────────────────────────────────────────
const cmd = (code, params, indent = 0) => ({ code, params, indent });
const text = (t, indent = 0) => cmd("ShowText", { text: t, position: "bottom", background: "window" }, indent);
const page = (p) => ({ conditions: [], trigger: "action", through: false, priority: "same", ...p });
const event = (id, name, { x, y }, pages) => ({ id, name, x, y, pages });
const sw = (id, value = true) => ({ kind: "switch", id, value });
const setSwitch = (ids, value, indent = 0) => cmd("ControlSwitches", { ids: [].concat(ids), value }, indent);
const flash = (color, duration, indent = 0) => cmd("FlashScreen", { color, duration }, indent);
const shake = (power, duration, indent = 0) => cmd("ShakeScreen", { power, duration, wait: false }, indent);
const FLASH_WATER = { r: 120, g: 190, b: 255, a: 0.5 };
const FLASH_GOLD = { r: 255, g: 230, b: 150, a: 0.7 };

const idx = (room) => ROOMS.findIndex((r) => r.id === room.id);
/** 部屋の水位が低い（水が引いている）スイッチ。入るときはどの部屋も水位が高い。 */
const LOW = (room) => `sw_low_${room.id}`;
const HALL_DRAINED = "sw_hall_drained";

/** 水位を変える ChangeMapTile（1 つの水路・堰の横並びを 1 コマンドで）。`toLow` が真なら水が引く。 */
const retile = (layout, toLow) =>
  ["~", "^"].flatMap((ch) =>
    layout.runs[ch].map((r) => cmd("ChangeMapTile", { map: "this", layer: 0, x: r.x, y: r.y, width: r.w, height: 1, tile: toLow ? GATE[ch].low : GATE[ch].high })),
  );

function events(room, layout, assets) {
  const props = (name) => ({ asset: assets["props.png"].id, index: PROPS[name], direction: "down" });
  const people = assets["people.png"].id;
  const i = idx(room);
  const { marks } = layout;
  const out = [];

  // 入口の間：はじめに一度だけ
  if (room.id === "map_hall") {
    out.push(
      event("ev_intro", "はじまり", { x: START.x, y: START.y }, [
        page({
          trigger: "autorun",
          priority: "below",
          through: true,
          commands: [
            text("水に沈んだ 古代の遺跡、\\C[6]水門の遺跡\\C[0]。その奥の 水神の間に、\n雨を呼ぶ 「水神の宝珠」が ねむっている。"),
            text("北の 階段は 水路に さえぎられて 近づけない。\nまずは 案内人に 話しかけてみよう。"),
            cmd("ControlSelfSwitch", { key: "A", value: true }),
          ],
        }),
        page({ conditions: [{ kind: "selfSwitch", key: "A", value: true }], priority: "below", through: true, commands: [] }),
      ]),
    );
    // 案内人：水位・水路・堰・しくみの説明（水路が干上がったあとは、話が変わる）
    const tips = [
      ["遺跡の あちこちに ある \\C[6]レバー\\C[0]を 引くと、その 部屋の\n\\C[6]水位\\C[0]が 上がったり 下がったり する。", "水位が \\C[6]高い\\C[0]ときは、\\C[6]水路\\C[0]が 水に 沈んで 渡れない。\n水位が \\C[6]低い\\C[0]ときは、水が 引いて 底を 歩ける。"],
      ["\\C[6]石の 堰\\C[0]は 反対じゃ。水位が 低いと 石の壁が\n立ちはだかり、高いと 水の下に かくれて 歩けるように なる。", "つまり、水位を 変えると 歩ける 場所も 変わる。\nどこで 引くかを 考えるんじゃ。"],
      ["水位は 部屋ごとに 変わる。そして 部屋を 出ても、\nセーブして 遊びなおしても、そのまま 残る。", "レバーの まわりは いつも 乾いた 床じゃ。\n引いた 拍子に 足元が 水に なる ことは ない。"],
      ["この 広間の 北の 水路は、ずっと 水に 沈んどる。\n奥にある \\C[6]大水門\\C[0]を 開ければ 水が 引くはずじゃ。", "水路の間・浮き橋の間・大水門の間と 進むんじゃ。\n東の すみの 階段が 水路の間への 入口じゃよ。"],
    ];
    out.push(
      event("ev_guide", "案内人", marks.guide[0], [
        page({
          conditions: [sw(HALL_DRAINED, false)],
          graphic: { asset: people, index: 1, direction: "down" },
          commands: [
            text("ようこそ、旅の人。ここは 水門の遺跡じゃ。\n何を 知りたい？"),
            cmd("ShowChoices", { choices: ["水位と水路", "石の堰", "水位の しくみ", "宝珠への道", "やめる"], cancel: 4 }),
            ...tips.flatMap(([a, b], n) => [cmd("ChoiceBranch", { index: n }), text(a, 1), text(b, 1)]),
            cmd("ChoiceBranch", { index: 4 }),
            cmd("EndBranch", {}),
            text("では、気をつけてな。"),
          ],
        }),
        page({
          conditions: [sw(HALL_DRAINED)],
          graphic: { asset: people, index: 1, direction: "down" },
          commands: [text("おお、北の 水路が 干上がっとる！\n大水門が 開いたんじゃな。"), text("この 水路は もう 水に 沈まん。\n北の 階段から 水神の間へ 行くがよい。")],
        }),
      ]),
    );
    // 北の階段（水神の間へ）
    out.push(
      event("ev_up", "水神の間への階段", marks.up[0], [
        page({ graphic: props("stairsUp"), trigger: "touch", priority: "below", through: true, commands: [cmd("TransferPlayer", { mapId: "map_shrine", x: START.x, y: START.y, dir: "up", fade: "black" })] }),
      ]),
    );
    // 東の階段（水路の間へ）
    out.push(
      event("ev_side", "水路の間への階段", marks.side[0], [
        page({ graphic: props("stairsDown"), trigger: "touch", priority: "below", through: true, commands: [cmd("TransferPlayer", { mapId: "map_canal", x: START.x, y: START.y, dir: "up", fade: "black" })] }),
      ]),
    );
    out.push(
      event("ev_down", "出口", marks.down[0], [
        page({ graphic: props("stairsDown"), trigger: "touch", commands: [text("入口は 崩れて ふさがっている。\n宝珠を 持ち帰るまで 帰れない。")] }),
      ]),
    );
  } else {
    // 奥への階段（あれば）と、戻る階段
    if (marks.up.length > 0) {
      const next = ROOMS[i + 1];
      out.push(
        event("ev_up", "奥への階段", marks.up[0], [
          page({ graphic: props("stairsUp"), trigger: "touch", priority: "below", through: true, commands: [cmd("TransferPlayer", { mapId: next.id, x: START.x, y: START.y, dir: "up", fade: "black" })] }),
        ]),
      );
    }
    // 戻る先：入口の間の東の階段の横、水神の間なら入口の間の北の水路、それ以外は前の部屋の階段の横
    const back =
      room.id === "map_canal" ? { map: "map_hall", x: 11, y: 8, dir: "left" } : room.id === "map_shrine" ? { map: "map_hall", x: 7, y: 3, dir: "down" } : { map: ROOMS[i - 1].id, x: 6, y: 2, dir: "down" };
    out.push(
      event("ev_down", "戻る階段", marks.down[0], [
        page({ graphic: props("stairsDown"), trigger: "touch", commands: [cmd("TransferPlayer", { mapId: back.map, x: back.x, y: back.y, dir: back.dir, fade: "black" })] }),
      ]),
    );
  }

  // 水門のレバー：引くたびに、この部屋の水位が高い ⇄ 低い と入れ替わる（水路と堰のタイルを ChangeMapTile で書き換える）
  marks.lever.forEach((p, n) => {
    out.push(
      event(`ev_lever_${n + 1}`, `水門のレバー${n + 1}`, p, [
        page({
          conditions: [sw(LOW(room), false)],
          graphic: props("leverHigh"),
          commands: [
            text("古い 水門の レバーだ。いまは 水位が 高い。\n引くと、水が 引きそうだ。"),
            cmd("ShowChoices", { choices: ["引く", "やめる"], cancel: 1 }),
            cmd("ChoiceBranch", { index: 0 }),
            setSwitch(LOW(room), true, 1),
            ...retile(layout, true).map((c) => ({ ...c, indent: 1 })),
            flash(FLASH_WATER, 14, 1),
            shake(3, 24, 1),
            text("\\C[6]ゴゴゴ……\\C[0] 水位が 下がった！\n水路の 水が 引いて、底が 歩けるように なった。\n石の 堰が 水面に あらわれて、道を ふさいだ。", 1),
            cmd("ChoiceBranch", { index: 1 }),
            cmd("EndBranch", {}),
          ],
        }),
        page({
          conditions: [sw(LOW(room))],
          graphic: props("leverLow"),
          commands: [
            text("古い 水門の レバーだ。いまは 水位が 低い。\n引くと、水が もどって きそうだ。"),
            cmd("ShowChoices", { choices: ["引く", "やめる"], cancel: 1 }),
            cmd("ChoiceBranch", { index: 0 }),
            setSwitch(LOW(room), false, 1),
            ...retile(layout, false).map((c) => ({ ...c, indent: 1 })),
            flash(FLASH_WATER, 14, 1),
            shake(3, 24, 1),
            text("\\C[6]ザザザ……\\C[0] 水位が 上がった！\n水路が 水に 沈んで 渡れなくなり、石の 堰は\n水の下で 浅瀬に なった。", 1),
            cmd("ChoiceBranch", { index: 1 }),
            cmd("EndBranch", {}),
          ],
        }),
      ]),
    );
  });

  // 大水門のレバー：まだ行っていない入口の間の水路を、いっぺんに干上がらせる。そして入口の間へ運ばれる
  marks.master.forEach((p) => {
    out.push(
      event("ev_master", "大水門のレバー", p, [
        page({
          conditions: [sw(HALL_DRAINED, false)],
          graphic: props("masterHigh"),
          commands: [
            text("遺跡じゅうの 水を つかさどる \\C[6]大水門\\C[0]の レバーだ！\n金の 飾りが 光っている。"),
            cmd("ShowChoices", { choices: ["引く", "やめる"], cancel: 1 }),
            cmd("ChoiceBranch", { index: 0 }),
            setSwitch(HALL_DRAINED, true, 1),
            // 入口の間は、まだ一度も出入りしていなくてもよい（入ったときに反映される）
            cmd("ChangeMapTile", { map: "map_hall", layer: 0, x: 1, y: 3, width: 13, height: 1, tile: T.bed }, 1),
            flash(FLASH_GOLD, 30, 1),
            shake(4, 40, 1),
            text("\\C[6]ゴゴゴゴゴゴ……！\\C[0]\n遺跡じゅうの 水が 動きだした。大きな 流れに のまれて……", 1),
            cmd("TransferPlayer", { mapId: "map_hall", x: START.x, y: START.y, dir: "up", fade: "white" }, 1),
            cmd("ChoiceBranch", { index: 1 }),
            cmd("EndBranch", {}),
          ],
        }),
        page({ conditions: [sw(HALL_DRAINED)], graphic: props("masterLow"), commands: [text("大水門の レバーは もう 引ききってある。\n入口の間の 水路は 干上がったはずだ。")] }),
      ]),
    );
  });

  // 水神の宝珠：取ると、エンディング
  if (room.id === "map_shrine") {
    out.push(
      event("ev_orb", "水神の宝珠", marks.altar[0], [
        page({
          conditions: [sw("sw_orb", false)],
          graphic: props("orb"),
          commands: [
            text("祭壇に、深い 青に かがやく 宝珠が 浮かんでいる。\nこれが 「水神の宝珠」だ！"),
            setSwitch("sw_orb", true),
            flash(FLASH_GOLD, 40),
            shake(3, 30),
            text("宝珠を 手に取ると、遺跡じゅうに 水の流れる 音が ひびいた。"),
            text("かわいた 大地に 雨が もどってくる。\\C[6]おめでとう！\\C[0]\n（水位を 切りかえて、遺跡を 渡りきった！）"),
            cmd("ReturnToTitle", {}),
          ],
        }),
        page({ conditions: [sw("sw_orb")], graphic: props("altar"), commands: [text("祭壇は からっぽだ。")] }),
      ]),
    );
  }
  return out;
}

// ── 書き出し ──────────────────────────────────────────────────────────
const toJson = (value) => `${JSON.stringify(value, null, 2).replace(/\[\s+([-\d.,\s]+?)\s+\]/g, (_, body) => `[${body.split(/,\s*/).join(", ")}]`)}\n`;

const layouts = Object.fromEntries(ROOMS.map((r) => [r.id, readRoom(r)]));
rmSync(ROOT, { recursive: true, force: true });
const assets = writeAssets(join(ROOT, "assets"), {
  "water_tileset.png": tileset(),
  "hero.png": character(HERO),
  "people.png": sheet(2, [
    character({ shirt: [54, 124, 84], hair: [34, 30, 40], skin: [240, 200, 160] }),
    character({ shirt: [96, 150, 190], hair: [226, 230, 236], skin: [236, 206, 176] }),
  ]),
  "props.png": sheet(3, [lever(false), lever(true), lever(false, true), lever(true, true), stairs(true), stairs(false), altar(true), altar(false)]),
});

mkdirSync(join(ROOT, "maps"), { recursive: true });
for (const room of ROOMS) {
  const layout = layouts[room.id];
  const evs = events(room, layout, assets);
  const map = {
    id: room.id,
    width: W,
    height: H,
    tileset: "ts_water",
    layers: [{ name: "ground", tiles: layout.ground }, { name: "objects", tiles: layout.objects }],
    events: Object.fromEntries(evs.map((e) => [e.id, e])),
  };
  writeFileSync(join(ROOT, "maps", `${room.id}.json`), toJson(map));
}

const entry = (name, a) => ({ name, kind: "image", mime: "image/png", size: a.size, width: a.width, height: a.height });
const params = Object.fromEntries(["mhp", "mmp", "atk", "def", "mat", "mdf", "agi", "luk"].map((p) => [p, { base: p === "mhp" ? 100 : p === "mmp" ? 20 : 10, growth: 2 }]));
const leverRooms = ROOMS.filter((r) => layouts[r.id].marks.lever.length > 0);
const project = {
  formatVersion: 1,
  meta: { id: "water", title: "デモ：水門の遺跡", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" },
  system: {
    startMap: ROOM_IDS[0],
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
  tilesets: { ts_water: { id: "ts_water", name: "水門の遺跡", image: { asset: assets["water_tileset.png"].id }, passage: PASSAGE } },
  database: {
    actors: { actor_hero: { id: "actor_hero", name: "リオ", classId: "class_hero", initialLevel: 1, walk: { asset: assets["hero.png"].id }, equips: {} } },
    classes: { class_hero: { id: "class_hero", name: "旅人", skills: [], params } },
    skills: {},
    items: {},
    enemies: {},
    troops: {},
    states: {},
    commonEvents: {},
  },
  assets: { entries: Object.fromEntries(Object.entries(assets).map(([name, a]) => [a.id, entry(name, a)])) },
  switches: {
    ...Object.fromEntries(leverRooms.map((r) => [LOW(r), { name: `${r.name}の水位が低い（水が引いている）` }])),
    [HALL_DRAINED]: { name: "大水門が開いて、入口の間の水路が干上がった" },
    sw_orb: { name: "水神の宝珠を取った" },
  },
  variables: {},
};
writeFileSync(join(ROOT, "project.json"), toJson(project));
console.log(`\n${W}x${H} の部屋 ${ROOMS.length} つ：${ROOMS.map((r) => r.name).join(" → ")}`);
