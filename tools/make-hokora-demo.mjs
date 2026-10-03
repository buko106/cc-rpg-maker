#!/usr/bin/env node
/**
 * ミニ JRPG「ほこらの冒険」のデモ（fixtures/projects/v1/hokora）を丸ごと生成する開発用スクリプト。
 * 出力: project.json、maps/<MapId>.json、assets/<AssetId>.<ext>（AssetId = 内容の sha256 先頭 16 桁）。
 * 生成物はコミット済み。マップや敵の強さ・絵を変えたいときだけ再実行する（何度実行しても同じものができる）。
 *
 *   node tools/make-hokora-demo.mjs
 *
 * 村で支度をして、草原を抜け、洞窟のかぎで封印を解き、ほこらの主を倒す王道の一本道。見せたいエンジンの機能：
 * 1. ランダムエンカウント（マップの `encounters` / `encounterStep`）：草原と洞窟は歩くたびに（平均 18 歩・13 歩に 1 回ほど）敵に出会う。
 *    敵グループは重みつきで選ばれる。村とほこらの中では出会わない。戦闘のあとは、勝っても逃げても、平均の半分ほどの歩数は安全。
 *    乱数はマップの乱数とは別の列なので、同じシード・同じ歩き方なら、同じ場所で同じ敵に出会う。
 * 2. メニューでのアイテム・スキルの使用（`system.menuSkill`）：ポーション、ミナのヒール・ヒールオールをメニューから味方に使える。
 * 3. 式の `gold`（所持金）：宿屋の「おかねが足りるか」を ConditionalBranch の式 `gold >= 15` で判定する。
 * 4. 走る機能（`system.dash`）：方向キーを押しながら Shift（スマホは操作パッドの走るボタン）で、歩く速さが 1 段階速くなる。広い草原を渡るのに使える。
 * 宿屋（やすらぎ亭）で休む・記録する、よろず屋（ShopProcessing）、洞窟のかぎ → 封印の扉 → ほこらの泉 → ほこらの主（逃走不可・敗北可）の順。
 * ほこらの主を倒すとエンディング（タイトルへ戻る）。全滅（敗北）は、ランダムエンカウントではゲームオーバー、ほこらの主では村の宿屋へ戻される。
 */
import { readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blit, canvas, character, HERO, image, lcg, monsterWalk, scale, shade, sheet, TILE, writeAssets } from "./pixel-art.mjs";
import { cmd, curve, endBranch, event, flash, ifExpr, otherwise, page, sw, text, toJson } from "./demo-lib.mjs";

const ROOT = join(import.meta.dirname, "..", "fixtures", "projects", "v1", "hokora");
/** 戦闘 BGM は「はじまりの村」と同じもの（tools/make-demo-assets.mjs が作った WAV）を使う。 */
const BATTLE_WAV = join(import.meta.dirname, "..", "fixtures", "projects", "v1", "demo", "assets", "87073bd84cdaced6.wav");

/** 画面は 15×11 タイル。草原・洞窟はそれより広く、スクロールする。 */
const SCREEN_W = 15;
const SCREEN_H = 11;

const T = {
  grass: 1, path: 2, water: 3, tree: 4, rock: 5, flower: 6, wall: 7, roofRed: 8, roofBlue: 9, door: 10,
  cave: 11, caveWall: 12, stone: 13, shrineWall: 14, pillar: 15, torch: 16, mouth: 17, fence: 18, bridge: 19, spring: 20, stairs: 21,
};
const CELLS = 22;
/** 通れるのは地面・橋・洞窟の口・階段だけ。木・岩・水・壁・柱・柵は通れない。 */
const PASSABLE = new Set([0, T.grass, T.path, T.flower, T.cave, T.stone, T.mouth, T.bridge, T.stairs]);
const PASSAGE = Array.from({ length: CELLS }, (_, id) => (PASSABLE.has(id) ? 15 : 0));

const MAPS = { village: "map_village", field: "map_field", cave: "map_cave", shrine: "map_shrine" };

// ── マップの下ごしらえ ────────────────────────────────────────────────
const grid = (w, h, v) => Array.from({ length: h }, () => Array.from({ length: w }, () => v));
const fillRect = (g, x0, y0, x1, y1, v) => {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) g[y][x] = v;
};
/** 折れ線の道（1 タイル幅）。`g` に `v` を敷き、通った座標を返す。 */
function polyline(g, points, v) {
  const cells = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let k = 0; k <= n; k++) {
      const x = x0 + Math.sign(x1 - x0) * k;
      const y = y0 + Math.sign(y1 - y0) * k;
      g[y][x] = v;
      cells.push([x, y]);
    }
  }
  return cells;
}

/** `(sx, sy)` から歩いて行ける場所（地面レイヤと物レイヤから通れるかを決める）。 */
function reachable(g, o, sx, sy, extraBlock = () => false) {
  const h = g.length;
  const w = g[0].length;
  const ok = (x, y) => x >= 0 && y >= 0 && x < w && y < h && PASSABLE.has(g[y][x]) && (o[y][x] === 0 || PASSABLE.has(o[y][x])) && !extraBlock(x, y);
  const seen = new Set([`${sx},${sy}`]);
  const queue = [[sx, sy]];
  while (queue.length > 0) {
    const [x, y] = queue.shift();
    for (const [i, j] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (ok(x + i, y + j) && !seen.has(`${x + i},${y + j}`)) {
        seen.add(`${x + i},${y + j}`);
        queue.push([x + i, y + j]);
      }
    }
  }
  return seen;
}
const mustReach = (name, seen, ...points) => {
  for (const [x, y] of points) if (!seen.has(`${x},${y}`)) throw new Error(`${name}：(${x}, ${y}) へ歩いて行けない`);
};
const layersOf = (g, o) => [
  { name: "ground", tiles: g.flat() },
  { name: "objects", tiles: o.flat() },
];

// 村：北の出口（草原へ）。宿屋と よろず屋は 戸口の前で話しかける。
const VILLAGE = { w: 17, h: 13, start: { x: 8, y: 11 }, exit: { x: 8, y: 0 }, inn: { x: 4, y: 3 }, shop: { x: 12, y: 3 }, elder: { x: 9, y: 6 }, woman: { x: 5, y: 6 }, kid: { x: 13, y: 7 }, sign: { x: 7, y: 1 } };
function buildVillage() {
  const { w, h } = VILLAGE;
  const g = grid(w, h, T.grass);
  const o = grid(w, h, 0);
  for (let x = 0; x < w; x++) o[0][x] = o[h - 1][x] = T.tree;
  for (let y = 0; y < h; y++) o[y][0] = o[y][w - 1] = T.tree;
  g[0][VILLAGE.exit.x] = T.path;
  o[0][VILLAGE.exit.x] = 0;
  // 道：まん中の道と、広場、戸口の前
  polyline(g, [[8, 0], [8, 11]], T.path);
  polyline(g, [[4, 4], [4, 5], [12, 5], [12, 4]], T.path);
  // 家：赤い屋根の宿屋（左）と、青い屋根のよろず屋（右）
  for (const [x0, roof, doorX] of [[3, T.roofRed, VILLAGE.inn.x], [11, T.roofBlue, VILLAGE.shop.x]]) {
    fillRect(g, x0, 2, x0 + 2, 2, roof);
    fillRect(g, x0, 3, x0 + 2, 3, T.wall);
    g[3][doorX] = T.door;
  }
  // 池と、花の庭（柵つき）
  fillRect(g, 2, 8, 4, 9, T.water);
  for (let x = 11; x <= 14; x++) o[9][x] = T.fence;
  fillRect(g, 11, 10, 14, 10, T.flower);
  const rnd = lcg(31);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    if (g[y][x] === T.grass && o[y][x] === 0 && rnd() < 0.08) g[y][x] = T.flower;
  }
  for (const [x, y] of [[1, 1], [15, 1], [1, 11], [15, 11], [14, 8]]) if (g[y][x] === T.grass || g[y][x] === T.flower) o[y][x] = T.tree;
  mustReach("村", reachable(g, o, VILLAGE.start.x, VILLAGE.start.y), [VILLAGE.exit.x, VILLAGE.exit.y], [VILLAGE.inn.x, VILLAGE.inn.y + 1], [VILLAGE.shop.x, VILLAGE.shop.y + 1], [VILLAGE.elder.x, VILLAGE.elder.y], [VILLAGE.woman.x, VILLAGE.woman.y], [VILLAGE.kid.x, VILLAGE.kid.y], [VILLAGE.sign.x, VILLAGE.sign.y]);
  return { g, o };
}

// 草原：南の出口（村へ）、北に洞窟の口。まん中を川が横切り、橋が 1 つ。
const FIELD = { w: 26, h: 22, start: { x: 13, y: 20 }, exitTile: { x: 13, y: 21 }, mouth: { x: 13, y: 3 }, chest: { x: 5, y: 15 }, sign: { x: 12, y: 5 } };
function buildField() {
  const { w, h } = FIELD;
  const g = grid(w, h, T.grass);
  const o = grid(w, h, 0);
  fillRect(g, 0, 0, w - 1, 3, T.rock);
  for (let y = 4; y < h; y++) o[y][0] = o[y][w - 1] = T.tree;
  for (let x = 0; x < w; x++) o[h - 1][x] = T.tree;
  fillRect(g, 0, 10, w - 1, 11, T.water);
  for (let y = 10; y <= 11; y++) o[y][0] = o[y][w - 1] = 0;
  const road = polyline(g, [[13, 21], [13, 17], [9, 17], [9, 7], [13, 7], [13, 4]], T.path);
  fillRect(g, 9, 10, 9, 11, T.bridge);
  g[FIELD.mouth.y][FIELD.mouth.x] = T.mouth;
  o[h - 1][FIELD.exitTile.x] = 0;
  // 道のまわり（1 タイル）は木を植えない。残りの草地に木と花をまく
  const near = new Set(road.flatMap(([x, y]) => [-1, 0, 1].flatMap((i) => [-1, 0, 1].map((j) => `${x + i},${y + j}`))));
  const keep = (x, y) => near.has(`${x},${y}`) || (Math.abs(x - FIELD.chest.x) <= 1 && Math.abs(y - FIELD.chest.y) <= 1);
  const rnd = lcg(5);
  for (let y = 4; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    if (g[y][x] !== T.grass || o[y][x] !== 0) continue;
    const r = rnd();
    if (r < 0.11 && !keep(x, y)) o[y][x] = T.tree;
    else if (r < 0.2) g[y][x] = T.flower;
  }
  mustReach("草原", reachable(g, o, FIELD.start.x, FIELD.start.y), [FIELD.mouth.x, FIELD.mouth.y], [FIELD.chest.x, FIELD.chest.y], [FIELD.sign.x, FIELD.sign.y], [FIELD.exitTile.x, FIELD.exitTile.y]);
  return { g, o };
}

// 洞窟：口（草原へ）、かぎの宝箱（北西の部屋）、エーテルの宝箱（東の広間）、封印の扉（北の通路）、階段（ほこらへ）。
const CAVE = { w: 21, h: 17, start: { x: 5, y: 15 }, mouth: { x: 5, y: 16 }, key: { x: 2, y: 3 }, ether: { x: 18, y: 9 }, seal: { x: 15, y: 3 }, stairs: { x: 15, y: 1 } };
function buildCave() {
  const { w, h } = CAVE;
  const g = grid(w, h, T.caveWall);
  const o = grid(w, h, 0);
  fillRect(g, 2, 12, 8, 15, T.cave); // 入口の部屋
  fillRect(g, 4, 6, 5, 11, T.cave); // 北へ
  fillRect(g, 2, 3, 8, 6, T.cave); // かぎの部屋
  fillRect(g, 9, 13, 13, 14, T.cave); // 東へ
  fillRect(g, 12, 9, 18, 14, T.cave); // 東の広間
  fillRect(g, 15, 2, 15, 8, T.cave); // 北の通路
  g[CAVE.mouth.y][CAVE.mouth.x] = T.mouth;
  g[CAVE.stairs.y][CAVE.stairs.x] = T.stairs;
  // 柱のような岩を少し（道をふさがない場所に）
  for (const [x, y] of [[3, 13], [7, 14], [6, 4], [13, 10], [17, 12], [15, 11]]) g[y][x] = T.caveWall;
  mustReach("洞窟", reachable(g, o, CAVE.start.x, CAVE.start.y), [CAVE.key.x, CAVE.key.y], [CAVE.ether.x, CAVE.ether.y], [CAVE.seal.x, CAVE.seal.y + 1], [CAVE.mouth.x, CAVE.mouth.y]);
  // 封印の扉（通路を 1 タイルふさぐ）の向こうに階段がある
  mustReach("洞窟（扉のむこう）", reachable(g, o, CAVE.start.x, CAVE.start.y), [CAVE.seal.x, CAVE.seal.y]);
  return { g, o };
}

// ほこら：階段（洞窟へ）から入り、泉で回復し、奥の主に挑む。
const SHRINE = { w: 15, h: 13, start: { x: 7, y: 11 }, stairs: { x: 7, y: 12 }, spring: { x: 2, y: 9 }, boss: { x: 7, y: 3 } };
function buildShrine() {
  const { w, h } = SHRINE;
  const g = grid(w, h, T.shrineWall);
  const o = grid(w, h, 0);
  fillRect(g, 1, 2, w - 2, h - 2, T.stone);
  g[SHRINE.stairs.y][SHRINE.stairs.x] = T.stairs;
  g[SHRINE.spring.y][SHRINE.spring.x] = T.spring;
  for (const x of [4, 10]) g[1][x] = T.torch;
  for (const [x, y] of [[4, 5], [10, 5], [4, 8], [10, 8]]) o[y][x] = T.pillar;
  mustReach("ほこら", reachable(g, o, SHRINE.start.x, SHRINE.start.y), [SHRINE.spring.x + 1, SHRINE.spring.y], [SHRINE.boss.x, SHRINE.boss.y + 1], [SHRINE.stairs.x, SHRINE.stairs.y]);
  return { g, o };
}

// ── 魔物（32×32 で描く。戦闘では拡大）──────────────────────────────
/** 三角形を塗る。 */
function tri(d, [x0, y0], [x1, y1], [x2, y2], c) {
  const area = (ax, ay, bx, by, cx, cy) => (ax - cx) * (by - cy) - (bx - cx) * (ay - cy);
  for (let y = Math.min(y0, y1, y2); y <= Math.max(y0, y1, y2); y++) for (let x = Math.min(x0, x1, x2); x <= Math.max(x0, x1, x2); x++) {
    const a = area(x, y, x0, y0, x1, y1);
    const b = area(x, y, x1, y1, x2, y2);
    const e = area(x, y, x2, y2, x0, y0);
    if (!((a < 0 || b < 0 || e < 0) && (a > 0 || b > 0 || e > 0))) d.set(x, y, c);
  }
}
const MONSTERS = {
  slime() {
    const d = canvas(32, 32);
    const c = [96, 170, 236];
    d.ellipse(16, 28, 12, 2, [0, 0, 0, 60]);
    d.ellipse(16, 20, 12, 10, c);
    d.rect(4, 20, 25, 7, c);
    d.ellipse(16, 26, 12, 2, shade(c, -26));
    d.rect(4, 25, 25, 2, shade(c, -26));
    d.ellipse(11, 14, 3, 2, [214, 238, 255]);
    d.rect(10, 19, 3, 5, [24, 36, 76]);
    d.rect(19, 19, 3, 5, [24, 36, 76]);
    d.set(11, 20, [255, 255, 255]);
    d.set(20, 20, [255, 255, 255]);
    d.rect(14, 25, 5, 1, [24, 36, 76]);
    return d;
  },
  bat() {
    const d = canvas(32, 32);
    const wing = [112, 78, 138];
    const body = [74, 52, 94];
    tri(d, [13, 12], [1, 5], [3, 17], wing);
    tri(d, [13, 15], [3, 17], [8, 25], shade(wing, -14));
    tri(d, [13, 14], [8, 25], [13, 22], wing);
    tri(d, [18, 12], [30, 5], [28, 17], wing);
    tri(d, [18, 15], [28, 17], [23, 25], shade(wing, -14));
    tri(d, [18, 14], [23, 25], [18, 22], wing);
    d.line(13, 12, 1, 5, shade(wing, 36));
    d.line(18, 12, 30, 5, shade(wing, 36));
    d.ellipse(16, 18, 4, 6, body);
    d.disc(16, 11, 5, body);
    tri(d, [11, 8], [10, 2], [14, 6], body);
    tri(d, [20, 8], [21, 2], [17, 6], body);
    d.rect(13, 10, 2, 2, [255, 70, 70]);
    d.rect(17, 10, 2, 2, [255, 70, 70]);
    d.rect(14, 14, 1, 2, [240, 240, 230]);
    d.rect(17, 14, 1, 2, [240, 240, 230]);
    return d;
  },
  wolf() {
    const d = canvas(32, 32);
    const fur = [128, 130, 144];
    const dark = shade(fur, -44);
    d.ellipse(16, 29, 13, 2, [0, 0, 0, 60]);
    d.ellipse(15, 19, 10, 6, fur);
    d.ellipse(13, 17, 6, 3, shade(fur, 18));
    for (const [x, l] of [[8, 0], [11, 1], [20, 1], [23, 0]]) d.rect(x, 22, 3, 6 + l, dark);
    // 尾
    tri(d, [5, 17], [0, 10], [7, 21], fur);
    // 頭（左向き）
    d.ellipse(25, 14, 5, 5, fur);
    tri(d, [21, 10], [20, 3], [25, 9], dark);
    tri(d, [27, 10], [29, 3], [25, 9], dark);
    d.rect(27, 14, 5, 3, dark);
    d.rect(26, 12, 2, 2, [250, 220, 60]);
    d.set(28, 17, [240, 240, 230]);
    d.set(30, 17, [240, 240, 230]);
    return d;
  },
  skeleton() {
    const d = canvas(32, 32);
    const bone = [226, 222, 204];
    const dark = shade(bone, -60);
    d.ellipse(16, 30, 9, 1, [0, 0, 0, 60]);
    d.symRect(11, 24, 3, 7, bone);
    d.symRect(10, 29, 4, 2, shade(bone, -20));
    d.rect(14, 15, 4, 9, bone);
    for (const y of [16, 18, 20, 22]) d.symRect(10, y, 5, 1, bone);
    d.symRect(8, 15, 2, 8, bone);
    d.disc(16, 9, 6, bone);
    d.rect(11, 12, 10, 4, bone);
    d.symRect(12, 8, 3, 3, dark);
    d.rect(15, 11, 2, 2, dark);
    for (const x of [13, 15, 17, 19]) d.set(x, 15, dark);
    // 剣
    d.rect(26, 7, 2, 15, [170, 178, 196]);
    d.rect(24, 21, 6, 2, [120, 84, 50]);
    d.rect(26, 23, 2, 3, [120, 84, 50]);
    return d;
  },
  gargoyle() {
    const d = canvas(32, 32);
    const stone = [92, 92, 112];
    const light = shade(stone, 30);
    const dark = shade(stone, -34);
    d.ellipse(16, 30, 12, 2, [0, 0, 0, 70]);
    // 翼
    tri(d, [11, 13], [0, 3], [1, 18], dark);
    tri(d, [11, 17], [1, 18], [6, 26], dark);
    tri(d, [20, 13], [31, 3], [30, 18], dark);
    tri(d, [20, 17], [30, 18], [25, 26], dark);
    d.line(11, 13, 0, 3, light);
    d.line(20, 13, 31, 3, light);
    // 体・脚・腕
    d.rect(10, 12, 12, 12, stone);
    d.rect(10, 12, 12, 2, light);
    d.symRect(10, 24, 4, 6, dark);
    d.symRect(7, 14, 3, 9, stone);
    d.symRect(6, 22, 4, 2, light);
    // 頭と角
    d.disc(16, 8, 5, stone);
    tri(d, [11, 6], [8, 0], [13, 4], light);
    tri(d, [21, 6], [24, 0], [19, 4], light);
    d.rect(13, 7, 2, 2, [255, 60, 50]);
    d.rect(17, 7, 2, 2, [255, 60, 50]);
    d.rect(14, 11, 4, 2, [20, 20, 30]);
    d.rect(15, 14, 2, 6, [200, 60, 60]);
    return d;
  },
};
/** 歩行シート（monsters.png）での並び（マップに出るのはほこらの主だけ）。 */
const MONSTER_INDEX = { gargoyle: 0 };
/** 人のシート（people.png）での並び。 */
const PEOPLE = {
  elder: { index: 0, look: { shirt: [136, 96, 62], hair: [238, 238, 242], skin: [236, 196, 156] } },
  woman: { index: 1, look: { shirt: [200, 84, 112], hair: [92, 56, 40], skin: [244, 210, 176] } },
  kid: { index: 2, look: { shirt: [86, 150, 84], hair: [214, 126, 52], skin: [240, 204, 168] } },
};

// ── タイルセット ──────────────────────────────────────────────────────
const GOLD = [222, 184, 84];

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
  const speckle = (c, base, seed, n, spread = 14) => {
    const rnd = lcg(seed);
    for (let i = 0; i < n; i++) c.set(rnd() * TILE, rnd() * TILE, shade(base, rnd() < 0.5 ? spread : -spread));
  };
  const GRASS = [86, 148, 70];
  const grassBase = (c, seed) => {
    c.rect(0, 0, TILE, TILE, GRASS);
    const rnd = lcg(seed);
    for (let i = 0; i < 40; i++) {
      const x = rnd() * TILE;
      const y = rnd() * TILE;
      const col = shade(GRASS, rnd() < 0.5 ? 14 : -16);
      c.set(x, y, col);
      c.set(x, y - 1, col);
    }
  };

  grassBase(cell(T.grass, { wrap: true }), 11);
  // 道：土
  {
    const c = cell(T.path, { wrap: true });
    const base = [196, 160, 108];
    c.rect(0, 0, TILE, TILE, base);
    speckle(c, base, 4, 50, 16);
    const rnd = lcg(9);
    for (let i = 0; i < 6; i++) c.rect(rnd() * 28, rnd() * 28, 2, 1, shade(base, -34));
  }
  // 水
  {
    const c = cell(T.water, { wrap: true });
    const base = [58, 120, 200];
    c.rect(0, 0, TILE, TILE, base);
    for (const [x, y] of [[4, 6], [18, 3], [10, 16], [24, 20], [2, 26], [20, 28]]) {
      c.rect(x, y, 6, 1, shade(base, 36));
      c.rect(x + 1, y + 1, 4, 1, shade(base, 14));
    }
  }
  // 木（草の上）
  {
    const c = cell(T.tree);
    c.ellipse(16, 29, 10, 2, [0, 0, 0, 70]);
    c.rect(14, 20, 4, 9, [112, 78, 46]);
    c.ellipse(16, 12, 11, 10, [44, 112, 56]);
    c.ellipse(11, 14, 7, 6, [52, 128, 62]);
    c.ellipse(21, 13, 7, 6, [58, 140, 70]);
    c.ellipse(15, 8, 6, 5, [72, 158, 82]);
    speckle(c, [58, 130, 66], 6, 14, 18);
  }
  // 岩山
  {
    const c = cell(T.rock, { wrap: true });
    const base = [124, 116, 106];
    c.rect(0, 0, TILE, TILE, base);
    speckle(c, base, 8, 70, 20);
    for (const [x, y, w] of [[2, 5, 12], [16, 12, 12], [4, 20, 14], [20, 26, 8]]) {
      c.rect(x, y, w, 1, shade(base, 34));
      c.rect(x, y + 1, w, 2, shade(base, -22));
    }
  }
  // 花
  {
    const c = cell(T.flower, { wrap: true });
    grassBase(c, 12);
    for (const [x, y, col] of [[7, 9, [250, 230, 120]], [20, 6, [255, 150, 180]], [14, 20, [250, 250, 250]], [25, 24, [250, 230, 120]], [5, 25, [255, 150, 180]]]) {
      c.set(x, y, col);
      c.set(x - 1, y, col);
      c.set(x + 1, y, col);
      c.set(x, y - 1, col);
      c.set(x, y + 1, col);
      c.set(x, y, [240, 170, 40]);
    }
  }
  // 家の壁
  {
    const c = cell(T.wall);
    const base = [226, 204, 160];
    c.rect(0, 0, TILE, TILE, base);
    c.rect(0, 0, TILE, 3, shade(base, -50));
    for (let y = 6; y < TILE; y += 8) c.rect(0, y, TILE, 1, shade(base, -22));
    for (const x of [6, 22]) c.rect(x, 3, 1, TILE, shade(base, -14));
    c.rect(0, TILE - 3, TILE, 3, shade(base, -36));
  }
  // 屋根（赤・青）
  for (const [id, base] of [[T.roofRed, [196, 70, 62]], [T.roofBlue, [66, 104, 188]]]) {
    const c = cell(id);
    c.rect(0, 0, TILE, TILE, base);
    for (let y = 0; y < TILE; y += 8) {
      c.rect(0, y + 7, TILE, 1, shade(base, -46));
      c.rect(0, y, TILE, 1, shade(base, 22));
      for (let x = (y / 8) % 2 === 0 ? 0 : 8; x < TILE; x += 16) c.rect(x, y, 1, 8, shade(base, -34));
    }
    c.rect(0, 0, TILE, 2, shade(base, 36));
  }
  // 戸口
  {
    const c = cell(T.door);
    c.rect(0, 0, TILE, TILE, [226, 204, 160]);
    c.rect(0, 0, TILE, 3, shade([226, 204, 160], -50));
    c.rect(5, 3, 22, 29, [96, 62, 40]);
    c.rect(7, 5, 18, 27, [140, 94, 58]);
    c.rect(15, 5, 2, 27, [96, 62, 40]);
    c.disc(21, 19, 1, GOLD);
    c.rect(5, 3, 22, 2, shade([96, 62, 40], 20));
  }
  // 洞窟の床
  {
    const c = cell(T.cave, { wrap: true });
    const base = [92, 80, 84];
    c.rect(0, 0, TILE, TILE, base);
    speckle(c, base, 3, 70, 12);
    const rnd = lcg(14);
    for (let i = 0; i < 5; i++) c.rect(rnd() * 28, rnd() * 28, 3, 2, shade(base, -22));
  }
  // 洞窟の壁
  {
    const c = cell(T.caveWall, { wrap: true });
    const base = [48, 42, 52];
    c.rect(0, 0, TILE, TILE, base);
    speckle(c, base, 21, 60, 12);
    for (const [x, y, w] of [[2, 6, 10], [16, 14, 12], [4, 22, 12], [20, 28, 8]]) {
      c.rect(x, y, w, 1, shade(base, 22));
      c.rect(x, y + 1, w, 2, shade(base, -14));
    }
  }
  // ほこらの床・壁・柱・たいまつ
  {
    const c = cell(T.stone, { wrap: true });
    const base = [142, 142, 158];
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) c.rect(i * 16, j * 16, 16, 16, (i + j) % 2 === 0 ? base : shade(base, -10));
    c.rect(0, 0, TILE, 1, shade(base, -40));
    c.rect(0, 16, TILE, 1, shade(base, -40));
    c.rect(0, 0, 1, TILE, shade(base, -40));
    c.rect(16, 0, 1, TILE, shade(base, -40));
    c.set(8, 8, shade(GOLD, -50));
    c.set(24, 24, shade(GOLD, -50));
  }
  const wallFace = (c) => {
    const base = [88, 84, 112];
    c.rect(0, 0, TILE, TILE, base);
    for (let y = 0; y < 24; y += 8) {
      c.rect(0, y, TILE, 1, shade(base, -30));
      for (let x = (y / 8) % 2 === 0 ? 0 : 8; x < TILE; x += 16) c.rect(x, y, 1, 8, shade(base, -30));
      c.rect(0, y + 1, TILE, 1, shade(base, 12));
    }
    c.rect(0, 24, TILE, 8, shade(base, -40));
    c.rect(0, 24, TILE, 2, shade(base, -10));
  };
  wallFace(cell(T.shrineWall));
  {
    const c = cell(T.torch);
    wallFace(c);
    c.rect(15, 14, 2, 8, [60, 50, 44]);
    c.rect(11, 20, 10, 2, GOLD);
    c.disc(16, 11, 3, [255, 160, 50]);
    c.rect(16, 5, 1, 4, [255, 214, 100]);
    c.set(16, 11, [255, 250, 210]);
  }
  {
    const c = cell(T.pillar);
    c.ellipse(16, 29, 10, 2, [0, 0, 0, 80]);
    c.rect(8, 25, 16, 5, [150, 150, 168]);
    c.rect(11, 5, 10, 21, [184, 184, 200]);
    c.rect(11, 5, 3, 21, [216, 216, 228]);
    c.rect(19, 5, 2, 21, [140, 140, 158]);
    c.rect(8, 2, 16, 4, [150, 150, 168]);
  }
  // 洞窟の口：岩の中の暗いアーチ
  {
    const c = cell(T.mouth);
    c.rect(0, 0, TILE, TILE, [124, 116, 106]);
    speckle(c, [124, 116, 106], 8, 50, 18);
    c.ellipse(16, 14, 11, 11, [92, 84, 80]);
    c.rect(5, 14, 22, 18, [92, 84, 80]);
    c.ellipse(16, 15, 9, 9, [20, 16, 24]);
    c.rect(7, 15, 18, 17, [20, 16, 24]);
    c.rect(10, 12, 12, 1, [40, 34, 44]);
  }
  // 柵
  {
    const c = cell(T.fence);
    c.ellipse(16, 29, 12, 2, [0, 0, 0, 60]);
    const wood = [150, 108, 64];
    c.rect(0, 12, TILE, 3, wood);
    c.rect(0, 20, TILE, 3, wood);
    c.rect(0, 12, TILE, 1, shade(wood, 26));
    c.rect(0, 20, TILE, 1, shade(wood, 26));
    for (const x of [3, 15, 27]) {
      c.rect(x, 7, 3, 22, shade(wood, -12));
      c.rect(x, 7, 3, 1, shade(wood, 30));
    }
  }
  // 橋
  {
    const c = cell(T.bridge, { wrap: true });
    const base = [58, 120, 200];
    c.rect(0, 0, TILE, TILE, base);
    const wood = [160, 116, 68];
    c.rect(4, 0, 24, TILE, wood);
    for (let y = 0; y < TILE; y += 6) c.rect(4, y, 24, 1, shade(wood, -40));
    c.rect(4, 0, 2, TILE, shade(wood, -30));
    c.rect(26, 0, 2, TILE, shade(wood, -30));
    c.rect(6, 0, 1, TILE, shade(wood, 20));
  }
  // ほこらの泉
  {
    const c = cell(T.spring);
    c.rect(0, 0, TILE, TILE, [142, 142, 158]);
    c.rect(1, 1, 30, 30, [150, 150, 168]);
    c.ellipse(16, 17, 13, 12, [96, 98, 120]);
    c.ellipse(16, 17, 11, 10, [90, 200, 230]);
    c.ellipse(13, 14, 5, 3, [170, 236, 250]);
    c.rect(15, 5, 2, 8, [200, 246, 255]);
    c.disc(16, 5, 2, [220, 250, 255]);
  }
  // 階段
  {
    const c = cell(T.stairs);
    const base = [96, 90, 108];
    c.rect(0, 0, TILE, TILE, base);
    for (let i = 0; i < 4; i++) {
      c.rect(0, i * 8, TILE, 6, shade(base, 24 - i * 14));
      c.rect(0, i * 8 + 6, TILE, 2, shade(base, -50));
    }
  }
  return img;
}

// ── 絵：宝箱・看板・封印の扉 ──────────────────────────────────────────
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
const signboard = () =>
  still((d) => {
    d.ellipse(16, 29, 9, 2, [0, 0, 0, 70]);
    d.rect(14, 16, 4, 13, [112, 78, 46]);
    d.rect(4, 6, 24, 12, [166, 124, 76]);
    d.rect(4, 6, 24, 2, shade([166, 124, 76], 30));
    d.rect(4, 16, 24, 2, shade([166, 124, 76], -50));
    for (const y of [10, 13]) d.rect(8, y, 16, 1, [96, 62, 40]);
  });
/** 洞窟の封印の扉：しるしの彫られた石のとびら。 */
const sealedDoor = () =>
  still((d) => {
    d.rect(0, 0, 32, 32, [70, 70, 90]);
    d.rect(2, 2, 28, 30, [118, 118, 140]);
    d.rect(2, 2, 28, 2, [160, 160, 182]);
    d.rect(15, 2, 2, 30, [70, 70, 90]);
    d.disc(16, 16, 7, [70, 70, 90]);
    d.disc(16, 16, 5, GOLD);
    d.disc(16, 16, 3, [70, 70, 90]);
    d.rect(15, 16, 2, 8, [70, 70, 90]);
    for (const [x, y] of [[5, 5], [26, 5], [5, 28], [26, 28]]) d.disc(x, y, 1, [170, 170, 190]);
  });
const PROPS = { chestClosed: 0, chestOpen: 1, sign: 2, sealedDoor: 3 };

// ── イベント ──────────────────────────────────────────────────────────
const self = (key = "A") => ({ kind: "selfSwitch", key, value: true });
const setSwitch = (id, value, indent = 0) => cmd("ControlSwitches", { ids: [id], value }, indent);
const gold = (op, value, indent = 0) => cmd("ChangeGold", { op, amount: { kind: "constant", value } }, indent);
const gainItem = (item, n, indent = 0) => cmd("ChangeItems", { item, op: "gain", amount: { kind: "constant", value: n } }, indent);
const transfer = (mapId, { x, y }, dir, indent = 0, fade = "black") => cmd("TransferPlayer", { mapId, x, y, dir, fade }, indent);
const choices = (labels, cancel) => cmd("ShowChoices", { choices: labels, cancel });
const branch = (index, indent = 0) => cmd("ChoiceBranch", { index }, indent);
/** 全員の HP/MP を全回復（戦闘不能は起こさない）。 */
const healAll = (indent = 0) => [
  cmd("ChangeHp", { target: "party", op: "gain", amount: { kind: "constant", value: 9999 }, allowDeath: false }, indent),
  cmd("ChangeMp", { target: "party", op: "gain", amount: { kind: "constant", value: 9999 } }, indent),
];
/** 一度ふれると消える宝箱（セルフスイッチ A）。 */
function chestEvent(id, name, pos, props, rewards, message) {
  return event(id, name, pos, [
    page({ graphic: props("chestClosed"), commands: [...rewards, text(message), cmd("ControlSelfSwitch", { key: "A", value: true })] }),
    page({ conditions: [self()], graphic: props("chestOpen"), commands: [text("宝箱は からっぽだ。")] }),
  ]);
}
/** 踏むと別のマップへ移る床（階段・出口・洞窟の口）。 */
const exitEvent = (id, name, pos, to, dest, dir) => event(id, name, pos, [page({ trigger: "touch", priority: "below", commands: [transfer(to, dest, dir)] })]);

function villageEvents(assets) {
  const people = assets["people.png"].id;
  const props = (name) => ({ asset: assets["props.png"].id, index: PROPS[name], direction: "down" });
  const npc = (who) => ({ asset: people, index: PEOPLE[who].index, direction: "down" });
  const out = [];

  // はじまり：村長の話（一度だけ）
  out.push(
    event("ev_intro", "はじまり", { x: VILLAGE.start.x + 1, y: VILLAGE.start.y }, [
      page({
        trigger: "autorun",
        priority: "below",
        through: true,
        commands: [
          text("ここは ミルト村。村の 北の ほこらに 魔物の 主が\nすみついて、旅人も 村人も こまっている。"),
          text("村長の 話を 聞いてみよう。\n（村の まん中の 広場に いる）"),
          cmd("ControlSelfSwitch", { key: "A", value: true }),
        ],
      }),
      page({ conditions: [self()], priority: "below", through: true, commands: [] }),
    ]),
  );

  // 村長：支度金と、冒険のヒント
  out.push(
    event("ev_elder", "村長", VILLAGE.elder, [
      page({
        graphic: npc("elder"),
        conditions: [sw("sw_key", false), { kind: "selfSwitch", key: "A", value: false }],
        commands: [
          text("おお、よく 来てくれた。わしが 村長じゃ。\n村の 北の 草原を 越えた 先の ほこらに、\n魔物の 主が すみついておる。"),
          text("ほこらへは 草原の 北の \\C[6]洞窟\\C[0]を 通る。\n洞窟の 奥の 扉は 古い \\C[6]かぎ\\C[0]で 封印されておる。\nかぎは 洞窟の どこかに あるはずじゃ。"),
          text("草原や 洞窟では、歩くたびに 魔物に 出会う。\nあぶなくなったら \\C[3]逃げて\\C[0]も よいぞ。\n逃げたあとは しばらく 魔物に 出会わん。"),
          text("支度金に \\C[6]50G\\C[0]と ポーション 3個じゃ。\nメニューの \\C[6]アイテム\\C[0]から 使えるぞ。"),
          gold("gain", 50),
          gainItem("item_potion", 3),
          text("\\C[6]50G\\C[0]と ポーション 3個を 受け取った！"),
          cmd("ControlSelfSwitch", { key: "A", value: true }),
        ],
      }),
      page({
        graphic: npc("elder"),
        conditions: [sw("sw_key", false), self()],
        commands: [
          text("ほこらの 封印の かぎは 洞窟の どこかじゃ。\n草原の 北の 洞窟に 行ってみなさい。"),
          text("傷ついたら メニューの \\C[6]スキル\\C[0]で ミナの\n\\C[3]ヒール\\C[0]を 使えば MPで 回復できる。\n宿屋で 休めば ぜんぶ 回復じゃ。"),
        ],
      }),
      page({
        graphic: npc("elder"),
        conditions: [sw("sw_key")],
        commands: [
          text("おお、かぎを 見つけたか！\n宿屋で 休み、薬を そろえて、\nほこらの 主に 挑むのじゃ。"),
          text("ほこらの 中の \\C[3]泉\\C[0]では 回復できる。\nだが 主の 前では 逃げられんぞ。覚悟して 行け！"),
        ],
      }),
    ]),
  );

  out.push(
    event("ev_woman", "村の女", VILLAGE.woman, [
      page({
        graphic: npc("woman"),
        commands: [
          text("草原には スライムや こうもりが 出るわ。\n洞窟の 魔物は ずっと 強いから 気をつけてね。"),
          text("魔物に 出会うと すぐ 戦闘よ。\nいやなら \\C[3]逃げる\\C[0]を 選べば いいの。\n足の 速い 勇者さんなら 成功しやすいわ。"),
        ],
      }),
    ]),
  );
  out.push(
    event("ev_kid", "村の子", VILLAGE.kid, [
      page({
        graphic: npc("kid"),
        commands: [
          text("ぼく 見たよ！ 歩いてると 急に 魔物が とびだすんだ。\n村の中なら 安全だけどね！"),
          text("お金は 魔物を 倒すと もらえるよ。\n貯めて よろず屋で 薬を 買おう。"),
        ],
      }),
    ]),
  );

  out.push(
    event("ev_sign_village", "看板", VILLAGE.sign, [
      page({ graphic: props("sign"), commands: [text("\\C[6]ミルト村\\C[0]\n北 → 草原・ほこらの洞窟\n宿屋 やすらぎ亭（左）／ よろず屋（右）")] }),
    ]),
  );

  // 宿屋：泊まる（15G）・記録・やめる
  out.push(
    event("ev_inn", "宿屋 やすらぎ亭", VILLAGE.inn, [
      page({
        commands: [
          text("いらっしゃい！ 宿屋 \\C[6]やすらぎ亭\\C[0]だよ。\n1泊 \\C[6]15G\\C[0]。ぐっすり 休めば ぜんぶ 回復さ。"),
          choices(["泊まる（15G）", "冒険を記録する", "やめる"], 2),
          branch(0),
          ifExpr("gold >= 15", 1),
          gold("lose", 15, 2),
          cmd("Fadeout", { duration: 30 }, 2),
          ...healAll(2),
          cmd("Wait", { frames: 40 }, 2),
          cmd("Fadein", { duration: 30 }, 2),
          text("ぐっすり 眠った。\nHP と MP が 回復した！", 2),
          otherwise(1),
          text("おっと、おかねが たりないようだね。\n魔物を 倒して 稼いでおいで。", 2),
          endBranch(1),
          branch(1),
          text("冒険の 記録を つけておくかい？", 1),
          cmd("SaveGame", {}, 1),
          branch(2),
          text("またの おこしを！", 1),
          endBranch(),
        ],
      }),
    ]),
  );

  // よろず屋
  out.push(
    event("ev_shop", "よろず屋", VILLAGE.shop, [
      page({
        commands: [
          text("いらっしゃい！ 旅の 薬なら おまかせだ。"),
          cmd("ShopProcessing", { goods: ["item_potion", "item_hipotion", "item_ether"], canSell: true }),
          text("気をつけてな！"),
        ],
      }),
    ]),
  );

  out.push(exitEvent("ev_to_field", "草原へ", VILLAGE.exit, MAPS.field, { x: FIELD.start.x, y: FIELD.start.y }, "up"));
  return out;
}

function fieldEvents(assets) {
  const props = (name) => ({ asset: assets["props.png"].id, index: PROPS[name], direction: "down" });
  return [
    exitEvent("ev_to_village", "村へ", FIELD.exitTile, MAPS.village, { x: VILLAGE.exit.x, y: VILLAGE.exit.y + 1 }, "down"),
    exitEvent("ev_to_cave", "洞窟へ", FIELD.mouth, MAPS.cave, CAVE.start, "up"),
    event("ev_sign_field", "看板", FIELD.sign, [
      page({ graphic: props("sign"), commands: [text("\\C[6]ほこらの洞窟\\C[0] この先\n洞窟の 魔物は 草原より 強い。\n宿屋で 休んでから 行こう。")] }),
    ]),
    chestEvent("ev_chest_field", "草原の宝箱", FIELD.chest, props, [gainItem("item_potion", 2)], "宝箱を あけた！\n\\C[6]ポーション\\C[0]を 2個 手に入れた！"),
  ];
}

function caveEvents(assets) {
  const props = (name) => ({ asset: assets["props.png"].id, index: PROPS[name], direction: "down" });
  return [
    exitEvent("ev_cave_out", "草原へ", CAVE.mouth, MAPS.field, { x: FIELD.mouth.x, y: FIELD.mouth.y + 1 }, "down"),
    // かぎの宝箱
    event("ev_key", "かぎの宝箱", CAVE.key, [
      page({
        conditions: [sw("sw_key", false)],
        graphic: props("chestClosed"),
        commands: [setSwitch("sw_key", true), flash({ r: 255, g: 230, b: 150, a: 0.5 }, 12), text("宝箱を あけた！\n\\C[6]古い かぎ\\C[0]を 手に入れた！\n（洞窟の 奥の 封印の 扉の かぎだ）")],
      }),
      page({ conditions: [sw("sw_key")], graphic: props("chestOpen"), commands: [text("宝箱は からっぽだ。")] }),
    ]),
    chestEvent("ev_chest_cave", "洞窟の宝箱", CAVE.ether, props, [gainItem("item_ether", 2)], "宝箱を あけた！\n\\C[6]エーテル\\C[0]を 2個 手に入れた！"),
    // 封印の扉：かぎで開く（開くまで通れない）
    event("ev_seal", "封印の扉", CAVE.seal, [
      page({
        conditions: [sw("sw_door", false)],
        graphic: props("sealedDoor"),
        commands: [
          ifExpr("s(\"sw_key\")"),
          text("古い かぎを さしこむと、封印の 扉が\nゆっくりと 開いた……", 1),
          setSwitch("sw_door", true, 1),
          otherwise(),
          text("しるしの 彫られた 石の 扉。かぎが かかっている。\n古い かぎが ひつようだ。", 1),
          endBranch(),
        ],
      }),
      page({ conditions: [sw("sw_door")], priority: "below", through: true, commands: [] }),
    ]),
    exitEvent("ev_to_shrine", "ほこらへ", CAVE.stairs, MAPS.shrine, SHRINE.start, "up"),
  ];
}

function shrineEvents(assets) {
  const monsters = assets["monsters.png"].id;
  const boss = event("ev_boss", "ほこらの主", SHRINE.boss, [
    page({
      graphic: { asset: monsters, index: MONSTER_INDEX.gargoyle, direction: "down" },
      conditions: [sw("sw_boss", false)],
      commands: [
        text("グオオオ……！ よくぞ ここまで 来た。\nわれこそ ほこらの 主。\n人間ごときに 倒されは せぬ！"),
        choices(["挑む", "まだ やめておく"], 1),
        branch(0),
        flash({ r: 255, g: 60, b: 40, a: 0.5 }, 16, 1),
        cmd("BattleProcessing", { troop: "tr_boss", canEscape: false, canLose: true }, 1),
        branch(0, 1),
        setSwitch("sw_boss", true, 2),
        flash({ r: 255, g: 255, b: 220, a: 1 }, 40, 2),
        text("ほこらの 主は くずれ去り、\n洞窟には ふたたび 静けさが もどった……", 2),
        text("\\C[6]ミルト村に 平和が もどった！\\C[0]\n勇者と ミナの 冒険は ここで ひとまず 終わり。\nおめでとう！", 2),
        cmd("Fadeout", { duration: 40 }, 2),
        cmd("ReturnToTitle", {}, 2),
        branch(1, 1),
        branch(2, 1),
        text("勇者と ミナは 力尽きた……", 2),
        ...healAll(2),
        transfer(MAPS.village, VILLAGE.start, "up", 2),
        text("……気がつくと、村の 入口に 運ばれていた。\n（ほこらの主は 何度でも 挑戦を 受けてくれる）", 2),
        endBranch(1),
        branch(1),
        text("体勢を 立て直してから 挑もう。\n（奥の 泉で 回復できる）", 1),
        endBranch(),
      ],
    }),
    page({ conditions: [sw("sw_boss")], through: true, priority: "below", commands: [] }),
  ]);
  return [
    exitEvent("ev_shrine_out", "洞窟へ", SHRINE.stairs, MAPS.cave, { x: CAVE.stairs.x, y: CAVE.stairs.y + 1 }, "down"),
    event("ev_spring", "ほこらの泉", SHRINE.spring, [
      page({
        commands: [
          flash({ r: 150, g: 220, b: 255, a: 0.6 }, 20),
          ...healAll(),
          text("泉の 水を 飲んだ。\nHP と MP が 回復した！"),
          text("ここまでの 冒険を 記録しますか？"),
          choices(["記録する", "しない"], 1),
          branch(0),
          cmd("SaveGame", {}, 1),
          branch(1),
          endBranch(),
        ],
      }),
    ]),
    boss,
  ];
}

// ── データベース ──────────────────────────────────────────────────────
const skill = (id, name, mpCost, scope, formula, effects = []) => ({ id, name, mpCost, scope, formula, effects });
const item = (id, name, kind, price, effects, extra = {}) => ({ id, name, kind, price, effects, ...extra });
const stats = (mhp, mmp, atk, def, mat, mdf, agi, luk) => ({ mhp, mmp, atk, def, mat, mdf, agi, luk });
/** 戦闘画面の中心 x（画面幅の半分）と、敵の高さ。 */
const CX = (SCREEN_W * TILE) / 2;
const row = (...enemies) => enemies.map((enemy, i) => ({ enemy, x: CX + (i - (enemies.length - 1) / 2) * 120, y: 150 }));
const troop = (id, name, ...enemies) => ({ id, name, members: row(...enemies), pages: [] });

function database(assets) {
  const battler = (name) => ({ asset: assets[`${name}.png`].id });
  return {
    actors: {
      actor_hero: { id: "actor_hero", name: "勇者", classId: "class_warrior", initialLevel: 1, walk: { asset: assets["hero.png"].id }, equips: { weapon: "wp_sword", armor: "ar_leather" } },
      actor_mina: { id: "actor_mina", name: "ミナ", classId: "class_cleric", initialLevel: 1, equips: { weapon: "wp_staff", armor: "ar_robe" } },
    },
    classes: {
      class_warrior: {
        id: "class_warrior",
        name: "戦士",
        params: { mhp: curve(72, 14), mmp: curve(8, 2), atk: curve(12, 3), def: curve(8, 2), mat: curve(4, 1), mdf: curve(6, 1), agi: curve(10, 2), luk: curve(8, 1) },
        skills: [{ level: 1, skill: "sk_smash" }, { level: 5, skill: "sk_break" }],
      },
      class_cleric: {
        id: "class_cleric",
        name: "僧侶",
        params: { mhp: curve(50, 9), mmp: curve(22, 4), atk: curve(6, 1), def: curve(7, 2), mat: curve(12, 3), mdf: curve(12, 2), agi: curve(9, 1), luk: curve(10, 1) },
        skills: [{ level: 1, skill: "sk_heal" }, { level: 3, skill: "sk_holy" }, { level: 5, skill: "sk_healall" }],
      },
    },
    skills: Object.fromEntries(
      [
        // 味方の技（ヒール・ヒールオールはメニューからも使える）
        skill("sk_smash", "強打", 3, "one-enemy", "a.atk * 6 - b.def * 2"),
        skill("sk_break", "かぶと割り", 5, "one-enemy", "a.atk * 4 - b.def", [{ kind: "buff", param: "def", level: -1 }]),
        skill("sk_heal", "ヒール", 3, "one-ally", "-(a.mat * 2 + 25)"),
        skill("sk_holy", "ホーリー", 5, "one-enemy", "a.mat * 5 - b.mdf * 2"),
        skill("sk_healall", "ヒールオール", 9, "all-allies", "-(a.mat + 20)"),
        // 敵の技
        skill("sk_tackle", "たいあたり", 0, "one-enemy", "a.atk * 4 - b.def * 2"),
        skill("sk_bite", "かみつく", 0, "one-enemy", "a.atk * 4 - b.def * 2"),
        skill("sk_wing", "つばさで うつ", 0, "one-enemy", "a.atk * 3 - b.def * 2"),
        skill("sk_howl", "遠ぼえ", 0, "self", "", [{ kind: "buff", param: "atk", level: 1 }]),
        skill("sk_slash", "斬りつける", 0, "one-enemy", "a.atk * 4 - b.def * 2"),
        skill("sk_claw", "石の爪", 0, "one-enemy", "a.atk * 4 - b.def * 2"),
        skill("sk_gale", "暗黒の風", 0, "all-enemies", "a.mat * 3 - b.mdf * 2"),
        skill("sk_harden", "石化の守り", 0, "self", "", [{ kind: "buff", param: "def", level: 1 }]),
        skill("sk_rage", "ほこらの怒り", 0, "all-enemies", "a.mat * 4 - b.mdf * 2"),
      ].map((s) => [s.id, s]),
    ),
    items: Object.fromEntries(
      [
        item("item_potion", "ポーション", "consumable", 20, [{ kind: "recoverHp", value: 60 }]),
        item("item_hipotion", "ハイポーション", "consumable", 80, [{ kind: "recoverHp", value: 160 }]),
        item("item_ether", "エーテル", "consumable", 90, [{ kind: "recoverMp", value: 30 }]),
        item("wp_sword", "銅の剣", "weapon", 100, [], { params: { atk: 4 } }),
        item("wp_staff", "樫の杖", "weapon", 80, [], { params: { mat: 3 } }),
        item("ar_leather", "革の鎧", "armor", 60, [], { params: { def: 3 } }),
        item("ar_robe", "旅のローブ", "armor", 50, [], { params: { def: 2, mdf: 2 } }),
      ].map((i) => [i.id, i]),
    ),
    enemies: {
      en_slime: { id: "en_slime", name: "スライム", graphic: battler("slime"), params: stats(80, 0, 10, 3, 0, 2, 5, 4), actions: [{ skill: "sk_tackle", rating: 5 }], drops: [{ item: "item_potion", rate: 0.08 }], exp: 10, gold: 6 },
      en_bat: { id: "en_bat", name: "こうもり", graphic: battler("bat"), params: stats(65, 0, 10, 2, 0, 2, 14, 6), actions: [{ skill: "sk_wing", rating: 5 }], drops: [], exp: 12, gold: 7 },
      en_wolf: { id: "en_wolf", name: "野犬", graphic: battler("wolf"), params: stats(170, 0, 11, 6, 0, 3, 11, 5), actions: [{ skill: "sk_bite", rating: 5 }, { skill: "sk_howl", rating: 2, condition: "turn == 1" }], drops: [{ item: "item_potion", rate: 0.2 }], exp: 30, gold: 14 },
      en_skeleton: { id: "en_skeleton", name: "ガイコツ", graphic: battler("skeleton"), params: stats(260, 0, 15, 9, 0, 4, 9, 4), actions: [{ skill: "sk_slash", rating: 5 }], drops: [{ item: "item_ether", rate: 0.1 }], exp: 48, gold: 22 },
      en_gargoyle: {
        id: "en_gargoyle",
        name: "ほこらの主",
        graphic: battler("gargoyle"),
        params: stats(1250, 60, 19, 12, 18, 10, 12, 8),
        actions: [
          { skill: "sk_claw", rating: 5 },
          { skill: "sk_gale", rating: 4, condition: "turn >= 2" },
          { skill: "sk_harden", rating: 3, condition: "turn == 1" },
          { skill: "sk_rage", rating: 8, condition: "a.hp * 2 < a.mhp && turn % 2 == 0" },
        ],
        drops: [],
        exp: 200,
        gold: 300,
      },
    },
    troops: Object.fromEntries(
      [
        troop("tr_slime", "スライム", "en_slime"),
        troop("tr_slimes", "スライム×2", "en_slime", "en_slime"),
        troop("tr_bat", "こうもり", "en_bat"),
        troop("tr_slime_bat", "スライムとこうもり", "en_slime", "en_bat"),
        troop("tr_wolf", "野犬", "en_wolf"),
        troop("tr_bats", "こうもり×2", "en_bat", "en_bat"),
        troop("tr_skeleton", "ガイコツ", "en_skeleton"),
        troop("tr_wolf_bat", "野犬とこうもり", "en_wolf", "en_bat"),
        troop("tr_skel_bat", "ガイコツとこうもり", "en_skeleton", "en_bat"),
        troop("tr_skeletons", "ガイコツ×2", "en_skeleton", "en_skeleton"),
        troop("tr_boss", "ほこらの主", "en_gargoyle"),
      ].map((t) => [t.id, t]),
    ),
    states: {},
    commonEvents: {},
  };
}

// ── 書き出し ──────────────────────────────────────────────────────────

const monsterSprites = Object.fromEntries(Object.keys(MONSTERS).map((name) => [name, MONSTERS[name]()]));
const battlerImages = Object.fromEntries(Object.entries(monsterSprites).map(([name, sprite]) => [`${name}.png`, scale(sprite, name === "gargoyle" ? 3 : 2)]));
const peopleSheets = Object.values(PEOPLE)
  .sort((a, b) => a.index - b.index)
  .map((p) => character(p.look));

rmSync(ROOT, { recursive: true, force: true });
const assets = writeAssets(join(ROOT, "assets"), {
  "hokora_tileset.png": tileset(),
  "hero.png": character(HERO),
  "people.png": sheet(3, peopleSheets),
  "monsters.png": sheet(1, [monsterWalk(monsterSprites.gargoyle)]),
  "props.png": sheet(4, [chest(false), chest(true), signboard(), sealedDoor()]),
  ...battlerImages,
  "battle.wav": { bytes: readFileSync(BATTLE_WAV), ext: "wav", info: "戦闘 BGM（はじまりの村と同じ）" },
});

/** マップ（地面・物・イベント・ランダムエンカウント）を書き出す。 */
mkdirSync(join(ROOT, "maps"), { recursive: true });
const writeMap = (id, built, w, h, events, extra = {}) => {
  const map = { id, width: w, height: h, tileset: "ts_hokora", layers: layersOf(built.g, built.o), events: Object.fromEntries(events.map((e) => [e.id, e])), ...extra };
  writeFileSync(join(ROOT, "maps", `${id}.json`), toJson(map));
};
writeMap(MAPS.village, buildVillage(), VILLAGE.w, VILLAGE.h, villageEvents(assets));
writeMap(MAPS.field, buildField(), FIELD.w, FIELD.h, fieldEvents(assets), {
  encounters: [
    { troop: "tr_slime", weight: 4 },
    { troop: "tr_slimes", weight: 3 },
    { troop: "tr_bat", weight: 3 },
    { troop: "tr_slime_bat", weight: 2 },
    { troop: "tr_wolf", weight: 1 },
  ],
  encounterStep: 18,
});
writeMap(MAPS.cave, buildCave(), CAVE.w, CAVE.h, caveEvents(assets), {
  encounters: [
    { troop: "tr_bats", weight: 3 },
    { troop: "tr_skeleton", weight: 3 },
    { troop: "tr_wolf", weight: 2 },
    { troop: "tr_wolf_bat", weight: 2 },
    { troop: "tr_skel_bat", weight: 2 },
    { troop: "tr_skeletons", weight: 1 },
  ],
  encounterStep: 13,
});
writeMap(MAPS.shrine, buildShrine(), SHRINE.w, SHRINE.h, shrineEvents(assets));

const entry = (name, a) =>
  name.endsWith(".wav")
    ? { name, kind: "audio", mime: "audio/wav", size: a.size }
    : { name, kind: "image", mime: "image/png", size: a.size, width: a.width, height: a.height };
const project = {
  formatVersion: 1,
  meta: { id: "hokora", title: "デモ：ほこらの冒険", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" },
  system: {
    startMap: MAPS.village,
    startX: VILLAGE.start.x,
    startY: VILLAGE.start.y,
    initialParty: ["actor_hero", "actor_mina"],
    tileSize: TILE,
    screen: { width: SCREEN_W * TILE, height: SCREEN_H * TILE },
    bgm: { battle: { asset: assets["battle.wav"].id, volume: 0.6, pitch: 1, loop: true } },
    // メニューに「スキル」を出す（ミナのヒール・ヒールオールをフィールドで使える）
    menuSkill: true,
    // Shift（スマホは操作パッドの走るボタン）で走れる
    dash: {},
    terms: { newGame: "ニューゲーム", attack: "攻撃", skill: "スキル", guard: "防御", escape: "逃げる" },
  },
  maps: {
    [MAPS.village]: { id: MAPS.village, name: "ミルト村", order: 0 },
    [MAPS.field]: { id: MAPS.field, name: "ミルトの草原", order: 1 },
    [MAPS.cave]: { id: MAPS.cave, name: "ほこらの洞窟", order: 2 },
    [MAPS.shrine]: { id: MAPS.shrine, name: "ほこら", order: 3 },
  },
  tilesets: { ts_hokora: { id: "ts_hokora", name: "ほこら", image: { asset: assets["hokora_tileset.png"].id }, passage: PASSAGE } },
  database: database(assets),
  assets: { entries: Object.fromEntries(Object.entries(assets).map(([name, a]) => [a.id, entry(name, a)])) },
  switches: {
    sw_key: { name: "古いかぎを持っている" },
    sw_door: { name: "封印の扉が開いた" },
    sw_boss: { name: "ほこらの主を倒した" },
  },
  variables: {},
};
writeFileSync(join(ROOT, "project.json"), toJson(project));
console.log(`\n村 ${VILLAGE.w}x${VILLAGE.h}・草原 ${FIELD.w}x${FIELD.h}・洞窟 ${CAVE.w}x${CAVE.h}・ほこら ${SHRINE.w}x${SHRINE.h}`);
