#!/usr/bin/env node
/**
 * 迷宮デモ（fixtures/projects/v1/maze）を丸ごと生成する開発用スクリプト。
 * 出力: project.json、maps/<MapId>.json、assets/<AssetId>.<ext>（AssetId = 内容の sha256 先頭 16 桁）。
 * 生成物はコミット済み。部屋の並びや絵を変えたいときだけ再実行する（乱数はシード固定なので、何度実行しても同じものができる）。
 *
 *   node tools/make-maze-demo.mjs
 *
 * 迷宮のしくみ：
 * - 部屋は 11×11 の正方形で、上下左右の真ん中に出入口がある（画面も 352×352 にして、部屋全体が見えるようにした）。
 * - 第 1〜19 の間は、出入口のうち 1 つだけが次の間へ通じる（正解）。来た方向の出入口は 1 つ前の間へ戻る。
 * - 残りの出入口は「ループ」（同じ間の反対側から出てくる。見た目では先へ進んだように見える）か、
 *   「押し戻し」（冷たい風に押し戻されて、入口の方の間へ戻される）。
 * - 第 1・5・9・13・17 の間には看板があり、今が第何の間で、出口まであといくつかがわかる。
 * - 5 つの間ごとに洞窟の色（土 → 石 → 水晶 → 深淵）が変わるので、押し戻されたことにも気づける。
 * - 第 20 の間の光に触れるとクリア（タイトルへ戻る）。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { character, HERO, image, lcg, shade, TILE, writeAssets } from "./pixel-art.mjs";

const ROOT = join(import.meta.dirname, "..", "fixtures", "projects", "v1", "maze");

// ── 迷宮の形 ───────────────────────────────────────────────────────────
/** 部屋の一辺（タイル）。出入口は各辺の真ん中（C）。 */
const SIZE = 11;
const C = (SIZE - 1) / 2;
/** 部屋の数。最後の部屋はゴール。 */
const ROOMS = 20;
const GOAL = ROOMS;
/** 看板のある部屋。 */
const SIGN_ROOMS = [1, 5, 9, 13, 17];
/** 看板の位置（その下のタイルは必ず空ける）。 */
const SIGN_POS = [C, 3];
/** ゴールの光の位置。 */
const LIGHT_POS = [C, C];

const DIRS = ["up", "down", "left", "right"];
const OPP = { up: "down", down: "up", left: "right", right: "left" };
/** 出入口のタイル（マップの縁）。 */
const DOOR = { up: [C, 0], down: [C, SIZE - 1], left: [0, C], right: [SIZE - 1, C] };
/** 出入口のすぐ内側（その出入口から入ってきたときに立つ位置）。 */
const INSIDE = { up: [C, 1], down: [C, SIZE - 2], left: [1, C], right: [SIZE - 2, C] };
const DIR_NAME = { up: "上", down: "下", left: "左", right: "右" };

const mapId = (k) => `map_room${String(k).padStart(2, "0")}`;
/** 5 部屋ごとの洞窟の種類（0〜3）。 */
const zoneOf = (k) => Math.min(3, Math.floor((k - 1) / 5));
const ZONES = ["土の洞窟", "石の洞窟", "水晶の洞窟", "深淵"];

/**
 * 迷宮の設計図。`correct[k]` は第 k の間の正解の方向、`doors[k][dir]` はその出入口の行き先。
 * 行き先は `{ kind, to, x, y, dir }`（`dir` は着いたときの向き）。
 */
function planMaze(seed) {
  const rnd = lcg(seed);
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const correct = [];
  for (let k = 1; k < GOAL; k++) {
    const entry = k === 1 ? undefined : OPP[correct[k - 1]];
    // 来た方向には戻らない。同じ方向が 3 回続かないようにする（覚えやすすぎないように）
    const same = k >= 3 && correct[k - 1] === correct[k - 2] ? correct[k - 1] : undefined;
    correct[k] = pick(DIRS.filter((d) => d !== entry && d !== same));
  }

  // 押し戻し先：第 8 の間までは第 1 の間へ、その先は 4 つ以上手前の看板の間へ
  const trapTarget = (k) => (k <= 8 ? 1 : Math.max(...SIGN_ROOMS.filter((s) => s <= k - 4)));
  // 部屋 k へ前から入ってきたときの位置（第 1 の間は開始位置）
  const arrival = (k) => (k === 1 ? { x: START.x, y: START.y, dir: START.dir } : at(INSIDE[OPP[correct[k - 1]]], correct[k - 1]));
  const at = ([x, y], dir) => ({ x, y, dir });

  const doors = [];
  for (let k = 1; k <= GOAL; k++) {
    const entry = k === 1 ? undefined : OPP[correct[k - 1]];
    const room = {};
    if (entry !== undefined) room[entry] = { kind: "back", to: k - 1, ...at(INSIDE[correct[k - 1]], OPP[correct[k - 1]]) };
    if (k === GOAL) {
      doors[k] = room;
      continue;
    }
    room[correct[k]] = { kind: "forward", to: k + 1, ...at(INSIDE[OPP[correct[k]]], correct[k]) };
    const wrong = DIRS.filter((d) => room[d] === undefined);
    // 間違いの出入口：1 つめはループ。2 つめは（第 1 の間を除き）たいてい押し戻し、ときどきループ
    for (let i = wrong.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [wrong[i], wrong[j]] = [wrong[j], wrong[i]];
    }
    wrong.forEach((d, i) => {
      const trap = k > 1 && i === wrong.length - 1 && rnd() < 0.75;
      room[d] = trap ? { kind: "trap", to: trapTarget(k), ...arrival(trapTarget(k)) } : { kind: "loop", to: k, ...at(INSIDE[OPP[d]], d) };
    });
    doors[k] = room;
  }
  return { correct, doors };
}

const START = { x: C, y: C + 1, dir: "up" };

// ── タイルセット ──────────────────────────────────────────────────────
/** 洞窟ごとの床・壁の色。 */
const PALETTES = [
  { floor: [112, 88, 64], wall: [78, 58, 44] }, // 土
  { floor: [94, 94, 102], wall: [60, 60, 72] }, // 石
  { floor: [66, 86, 112], wall: [40, 54, 82] }, // 水晶
  { floor: [72, 58, 92], wall: [42, 32, 60] }, // 深淵
];

const T = {
  floor: (z) => 1 + z, // 1〜4
  wall: (z) => 5 + z, // 5〜8
  tunnel: { up: 9, down: 10, left: 11, right: 12 },
  boulder: 13,
  stalagmite: 14,
  crystalBlue: 15,
  crystalPurple: 16,
  puddle: 17,
  mushrooms: 18,
  pebbles: 19,
  torch: 20,
  light: 21,
  cobweb: 22,
  beam: 23,
};
const CELLS = 24;
/** 通行：床・トンネル・キノコ・小石・光・光の筋・クモの巣は通れる。壁と、岩・石筍・水晶・水たまり・たいまつは通れない。 */
const PASSAGE = Array.from({ length: CELLS }, (_, id) =>
  id === 0 || (id >= 1 && id <= 4) || (id >= 9 && id <= 12) || [T.mushrooms, T.pebbles, T.light, T.cobweb, T.beam].includes(id) ? 15 : 0,
);

function tileset() {
  const img = image(TILE * CELLS, TILE);
  /** セル `id` の中に描く。`wrap` なら、はみ出した分を反対側に回り込ませる（敷き詰めても継ぎ目が出ない）。 */
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

  PALETTES.forEach(({ floor, wall }, z) => {
    // 床：ざらついた土・石。ところどころにひび
    {
      const { set, rect } = cell(T.floor(z), { wrap: true });
      rect(0, 0, TILE, TILE, floor);
      const rnd = lcg(100 + z);
      for (let i = 0; i < 90; i++) set(rnd() * TILE, rnd() * TILE, shade(floor, rnd() < 0.5 ? 12 : -14));
      for (let i = 0; i < 3; i++) {
        let x = rnd() * TILE;
        let y = rnd() * TILE;
        for (let n = 0; n < 5; n++) {
          set(x, y, shade(floor, -30));
          x += rnd() < 0.5 ? 1 : 0;
          y += rnd() < 0.5 ? 1 : -1;
        }
      }
    }
    // 壁：ごつごつした岩の塊を重ねる（上が明るく、下が暗い）
    {
      const { set, rect, disc } = cell(T.wall(z), { wrap: true });
      rect(0, 0, TILE, TILE, shade(wall, -22));
      const rnd = lcg(200 + z);
      for (let i = 0; i < 9; i++) {
        const cx = rnd() * TILE;
        const cy = rnd() * TILE;
        const r = 5 + Math.floor(rnd() * 5);
        disc(cx, cy + 1, r, shade(wall, -34));
        disc(cx, cy, r, wall);
        disc(cx - 1, cy - 2, r - 3, shade(wall, 14));
        set(cx - 2, cy - r + 2, shade(wall, 30));
      }
      for (let i = 0; i < 40; i++) set(rnd() * TILE, rnd() * TILE, shade(wall, -40));
    }
  });

  // トンネル（出入口）：外側ほど暗くなる。横の縁は岩
  for (const [dir, id] of Object.entries(T.tunnel)) {
    const { set } = cell(id);
    const rnd = lcg(300 + id);
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        // out: 0（部屋の側）→ 1（マップの縁の側）、side: 通路の中心からの横のずれ（0〜1）
        const along = dir === "up" ? 1 - y / (TILE - 1) : dir === "down" ? y / (TILE - 1) : dir === "left" ? 1 - x / (TILE - 1) : x / (TILE - 1);
        const across = dir === "up" || dir === "down" ? x : y;
        const side = Math.abs(across - (TILE - 1) / 2) / ((TILE - 1) / 2);
        const dark = Math.min(1, along * 1.1 + Math.max(0, side - 0.55) * 1.6);
        const base = [70, 58, 50].map((v) => Math.round(v * (1 - dark) + 6 * dark));
        set(x, y, rnd() < 0.12 ? shade(base, 8) : base);
      }
    }
  }

  // 岩
  {
    const { set, ellipse, disc } = cell(T.boulder);
    ellipse(16, 26, 12, 4, [0, 0, 0, 80]);
    disc(16, 17, 11, [92, 84, 80]);
    disc(14, 15, 8, [118, 110, 104]);
    disc(12, 12, 3, [150, 142, 136]);
    for (const [x, y] of [[20, 20], [21, 21], [22, 21], [19, 13], [20, 14]]) set(x, y, [60, 54, 52]);
  }
  // 石筍（とがった岩）
  {
    const { set, ellipse } = cell(T.stalagmite);
    ellipse(16, 28, 10, 3, [0, 0, 0, 80]);
    for (let y = 3; y <= 28; y++) {
      const half = Math.round(((y - 3) / 25) * 9);
      for (let x = -half; x <= half; x++) set(16 + x, y, x < -half / 3 ? [150, 132, 112] : x > half / 2 ? [84, 70, 58] : [118, 100, 84]);
    }
    for (const y of [10, 17, 23]) for (let x = -2; x <= 2; x++) set(16 + x, y, [96, 80, 66]);
  }
  // 水晶（青・紫）：細長い六角柱を 3 本。まわりがうっすら光る
  const crystal = (id, body) => {
    const { set, ellipse } = cell(id);
    ellipse(16, 20, 14, 11, [...shade(body, 40), 40]);
    ellipse(16, 28, 10, 3, [0, 0, 0, 70]);
    for (const [cx, top, bottom, w] of [[16, 3, 28, 4], [9, 12, 28, 3], [23, 10, 28, 3]]) {
      for (let y = top; y <= bottom; y++) {
        const half = y < top + w ? y - top : w;
        for (let x = -half; x <= half; x++) set(cx + x, y, x < 0 ? shade(body, 50) : x === 0 ? shade(body, 90) : body);
      }
    }
  };
  crystal(T.crystalBlue, [70, 150, 220]);
  crystal(T.crystalPurple, [170, 90, 210]);
  // 水たまり
  {
    const { ellipse, rect } = cell(T.puddle);
    ellipse(16, 17, 14, 10, [30, 44, 64]);
    ellipse(16, 17, 12, 8, [44, 78, 118]);
    rect(9, 13, 6, 1, [140, 180, 220]);
    rect(18, 20, 4, 1, [110, 150, 200]);
  }
  // 光るキノコ（通れる）
  {
    const { disc, rect } = cell(T.mushrooms);
    for (const [x, y, r] of [[9, 20, 4], [21, 14, 5], [22, 25, 3]]) {
      disc(x, y, r + 3, [120, 255, 220, 45]);
      rect(x - 1, y, 2, r + 2, [220, 220, 200]);
      disc(x, y, r, [80, 220, 200]);
      rect(x - 1, y - r + 1, 2, 1, [220, 255, 250]);
    }
  }
  // 小石（通れる）
  {
    const { disc, set } = cell(T.pebbles);
    for (const [x, y, r] of [[8, 9, 2], [22, 7, 1], [13, 23, 2], [25, 20, 2], [17, 15, 1]]) {
      disc(x, y + 1, r, [40, 34, 30, 120]);
      disc(x, y, r, [140, 130, 118]);
      set(x - 1, y - 1, [180, 170, 158]);
    }
  }
  // たいまつ（壁に掛ける）
  {
    const { disc, rect } = cell(T.torch);
    disc(16, 12, 12, [255, 170, 60, 50]);
    disc(16, 12, 8, [255, 190, 80, 60]);
    rect(15, 14, 3, 12, [96, 64, 36]);
    rect(12, 24, 9, 2, [70, 70, 76]);
    disc(16, 11, 4, [255, 140, 30]);
    disc(16, 9, 3, [255, 210, 80]);
    disc(16, 8, 1, [255, 250, 210]);
  }
  // 出口の光（通れる）
  {
    const { set } = cell(T.light);
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const d = Math.hypot(x - 15.5, y - 15.5) / 16;
        if (d <= 1) set(x, y, [255, 250, 200, Math.round(230 * (1 - d) ** 0.7)]);
      }
    }
  }
  // クモの巣（部屋の隅の飾り。通れる）
  {
    const { set } = cell(T.cobweb);
    const web = [230, 230, 240, 140];
    // 左上の隅から放射状に張った糸と、それをつなぐ 2 本の弧
    for (const [dx, dy] of [[1, 0.15], [1, 0.55], [1, 1], [0.55, 1], [0.15, 1]]) for (let i = 0; i < 22; i++) set(Math.round(i * dx), Math.round(i * dy), web);
    for (const r of [8, 15]) for (let a = 0; a <= 90; a += 2) set(Math.round(Math.cos((a * Math.PI) / 180) * r), Math.round(Math.sin((a * Math.PI) / 180) * r), web);
  }
  // 光の筋（天井の穴から差しこむ光。ゴールの光の上に並べる。通れる）
  {
    const { set } = cell(T.beam);
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const d = Math.abs(x - 15.5) / 12;
        const ray = (x + y) % 7 === 0 ? 30 : 0;
        if (d <= 1) set(x, y, [255, 248, 200, Math.round(90 * (1 - d) + ray)]);
      }
    }
  }
  return img;
}

// ── 看板：キャラクターシートと同じ並び（3 パターン × 4 方向）。全コマ同じ絵 ─────
function signboard() {
  const img = image(TILE * 3, TILE * 4);
  for (let row = 0; row < 4; row++) {
    for (let pattern = 0; pattern < 3; pattern++) {
      const ox = pattern * TILE;
      const oy = row * TILE;
      const R = (x, y, w, h, c) => img.rect(ox + x, oy + y, w, h, c);
      for (let j = -3; j <= 3; j++) for (let i = -9; i <= 9; i++) if ((i * i) / 81 + (j * j) / 9 <= 1) img.set(ox + 16 + i, oy + 28 + j, [0, 0, 0, 70]);
      R(14, 16, 4, 13, [96, 62, 34]); // 柱
      R(14, 16, 1, 13, [130, 88, 50]);
      R(4, 5, 24, 14, [84, 52, 26]); // 板の縁
      R(5, 6, 22, 12, [176, 128, 76]);
      R(5, 6, 22, 1, [206, 160, 104]);
      for (const [y, w] of [[9, 16], [12, 12], [15, 14]]) R(8, y, w, 1, [96, 62, 34]); // 文字
    }
  }
  return img;
}

// ── 部屋 ──────────────────────────────────────────────────────────────
const key = (x, y) => `${x},${y}`;

/** 通れないタイル（床・壁のレイヤと物のレイヤの両方）とイベントを見て、`from` から歩いて行けるタイルの集合。 */
function reachable(blocked, from) {
  const seen = new Set([key(...from)]);
  const queue = [from];
  while (queue.length > 0) {
    const [x, y] = queue.shift();
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE || blocked(nx, ny) || seen.has(key(nx, ny))) continue;
      seen.add(key(nx, ny));
      queue.push([nx, ny]);
    }
  }
  return seen;
}

/** 洞窟ごとの置き物（`block` は通れない、`deco` は通れる飾り）。 */
const PROPS = [
  { block: [T.boulder, T.boulder, T.stalagmite], deco: [T.pebbles, T.pebbles, T.cobweb] },
  { block: [T.stalagmite, T.stalagmite, T.boulder, T.puddle], deco: [T.pebbles, T.mushrooms] },
  { block: [T.crystalBlue, T.crystalBlue, T.boulder, T.puddle], deco: [T.mushrooms, T.pebbles] },
  { block: [T.crystalPurple, T.crystalPurple, T.stalagmite, T.crystalBlue], deco: [T.mushrooms, T.mushrooms, T.pebbles] },
];

function buildRoom(k, plan) {
  const z = zoneOf(k);
  const doors = plan.doors[k];
  const hasSign = SIGN_ROOMS.includes(k);
  // 空けておくタイル：出入口のすぐ内側、看板の前、開始位置（第 1 の間へ押し戻されたときもここに立つ）、ゴールの光
  const keep = new Set([...Object.keys(doors).map((d) => key(...INSIDE[d])), key(START.x, START.y)]);
  if (hasSign) keep.add(key(SIGN_POS[0], SIGN_POS[1] + 1));
  if (k === GOAL) for (const [dx, dy] of [[0, 0], [0, 1], [0, -1], [1, 0], [-1, 0]]) keep.add(key(LIGHT_POS[0] + dx, LIGHT_POS[1] + dy));

  for (let attempt = 0; ; attempt++) {
    const rnd = lcg(k * 7919 + attempt * 104729);
    const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
    const ground = new Array(SIZE * SIZE).fill(T.floor(z));
    const props = new Array(SIZE * SIZE).fill(0);
    const set = (layer, x, y, t) => (layer[y * SIZE + x] = t);
    const get = (layer, x, y) => layer[y * SIZE + x];
    const edge = (x, y) => x === 0 || y === 0 || x === SIZE - 1 || y === SIZE - 1;

    // 外周は壁、出入口だけトンネル
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) if (edge(x, y)) set(ground, x, y, T.wall(z));
    for (const d of Object.keys(doors)) set(ground, ...DOOR[d], T.tunnel[d]);
    // 内側の 1 周を、ところどころ岩壁にしてでこぼこにする（出入口の近くは空ける）
    for (let y = 1; y < SIZE - 1; y++) {
      for (let x = 1; x < SIZE - 1; x++) {
        const ring = x === 1 || y === 1 || x === SIZE - 2 || y === SIZE - 2;
        const nearDoor = Math.abs(x - C) <= 1 || Math.abs(y - C) <= 1;
        const corner = (x === 1 || x === SIZE - 2) && (y === 1 || y === SIZE - 2);
        if (ring && !nearDoor && !keep.has(key(x, y)) && rnd() < (corner ? 0.8 : 0.4)) set(ground, x, y, T.wall(z));
      }
    }
    // 通れない置き物
    const blockCount = 5 + Math.floor(rnd() * 6);
    for (let n = 0; n < blockCount; n++) {
      const x = 2 + Math.floor(rnd() * (SIZE - 4));
      const y = 2 + Math.floor(rnd() * (SIZE - 4));
      if (keep.has(key(x, y)) || (hasSign && x === SIGN_POS[0] && y === SIGN_POS[1])) continue;
      set(props, x, y, pick(PROPS[z].block));
    }
    // 通れる飾り（クモの巣は隅だけ）
    for (let n = 0; n < 6; n++) {
      const x = 1 + Math.floor(rnd() * (SIZE - 2));
      const y = 1 + Math.floor(rnd() * (SIZE - 2));
      if (get(ground, x, y) !== T.floor(z) || get(props, x, y) !== 0) continue;
      const deco = pick(PROPS[z].deco);
      if (deco === T.cobweb && get(ground, x - 1, y) !== T.wall(z)) continue;
      set(props, x, y, deco);
    }
    // 壁のたいまつ（上の壁の 2 か所）
    for (const x of [2, SIZE - 3]) if (rnd() < (k === GOAL ? 1 : 0.6)) set(props, x, 0, T.torch);
    if (k === GOAL) {
      set(props, ...LIGHT_POS, T.light);
      for (let y = 1; y < LIGHT_POS[1]; y++) set(props, LIGHT_POS[0], y, T.beam);
    }

    // 検査：出入口・看板の前・開始位置がすべて空いていて、つながっている
    const blocked = (x, y) =>
      PASSAGE[get(ground, x, y)] === 0 || PASSAGE[get(props, x, y)] === 0 || (hasSign && x === SIGN_POS[0] && y === SIGN_POS[1]);
    const seen = reachable(blocked, [START.x, START.y]);
    const ok = !blocked(START.x, START.y) && [...keep].every((s) => seen.has(s));
    if (ok && Object.keys(doors).every((d) => seen.has(key(...DOOR[d])))) return { ground, props };
  }
}

// ── イベント ──────────────────────────────────────────────────────────
const cmd = (code, params, indent = 0) => ({ code, params, indent });
const text = (t) => cmd("ShowText", { text: t, position: "bottom", background: "window" });
/** 部屋を移るときは暗転する（`TransferPlayer` の `fade: "black"`。暗転 → 場所移動 → 明転、終わるまで歩けない）。 */
const transfer = (to, x, y, dir) => cmd("TransferPlayer", { mapId: mapId(to), x, y, dir, fade: "black" });

function doorEvent(k, dir, door) {
  const commands = [];
  if (door.kind === "trap") commands.push(text("ひゅうっ……！\n冷たい風に 押し戻された！"));
  commands.push(transfer(door.to, door.x, door.y, door.dir));
  const [x, y] = DOOR[dir];
  return {
    id: `ev_door_${dir}`,
    name: `${DIR_NAME[dir]}の出入口`,
    x,
    y,
    pages: [{ conditions: [], trigger: "touch", through: false, priority: "below", commands }],
  };
}

function signText(k) {
  const left = GOAL - k;
  const lines = [`\\C[6]〜 ${ZONES[zoneOf(k)]}・第${k}の間 〜\\C[0]`];
  if (k === 1) {
    return [
      text(`${lines[0]}\n出口の光は 第${GOAL}の間に ある。`),
      text("どの間にも 出入口は 4つ。\n先へ進めるのは いつも ひとつだけ。"),
      text("まちがえると 同じ間を さまよったり、\n入口の方へ 押し戻されたりする。\n迷ったら 看板を 探すこと。"),
    ];
  }
  return [text(`${lines[0]}\nここまで 来た。\n出口まで、あと \\C[1]${left}\\C[0] の間。`)];
}

function signEvent(k, signAsset) {
  return {
    id: "ev_sign",
    name: "看板",
    x: SIGN_POS[0],
    y: SIGN_POS[1],
    pages: [{ conditions: [], graphic: { asset: signAsset, index: 0, direction: "down" }, trigger: "action", through: false, priority: "same", commands: signText(k) }],
  };
}

function goalEvent() {
  return {
    id: "ev_light",
    name: "出口の光",
    x: LIGHT_POS[0],
    y: LIGHT_POS[1],
    pages: [
      {
        conditions: [],
        trigger: "touch",
        through: false,
        priority: "below",
        commands: [
          cmd("FlashScreen", { color: { r: 255, g: 250, b: 210, a: 1 }, duration: 30 }),
          text("まぶしい光が 差しこんでいる……！"),
          text("\\N[actor_hero]は 地下迷宮を 抜け出した！\n\\C[6]クリア おめでとう！\\C[0]"),
          cmd("Fadeout", { duration: 30 }),
          cmd("ReturnToTitle", {}),
        ],
      },
    ],
  };
}

// ── 書き出し ──────────────────────────────────────────────────────────
/** JSON を 2 スペースで整形し、数値だけの配列は 1 行にまとめる（既存のフィクスチャと同じ体裁）。 */
const toJson = (value) => `${JSON.stringify(value, null, 2).replace(/\[\s+([-\d.,\s]+?)\s+\]/g, (_, body) => `[${body.split(/,\s*/).join(", ")}]`)}\n`;

const plan = planMaze(20260930);

rmSync(ROOT, { recursive: true, force: true });
const assets = writeAssets(join(ROOT, "assets"), {
  "cave_tileset.png": tileset(),
  "hero.png": character(HERO),
  "signboard.png": signboard(),
});

mkdirSync(join(ROOT, "maps"), { recursive: true });
const mapsMeta = {};
for (let k = 1; k <= GOAL; k++) {
  const { ground, props } = buildRoom(k, plan);
  const events = {};
  for (const [dir, door] of Object.entries(plan.doors[k])) {
    const ev = doorEvent(k, dir, door);
    events[ev.id] = ev;
  }
  if (SIGN_ROOMS.includes(k)) events.ev_sign = signEvent(k, assets["signboard.png"].id);
  if (k === GOAL) events.ev_light = goalEvent();
  const id = mapId(k);
  writeFileSync(
    join(ROOT, "maps", `${id}.json`),
    toJson({ id, width: SIZE, height: SIZE, tileset: "ts_cave", layers: [{ name: "ground", tiles: ground }, { name: "objects", tiles: props }], events }),
  );
  mapsMeta[id] = { id, name: k === GOAL ? `第${k}の間（出口）` : `第${k}の間`, order: k - 1 };
}

const params = Object.fromEntries(["mhp", "mmp", "atk", "def", "mat", "mdf", "agi", "luk"].map((p) => [p, { base: p === "mhp" ? 100 : p === "mmp" ? 20 : 10, growth: 2 }]));
const entry = (name, a, mime) => ({ name, kind: "image", mime, size: a.size, width: a.width, height: a.height });
const project = {
  formatVersion: 1,
  meta: { id: "maze", title: "デモ：地下迷宮", createdAt: "2026-09-30T00:00:00Z", updatedAt: "2026-09-30T00:00:00Z" },
  system: {
    startMap: mapId(1),
    startX: START.x,
    startY: START.y,
    initialParty: ["actor_hero"],
    tileSize: TILE,
    screen: { width: SIZE * TILE, height: SIZE * TILE },
    bgm: {},
    terms: { newGame: "ニューゲーム" },
  },
  maps: mapsMeta,
  tilesets: { ts_cave: { id: "ts_cave", name: "洞窟", image: { asset: assets["cave_tileset.png"].id }, passage: PASSAGE } },
  database: {
    actors: { actor_hero: { id: "actor_hero", name: "勇者", classId: "class_hero", initialLevel: 1, walk: { asset: assets["hero.png"].id }, equips: {} } },
    classes: { class_hero: { id: "class_hero", name: "戦士", skills: [], params } },
    skills: {},
    items: {},
    enemies: {},
    troops: {},
    states: {},
    commonEvents: {},
  },
  assets: { entries: Object.fromEntries(Object.entries(assets).map(([name, a]) => [a.id, entry(name, a, "image/png")])) },
  switches: {},
  variables: {},
};
writeFileSync(join(ROOT, "project.json"), toJson(project));

// 設計図を表示する（正解の道筋と、間違いの出入口の行き先）
console.log(`\n正解の道: ${plan.correct.slice(1).map((d) => DIR_NAME[d]).join(" → ")}`);
for (let k = 1; k < GOAL; k++) {
  const desc = Object.entries(plan.doors[k])
    .map(([d, door]) => `${DIR_NAME[d]}:${door.kind === "forward" ? "正解" : door.kind === "back" ? "戻る" : door.kind === "loop" ? "ループ" : `押し戻し→第${door.to}`}`)
    .join(" ");
  console.log(`第${String(k).padStart(2)}の間  ${desc}`);
}
