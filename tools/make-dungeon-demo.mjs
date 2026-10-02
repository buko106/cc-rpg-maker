#!/usr/bin/env node
/**
 * 不思議のダンジョンのデモ（fixtures/projects/v2/dungeon）を丸ごと生成する開発用スクリプト。
 * 出力: project.json、maps/<MapId>.json、assets/<AssetId>.<ext>（AssetId = 内容の sha256 先頭 16 桁）。
 * 生成物はコミット済み。町やデータを変えたいときだけ再実行する（何度実行しても同じものができる）。
 *
 *   node tools/make-dungeon-demo.mjs
 *
 * 「風鳴りの洞窟」：町の外れの洞窟に入り、地下 7 階の宝を持ち帰る。見せたいもの：
 * 1. プラグイン `@rpg/plugin-dungeon`（docs/18-dungeon-plugin.md）がダンジョンのすべてを担う。マップは町（`map_town`）と、
 *    全マスが岩の「フロアのひな形」（`map_floor`。コントローラのイベントが 1 つあるだけ）の 2 枚だけ。フロアの地形はプラグインが入るたびに作って書き込む。
 * 2. 入るたびに地形・敵・落ちている物が変わる（シードから決まる）。降りるたびに新しいフロア。
 * 3. 1 歩歩くと敵も 1 歩動くターン制。敵にぶつかって攻撃、決定ボタンで目の前を攻撃（敵がいなければ 1 ターン休む）。
 * 4. 満腹度（おにぎりを拾うと食べる）、くすり草（拾うと持ち物に入り、メニューから使う）、ちからの種、お金。倒した敵の経験値でレベルが上がる。
 * 5. 歩いた場所だけが見える（ミニマップつき）。倒れると、持ち物とダンジョンで手に入れたお金を失って町へ戻る。
 * 6. 入るときにレベル 1 から。最深階・クリア回数は変数に残り、町の長老が覚えている。
 * 設定（出る敵・落ちている物・階の範囲・満腹度など）は `system.plugins` の `params`（docs/18）。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canvas, character, HERO, image, lcg, shade, TILE, writeAssets } from "./pixel-art.mjs";

const ROOT = join(import.meta.dirname, "..", "fixtures", "projects", "v2", "dungeon");

/** 画面は 15×11 タイル。 */
const SCREEN = { width: 480, height: 352 };
/** フロアのひな形の大きさ（プラグインの設定の width × height と同じにする）。 */
const FLOOR_W = 39;
const FLOOR_H = 27;
const GOAL_FLOOR = 7;
const TOWN_W = 20;
const TOWN_H = 14;

// ── タイルセット ──────────────────────────────────────────────────────
const T = { rock: 1, wallFace: 2, floorA: 3, floorB: 4, stairs: 5, treasure: 6, grass: 7, flowers: 8, path: 9, tree: 10, stone: 11, cave: 12 };
const CELLS = 13;
/** 通れないのは、岩・壁の正面・木・石垣・洞窟の入口の岩。 */
const PASSAGE = Array.from({ length: CELLS }, (_, id) => ([T.rock, T.wallFace, T.tree, T.stone, T.cave].includes(id) ? 0 : 15));

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

  // 岩：暗い青灰色のざらざら（歩いたことのある場所の外側に見える）
  noise(T.rock, [38, 40, 52], 11, 120, 10);
  // 壁の正面：レンガ積み
  {
    const { rect } = cell(T.wallFace);
    const rnd = lcg(21);
    rect(0, 0, TILE, TILE, [66, 60, 74]);
    for (let row = 0; row < 4; row++) {
      const y = row * 8;
      const off = row % 2 === 0 ? 0 : 8;
      rect(0, y, TILE, 1, [40, 36, 48]);
      for (let x = off; x < TILE + 8; x += 16) rect(x, y, 1, 8, [40, 36, 48]);
      for (let x = off; x < TILE; x += 16) rect(x + 1, y + 1, 14, 2, shade([66, 60, 74], 14 + Math.floor(rnd() * 8)));
    }
    rect(0, 24, TILE, 8, [58, 52, 66]);
    rect(0, 31, TILE, 1, [30, 26, 38]);
  }
  // 床：暖かい灰色の石畳。B はひびつき
  noise(T.floorA, [118, 108, 98], 31, 90, 9);
  noise(T.floorB, [114, 104, 94], 41, 90, 9);
  for (const id of [T.floorA, T.floorB]) {
    const { rect } = cell(id);
    rect(0, 0, TILE, 1, [92, 84, 76]);
    rect(0, 0, 1, TILE, [92, 84, 76]);
    rect(TILE - 1, 0, 1, TILE, [134, 124, 112]);
    rect(0, TILE - 1, TILE, 1, [134, 124, 112]);
  }
  {
    const { set } = cell(T.floorB);
    let x = 7;
    let y = 6;
    for (let n = 0; n < 12; n++) {
      set(x, y, [78, 70, 64]);
      x += n % 3 === 0 ? 1 : 0;
      y += 1;
    }
  }
  // 階段：床の上の黒い穴と、下りの段
  {
    noise(T.stairs, [118, 108, 98], 51, 70, 9);
    const { rect } = cell(T.stairs);
    rect(4, 4, 24, 24, [34, 30, 40]);
    for (let i = 0; i < 5; i++) {
      rect(4 + i * 3, 4 + i * 5, 24 - i * 3, 5, shade([150, 140, 124], -i * 22));
      rect(4 + i * 3, 4 + i * 5 + 4, 24 - i * 3, 1, shade([90, 82, 72], -i * 12));
    }
    rect(4, 4, 24, 1, [70, 62, 54]);
  }
  // 宝：床の上に光る宝玉の台座
  {
    noise(T.treasure, [118, 108, 98], 61, 70, 9);
    const { ellipse, disc, rect } = cell(T.treasure);
    ellipse(16, 17, 14, 12, [255, 230, 120, 50]);
    ellipse(16, 24, 9, 3, [0, 0, 0, 80]);
    rect(10, 20, 12, 5, [150, 140, 150]);
    rect(8, 24, 16, 3, [120, 110, 124]);
    disc(16, 14, 6, [60, 170, 255]);
    disc(14, 12, 3, [150, 225, 255]);
    disc(13, 11, 1, [255, 255, 255]);
  }
  // 草・花・小道
  noise(T.grass, [88, 144, 84], 71, 110, 12);
  noise(T.flowers, [88, 144, 84], 72, 110, 12);
  {
    const { set } = cell(T.flowers);
    const rnd = lcg(73);
    for (let i = 0; i < 6; i++) {
      const x = 3 + Math.floor(rnd() * 26);
      const y = 3 + Math.floor(rnd() * 26);
      const c = [[250, 230, 90], [240, 130, 160], [250, 250, 250]][i % 3];
      for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) set(x + dx, y + dy, c);
      set(x, y, [230, 150, 40]);
    }
  }
  noise(T.path, [182, 152, 108], 81, 100, 12);
  // 木（草の上）
  {
    noise(T.tree, [88, 144, 84], 91, 80, 10);
    const { disc, rect, ellipse } = cell(T.tree);
    ellipse(16, 28, 10, 3, [0, 0, 0, 70]);
    rect(14, 18, 5, 10, [96, 64, 36]);
    disc(16, 12, 11, [44, 100, 58]);
    disc(12, 10, 7, [60, 128, 70]);
    disc(11, 8, 3, [92, 160, 92]);
    disc(21, 14, 5, [36, 86, 50]);
  }
  // 石垣（町の崖）
  {
    const { rect } = cell(T.stone);
    const rnd = lcg(101);
    rect(0, 0, TILE, TILE, [120, 118, 124]);
    for (let row = 0; row < 4; row++) {
      const y = row * 8;
      const off = row % 2 === 0 ? 0 : 8;
      rect(0, y, TILE, 1, [78, 76, 84]);
      for (let x = off; x < TILE + 8; x += 16) rect(x, y, 1, 8, [78, 76, 84]);
      for (let x = off; x < TILE; x += 16) rect(x + 1, y + 1, 14, 2, shade([120, 118, 124], 12 + Math.floor(rnd() * 14)));
    }
  }
  // 洞窟の入口：石垣の中の黒い口
  {
    const { rect, ellipse, set } = cell(T.cave);
    rect(0, 0, TILE, TILE, [120, 118, 124]);
    ellipse(16, 22, 15, 20, [90, 88, 96]);
    ellipse(16, 24, 12, 18, [10, 8, 16]);
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) if (Math.hypot((x - 16) / 12, (y - 24) / 18) < 1 && y < 16 && (x + y) % 5 === 0) set(x, y, [24, 20, 32]);
    ellipse(16, 30, 9, 2, [60, 46, 40]);
  }
  return img;
}

// ── スプライト：32×32 のコマを並べたシート（敵 5 種 + 落ちている物）──────────
/** 敵・物の絵のコマの位置（列, 行）。プラグインの設定の `sprite: { sx, sy }` は、これを 32 倍した値。 */
const CELL = { slime: [0, 0], bat: [1, 0], goblin: [2, 0], golem: [3, 0], dragon: [4, 0], herb: [0, 1], onigiri: [1, 1], gold: [2, 1], seed: [3, 1], bigHerb: [4, 1] };
const px = ([col, row]) => ({ sx: col * TILE, sy: row * TILE });

function sprites() {
  const img = image(TILE * 5, TILE * 2);
  const at = ([col, row]) => {
    const c = canvas(TILE, TILE);
    return { c, done: () => {
      for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
        const p = c.get(x, y);
        if (p[3] > 0) img.set(col * TILE + x, row * TILE + y, p);
      }
    } };
  };
  const shadow = (c, rx = 10) => c.ellipse(16, 28, rx, 3, [0, 0, 0, 80]);
  const eyes = (c, y, color = [20, 20, 30]) => {
    c.rect(11, y, 3, 4, [255, 255, 255]);
    c.rect(18, y, 3, 4, [255, 255, 255]);
    c.rect(12, y + 1, 2, 3, color);
    c.rect(19, y + 1, 2, 3, color);
  };

  // スライム
  {
    const { c, done } = at(CELL.slime);
    shadow(c, 11);
    c.ellipse(16, 20, 12, 8, [60, 150, 70]);
    c.ellipse(16, 18, 10, 9, [110, 210, 110]);
    c.ellipse(16, 12, 6, 5, [110, 210, 110]);
    c.ellipse(12, 12, 2, 2, [190, 250, 190]);
    eyes(c, 15);
    c.rect(14, 22, 5, 1, [40, 100, 50]);
    done();
  }
  // コウモリ
  {
    const { c, done } = at(CELL.bat);
    c.ellipse(16, 27, 7, 2, [0, 0, 0, 70]);
    for (const s of [-1, 1]) {
      const cx = 16 + s * 9;
      c.ellipse(cx, 13, 8, 5, [88, 56, 120]);
      for (const dx of [-6, -2, 2, 6]) c.rect(cx + dx * s - 1, 16, 3, 4, [88, 56, 120]);
      c.ellipse(cx, 12, 6, 3, [120, 80, 156]);
    }
    c.ellipse(16, 16, 6, 7, [52, 36, 72]);
    c.rect(11, 6, 3, 5, [52, 36, 72]);
    c.rect(18, 6, 3, 5, [52, 36, 72]);
    c.rect(12, 14, 2, 2, [255, 80, 80]);
    c.rect(18, 14, 2, 2, [255, 80, 80]);
    c.rect(14, 19, 1, 2, [255, 255, 255]);
    c.rect(17, 19, 1, 2, [255, 255, 255]);
    done();
  }
  // ゴブリン
  {
    const { c, done } = at(CELL.goblin);
    shadow(c);
    c.rect(11, 22, 4, 6, [90, 60, 36]);
    c.rect(17, 22, 4, 6, [90, 60, 36]);
    c.rect(9, 14, 14, 10, [150, 100, 56]);
    c.rect(9, 20, 14, 2, [100, 66, 36]);
    c.ellipse(16, 10, 8, 7, [110, 170, 80]);
    c.rect(5, 8, 5, 3, [110, 170, 80]);
    c.rect(22, 8, 5, 3, [110, 170, 80]);
    c.rect(11, 8, 3, 3, [255, 240, 120]);
    c.rect(18, 8, 3, 3, [255, 240, 120]);
    c.rect(12, 9, 1, 2, [20, 20, 20]);
    c.rect(19, 9, 1, 2, [20, 20, 20]);
    c.rect(13, 14, 6, 1, [60, 40, 30]);
    c.line(25, 12, 29, 26, [130, 90, 50], 1);
    c.disc(25, 11, 3, [150, 110, 64]);
    done();
  }
  // ゴーレム
  {
    const { c, done } = at(CELL.golem);
    shadow(c, 12);
    c.rect(8, 22, 6, 6, [110, 108, 112]);
    c.rect(18, 22, 6, 6, [110, 108, 112]);
    c.rect(6, 10, 20, 14, [138, 136, 142]);
    c.rect(6, 10, 20, 2, [170, 168, 174]);
    c.rect(2, 12, 5, 10, [120, 118, 124]);
    c.rect(25, 12, 5, 10, [120, 118, 124]);
    c.rect(10, 3, 12, 9, [150, 148, 154]);
    c.rect(12, 6, 3, 3, [255, 150, 40]);
    c.rect(18, 6, 3, 3, [255, 150, 40]);
    c.rect(11, 16, 10, 1, [90, 88, 94]);
    c.rect(15, 12, 1, 8, [90, 88, 94]);
    done();
  }
  // 竜（ボス）
  {
    const { c, done } = at(CELL.dragon);
    shadow(c, 13);
    c.line(22, 22, 30, 16, [150, 40, 40], 2);
    for (const s of [-1, 1]) c.ellipse(16 + s * 11, 11, 7, 8, [110, 24, 36]);
    c.ellipse(16, 19, 10, 9, [190, 50, 50]);
    c.ellipse(16, 22, 6, 5, [240, 190, 120]);
    c.ellipse(16, 9, 8, 7, [200, 58, 58]);
    c.rect(9, 1, 3, 6, [240, 220, 180]);
    c.rect(20, 1, 3, 6, [240, 220, 180]);
    c.rect(11, 8, 3, 3, [255, 230, 60]);
    c.rect(18, 8, 3, 3, [255, 230, 60]);
    c.rect(12, 9, 1, 2, [20, 10, 10]);
    c.rect(19, 9, 1, 2, [20, 10, 10]);
    c.rect(12, 13, 8, 2, [120, 20, 30]);
    c.rect(13, 14, 1, 2, [255, 255, 255]);
    c.rect(18, 14, 1, 2, [255, 255, 255]);
    c.rect(10, 26, 4, 3, [150, 40, 40]);
    c.rect(18, 26, 4, 3, [150, 40, 40]);
    done();
  }
  // くすり草
  {
    const { c, done } = at(CELL.herb);
    shadow(c, 8);
    c.line(16, 26, 16, 14, [60, 130, 60], 1);
    for (const [dx, dy, r] of [[-6, 11, 5], [6, 11, 5], [0, 7, 5]]) c.ellipse(16 + dx, dy + 3, r, r - 1, [90, 190, 90]);
    c.ellipse(14, 9, 2, 1, [180, 240, 170]);
    c.disc(16, 5, 2, [250, 240, 120]);
    done();
  }
  // おにぎり
  {
    const { c, done } = at(CELL.onigiri);
    shadow(c, 9);
    for (let y = 6; y <= 25; y++) {
      const half = Math.round(((y - 6) / 19) * 10) + 1;
      for (let x = -half; x <= half; x++) c.set(16 + x, y, x > half - 3 ? [214, 210, 200] : [250, 248, 240]);
    }
    c.rect(11, 18, 10, 8, [30, 40, 36]);
    c.rect(12, 19, 8, 1, [60, 76, 64]);
    done();
  }
  // お金の袋
  {
    const { c, done } = at(CELL.gold);
    shadow(c, 9);
    c.ellipse(16, 19, 9, 8, [150, 104, 56]);
    c.ellipse(14, 17, 5, 5, [182, 130, 72]);
    c.rect(11, 9, 10, 3, [120, 80, 40]);
    c.rect(13, 7, 6, 3, [150, 104, 56]);
    c.disc(16, 20, 4, [250, 210, 70]);
    c.rect(15, 18, 2, 5, [190, 140, 30]);
    done();
  }
  // ちからの種
  {
    const { c, done } = at(CELL.seed);
    c.ellipse(16, 17, 12, 12, [255, 170, 60, 50]);
    shadow(c, 6);
    c.ellipse(16, 17, 6, 8, [230, 110, 40]);
    c.ellipse(14, 14, 2, 3, [255, 190, 110]);
    c.rect(15, 7, 2, 3, [90, 150, 60]);
    done();
  }
  // 大きなくすり草
  {
    const { c, done } = at(CELL.bigHerb);
    shadow(c, 9);
    c.ellipse(16, 15, 13, 13, [100, 190, 255, 45]);
    c.line(16, 27, 16, 13, [50, 110, 150], 1);
    for (const [dx, dy] of [[-8, 12], [8, 12], [-4, 6], [4, 6]]) c.ellipse(16 + dx, dy + 4, 5, 4, [90, 170, 220]);
    c.ellipse(16, 8, 5, 5, [160, 220, 255]);
    c.disc(16, 8, 2, [255, 255, 255]);
    done();
  }
  return img;
}

// ── 町 ────────────────────────────────────────────────────────────────
const cmd = (code, params, indent = 0) => ({ code, params, indent });
const text = (t) => cmd("ShowText", { text: t, position: "bottom", background: "window" });
const page = (extra) => ({ conditions: [], trigger: "action", through: false, priority: "same", commands: [], ...extra });
const VARS = { event: "var_dungeon_event", best: "var_dungeon_best", result: "var_dungeon_result", clears: "var_dungeon_clears" };
const when = (id, value, op = ">=") => ({ kind: "variable", id, op, value });

function townMap(assets) {
  const ground = new Array(TOWN_W * TOWN_H).fill(T.grass);
  const set = (x, y, t) => (ground[y * TOWN_W + x] = t);
  const rnd = lcg(7);
  for (let y = 0; y < TOWN_H; y++) for (let x = 0; x < TOWN_W; x++) if (rnd() < 0.08) set(x, y, T.flowers);
  for (let x = 0; x < TOWN_W; x++) {
    set(x, 0, T.tree);
    set(x, TOWN_H - 1, T.tree);
  }
  for (let y = 0; y < TOWN_H; y++) {
    set(0, y, T.tree);
    set(TOWN_W - 1, y, T.tree);
  }
  // 北の崖（石垣）と、真ん中の洞窟の入口。そこから南へ小道
  for (let x = 2; x <= TOWN_W - 3; x++) {
    set(x, 1, T.stone);
    set(x, 2, T.stone);
  }
  const CAVE = [10, 2];
  set(CAVE[0], CAVE[1], T.cave);
  for (let y = 3; y <= TOWN_H - 2; y++) set(CAVE[0], y, T.path);
  for (let x = 6; x <= 14; x++) set(x, 7, T.path);
  // 木をいくつか
  for (const [x, y] of [[3, 4], [4, 9], [16, 4], [15, 10], [2, 11], [17, 8], [6, 11]]) set(x, y, T.tree);

  const events = {
    ev_cave: {
      id: "ev_cave",
      name: "洞窟の入口",
      x: CAVE[0],
      y: CAVE[1],
      pages: [
        page({
          trigger: "touch",
          priority: "same",
          commands: [
            text("風鳴りの洞窟だ。奥から ひゅうひゅうと 風の音がする。\n\n入るたびに 中の様子は 変わるという。"),
            cmd("ShowChoices", { choices: ["入る", "やめておく"], cancel: 1 }),
            cmd("ChoiceBranch", { index: 0 }, 0),
            cmd("plugin:dungeon/Enter", {}, 1),
            cmd("ChoiceBranch", { index: 1 }, 0),
            cmd("EndBranch", {}, 0),
          ],
        }),
      ],
    },
    ev_elder: {
      id: "ev_elder",
      name: "長老",
      x: 7,
      y: 5,
      pages: [
        page({
          graphic: { asset: assets["elder.png"].id, index: 0, direction: "down" },
          commands: [
            text("よく来た、旅人よ。\n北の洞窟は『風鳴りの洞窟』。入るたびに 姿を変える 不思議な洞窟じゃ。"),
            text("洞窟では、おぬしが 1 歩 歩くと 魔物も 1 歩 動く。\n魔物に ぶつかると 攻撃じゃ。\n\\C[6]決定ボタン\\C[0]で 目の前を攻撃、何もいなければ その場で 1 ターン 休める。"),
            text("洞窟に入ると レベルは 1 に戻る。\n倒れたら 持ち物と 洞窟で拾ったお金は 失うぞ。\n\nおなかが すくと 力が出ない。\\C[6]おにぎり\\C[0]を 見つけて 食べるのじゃ。"),
            text(`最深部は 地下 ${GOAL_FLOOR} 階。\n奥の宝を 持ち帰れば 一人前じゃ。 くすり草は \\C[6]メニュー\\C[0]から 使えるぞ。`),
          ],
        }),
        page({
          conditions: [when(VARS.best, 2)],
          graphic: { asset: assets["elder.png"].id, index: 0, direction: "down" },
          commands: [text("洞窟で 一番 深く 降りたのは 地下 \\V[var_dungeon_best] 階か。\n\n無理はするな。倒れても 命までは 取られんが……持ち物は 失うからのう。")],
        }),
        page({
          conditions: [when(VARS.clears, 1)],
          graphic: { asset: assets["elder.png"].id, index: 0, direction: "down" },
          commands: [
            text("おお、宝を 持ち帰ったか！\n\\C[6]一人前の冒険者じゃ\\C[0]。"),
            text("洞窟は 何度でも 入れる。\n宝を持ち帰った回数は \\V[var_dungeon_clears] 回。\n次は 奥まで 1 度も 休まずに 行けるかな？"),
          ],
        }),
      ],
    },
    ev_sign: {
      id: "ev_sign",
      name: "立て札",
      x: 13,
      y: 5,
      pages: [
        page({
          graphic: { asset: assets["sign.png"].id, index: 0, direction: "down" },
          commands: [
            text("〜 風鳴りの洞窟 〜\n\n矢印キー（WASD）… 1 歩 歩く（敵にぶつかると 攻撃）\nZ / Enter … 目の前を攻撃・その場で 1 ターン 休む\nM / Esc … メニュー（くすり草を使う・セーブ）"),
            text("・おにぎり … 拾うと その場で 食べる（満腹度が増える）\n・ちからの種 … 食べると 攻撃力が 上がる\n・満腹度が 0 になると 少しずつ 弱っていく"),
          ],
        }),
      ],
    },
  };
  return { id: "map_town", width: TOWN_W, height: TOWN_H, tileset: "ts_dungeon", layers: [{ name: "ground", tiles: ground }], events, home: { x: CAVE[0], y: CAVE[1] + 1 } };
}

/** フロアのひな形：全マスが岩。コントローラ（毎フレーム Tick を呼び、倒れたとき・宝を取ったときに町へ戻す）が 1 つ。 */
function floorMap() {
  const tiles = new Array(FLOOR_W * FLOOR_H).fill(T.rock);
  const controller = {
    id: "ev_dungeon",
    name: "ダンジョンのコントローラ",
    x: 0,
    y: 0,
    pages: [
      { conditions: [], trigger: "parallel", through: true, priority: "below", commands: [cmd("plugin:dungeon/Tick", {})] },
      {
        conditions: [when(VARS.event, 1, "==")],
        trigger: "autorun",
        through: true,
        priority: "below",
        commands: [
          text("目の前が 真っ暗になった……"),
          text("気がつくと、洞窟の入口に 倒れていた。\n持ち物と、洞窟で拾ったお金を 失ってしまったようだ。"),
          cmd("plugin:dungeon/Finish", { result: "dead" }),
        ],
      },
      {
        conditions: [when(VARS.event, 2, "==")],
        trigger: "autorun",
        through: true,
        priority: "below",
        commands: [
          cmd("FlashScreen", { color: { r: 255, g: 250, b: 210, a: 1 }, duration: 30, wait: true }),
          text("輝く宝玉を 手に入れた！\n\\C[6]風鳴りの洞窟を 踏破したのだ！\\C[0]"),
          text("まばゆい光に 包まれて……\n気がつくと、洞窟の入口に 戻っていた。"),
          cmd("plugin:dungeon/Finish", { result: "clear" }),
        ],
      },
    ],
  };
  return { id: "map_floor", width: FLOOR_W, height: FLOOR_H, tileset: "ts_dungeon", layers: [{ name: "ground", tiles }], events: { [controller.id]: controller } };
}

// ── 書き出し ──────────────────────────────────────────────────────────
/** JSON を 2 スペースで整形し、数値だけの配列は 1 行にまとめる（既存のフィクスチャと同じ体裁）。 */
const toJson = (value) => `${JSON.stringify(value, null, 2).replace(/\[\s+([-\d.,\s]+?)\s+\]/g, (_, body) => `[${body.split(/,\s*/).join(", ")}]`)}\n`;

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

rmSync(ROOT, { recursive: true, force: true });
const assets = writeAssets(join(ROOT, "assets"), {
  "dungeon_tiles.png": tileset(),
  "hero.png": character(HERO),
  "elder.png": character({ shirt: [120, 96, 150], hair: [235, 235, 235], skin: [236, 196, 160] }),
  "sign.png": signboard(),
  "sprites.png": sprites(),
});

const town = townMap(assets);
const { home, ...townData } = town;
mkdirSync(join(ROOT, "maps"), { recursive: true });
for (const map of [townData, floorMap()]) writeFileSync(join(ROOT, "maps", `${map.id}.json`), toJson(map));

const statsOf = (mhp, atk, def, agi = 8) => ({ mhp, mmp: 0, atk, def, mat: 0, mdf: 0, agi, luk: 0 });
const enemy = (id, name, params, exp, gold, drops = []) => ({ id, name, params, actions: [], drops, exp, gold });
const curve = (base, growth) => ({ base, growth });
const entry = (name, a) => ({ name, kind: "image", mime: "image/png", size: a.size, width: a.width, height: a.height });

/** プラグインの設定。敵・物の `sprite` は `sprites.png` の中のコマ（左上のピクセル）。 */
const dungeonParams = {
  floorMap: "map_floor",
  width: FLOOR_W,
  height: FLOOR_H,
  goalFloor: GOAL_FLOOR,
  home: { map: "map_town", x: home.x, y: home.y, dir: "down" },
  tiles: { rock: T.rock, wallFace: T.wallFace, floor: [T.floorA, T.floorB], stairs: T.stairs, treasure: T.treasure },
  sprites: { asset: assets["sprites.png"].id, size: TILE, drop: px(CELL.herb) },
  resetOnEnter: true,
  startItems: { item_herb: 2 },
  belly: { max: 100, interval: 4, hungry: 30, weak: 10, starveDamage: 1 },
  regenInterval: 6,
  monsters: { base: 3, perFloor: 0.5, spread: 2 },
  loot: { base: 5, spread: 2 },
  sight: 9,
  clearGold: 500,
  vars: VARS,
  enemies: [
    { enemy: "enemy_slime", floors: [1, 3], weight: 4, sprite: px(CELL.slime) },
    { enemy: "enemy_bat", floors: [2, 5], weight: 3, sprite: px(CELL.bat), act: "fast" },
    { enemy: "enemy_goblin", floors: [3, GOAL_FLOOR], weight: 4, sprite: px(CELL.goblin) },
    { enemy: "enemy_golem", floors: [5, GOAL_FLOOR], weight: 3, sprite: px(CELL.golem), act: "slow" },
    { enemy: "enemy_dragon", boss: true, sprite: px(CELL.dragon) },
  ],
  items: [
    { kind: "item", key: "herb", item: "item_herb", floors: [1, GOAL_FLOOR], weight: 5, sprite: px(CELL.herb) },
    { kind: "item", key: "bigherb", item: "item_bigherb", floors: [4, GOAL_FLOOR], weight: 2, sprite: px(CELL.bigHerb) },
    { kind: "food", key: "onigiri", name: "おにぎり", amount: 40, floors: [1, GOAL_FLOOR], weight: 5, sprite: px(CELL.onigiri) },
    { kind: "gold", key: "gold", min: 15, max: 60, floors: [1, GOAL_FLOOR], weight: 3, sprite: px(CELL.gold) },
    { kind: "seed", key: "seed", name: "ちからの種", atk: 1, floors: [2, GOAL_FLOOR], weight: 1, sprite: px(CELL.seed) },
  ],
};

const project = {
  formatVersion: 2,
  meta: { id: "dungeon", title: "デモ：風鳴りの洞窟（不思議のダンジョン）", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" },
  system: {
    startMap: "map_town",
    startX: 10,
    startY: 7,
    initialParty: ["actor_hero"],
    tileSize: TILE,
    screen: SCREEN,
    bgm: {},
    turnInPlace: true,
    terms: { newGame: "ニューゲーム" },
    plugins: [{ name: "dungeon", version: "1.0.0", params: dungeonParams }],
  },
  maps: { map_town: { id: "map_town", name: "洞窟の前の広場", order: 0 }, map_floor: { id: "map_floor", name: "風鳴りの洞窟（フロアのひな形）", order: 1 } },
  tilesets: { ts_dungeon: { id: "ts_dungeon", name: "ダンジョンと町", image: { asset: assets["dungeon_tiles.png"].id }, passage: PASSAGE } },
  database: {
    actors: { actor_hero: { id: "actor_hero", name: "旅人", classId: "class_hero", initialLevel: 1, walk: { asset: assets["hero.png"].id }, equips: {} } },
    // 主人公の能力は、プラグインがレベルから読む（最大 HP・攻撃力・防御力）
    classes: {
      class_hero: {
        id: "class_hero",
        name: "旅人",
        skills: [],
        params: { mhp: curve(30, 8), mmp: curve(0, 0), atk: curve(7, 2.5), def: curve(3, 1.2), mat: curve(0, 0), mdf: curve(0, 0), agi: curve(8, 0), luk: curve(0, 0) },
      },
    },
    skills: {},
    items: {
      item_herb: { id: "item_herb", name: "くすり草", kind: "consumable", price: 30, effects: [{ kind: "recoverHp", value: 30 }] },
      item_bigherb: { id: "item_bigherb", name: "大きなくすり草", kind: "consumable", price: 120, effects: [{ kind: "recoverHp", value: 100 }] },
    },
    enemies: {
      enemy_slime: enemy("enemy_slime", "スライム", statsOf(8, 5, 1), 4, 3, [{ item: "item_herb", rate: 0.12 }]),
      enemy_bat: enemy("enemy_bat", "コウモリ", statsOf(7, 6, 0, 14), 6, 4),
      enemy_goblin: enemy("enemy_goblin", "ゴブリン", statsOf(18, 10, 3), 10, 8, [{ item: "item_herb", rate: 0.2 }]),
      enemy_golem: enemy("enemy_golem", "ゴーレム", statsOf(34, 15, 8, 4), 20, 15, [{ item: "item_bigherb", rate: 0.25 }]),
      enemy_dragon: enemy("enemy_dragon", "洞窟の竜", statsOf(90, 20, 8), 80, 100),
    },
    troops: {},
    states: {},
    commonEvents: {},
  },
  assets: { entries: Object.fromEntries(Object.entries(assets).map(([name, a]) => [a.id, entry(name, a)])) },
  switches: {},
  variables: Object.fromEntries(Object.entries({ [VARS.event]: "ダンジョン：イベント", [VARS.best]: "ダンジョン：最深階", [VARS.result]: "ダンジョン：最後の結果", [VARS.clears]: "ダンジョン：クリア回数" }).map(([id, name]) => [id, { name }])),
};
writeFileSync(join(ROOT, "project.json"), toJson(project));
console.log(`\n町 ${TOWN_W}×${TOWN_H}、フロアのひな形 ${FLOOR_W}×${FLOOR_H}、最深階 ${GOAL_FLOOR}`);
