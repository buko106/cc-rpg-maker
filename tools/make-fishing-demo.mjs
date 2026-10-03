#!/usr/bin/env node
/**
 * 釣り大会のデモ（fixtures/projects/v2/fishing）を丸ごと生成する開発用スクリプト。
 * 出力: project.json、maps/<MapId>.json、assets/<AssetId>.<ext>（AssetId = 内容の sha256 先頭 16 桁）。
 * 生成物はコミット済み。マップやデータを変えたいときだけ再実行する（何度実行しても同じものができる）。
 *
 *   node tools/make-fishing-demo.mjs
 *
 * 「港町ナミマの釣り大会」：港の桟橋・岩場の突堤・桟橋の先の沖で釣りをして、受付で申しこんだ釣り大会で優勝をねらう。見せたいもの：
 * 1. プラグイン `@rpg/plugin-fishing`（docs/19-fishing-plugin.md）が、釣りのすべてを担う。マップは港町 1 枚だけ。
 *    釣り場は水辺のイベント（水に向かって決定ボタン → `plugin:fishing/Cast`）。魚・竿・エサはデータベースのアイテム。
 * 2. 竿を振る → あたりを待つ → 「！」で決定ボタン → バーの中に魚を入れ続けて巻き上げる、というミニゲーム。
 *    ミニゲームは、プラグインのコマンドが毎フレーム入力を読む待機（core の `wait: plugin`）で動く。表示はプラグインが描く。
 * 3. 竿を買い替えるほど当たり判定が広がり、エサが良いほど大物が来る。釣り場（桟橋・岩場・沖）で釣れる魚が違う。
 * 4. 受付で申しこむと、制限時間つきの大会（core のタイマー）。時間が来ると進行役が結果発表（ライバルと点数を競う）。賞金・トロフィー。
 * 5. つり手帳（図鑑）。魚を全種類釣ると、港のおじさんが認めてくれる。
 * 設定（竿・エサ・魚・大会）は `system.plugins` の `params`（docs/19）。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { character, HERO, image, lcg, shade, TILE, writeAssets } from "./pixel-art.mjs";
import { cmd, curve, endBranch, entry, ifExpr, ifVar, otherwise, sw, text, toJson } from "./demo-lib.mjs";

const ROOT = join(import.meta.dirname, "..", "fixtures", "projects", "v2", "fishing");

/** 画面は 15×11 タイル。 */
const SCREEN = { width: 480, height: 352 };
const W = 26;
const H = 18;

// ── タイルセット ──────────────────────────────────────────────────────
const T = { water: 1, water2: 2, deep: 3, sand: 4, grass: 5, flowers: 6, plank: 7, stone: 8, roof: 9, roofBlue: 10, wall: 11, window: 12, door: 13, tree: 14, reef: 15, post: 16, crate: 17, barrel: 18, path: 19 };
const CELLS = 20;
/** 通れるのは、砂・草・花・桟橋の板・突堤の石畳・小道。水・建物・木・岩・杭・木箱・樽は通れない。 */
const PASSAGE = Array.from({ length: CELLS }, (_, id) => ([T.sand, T.grass, T.flowers, T.plank, T.stone, T.path].includes(id) ? 15 : 0));

function tileset() {
  const img = image(TILE * CELLS, TILE);
  const cell = (id) => {
    const set = (x, y, c) => {
      if (x < 0 || y < 0 || x >= TILE || y >= TILE) return;
      img.set(id * TILE + Math.round(x), Math.round(y), c);
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
  const noise = (id, base, seed, n, amp) => {
    const { set, rect } = cell(id);
    rect(0, 0, TILE, TILE, base);
    const rnd = lcg(seed);
    for (let i = 0; i < n; i++) set(rnd() * TILE, rnd() * TILE, shade(base, rnd() < 0.5 ? amp : -amp));
  };
  /** 水面：細かい波の線（明るい） */
  const waves = (id, seed, n, color) => {
    const { rect } = cell(id);
    const rnd = lcg(seed);
    for (let i = 0; i < n; i++) rect(Math.floor(rnd() * 24), Math.floor(rnd() * 30), 4 + Math.floor(rnd() * 5), 1, color);
  };

  // 水・波・沖（深い水）
  noise(T.water, [62, 128, 196], 11, 80, 8);
  waves(T.water, 12, 5, [130, 190, 236]);
  noise(T.water2, [60, 124, 192], 13, 80, 8);
  waves(T.water2, 14, 6, [124, 184, 232]);
  noise(T.deep, [32, 78, 148], 15, 90, 8);
  waves(T.deep, 16, 4, [70, 120, 190]);
  // 砂浜
  noise(T.sand, [226, 208, 160], 21, 90, 10);
  // 草・花・小道
  noise(T.grass, [92, 150, 88], 31, 110, 12);
  noise(T.flowers, [92, 150, 88], 32, 110, 12);
  {
    const { set } = cell(T.flowers);
    const rnd = lcg(33);
    for (let i = 0; i < 6; i++) {
      const x = 3 + Math.floor(rnd() * 26);
      const y = 3 + Math.floor(rnd() * 26);
      const c = [[250, 230, 90], [240, 130, 160], [250, 250, 250]][i % 3];
      for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) set(x + dx, y + dy, c);
      set(x, y, [230, 150, 40]);
    }
  }
  noise(T.path, [190, 160, 116], 41, 100, 12);
  // 桟橋の板：横に並ぶ板と釘
  {
    noise(T.plank, [166, 118, 70], 51, 60, 8);
    const { rect, set } = cell(T.plank);
    for (let row = 0; row < 4; row++) {
      rect(0, row * 8, TILE, 1, [112, 74, 40]);
      rect(0, row * 8 + 7, TILE, 1, [186, 140, 90]);
      set(3, row * 8 + 3, [80, 54, 32]);
      set(TILE - 4, row * 8 + 3, [80, 54, 32]);
    }
  }
  // 突堤の石畳
  {
    noise(T.stone, [150, 150, 158], 61, 70, 9);
    const { rect } = cell(T.stone);
    const rnd = lcg(62);
    for (let row = 0; row < 4; row++) {
      const y = row * 8;
      const off = row % 2 === 0 ? 0 : 8;
      rect(0, y, TILE, 1, [100, 100, 110]);
      for (let x = off; x < TILE + 8; x += 16) rect(x, y, 1, 8, [100, 100, 110]);
      for (let x = off; x < TILE; x += 16) rect(x + 1, y + 1, 14, 2, shade([150, 150, 158], 10 + Math.floor(rnd() * 12)));
    }
  }
  // 屋根（赤・青）：横縞の瓦
  for (const [id, base, seed] of [[T.roof, [190, 74, 62], 71], [T.roofBlue, [62, 104, 174], 72]]) {
    noise(id, base, seed, 40, 8);
    const { rect } = cell(id);
    for (let row = 0; row < 4; row++) {
      rect(0, row * 8, TILE, 1, shade(base, -46));
      rect(0, row * 8 + 1, TILE, 2, shade(base, 18));
      for (let x = (row % 2) * 8; x < TILE; x += 16) rect(x, row * 8 + 3, 1, 5, shade(base, -34));
    }
    rect(0, 29, TILE, 3, shade(base, -60));
  }
  // 壁・窓・扉
  for (const id of [T.wall, T.window, T.door]) {
    noise(id, [238, 230, 212], 80 + id, 50, 6);
    const { rect } = cell(id);
    rect(0, 0, TILE, 3, [150, 108, 68]);
    rect(0, 29, TILE, 3, [120, 90, 60]);
  }
  {
    const { rect } = cell(T.window);
    rect(8, 7, 16, 16, [96, 70, 44]);
    rect(10, 9, 12, 12, [140, 196, 236]);
    rect(10, 9, 12, 3, [190, 226, 250]);
    rect(15, 9, 2, 12, [96, 70, 44]);
    rect(10, 14, 12, 2, [96, 70, 44]);
  }
  {
    const { rect, disc } = cell(T.door);
    rect(6, 5, 20, 27, [96, 62, 36]);
    rect(8, 7, 16, 25, [130, 88, 50]);
    rect(15, 7, 2, 25, [96, 62, 36]);
    disc(21, 20, 1, [250, 220, 90]);
    disc(11, 20, 1, [250, 220, 90]);
  }
  // 木（草の上）
  {
    noise(T.tree, [92, 150, 88], 91, 80, 10);
    const { disc, rect, ellipse } = cell(T.tree);
    ellipse(16, 28, 10, 3, [0, 0, 0, 70]);
    rect(14, 18, 5, 10, [96, 64, 36]);
    disc(16, 12, 11, [44, 108, 62]);
    disc(12, 10, 7, [62, 134, 74]);
    disc(11, 8, 3, [96, 166, 96]);
    disc(21, 14, 5, [38, 92, 54]);
  }
  // 岩礁（水の上の岩）
  {
    noise(T.reef, [62, 128, 196], 101, 70, 8);
    waves(T.reef, 102, 3, [130, 190, 236]);
    const { ellipse } = cell(T.reef);
    ellipse(16, 25, 12, 4, [30, 70, 130, 120]);
    ellipse(12, 19, 8, 7, [96, 98, 108]);
    ellipse(21, 21, 6, 5, [84, 86, 96]);
    ellipse(10, 16, 4, 3, [140, 142, 152]);
    ellipse(20, 19, 3, 2, [128, 130, 140]);
    ellipse(16, 27, 11, 2, [200, 230, 250, 150]);
  }
  // 杭（砂の上の係留柱）
  {
    noise(T.post, [226, 208, 160], 111, 90, 10);
    const { rect, ellipse } = cell(T.post);
    ellipse(16, 28, 8, 3, [0, 0, 0, 60]);
    rect(12, 8, 8, 20, [112, 76, 44]);
    rect(12, 8, 3, 20, [140, 98, 58]);
    rect(11, 6, 10, 4, [150, 106, 64]);
    rect(10, 14, 12, 2, [196, 170, 110]);
    rect(10, 18, 12, 2, [196, 170, 110]);
  }
  // 木箱
  {
    noise(T.crate, [226, 208, 160], 121, 90, 10);
    const { rect, ellipse } = cell(T.crate);
    ellipse(16, 29, 12, 3, [0, 0, 0, 60]);
    rect(5, 9, 22, 20, [168, 124, 72]);
    rect(5, 9, 22, 2, [196, 152, 96]);
    rect(5, 9, 2, 20, [130, 92, 52]);
    rect(25, 9, 2, 20, [130, 92, 52]);
    rect(5, 27, 22, 2, [120, 84, 48]);
    for (let i = 0; i < 20; i++) {
      rect(7 + i, 11 + i, 1, 1, [130, 92, 52]);
      rect(25 - i, 11 + i, 1, 1, [130, 92, 52]);
    }
  }
  // 樽
  {
    noise(T.barrel, [226, 208, 160], 131, 90, 10);
    const { rect, ellipse } = cell(T.barrel);
    ellipse(16, 29, 10, 3, [0, 0, 0, 60]);
    ellipse(16, 18, 10, 11, [140, 96, 56]);
    ellipse(14, 16, 5, 8, [168, 120, 74]);
    rect(6, 12, 20, 2, [70, 70, 80]);
    rect(6, 22, 20, 2, [70, 70, 80]);
    ellipse(16, 8, 8, 2, [96, 64, 36]);
  }
  return img;
}

// ── 立て札 ────────────────────────────────────────────────────────────
function signboard() {
  const img = image(TILE * 3, TILE * 4);
  for (let row = 0; row < 4; row++) {
    for (let pattern = 0; pattern < 3; pattern++) {
      const ox = pattern * TILE;
      const oy = row * TILE;
      const R = (x, y, w, h, c) => img.rect(ox + x, oy + y, w, h, c);
      for (let j = -3; j <= 3; j++) for (let i = -9; i <= 9; i++) if ((i * i) / 81 + (j * j) / 9 <= 1) img.set(ox + 16 + i, oy + 28 + j, [0, 0, 0, 70]);
      R(14, 16, 4, 13, [96, 62, 34]);
      R(4, 5, 24, 14, [84, 52, 26]);
      R(5, 6, 22, 12, [176, 128, 76]);
      R(5, 6, 22, 1, [206, 160, 104]);
      for (const [y, w] of [[9, 16], [12, 12], [15, 14]]) R(8, y, w, 1, [96, 62, 34]);
    }
  }
  return img;
}

// ── イベントの書き方 ──────────────────────────────────────────────────
const page = (extra) => ({ conditions: [], trigger: "action", through: false, priority: "same", commands: [], ...extra });
const when = (id, value, op = ">=") => ({ kind: "variable", id, op, value });
const self = (value = true) => ({ kind: "selfSwitch", key: "A", value });
const setSwitch = (id, value, indent = 0) => cmd("ControlSwitches", { ids: [id], value }, indent);
const gold = (op, value, indent = 0) => cmd("ChangeGold", { op, amount: { kind: "constant", value } }, indent);
const gain = (item, n, indent = 0) => cmd("ChangeItems", { item, op: "gain", amount: { kind: "constant", value: n } }, indent);
const choices = (labels, cancel) => cmd("ShowChoices", { choices: labels, cancel });
const branch = (index, indent = 0) => cmd("ChoiceBranch", { index }, indent);
const plugin = (name, params = {}, indent = 0) => cmd(`plugin:fishing/${name}`, params, indent);

const VARS = { event: "var_fishing_event", species: "var_fishing_species", rank: "var_fishing_rank", score: "var_fishing_score", wins: "var_fishing_wins" };
const SW = { intro: "sw_intro", tournament: "sw_tournament" };

// ── 魚・竿・エサ（データベースのアイテムと、プラグインの設定）─────────────
const FISH = [
  { key: "iwashi", name: "イワシ", size: [8, 20], points: 6, weight: 12, spots: ["pier"], difficulty: 1, price: 10 },
  { key: "aji", name: "アジ", size: [10, 25], points: 10, weight: 10, spots: ["pier", "rocks"], difficulty: 1, price: 20 },
  { key: "mebaru", name: "メバル", size: [15, 30], points: 18, weight: 6, spots: ["rocks"], difficulty: 2, price: 50 },
  { key: "kasago", name: "カサゴ", size: [15, 35], points: 20, weight: 5, spots: ["rocks"], difficulty: 2, price: 60 },
  { key: "kurodai", name: "クロダイ", size: [30, 55], points: 40, weight: 3, spots: ["pier", "rocks"], difficulty: 3, price: 160 },
  { key: "suzuki", name: "スズキ", size: [40, 80], points: 60, weight: 3, spots: ["deep"], difficulty: 3, price: 240 },
  { key: "madai", name: "マダイ", size: [40, 90], points: 90, weight: 2, spots: ["deep"], difficulty: 4, price: 480 },
  { key: "maguro", name: "まぼろしのマグロ", size: [100, 180], points: 250, weight: 0.5, spots: ["deep"], difficulty: 5, price: 2000 },
  { key: "boots", name: "ながぐつ", size: [20, 30], points: 0, weight: 3, spots: ["pier", "rocks", "deep"], difficulty: 1, price: 2 },
];
const RODS = [
  { item: "item_rod1", name: "つりざお", zone: 0.28, price: 300, description: "ふつうの 釣りざお。バーの 当たり判定が 広がる。" },
  { item: "item_rod2", name: "ぐんじょう竿", zone: 0.36, price: 1200, description: "しなやかな 名竿。大物にも 負けにくい。" },
];
const BAITS = [
  { item: "item_worm", name: "ミミズ", bite: 0.85, rare: 1, price: 5, description: "ふつうの エサ。1 回の釣りで 1 つ使う。" },
  { item: "item_shrimp", name: "エビ", bite: 0.65, rare: 1.6, price: 15, description: "あたりが 早く、大物も 来やすい。" },
  { item: "item_lure", name: "ひかるルアー", bite: 0.5, rare: 2.6, price: 40, description: "あたりが とても早く、大物が よく来る。" },
];
const TROPHY = "item_trophy";

const fishingParams = {
  baseZone: 0.2,
  rods: RODS.map(({ item, name, zone }) => ({ item, name, zone })),
  baits: BAITS.map(({ item, name, bite, rare }) => ({ item, name, bite, rare })),
  fish: FISH.map((f) => ({ key: f.key, item: `item_${f.key}`, name: f.name, size: f.size, points: f.points, weight: f.weight, spots: f.spots, difficulty: f.difficulty })),
  tournament: {
    seconds: 120,
    rivals: [{ name: "ミナ", skill: 70 }, { name: "ゴンさん", skill: 150 }, { name: "トビさん", skill: 280 }],
    prizes: [1500, 700, 300],
    trophy: TROPHY,
  },
  vars: VARS,
};

// ── 港町 ──────────────────────────────────────────────────────────────
const POS = {
  start: { x: 12, y: 10 },
  clerk: { x: 5, y: 12 },
  shop: { x: 18, y: 12 },
  board: { x: 9, y: 12 },
  guide: { x: 11, y: 12 },
  master: { x: 15, y: 14 },
  tobi: { x: 22, y: 12 },
  gon: { x: 13, y: 5 },
  mina: { x: 4, y: 5 },
};

function groundTiles() {
  const g = new Array(W * H).fill(T.grass);
  const set = (x, y, t) => {
    if (x >= 0 && y >= 0 && x < W && y < H) g[y * W + x] = t;
  };
  for (let y = 0; y <= 8; y++) for (let x = 0; x < W; x++) set(x, y, y <= 3 ? T.deep : (x * 7 + y * 3) % 5 === 0 ? T.water2 : T.water);
  for (let x = 0; x < W; x++) set(x, 9, T.sand);
  const rnd = lcg(7);
  for (let y = 10; y <= 16; y++) for (let x = 0; x < W; x++) if (rnd() < 0.07) set(x, y, T.flowers);
  for (let x = 0; x < W; x++) set(x, H - 1, T.tree);
  for (let y = 10; y < H; y++) {
    set(0, y, T.tree);
    set(W - 1, y, T.tree);
  }
  // 小道：桟橋のつけねから南へ、東西に長い道
  for (let y = 9; y <= 16; y++) for (const x of [12, 13]) set(x, y, T.path);
  for (let x = 2; x <= 23; x++) set(x, 13, T.path);
  // 桟橋：板が南北に 2 マス幅。先は T 字
  for (let y = 3; y <= 8; y++) for (const x of [12, 13]) set(x, y, T.plank);
  for (let x = 10; x <= 15; x++) set(x, 3, T.plank);
  // 岩場の突堤：石畳が 1 マス幅。まわりに岩礁
  for (let y = 5; y <= 8; y++) set(4, y, T.stone);
  for (const [x, y] of [[2, 5], [2, 7], [1, 6], [6, 5], [7, 7], [6, 5], [2, 4], [3, 3], [5, 3], [7, 4], [8, 6]]) set(x, y, T.reef);
  // 建物：受付（赤い屋根）と釣具屋（青い屋根）。扉の前に立つ
  const building = (x0, x1, roof, doorX) => {
    for (let x = x0; x <= x1; x++) {
      set(x, 10, roof);
      set(x, 11, x === doorX ? T.door : (x - x0) % 2 === 0 ? T.window : T.wall);
    }
  };
  building(3, 7, T.roof, 5);
  building(16, 20, T.roofBlue, 18);
  // 浜辺の小物
  // （浜辺の道をふさがないこと：突堤のつけね（4, 9）へは、東から (5..10, 9) を通って歩ける）
  for (const [x, y, t] of [[11, 9, T.post], [14, 9, T.post], [8, 10, T.crate], [9, 10, T.barrel], [17, 9, T.crate], [19, 9, T.barrel], [2, 9, T.post]]) set(x, y, t);
  // 木をいくつか
  for (const [x, y] of [[2, 11], [24, 11], [2, 15], [23, 15], [7, 15], [18, 16], [10, 16], [4, 14]]) set(x, y, T.tree);
  return g;
}

/** 水辺の釣り場：水に向かって立って決定ボタンを押すと、竿を振る。 */
function spots() {
  const out = [];
  // 桟橋の右側の (14, 5) は、ゴンさんの立つ (13, 5) からしか向かえないので、釣り場にしない
  for (let y = 4; y <= 8; y++) out.push({ x: 11, y, spot: "pier" }, ...(y === 5 ? [] : [{ x: 14, y, spot: "pier" }]));
  for (let x = 10; x <= 15; x++) out.push({ x, y: 2, spot: "deep" });
  out.push({ x: 9, y: 3, spot: "deep" }, { x: 16, y: 3, spot: "deep" });
  for (let y = 6; y <= 8; y++) out.push({ x: 3, y, spot: "rocks" }, { x: 5, y, spot: "rocks" });
  return out;
}

function townMap(assets) {
  const gfx = (name, direction = "down") => ({ asset: assets[name].id, index: 0, direction });
  const events = {};
  const add = (ev) => (events[ev.id] = ev);

  // 釣り場
  spots().forEach((s, i) => add({ id: `ev_spot_${String(i + 1).padStart(2, "0")}`, name: `釣り場（${s.spot}）`, x: s.x, y: s.y, pages: [page({ commands: [plugin("Cast", { spot: s.spot })] })] }));

  // はじめに：おこづかいとエサ
  add({
    id: "ev_intro",
    name: "はじまり",
    x: W - 1,
    y: 0,
    pages: [
      page({
        conditions: [sw(SW.intro, false)],
        trigger: "autorun",
        through: true,
        priority: "below",
        commands: [
          text("ここは 港町 \\C[6]ナミマ\\C[0]。\n今日は 年に一度の \\C[6]釣り大会\\C[0]の 日だ。"),
          text("桟橋の先で 釣りを しながら、腕を みがこう。\n水に 向かって \\C[6]決定ボタン\\C[0]で 竿を ふる！"),
          gold("gain", 300),
          gain("item_worm", 8),
          text("旅の おこづかいと エサを 受け取った。\n（\\C[6]300G\\C[0]・ミミズ ×8）"),
          setSwitch(SW.intro, true),
        ],
      }),
    ],
  });

  // 大会の進行役：毎フレーム見張り、時間が来たら結果発表
  add({
    id: "ev_controller",
    name: "大会の進行役",
    x: 0,
    y: 0,
    pages: [
      { conditions: [], trigger: "parallel", through: true, priority: "below", commands: [plugin("Watch")] },
      {
        conditions: [when(VARS.event, 1, "==")],
        trigger: "autorun",
        through: true,
        priority: "below",
        commands: [
          text("カーン　カーン　カーン！\n\n\\C[6]終了の鐘\\C[0]が 鳴りひびいた。釣りは そこまで！"),
          plugin("Result"),
          setSwitch(SW.tournament, false),
          ifVar(VARS.rank, "==", 1),
          text("\\C[6]優勝\\C[0]！ おめでとう！\n賞金 \\C[6]1500G\\C[0]と、\\C[6]金のトロフィー\\C[0]を 受け取った！"),
          otherwise(),
          ifVar(VARS.rank, "==", 2, 1),
          text("\\C[6]2位\\C[0]！ 惜しかった！\n賞金 \\C[6]700G\\C[0]を 受け取った。", 1),
          otherwise(1),
          ifVar(VARS.rank, "==", 3, 2),
          text("\\C[6]3位\\C[0]。入賞だ！\n賞金 \\C[6]300G\\C[0]を 受け取った。", 2),
          otherwise(2),
          text("\\C[6]4位\\C[0]……。\nもっと 良い竿と エサで 来年こそ！", 2),
          endBranch(2),
          endBranch(1),
          endBranch(),
        ],
      },
    ],
  });

  // 受付
  add({
    id: "ev_clerk",
    name: "受付",
    ...POS.clerk,
    pages: [
      page({
        graphic: gfx("clerk.png"),
        commands: [
          text("釣り大会の 受付だよ！\n参加費は \\C[6]100G\\C[0]。制限時間は \\C[6]2 分\\C[0]。釣った魚の 点数で 競うんだ。"),
          choices(["参加する（100G）", "ルールを聞く", "やめる"], 2),
          branch(0),
          ifExpr("gold >= 100", 1),
          gold("lose", 100, 2),
          text("参加ありがとう！ ミミズも おまけに 3 つ あげるよ。", 2),
          gain("item_worm", 3, 2),
          text("それじゃあ……\\C[6]よーい、スタート！\\C[0]\n右上の タイマーが 0 になるまで だよ！", 2),
          setSwitch(SW.tournament, true, 2),
          plugin("Start", {}, 2),
          otherwise(1),
          text("おっと、参加費が たりないね。\nまずは 魚を 釣って 釣具屋で 売っておいで。", 2),
          endBranch(1),
          branch(1),
          text("点数は 魚の 種類と 大きさで 決まるよ。\n大物ほど 高得点！ 釣れなかった時間は もったいない！", 1),
          text("釣った魚は そのまま 持ち物に 入る。\n大会が 終わったら 釣具屋で 売れるよ。", 1),
          text("ライバルは \\C[6]ミナ\\C[0]、\\C[6]ゴンさん\\C[0]、\\C[6]トビさん\\C[0]。\n1 位は 賞金 \\C[6]1500G\\C[0]と トロフィーだ！", 1),
          branch(2),
          text("またの 申しこみを まってるよ！", 1),
          endBranch(),
        ],
      }),
      page({
        conditions: [sw(SW.tournament)],
        graphic: gfx("clerk.png"),
        commands: [text("大会 じっこうちゅうだよ！\nタイマーが 0 になるまで、がんばって！")],
      }),
    ],
  });

  // 釣具屋
  add({
    id: "ev_shop",
    name: "釣具屋",
    ...POS.shop,
    pages: [
      page({
        graphic: gfx("merchant.png"),
        commands: [
          text("いらっしゃい！ 釣具屋だ。\n\\C[6]良い竿\\C[0]ほど 大物に 負けにくく、\\C[6]良いエサ\\C[0]ほど 早く 大物が 来る。"),
          cmd("ShopProcessing", { goods: [...BAITS.map((b) => b.item), ...RODS.map((r) => r.item)], canSell: true }),
          text("釣った魚は いつでも 買い取るぜ。\n大物を 期待してるよ！"),
        ],
      }),
    ],
  });

  // つり手帳の板
  add({
    id: "ev_board",
    name: "魚拓の板",
    ...POS.board,
    pages: [page({ graphic: gfx("sign.png"), commands: [text("〜 魚拓の板 〜\n釣った魚の 記録を 見られる。"), plugin("Album")] })],
  });

  // 釣り場の案内
  add({
    id: "ev_guide",
    name: "釣り場の案内",
    ...POS.guide,
    pages: [
      page({
        graphic: gfx("sign.png"),
        commands: [
          text("〜 釣り場の ご案内 〜\n\\C[6]桟橋\\C[0] イワシ・アジ・クロダイ\n\\C[6]岩場の突堤\\C[0] アジ・メバル・カサゴ・クロダイ"),
          text("\\C[6]桟橋の 先（沖）\\C[0] スズキ・マダイ・\\C[6]まぼろしのマグロ\\C[0]\n※ 沖の大物は 良い竿と エサが ないと 逃げられる。"),
          text("・水に 向かって 決定ボタンで 竿を ふる\n・「！」が 出たら すぐ 決定ボタン\n・決定ボタンを 押している間は バーが 右へ、離すと 左へ\n  魚（●）を 緑の 範囲に 入れ続けて 巻き上げろ"),
        ],
      }),
    ],
  });

  // 港のおじさん：図鑑を全部そろえると認めてくれる
  add({
    id: "ev_master",
    name: "港のおじさん",
    ...POS.master,
    pages: [
      page({
        graphic: gfx("master.png"),
        commands: [text("わしは この港の 主みたいなもんじゃ。\n釣りの 腕は 竿と エサと 根気で 決まる。"), text("\\C[6]つり手帳\\C[0]（魚拓の板）の 魚を すべて 釣りあげたら、\nおぬしを 一人前の 釣り人と 認めよう。")],
      }),
      page({
        conditions: [when(VARS.species, 9)],
        graphic: gfx("master.png"),
        commands: [
          text("な、なんと！ 港に いる 魚を\n\\C[6]ぜんぶ\\C[0] 釣りあげたのか！"),
          gold("gain", 3000),
          text("おぬしは 港いちばんの \\C[6]釣りの達人\\C[0]じゃ！\nこれは 祝いの 品じゃ。（\\C[6]3000G\\C[0]）"),
          cmd("ControlSelfSwitch", { key: "A", value: true }),
        ],
      }),
      page({
        conditions: [when(VARS.species, 9), self()],
        graphic: gfx("master.png"),
        commands: [text("おぬしは もう 立派な 達人じゃ。\n大会で トビに 勝つ姿も 見たいのう。")],
      }),
    ],
  });

  // ライバルたち
  add({
    id: "ev_gon",
    name: "ゴンさん",
    ...POS.gon,
    pages: [
      page({
        graphic: gfx("gon.png", "up"),
        commands: [text("ワシは 30年 この桟橋で 釣っとる ゴンじゃ。\n桟橋の 先の 沖は 大物の 巣じゃが……"), text("バーの 幅が せまい 竿では 逃げられる。\nまずは 浅いところで 腕を みがくんじゃな。")],
      }),
      page({ conditions: [sw(SW.tournament)], graphic: gfx("gon.png", "up"), commands: [text("しっ！ 今 ウキが 沈みそうなんじゃ。\n話しかけるな！")] }),
      page({
        conditions: [when(VARS.rank, 1), sw(SW.tournament, false)],
        graphic: gfx("gon.png", "up"),
        commands: [text("先の 大会は おぬしが \\C[6]\\V[var_fishing_rank]位\\C[0]、\n点数は \\V[var_fishing_score] てんじゃったな。\n次は 負けんぞ。")],
      }),
    ],
  });
  add({
    id: "ev_mina",
    name: "ミナ",
    ...POS.mina,
    pages: [
      page({
        graphic: gfx("mina.png", "up"),
        commands: [text("岩場は メバルや カサゴが 釣れるのよ。\nちょっと 引きが 強いけど、点数も 高いわ。"), text("エサは 良いものほど 大物が 来やすいの。\n\\C[6]エビ\\C[0]や \\C[6]ひかるルアー\\C[0]、おすすめよ！")],
      }),
      page({ conditions: [sw(SW.tournament)], graphic: gfx("mina.png", "up"), commands: [text("今 いい ところなの！ 邪魔しないでね！")] }),
      page({
        conditions: [when(VARS.rank, 1), sw(SW.tournament, false)],
        graphic: gfx("mina.png", "up"),
        commands: [text("大会、おつかれさま！ あなたは \\C[6]\\V[var_fishing_rank]位\\C[0]だったのね。\nわたしも もっと 腕を みがかなきゃ。")],
      }),
    ],
  });
  add({
    id: "ev_tobi",
    name: "トビさん",
    ...POS.tobi,
    pages: [
      page({
        graphic: gfx("tobi.png"),
        commands: [text("俺は 去年の 優勝者、\\C[6]トビ\\C[0]だ。\n今年も 賞金は いただくぜ。"), text("沖の 大物を 狙えば 点数は 桁ちがいだ。\nだが 良い竿が なければ 話に ならん。")],
      }),
      page({ conditions: [sw(SW.tournament)], graphic: gfx("tobi.png"), commands: [text("大会中に 無駄口を たたくな。\n釣れ、釣れ！")] }),
      page({ conditions: [when(VARS.wins, 1), sw(SW.tournament, false)], graphic: gfx("tobi.png"), commands: [text("……やるな。俺に 勝つとは。\n来年は こうは いかんぞ。")] }),
    ],
  });

  return { id: "map_harbor", width: W, height: H, tileset: "ts_harbor", layers: [{ name: "ground", tiles: groundTiles() }], events };
}

// ── 書き出し ──────────────────────────────────────────────────────────
rmSync(ROOT, { recursive: true, force: true });
const assets = writeAssets(join(ROOT, "assets"), {
  "harbor_tiles.png": tileset(),
  "hero.png": character(HERO),
  "clerk.png": character({ shirt: [200, 90, 90], hair: [90, 60, 40], skin: [240, 204, 170] }),
  "merchant.png": character({ shirt: [70, 120, 180], hair: [60, 60, 70], skin: [230, 190, 150] }),
  "master.png": character({ shirt: [90, 120, 110], hair: [236, 236, 236], skin: [226, 186, 150] }),
  "gon.png": character({ shirt: [120, 100, 70], hair: [200, 200, 200], skin: [222, 180, 140] }),
  "mina.png": character({ shirt: [240, 170, 70], hair: [190, 90, 40], skin: [244, 210, 180] }),
  "tobi.png": character({ shirt: [170, 50, 50], hair: [40, 30, 30], skin: [226, 184, 146] }),
  "sign.png": signboard(),
});

mkdirSync(join(ROOT, "maps"), { recursive: true });
const harbor = townMap(assets);
writeFileSync(join(ROOT, "maps", `${harbor.id}.json`), toJson(harbor));

const noStats = { mhp: 30, mmp: 0, atk: 5, def: 3, mat: 0, mdf: 0, agi: 8, luk: 0 };
const items = {};
for (const f of FISH) items[`item_${f.key}`] = { id: `item_${f.key}`, name: f.name, kind: "consumable", price: f.price, effects: [], description: `${f.name}。釣具屋で 売れる。` };
for (const b of BAITS) items[b.item] = { id: b.item, name: b.name, kind: "consumable", price: b.price, effects: [], description: b.description };
for (const r of RODS) items[r.item] = { id: r.item, name: r.name, kind: "key", price: r.price, effects: [], description: r.description };
items[TROPHY] = { id: TROPHY, name: "金のトロフィー", kind: "key", price: 0, effects: [], description: "釣り大会で 優勝した 証。" };

const project = {
  formatVersion: 2,
  meta: { id: "fishing", title: "デモ：港町の釣り大会", createdAt: "2026-10-02T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z" },
  system: {
    startMap: "map_harbor",
    startX: POS.start.x,
    startY: POS.start.y,
    initialParty: ["actor_hero"],
    tileSize: TILE,
    screen: SCREEN,
    bgm: {},
    terms: { newGame: "ニューゲーム" },
    plugins: [{ name: "fishing", version: "1.0.0", params: fishingParams }],
  },
  maps: { map_harbor: { id: "map_harbor", name: "港町ナミマ", order: 0 } },
  tilesets: { ts_harbor: { id: "ts_harbor", name: "港町", image: { asset: assets["harbor_tiles.png"].id }, passage: PASSAGE } },
  database: {
    actors: { actor_hero: { id: "actor_hero", name: "旅人", classId: "class_hero", initialLevel: 1, walk: { asset: assets["hero.png"].id }, equips: {} } },
    classes: {
      class_hero: {
        id: "class_hero",
        name: "旅人",
        skills: [],
        params: { mhp: curve(noStats.mhp, 5), mmp: curve(0, 0), atk: curve(noStats.atk, 1), def: curve(noStats.def, 1), mat: curve(0, 0), mdf: curve(0, 0), agi: curve(8, 0), luk: curve(0, 0) },
      },
    },
    skills: {},
    items,
    enemies: {},
    troops: {},
    states: {},
    commonEvents: {},
  },
  assets: { entries: Object.fromEntries(Object.entries(assets).map(([name, a]) => [a.id, entry(name, a)])) },
  switches: { [SW.intro]: { name: "はじまりの説明を聞いた" }, [SW.tournament]: { name: "釣り大会に出ている" } },
  variables: Object.fromEntries(
    Object.entries({ [VARS.event]: "釣り：イベント", [VARS.species]: "釣り：釣った魚の種類", [VARS.rank]: "釣り：最後の大会の順位", [VARS.score]: "釣り：最後の大会の点数", [VARS.wins]: "釣り：大会で優勝した回数" }).map(([id, name]) => [id, { name }]),
  ),
};
writeFileSync(join(ROOT, "project.json"), toJson(project));
console.log(`\n港町 ${W}×${H}、釣り場 ${spots().length} か所、魚 ${FISH.length} 種`);
