#!/usr/bin/env node
/**
 * 水門の遺跡のデモ（fixtures/projects/v1/water）を丸ごと生成する開発用スクリプト。
 * 出力: project.json、maps/<MapId>.json、assets/<AssetId>.<ext>（AssetId = 内容の sha256 先頭 16 桁）。
 * 生成物はコミット済み。遺跡の作りを変えたいときだけ再実行する（何度実行しても同じものができる）。
 *
 *   node tools/make-water-demo.mjs
 *
 * 水没した遺跡の奥にある「水神の宝珠」を取りにいく。戦闘は無く、水位をあやつる謎解きだけで進む。入口の間から、西と東の二つの部屋を
 * 好きな順に解いて、水晶を 2 つ集めると、北の水路が干上がって水神の間へ渡れる。見せたいエンジンの機能：
 * 1. マップのタイルの書き換え（`ChangeMapTile`）：水路（`~`）と堰（`^`）のタイルを、水位に合わせて入れ替える。
 *    水位が高いとき：水路は水に沈んで通れず、堰は水の下の浅瀬で歩ける。水位が低いとき：水路は干上がって底を歩け、堰は石の壁になる。
 *    通行判定は書き換えたタイルを見るので、水位を変えると歩ける所が変わる。書き換えは、部屋を出ても・セーブしても残る（`GameState.mapTiles`）。
 * 2. 浮き橋の間（西）：押せる木箱（`pushable`）と水位の組み合わせ。水位が低いとき水路の底へ木箱を押しこんで、水位を上げると、木箱は沈んで
 *    永久の浮き橋（ずっと渡れるタイル）になる。並列イベントが毎フレーム、木箱が水路のマスに載っているかを `evx()` / `evy()` で調べて、
 *    沈めて、そのマスを `ChangeMapTile` で浮き橋にする。レバーは、浮き橋にしたマスをもとの水に戻さない。入口の魔法陣で、やり直せる。
 * 3. 連動水門の間（東）：青・緑・紫の三つの水路が、それぞれ別の水位を持つ。レバーはランプの色の水路の水位を、まとめて入れかえる
 *    （ひとつのレバーが複数の水路を動かす）。どのレバーをどの順に引くかを考える。
 * 4. 別のマップの書き換え：二つ目の水晶を取ると、入口の間の水路（まだ入っていなくてもよい）を `ChangeMapTile { map: "map_hall" }` で干上がらせる。
 * パズルは、tools の外で探索して決めた（apps/player の fixture テストが、同じ規則のモデルで最短の手順を BFS で求めて、実際のエンジンで再生する）：
 * 浮き橋の間 91 手（箱を 20 回あまり押す）、連動水門の間 80 手（レバーを 5 回引く）。どちらも、解き方を知らないと手数が合わない。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blit, canvas, character, HERO, image, lcg, shade, sheet, TILE, writeAssets } from "./pixel-art.mjs";
import { cmd, entry, event, flash, page, params, setSwitch, sw, text, toJson } from "./demo-lib.mjs";

const ROOT = join(import.meta.dirname, "..", "fixtures", "projects", "v1", "water");

/** 画面は 15×11 タイル。部屋はどれもちょうど 1 画面（スクロールしない）。 */
const SCREEN_W = 15;
const SCREEN_H = 11;
const START = { x: 7, y: 8 };

// ── 部屋 ──────────────────────────────────────────────────────────────
/**
 * 文字の意味：`#` 壁、`.` 床、`O` 石柱（通れない）、`<` 戻る階段、`G` 案内人、`W` / `E` 西 / 東の階段、`>` 北の階段、`P` / `Q` 水晶の台座（入口の間）、
 * `T` 祭壇（水神の宝珠）、`X` 水晶の祭壇、`R` 木箱（床の上に置く。押せる）、`L` 水門のレバー（水位を入れかえる）、`1` `2` `3` 連動水門のレバー、
 * 水路：`~`（水位が高いと水で通れず、低いと干上がって歩ける）と、堰：`^`（高いと浅瀬で歩け、低いと石の壁）。連動水門の間では、水路が三つに分かれる：
 * 小文字 `a` `b` `c` = 青・緑・紫の水路、大文字 `A` `B` `C` = 青・緑・紫の堰。`~` / `^` は青（`a` / `A`）と同じ。
 * 階段 `<` の上の (7, 8) が入口（プレイヤーが着く所）。`<` は通れない（下へ歩いて突き当たると前の部屋へ戻る）。
 * どの部屋も、水位が高い（水路は水の下）ところから始まる。レバーのまわりは、水路や堰ではなく床（レバーを引いたとき、足元が水になって動けなくならないように）。
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
      "#...P.....Q...#",
      "#......G......#",
      "#.............#",
      "#.O.........O.#",
      "#.W.........E.#",
      "#......<......#",
      "###############",
    ],
  },
  {
    id: "map_crates",
    name: "浮き橋の間",
    plan: [
      "###############",
      "###############",
      "#....#X#......#",
      "#....#...#....#",
      "##^...####^##^#",
      "#.........##..#",
      "###~#~~##~#~#~#",
      "#L#..R........#",
      "#....R........#",
      "#######<#######",
      "###############",
    ],
  },
  {
    id: "map_gates",
    name: "連動水門の間",
    plan: [
      "###############",
      "###############",
      "#....3#cX#.1..#",
      "#......c.2..#.#",
      "#......c#.....#",
      "#ACCCCCCCaaaab#",
      "#...#......#..#",
      "#.............#",
      "#.............#",
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

/** 水路の色：青（a）・緑（b）・紫（c）。 */
const CHANNELS = {
  a: { name: "青", color: [36, 98, 170], tiles: { water: 2, bed: 3, shallow: 4, barrier: 5 } },
  b: { name: "緑", color: [26, 150, 104], tiles: { water: 11, bed: 12, shallow: 13, barrier: 14 } },
  c: { name: "紫", color: [128, 78, 188], tiles: { water: 15, bed: 16, shallow: 17, barrier: 18 } },
};
const T = { floor: 1, wallTop: 6, wallFace: 7, pillar: 8, moss: 9, raft: 10 };
const CELLS = 19;
/** 通れるのは、床・干上がった水路の底・水の下の浅瀬・浮き橋だけ。水・石の堰・壁・石柱は通れない。 */
const PASSAGE = Array.from({ length: CELLS }, (_, id) => {
  const blocked = [T.wallTop, T.wallFace, T.pillar, T.moss, ...Object.values(CHANNELS).flatMap((c) => [c.tiles.water, c.tiles.barrier])];
  return blocked.includes(id) ? 0 : 15;
});
/** 見取り図の文字 → 水路（`ch`）と、水路（`water`）か堰（`dam`）か。 */
const GATE_CHAR = { "~": ["a", "water"], "^": ["a", "dam"], a: ["a", "water"], b: ["b", "water"], c: ["c", "water"], A: ["a", "dam"], B: ["b", "dam"], C: ["c", "dam"] };
/** 水位が高いとき / 低いときの、水路・堰のタイル。 */
const tileOf = (ch, kind, low) => {
  const t = CHANNELS[ch].tiles;
  return kind === "water" ? (low ? t.bed : t.water) : low ? t.barrier : t.shallow;
};

/** 部屋の見取り図を読む：地面と飾りのタイル、各印の位置、水路・堰（水位で入れかわるマス）。 */
function readRoom(room) {
  const { plan } = room;
  if (plan.length !== H || plan.some((row) => row.length !== W)) throw new Error(`${room.id}: 部屋は ${W}x${H} でなければならない`);
  const marks = { lever: [], crate: [], goal: [], up: [], down: [], west: [], east: [], guide: [], altar: [], ped: [] };
  const KIND = { L: "lever", 1: "lever", 2: "lever", 3: "lever", R: "crate", X: "goal", ">": "up", "<": "down", W: "west", E: "east", G: "guide", T: "altar", P: "ped", Q: "ped" };
  const ground = [];
  const objects = [];
  /** 水位で入れかわるマス。 */
  const gates = [];
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
      } else if (GATE_CHAR[ch] !== undefined) {
        const [c, kind] = GATE_CHAR[ch];
        g = tileOf(c, kind, false);
        gates.push({ x, y, ch: c, kind });
      } else if (ch === "O") o = T.pillar;
      ground.push(g);
      objects.push(o);
    }
  }
  if (plan[START.y][START.x] !== "." || plan[START.y + 1][START.x] !== "<") throw new Error(`${room.id}: 入口 (${START.x}, ${START.y}) は床で、その下が階段でなければならない`);
  if (marks.down.length !== 1) throw new Error(`${room.id}: 戻る階段は 1 つ`);
  // レバーのまわりに水路・堰があると、そこに立ってレバーを引いたとき、足元が水になって動けなくなる
  for (const p of marks.lever) {
    for (const [dx, dy] of [[0, 1], [-1, 0], [1, 0], [0, -1]]) {
      if (gates.some((g) => g.x === p.x + dx && g.y === p.y + dy)) throw new Error(`${room.id}: レバー (${p.x}, ${p.y}) のとなりに水路・堰がある`);
    }
  }
  return { ground, objects, marks, gates };
}

/** 同じ水路・同じ種類のマスが横に続くところ（`ChangeMapTile` で 1 度に書き換える）。 */
const runsOf = (gates, ch, kind) => {
  const runs = [];
  for (const g of gates.filter((x) => x.ch === ch && x.kind === kind)) {
    const last = runs.at(-1);
    if (last !== undefined && last.y === g.y && last.x + last.w === g.x) last.w++;
    else runs.push({ x: g.x, y: g.y, w: 1 });
  }
  return runs;
};

// ── タイルセット ──────────────────────────────────────────────────────
const STONE = [118, 132, 134];
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
  // 水路の色ごとに、水・干上がった底・浅瀬・石の堰
  Object.values(CHANNELS).forEach(({ color, tiles }, k) => {
    // 水：深い水（通れない）
    {
      const c = cell(tiles.water, { wrap: true });
      waves(c, color, 7 + k, 36);
      c.rect(0, 0, TILE, 2, shade(color, -28));
    }
    // 干上がった水路の底：湿った砂に、水の色の水たまりと波の跡が残る
    {
      const c = cell(tiles.bed, { wrap: true });
      c.rect(0, 0, TILE, TILE, SAND);
      const rnd = lcg(19 + k);
      for (let i = 0; i < 40; i++) c.set(rnd() * TILE, rnd() * TILE, shade(SAND, rnd() < 0.5 ? 14 : -14));
      for (const [x, y, w, h] of [[5, 7, 7, 3], [19, 18, 8, 4], [8, 24, 5, 2]]) {
        c.ellipse(x + 3, y + 1, w >> 1, h >> 1, shade(color, 40));
        c.ellipse(x + 3, y + 1, (w >> 1) - 1, (h >> 1) - 1 || 1, shade(color, 70));
      }
      for (const y of [4, 13, 29]) c.line(1, y, 30, y + 1, shade(SAND, -24));
      c.rect(0, 0, TILE, 1, shade(SAND, -40));
    }
    // 水の下の浅瀬：水に飛び石が沈んでいる（歩ける）
    {
      const c = cell(tiles.shallow, { wrap: true });
      waves(c, shade(color, 26), 23 + k, 28);
      for (const [x, y] of [[3, 3], [17, 3], [10, 15], [3, 21], [20, 20]]) {
        c.rect(x, y, 10, 8, [96, 124, 130]);
        c.rect(x, y, 10, 2, [150, 184, 188]);
        c.rect(x, y + 7, 10, 1, [58, 84, 92]);
        c.rect(x, y, 1, 8, [124, 152, 156]);
      }
    }
    // 石の堰：水をせきとめる、鉄格子つきの石壁（通れない）。水路の色の宝石が埋めてある
    {
      const c = cell(tiles.barrier);
      c.rect(0, 0, TILE, TILE, [88, 100, 108]);
      c.rect(0, 0, TILE, 4, [150, 164, 170]);
      c.rect(0, 28, TILE, 4, [52, 62, 72]);
      for (let x = 3; x < TILE; x += 6) {
        c.rect(x, 5, 3, 22, [50, 56, 68]);
        c.rect(x, 5, 1, 22, [120, 128, 142]);
      }
      c.rect(0, 12, TILE, 2, [72, 80, 94]);
      c.rect(0, 22, TILE, 2, [72, 80, 94]);
      for (const x of [6, 15, 26]) c.rect(x, 24, 1, 8, shade(color, 30)); // 水がしみだした跡
      c.ellipse(16, 17, 4, 3, shade(color, -60));
      c.ellipse(16, 17, 3, 2, shade(color, 40));
      c.set(15, 16, [255, 255, 255]);
    }
  });
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
  // 浮き橋：木箱が沈んで、水に浮かぶ木の板になったもの（通れる。どの水位でも）
  {
    const c = cell(T.raft, { wrap: true });
    waves(c, shade(CHANNELS.a.color, 26), 41, 20);
    c.rect(2, 3, 28, 26, [92, 62, 36]);
    for (let y = 3; y < 29; y += 6) {
      c.rect(2, y, 28, 5, y % 12 === 3 ? [168, 120, 66] : [150, 104, 56]);
      c.rect(2, y + 5, 28, 1, [70, 44, 24]);
    }
    for (const x of [4, 27]) for (const y of [5, 17, 25]) c.set(x, y, [60, 38, 22]);
    c.rect(2, 3, 28, 1, [196, 150, 90]);
    c.rect(2, 3, 1, 26, [196, 150, 90]);
  }
  return img;
}

// ── 絵：物（レバー・階段・祭壇・木箱）と人 ────────────────────────────
const still = (draw) => {
  const one = canvas(TILE, TILE);
  draw(one);
  const out = image(TILE * 3, TILE * 4);
  for (let row = 0; row < 4; row++) for (let p = 0; p < 3; p++) blit(out, one, p * TILE, row * TILE);
  return out;
};
const GOLD = [236, 200, 96];
/** 水門のレバー：石の台座から生えた鉄のレバー。`low` は水が引いている（レバーが下がっている）。 */
const lever = (low) =>
  still((d) => {
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
    d.line(16, 17, x1, y1 - 1, [120, 134, 142]);
    d.disc(x1, y1, 3, low ? [226, 120, 60] : [80, 160, 236]);
    d.disc(x1, y1 - 1, 2, low ? [255, 190, 120] : [168, 220, 255]);
  });
/** 連動水門のレバー：台座の前に、動かす水路の色のランプが並ぶ。 */
const lampLever = (channels) =>
  still((d) => {
    d.ellipse(16, 28, 12, 3, [10, 30, 40, 100]);
    d.rect(7, 19, 18, 9, [96, 108, 116]);
    d.rect(7, 19, 18, 2, [164, 176, 182]);
    d.rect(7, 26, 18, 2, [60, 70, 80]);
    d.rect(10, 15, 12, 5, [124, 138, 146]);
    d.rect(10, 15, 12, 1, [182, 194, 198]);
    d.line(16, 17, 16, 5, [44, 52, 64]);
    d.line(17, 17, 17, 5, [44, 52, 64]);
    d.disc(16, 4, 3, GOLD);
    d.disc(16, 3, 2, [255, 244, 190]);
    // ランプ：台座の前に、動かす水路の色
    const xs = channels.length === 1 ? [16] : channels.length === 2 ? [12, 20] : [9, 16, 23];
    channels.forEach((ch, i) => {
      const c = CHANNELS[ch].color;
      d.disc(xs[i], 23, 3, shade(c, -70));
      d.disc(xs[i], 23, 2, shade(c, 50));
      d.set(xs[i] - 1, 22, [255, 255, 255]);
    });
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
/** 祭壇：`gem` の色の宝石（水晶）か、水神の宝珠（`orb`）を載せる。`null` なら空。 */
const altar = (gem, orb = false) =>
  still((d) => {
    d.ellipse(16, 28, 11, 3, [10, 30, 50, 90]);
    d.rect(7, 20, 18, 8, [100, 124, 130]);
    d.rect(7, 20, 18, 2, [184, 206, 210]);
    d.rect(9, 14, 14, 7, [128, 154, 160]);
    d.rect(9, 14, 14, 2, [200, 220, 224]);
    if (orb) {
      d.disc(16, 9, 7, [20, 84, 150]);
      d.disc(16, 9, 6, [60, 150, 230]);
      d.disc(16, 8, 4, [130, 206, 255]);
      d.disc(14, 6, 2, [236, 250, 255]);
    } else if (gem !== null) {
      // 六角柱の水晶
      d.rect(12, 3, 8, 12, shade(gem, -40));
      d.rect(13, 2, 6, 13, gem);
      d.rect(14, 1, 4, 2, shade(gem, 60));
      d.rect(13, 4, 2, 9, shade(gem, 70));
      d.set(14, 3, [255, 255, 255]);
    }
  });
/** 木箱：水に浮く、押せる箱。 */
const crate = () =>
  still((d) => {
    d.ellipse(16, 28, 12, 3, [10, 24, 36, 110]);
    const edge = [58, 36, 18];
    d.rect(4, 6, 24, 22, edge);
    d.rect(5, 7, 22, 20, [168, 118, 64]);
    d.rect(5, 7, 22, 3, [214, 164, 100]);
    d.rect(5, 23, 22, 4, [120, 80, 40]);
    for (const x of [5, 25]) d.rect(x, 7, 2, 20, [120, 80, 40]);
    d.line(6, 8, 26, 26, edge);
    d.line(26, 8, 6, 26, edge);
    for (const [x, y] of [[7, 9], [24, 9], [7, 24], [24, 24]]) d.set(x, y, [236, 220, 170]);
  });
/** 魔法陣（やり直し）：足元に描かれた円。 */
const rune = () =>
  still((d) => {
    const c = [120, 206, 255];
    d.ellipse(16, 18, 13, 9, shade(c, -90));
    d.ellipse(16, 18, 12, 8, [30, 54, 100]);
    d.ellipse(16, 18, 11, 7, c);
    d.ellipse(16, 18, 9, 5, [30, 54, 100]);
    for (const [x0, y0, x1, y1] of [[16, 13, 16, 23], [10, 15, 22, 21], [10, 21, 22, 15]]) d.line(x0, y0, x1, y1, c);
    d.disc(16, 18, 2, [236, 250, 255]);
  });
const GEM_A = [90, 220, 240];
const GEM_B = [232, 100, 200];
const PROPS = {
  leverHigh: 0, leverLow: 1, lamp1: 2, lamp2: 3, lamp3: 4, stairsUp: 5, stairsDown: 6,
  gemA: 7, gemB: 8, altarEmpty: 9, orb: 10, crate: 11, rune: 12,
};

// ── イベント ──────────────────────────────────────────────────────────
const shake = (power, duration, indent = 0) => cmd("ShakeScreen", { power, duration, wait: false }, indent);
const FLASH_WATER = { r: 120, g: 190, b: 255, a: 0.5 };
const FLASH_GOLD = { r: 255, g: 230, b: 150, a: 0.7 };
/** コマンド列を `n` だけ字下げする。 */
const shift = (cmds, n) => cmds.map((c) => ({ ...c, indent: c.indent + n }));
/** `condition` が真のときだけ `body` を行う（`body` は字下げ 0 で書く）。 */
const when = (condition, body) => [cmd("ConditionalBranch", { condition }), ...shift(body, 1), cmd("EndBranch", {})];
/** `condition` が真なら `yes`、そうでなければ `no` を行う（どちらも字下げ 0 で書く）。 */
const ifElse = (condition, yes, no) => [cmd("ConditionalBranch", { condition }), ...shift(yes, 1), cmd("Else", {}), ...shift(no, 1), cmd("EndBranch", {})];
/** 「引く / やめる」の選択肢：「引く」を選んだときだけ `body` を行う。 */
const pull = (body) => [cmd("ShowChoices", { choices: ["引く", "やめる"], cancel: 1 }), cmd("ChoiceBranch", { index: 0 }), ...shift(body, 1), cmd("ChoiceBranch", { index: 1 }), cmd("EndBranch", {})];
const retile = (runs, tile) => runs.map((r) => cmd("ChangeMapTile", { map: "this", layer: 0, x: r.x, y: r.y, width: r.w, height: 1, tile }));

/** 部屋の水位が低い（水が引いている）スイッチ。連動水門の間は、水路（青・緑・紫）ごと。 */
const LOW = (room, ch = "a") => (room.id === "map_gates" ? `sw_low_${room.id}_${ch}` : `sw_low_${room.id}`);
const HALL_DRAINED = "sw_hall_drained";
const CRYSTAL = { map_crates: "sw_crystal_a", map_gates: "sw_crystal_b" };
const SUNK = (n) => `sw_sunk_${n}`;
const RAFT = (i) => `sw_raft_${i}`;

/** 水晶を取ったとき：もう片方も取っていれば、入口の間の水路を干上がらせる（まだ入っていなくてもよい別のマップの書き換え）。 */
const crystalEvent = (room, pos, props, gem) => {
  const mine = CRYSTAL[room.id];
  const other = room.id === "map_crates" ? CRYSTAL.map_gates : CRYSTAL.map_crates;
  return event("ev_crystal", "水晶の祭壇", pos, [
    page({
      conditions: [sw(mine, false)],
      graphic: props(gem),
      commands: [
        text("祭壇に、澄んだ 水晶が 浮かんでいる。\n手に取ると、ひんやりと 冷たい。"),
        setSwitch(mine, true),
        flash(FLASH_GOLD, 24),
        text("\\C[6]水晶を 手に入れた！\\C[0]\n入口の間の 台座に 戻そう。"),
        ...when(`s("${other}")`, [
          setSwitch(HALL_DRAINED, true),
          cmd("ChangeMapTile", { map: "map_hall", layer: 0, x: 1, y: 3, width: 13, height: 1, tile: CHANNELS.a.tiles.bed }),
          shake(3, 40),
          text("二つの 水晶が そろった。\\C[6]ゴゴゴ……\\C[0]\n遠くで 水の 流れる 音が する。"),
          text("入口の間の 北の 水路が 干上がった はずだ。\n入口の間へ もどって、北の 階段を めざそう。"),
        ]),
      ],
    }),
    page({ conditions: [sw(mine)], graphic: props("altarEmpty"), commands: [text("祭壇は からっぽだ。水晶は もう 持ちだした。")] }),
  ]);
};

function events(room, layout, assets) {
  const props = (name) => ({ asset: assets["props.png"].id, index: PROPS[name], direction: "down" });
  const people = assets["people.png"].id;
  const { marks } = layout;
  const out = [];
  const stair = (id, name, p, prop, to, trigger) =>
    event(id, name, p, [page({ graphic: props(prop), trigger: "touch", ...(trigger ?? {}), commands: [cmd("TransferPlayer", { mapId: to.map, x: to.x, y: to.y, dir: to.dir, fade: "black" })] })]);
  const door = { priority: "below", through: true };

  // ── 入口の間 ─────────────────────────────────────────────
  if (room.id === "map_hall") {
    out.push(
      event("ev_intro", "はじまり", START, [
        page({
          trigger: "autorun",
          priority: "below",
          through: true,
          commands: [
            text("水に沈んだ 古代の遺跡、\\C[6]水門の遺跡\\C[0]。その奥の 水神の間に、\n雨を呼ぶ 「水神の宝珠」が ねむっている。"),
            text("北の 階段は 水路に さえぎられて 近づけない。\n西と 東の 部屋に ある \\C[6]水晶\\C[0]を 二つ 集めよう。"),
            cmd("ControlSelfSwitch", { key: "A", value: true }),
          ],
        }),
        page({ conditions: [{ kind: "selfSwitch", key: "A", value: true }], priority: "below", through: true, commands: [] }),
      ]),
    );
    const tips = [
      ["遺跡の \\C[6]レバー\\C[0]を 引くと、\\C[6]水位\\C[0]が 変わる。\n水位が 高いと、\\C[6]水路\\C[0]は 水に 沈んで 渡れない。", "水位が 低いと、水が 引いて 底を 歩ける。\n\\C[6]石の 堰\\C[0]は 反対で、低いと 石の壁、高いと 浅瀬じゃ。"],
      ["西の \\C[6]浮き橋の間\\C[0]には 木箱が ある。水位が 低いうちに\n水路の 底へ 箱を 押しこんで、水位を 上げるんじゃ。", "水の中の 箱は 沈んで、ずっと 渡れる \\C[6]浮き橋\\C[0]に なる。\nただし 箱は 少ない。どこを 橋に するか 考えなされ。"],
      ["東の \\C[6]連動水門の間\\C[0]は、青・緑・紫の 三つの 水路が\nそれぞれ 別の 水位を もっておる。", "レバーの \\C[6]ランプの 色\\C[0]が、動かす 水路じゃ。\n一つの レバーが 二つの 水路を 同時に 動かす ことも ある。"],
      ["足元が 水に なって 動けなく なる ことは ない。\nレバーの まわりは いつも 乾いた 床じゃ。", "水位は 部屋を 出ても、セーブしても 残る。\n箱を 動かしすぎたら 入口の \\C[6]魔法陣\\C[0]で やり直せ。"],
    ];
    out.push(
      event("ev_guide", "案内人", marks.guide[0], [
        page({
          conditions: [sw(HALL_DRAINED, false)],
          graphic: { asset: people, index: 1, direction: "down" },
          commands: [
            text("ようこそ、旅の人。ここは 水門の遺跡じゃ。\n何を 知りたい？"),
            cmd("ShowChoices", { choices: ["水位と水路", "木箱と浮き橋", "連動水門", "しくみ・やり直し", "やめる"], cancel: 4 }),
            ...tips.flatMap(([a, b], n) => [cmd("ChoiceBranch", { index: n }), text(a, 1), text(b, 1)]),
            cmd("ChoiceBranch", { index: 4 }),
            cmd("EndBranch", {}),
            text("水晶は 西と 東の 部屋に 一つずつ。\n二つ そろえば、北の 水路が 干上がる はずじゃ。"),
          ],
        }),
        page({
          conditions: [sw(HALL_DRAINED)],
          graphic: { asset: people, index: 1, direction: "down" },
          commands: [text("おお、北の 水路が 干上がっとる！\n二つの 水晶を そろえたんじゃな。"), text("この 水路は もう 水に 沈まん。\n北の 階段から 水神の間へ 行くがよい。")],
        }),
      ]),
    );
    out.push(stair("ev_up", "水神の間への階段", marks.up[0], "stairsUp", { map: "map_shrine", x: START.x, y: START.y, dir: "up" }, door));
    out.push(stair("ev_west", "浮き橋の間への階段", marks.west[0], "stairsDown", { map: "map_crates", x: START.x, y: START.y, dir: "up" }, door));
    out.push(stair("ev_east", "連動水門の間への階段", marks.east[0], "stairsDown", { map: "map_gates", x: START.x, y: START.y, dir: "up" }, door));
    out.push(
      event("ev_down", "出口", marks.down[0], [
        page({ graphic: props("stairsDown"), commands: [text("入口は 崩れて ふさがっている。\n宝珠を 持ち帰るまで 帰れない。")] }),
      ]),
    );
    // 水晶の台座：取った水晶が置かれる
    marks.ped.forEach((p, n) => {
      const key = n === 0 ? CRYSTAL.map_crates : CRYSTAL.map_gates;
      out.push(
        event(`ev_ped_${n === 0 ? "a" : "b"}`, "水晶の台座", p, [
          page({ conditions: [sw(key, false)], graphic: props("altarEmpty"), commands: [text("水晶を 置く 台座のようだ。\n水晶は 取ったときに ここへ 戻ってくる。")] }),
          page({ conditions: [sw(key)], graphic: props(n === 0 ? "gemA" : "gemB"), commands: [text("水晶が 台座で 静かに 光っている。")] }),
        ]),
      );
    });
    return out;
  }

  // ── 水神の間 ─────────────────────────────────────────────
  if (room.id === "map_shrine") {
    out.push(stair("ev_down", "戻る階段", marks.down[0], "stairsDown", { map: "map_hall", x: 7, y: 3, dir: "down" }));
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
            text("かわいた 大地に 雨が もどってくる。\\C[6]おめでとう！\\C[0]\n（水位を あやつって、遺跡を 渡りきった！）"),
            cmd("ReturnToTitle", {}),
          ],
        }),
        page({ conditions: [sw("sw_orb")], graphic: props("altarEmpty"), commands: [text("祭壇は からっぽだ。")] }),
      ]),
    );
    return out;
  }

  // ── パズルの部屋（浮き橋の間・連動水門の間）の共通：戻る階段 ──
  const back = room.id === "map_crates" ? { map: "map_hall", x: 3, y: 8, dir: "right" } : { map: "map_hall", x: 11, y: 8, dir: "left" };
  out.push(stair("ev_down", "戻る階段", marks.down[0], "stairsDown", back));

  // ── 浮き橋の間：木箱・水位のレバー・沈める仕掛け・魔法陣・水晶 ──
  if (room.id === "map_crates") {
    const water = layout.gates.filter((g) => g.kind === "water");
    const dams = runsOf(layout.gates, "a", "dam");
    const crates = marks.crate.map((p, n) => ({ ...p, id: `ev_crate_${n + 1}`, n: n + 1 }));
    /** 水路のマスを、水位に合わせて書き換える。浮き橋にしたマスはそのまま。 */
    const level = (toLow) => [
      ...water.flatMap((g, i) => when(`!s("${RAFT(i)}")`, [cmd("ChangeMapTile", { map: "this", layer: 0, x: g.x, y: g.y, width: 1, height: 1, tile: tileOf("a", "water", toLow) })])),
      ...retile(dams, tileOf("a", "dam", toLow)),
    ];
    out.push(
      ...crates.map((c) =>
        event(c.id, "木箱", c, [
          page({ graphic: props("crate"), pushable: true, commands: [text("水に浮く 木箱だ。正面から 押せば 動かせそうだ。")] }),
          // 沈んだ木箱：浮き橋の下に消える（通れる・見えない）
          page({ conditions: [sw(SUNK(c.n))], priority: "below", through: true, commands: [] }),
        ]),
      ),
    );
    out.push(
      event("ev_lever_1", "水門のレバー", marks.lever[0], [
        page({
          conditions: [sw(LOW(room), false)],
          graphic: props("leverHigh"),
          commands: [
            text("古い 水門の レバーだ。いまは 水位が 高い。\n引くと、水が 引きそうだ。"),
            ...pull([
              setSwitch(LOW(room), true),
              ...level(true),
              flash(FLASH_WATER, 14),
              shake(3, 24),
              text("\\C[6]ゴゴゴ……\\C[0] 水位が 下がった！\n水路の 水が 引いて、底が 歩けるように なった。\n石の 堰が あらわれて、道を ふさいだ。"),
            ]),
          ],
        }),
        page({
          conditions: [sw(LOW(room))],
          graphic: props("leverLow"),
          commands: [
            text("古い 水門の レバーだ。いまは 水位が 低い。\n引くと、水が もどって きそうだ。"),
            ...pull([
              setSwitch(LOW(room), false),
              ...level(false),
              flash(FLASH_WATER, 14),
              shake(3, 24),
              text("\\C[6]ザザザ……\\C[0] 水位が 上がった！\n水路が 水に 沈み、石の 堰は 水の下の 浅瀬に なった。\n水路に あった 木箱は 沈んで いく……。"),
            ]),
          ],
        }),
      ]),
    );
    // 沈める仕掛け：水位が高いあいだ、水路のマスに木箱が載っていたら、箱は沈んで、そのマスはずっと渡れる浮き橋になる
    const sink = crates.flatMap((c) =>
      water.flatMap((g, i) =>
        when(`!s("${SUNK(c.n)}") && !s("${RAFT(i)}") && evx("${c.id}") == ${g.x} && evy("${c.id}") == ${g.y}`, [
          setSwitch([SUNK(c.n), RAFT(i)], true),
          cmd("ChangeMapTile", { map: "this", layer: 0, x: g.x, y: g.y, width: 1, height: 1, tile: T.raft }),
          flash({ r: 200, g: 230, b: 255, a: 0.35 }, 10),
          text("\\C[6]ブクブク……\\C[0] 木箱が 水に 沈んで、\n水の上に 浮き橋が できた！"),
        ]),
      ),
    );
    out.push(event("ev_sink", "しかけ", { x: 0, y: 0 }, [page({ trigger: "parallel", through: true, priority: "below", conditions: [sw(LOW(room), false)], commands: sink })]));
    // 入口の魔法陣：木箱・浮き橋・水位をはじめにもどす
    const reset = [
      setSwitch(LOW(room), false),
      setSwitch([...crates.map((c) => SUNK(c.n)), ...water.map((_, i) => RAFT(i))], false),
      ...water.map((g) => cmd("ChangeMapTile", { map: "this", layer: 0, x: g.x, y: g.y, width: 1, height: 1, tile: tileOf("a", "water", false) })),
      ...retile(dams, tileOf("a", "dam", false)),
      ...crates.map((c) => cmd("SetEventLocation", { target: c.id, x: c.x, y: c.y, dir: "retain" })),
      flash(FLASH_WATER, 14),
      text("水位も、木箱も、浮き橋も、はじめの 状態に もどった。"),
    ];
    const hints = [
      "水位が 低いとき、水路は 乾いた 底に なる。\n箱は 乾いた 底へなら 押しこめる。",
      "水位を 上げると、水路の 箱は 沈んで 浮き橋に なる。\nレバーは 入口の 近くの すみに ある。",
      "石の 堰は 水位が 高いときだけ 渡れる。\n水晶は 堰の むこうに ある ようだ。",
    ];
    out.push(
      event("ev_rune", "魔法陣", START, [
        page({
          graphic: props("rune"),
          priority: "below",
          through: true,
          commands: [
            text("足元の 魔法陣が かすかに 光っている。"),
            cmd("ShowChoices", { choices: ["はじめから やりなおす", "ヒントを 読む", "やめる"], cancel: 2 }),
            cmd("ChoiceBranch", { index: 0 }),
            ...shift(reset, 1),
            cmd("ChoiceBranch", { index: 1 }),
            ...hints.map((t) => text(t, 1)),
            cmd("ChoiceBranch", { index: 2 }),
            cmd("EndBranch", {}),
          ],
        }),
      ]),
    );
    out.push(crystalEvent(room, marks.goal[0], props, "gemA"));
    return out;
  }

  // ── 連動水門の間：ランプつきのレバー・水晶・魔法陣 ──
  const channelIds = ["a", "b", "c"];
  const COUPLE = { 1: ["a", "b"], 2: ["b", "c"], 3: ["a"] };
  const setLevel = (ch, toLow) => [...retile(runsOf(layout.gates, ch, "water"), tileOf(ch, "water", toLow)), ...retile(runsOf(layout.gates, ch, "dam"), tileOf(ch, "dam", toLow))];
  for (const p of marks.lever) {
    const chs = COUPLE[p.ch];
    const names = chs.map((c) => `${CHANNELS[c].name}`).join("と");
    out.push(
      event(`ev_lever_${p.ch}`, `連動水門のレバー${p.ch}`, p, [
        page({
          graphic: props(`lamp${p.ch}`),
          commands: [
            text(`連動水門の レバーだ。台座の ランプは \\C[6]${names}\\C[0]。\n引くと、${names}の 水路の 水位が 入れかわる。`),
            ...pull([
              // それぞれの水路：低ければ高く、高ければ低くする
              ...chs.flatMap((c) => ifElse(`s("${LOW(room, c)}")`, [setSwitch(LOW(room, c), false), ...setLevel(c, false)], [setSwitch(LOW(room, c), true), ...setLevel(c, true)])),
              flash(FLASH_WATER, 14),
              shake(3, 24),
              text(`\\C[6]ゴゴゴ……\\C[0] ${names}の 水路の 水位が 入れかわった！`),
            ]),
          ],
        }),
      ]),
    );
  }
  out.push(crystalEvent(room, marks.goal[0], props, "gemB"));
  const resetGates = [
    setSwitch(channelIds.map((c) => LOW(room, c)), false),
    ...channelIds.flatMap((c) => setLevel(c, false)),
    flash(FLASH_WATER, 14),
    text("三つの 水路の 水位が、はじめの 状態に もどった。"),
  ];
  const gateHints = [
    "レバーの ランプの 色が、動かす 水路の 色だ。\n一つの レバーが、二つの 水路を 動かす ことも ある。",
    "水路が 干上がると、堰は 石の壁に なる。\n通りたい 場所の 水位は、いま どう なっているか？",
    "レバーを 引く 順番しだい で、別の 場所の レバーへ\n届く ように なる。まず 動ける 場所を 数えよう。",
  ];
  out.push(
    event("ev_rune", "魔法陣", START, [
      page({
        graphic: props("rune"),
        priority: "below",
        through: true,
        commands: [
          text("足元の 魔法陣が かすかに 光っている。"),
          cmd("ShowChoices", { choices: ["水位を もとに もどす", "ヒントを 読む", "やめる"], cancel: 2 }),
          cmd("ChoiceBranch", { index: 0 }),
          ...shift(resetGates, 1),
          cmd("ChoiceBranch", { index: 1 }),
          ...gateHints.map((t) => text(t, 1)),
          cmd("ChoiceBranch", { index: 2 }),
          cmd("EndBranch", {}),
        ],
      }),
    ]),
  );
  return out;
}

// ── 書き出し ──────────────────────────────────────────────────────────

const layouts = Object.fromEntries(ROOMS.map((r) => [r.id, readRoom(r)]));
rmSync(ROOT, { recursive: true, force: true });
const assets = writeAssets(join(ROOT, "assets"), {
  "water_tileset.png": tileset(),
  "hero.png": character(HERO),
  "people.png": sheet(2, [
    character({ shirt: [54, 124, 84], hair: [34, 30, 40], skin: [240, 200, 160] }),
    character({ shirt: [96, 150, 190], hair: [226, 230, 236], skin: [236, 206, 176] }),
  ]),
  "props.png": sheet(3, [
    lever(false), lever(true), lampLever(["a", "b"]), lampLever(["b", "c"]), lampLever(["a"]), stairs(true), stairs(false),
    altar(GEM_A), altar(GEM_B), altar(null), altar(null, true), crate(), rune(),
  ]),
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

const cratesRoom = ROOMS.find((r) => r.id === "map_crates");
const gatesRoom = ROOMS.find((r) => r.id === "map_gates");
const cratesLayout = layouts.map_crates;
const switches = {
  [LOW(cratesRoom)]: { name: `${cratesRoom.name}の水位が低い（水が引いている）` },
  ...Object.fromEntries(["a", "b", "c"].map((c) => [LOW(gatesRoom, c), { name: `${gatesRoom.name}の${CHANNELS[c].name}の水路の水位が低い` }])),
  ...Object.fromEntries(cratesLayout.marks.crate.map((_, n) => [SUNK(n + 1), { name: `木箱${n + 1}が沈んだ` }])),
  ...Object.fromEntries(cratesLayout.gates.filter((g) => g.kind === "water").map((g, i) => [RAFT(i), { name: `浮き橋の間の水路 (${g.x}, ${g.y}) が浮き橋になった` }])),
  [CRYSTAL.map_crates]: { name: "浮き橋の間の水晶を取った" },
  [CRYSTAL.map_gates]: { name: "連動水門の間の水晶を取った" },
  [HALL_DRAINED]: { name: "水晶が二つそろって、入口の間の水路が干上がった" },
  sw_orb: { name: "水神の宝珠を取った" },
};
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
  switches,
  variables: {},
};
writeFileSync(join(ROOT, "project.json"), toJson(project));
console.log(`\n${W}x${H} の部屋 ${ROOMS.length} つ：${ROOMS.map((r) => r.name).join("、")}`);
