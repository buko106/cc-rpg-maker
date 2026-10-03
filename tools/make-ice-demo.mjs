#!/usr/bin/env node
/**
 * 氷の神殿のデモ（fixtures/projects/v1/ice）を丸ごと生成する開発用スクリプト。
 * 出力: project.json、maps/<MapId>.json、assets/<AssetId>.<ext>（AssetId = 内容の sha256 先頭 16 桁）。
 * 生成物はコミット済み。神殿の作りを変えたいときだけ再実行する（何度実行しても同じものができる）。
 *
 *   node tools/make-ice-demo.mjs
 *
 * 凍った神殿の奥から「炎のしずく」を持ち帰る。戦闘は無く、空間のパズルだけを解いていく。見せたいエンジンの機能：
 * 1. 滑る床（`tileset.ice`）：氷のタイルに着くと、同じ向きに止まるまで滑る。止まるのは、壁・氷の柱・岩・閉じた扉に突き当たるか、雪の床に着いたとき。
 * 2. 押せる岩（ページの `pushable`）：突き当たると 1 タイル押せる（先が通れるときだけ。引くことはできない）。氷の上でも岩は滑らない。
 *    滑る床の上では、岩が「止まる位置の目印」にもなる。階段・台座・扉のような、触れる・話しかけると動くイベントのタイルへは押せない。
 * 3. イベントの位置を式で読む（`evx("ev_rock")` / `evy(...)`）：感圧板の上に岩があるかを、並列イベントが毎フレーム調べて、スイッチを入れる。
 *    すべての板が押されると扉が開く（開いたままになる）。
 * 4. イベントの瞬間移動（`SetEventLocation`）：部屋の入口の魔法陣で、岩をもとの位置に戻せる（押しすぎて動かせなくなったときのやり直し）。
 *    部屋を出入りしても、岩はもとの位置に戻る。
 * 5. 場所移動のたびのオートセーブ（`system.autosave`）：詰んだら、メニューの「ロード」で部屋の入口からやり直せる。
 * 部屋のならべ方は、tools の外で探索して決めた（BFS で解けることを確かめている。apps/player の fixture テストが、同じ規則のモデルで解を求めて、
 * 実際のエンジンで解を再生する）：すべる回廊 7 手、岩と感圧板 16 手、二つの感圧板 19 手。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blit, canvas, character, HERO, image, lcg, shade, sheet, TILE, writeAssets } from "./pixel-art.mjs";
import { cmd, endBranch, entry, event, flash, hidden, ifExpr, otherwise, page, params, setSwitch, sw, text, toJson } from "./demo-lib.mjs";

const ROOT = join(import.meta.dirname, "..", "fixtures", "projects", "v1", "ice");

/** 画面は 15×11 タイル。部屋はどれもちょうど 1 画面（スクロールしない）。 */
const SCREEN_W = 15;
const SCREEN_H = 11;
const START = { x: 7, y: 8 };

// ── 部屋 ──────────────────────────────────────────────────────────────
/**
 * 文字の意味：`#` 壁、`.` 雪の床、`~` 氷の床（滑る）、`O` 氷の柱（通れない）、`R` / `r` 押せる岩（氷の上 / 雪の上）、
 * `P` 感圧板（雪の上）、`D` 扉、`>` 次の部屋への階段、`<` 前の部屋への階段、`G` 案内人、`T` 台座。
 * 階段 `<` の上の (7, 8) が入口（プレイヤーが着く所）。`<` は通れない（滑ってきても手前で止まり、下へ歩いて突き当たると前の部屋へ戻る）。`>` は通れて、上に着くと次の部屋へ進む。岩のある部屋は、入口に魔法陣（やり直し）がある。
 */
const ROOMS = [
  {
    id: "map_hall",
    name: "入口の間",
    pillarFloor: ".",
    plan: [
      "###############",
      "###############",
      "#.O....>....O.#",
      "#.............#",
      "#.............#",
      "#.....G.......#",
      "#.............#",
      "#.O.........O.#",
      "#.............#",
      "#......<......#",
      "###############",
    ],
  },
  {
    id: "map_slide",
    name: "すべる回廊",
    pillarFloor: "~",
    plan: [
      "###############",
      "###############",
      "#~~~O~O>~~O~~~#",
      "#O~~O~~~~~~~~~#",
      "#~~~~~~OO~~~O~#",
      "#~~.~~~~~~~.~~#",
      "#~~~~~O~~~~O~~#",
      "#~~~~~~~~~O~~~#",
      "#~O.~~~.~~~~~~#",
      "#~~~~~~<~~~~~~#",
      "###############",
    ],
  },
  {
    id: "map_rock1",
    name: "岩と感圧板",
    pillarFloor: "~",
    plan: [
      "###############",
      "###############",
      "#......>......#",
      "#######D#######",
      "#O~~~.~~~~~~~~#",
      "#~~~~~~~.~~~~~#",
      "#.~~~~O~PO~~~~#",
      "#~~~~~~R~~~~~~#",
      "#~O~~~~.~~~~~~#",
      "#~~OO~.<~~~~~~#",
      "###############",
    ],
  },
  {
    id: "map_rock2",
    name: "二つの感圧板",
    pillarFloor: "~",
    plan: [
      "###############",
      "###############",
      "#......>......#",
      "#######D#######",
      "#~~O~O~~~~~O~~#",
      "#~R~~~~~~~~~~~#",
      "#~P~~~~~~~~~~~#",
      "#~~~~~PR~~~~OO#",
      "#~~~~~~.~~~~.~#",
      "#~~~~~~<~~~~~~#",
      "###############",
    ],
  },
  {
    id: "map_orb",
    name: "炎のしずくの間",
    pillarFloor: ".",
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

const T = { snow: 1, ice: 2, wallTop: 3, wallFace: 4, pillar: 5, crystal: 6 };
const CELLS = 8;
/** 通れるのは床（雪・氷）だけ。壁・氷の柱・壁の飾りは通れない。 */
const PASSAGE = [15, 15, 15, 0, 0, 0, 0, 0];

/** 部屋の見取り図を読む：床の種類、柱、各印の位置。 */
function readRoom(room) {
  const { plan } = room;
  if (plan.length !== H || plan.some((row) => row.length !== W)) throw new Error(`${room.id}: 部屋は ${W}x${H} でなければならない`);
  const marks = { rock: [], plate: [], door: [], up: [], down: [], guide: [], pedestal: [] };
  const KIND = { R: "rock", r: "rock", P: "plate", D: "door", ">": "up", "<": "down", G: "guide", T: "pedestal" };
  const ground = [];
  const objects = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const ch = plan[y][x];
      if (KIND[ch] !== undefined) marks[KIND[ch]].push({ x, y, ch });
      let g = T.snow;
      let o = 0;
      if (ch === "#") {
        // 床の北にある壁は壁の正面（レンガ）、そうでない壁は壁の上。壁の正面には、ところどころ氷の結晶の飾りを付ける
        const below = plan[y + 1]?.[x];
        const wallLike = below === undefined || below === "#";
        g = wallLike ? T.wallTop : T.wallFace;
        if (!wallLike && y === 1 && x % 4 === 3) o = T.crystal;
      } else if (ch === "~" || ch === "R") g = T.ice;
      else if (ch === "O") {
        g = room.pillarFloor === "~" ? T.ice : T.snow;
        o = T.pillar;
      }
      ground.push(g);
      objects.push(o);
    }
  }
  if (plan[START.y][START.x] !== "." || plan[START.y + 1][START.x] !== "<") throw new Error(`${room.id}: 入口 (${START.x}, ${START.y}) は雪の床で、その下が階段でなければならない`);
  if (marks.down.length !== 1) throw new Error(`${room.id}: 戻る階段は 1 つ`);
  if (marks.up.length > 1 || (marks.up.length === 0) !== (room.id === "map_orb")) throw new Error(`${room.id}: 進む階段の数が合わない`);
  if (marks.rock.length !== marks.plate.length) throw new Error(`${room.id}: 岩と感圧板の数が合わない`);
  return { ground, objects, marks };
}

// ── タイルセット ──────────────────────────────────────────────────────
const SNOW = [206, 220, 236];
const ICE = [150, 208, 240];
const WALL = [78, 100, 150];

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

  // 雪の床：石畳に雪が積もったもの
  {
    const c = cell(T.snow, { wrap: true });
    c.rect(0, 0, TILE, TILE, SNOW);
    const rnd = lcg(21);
    for (let i = 0; i < 46; i++) c.set(rnd() * TILE, rnd() * TILE, shade(SNOW, rnd() < 0.5 ? 14 : -14));
    for (const [x, y, w, h] of [[0, 0, TILE, 1], [0, 0, 1, TILE]]) c.rect(x, y, w, h, shade(SNOW, -26));
    c.rect(1, 1, TILE - 1, 1, shade(SNOW, 16));
    c.rect(1, 1, 1, TILE - 1, shade(SNOW, 16));
  }
  // 氷の床：つるつるで、斜めに光が走る（雪の床と、色とつやで見分けがつくように）
  {
    const c = cell(T.ice, { wrap: true });
    c.rect(0, 0, TILE, TILE, ICE);
    const rnd = lcg(33);
    for (let i = 0; i < 24; i++) c.set(rnd() * TILE, rnd() * TILE, shade(ICE, rnd() < 0.5 ? 10 : -10));
    for (const [x, y, len] of [[3, 24, 14], [14, 30, 12], [-2, 12, 10], [18, 14, 10]]) {
      c.line(x, y, x + len, y - len, [226, 246, 255]);
      c.line(x + 1, y, x + len + 1, y - len, shade([226, 246, 255], -22));
    }
    c.rect(0, 0, TILE, 2, shade(ICE, -34));
    c.rect(0, 0, 2, TILE, shade(ICE, -34));
    c.rect(TILE - 2, 2, 2, TILE - 2, shade(ICE, 22));
    c.rect(2, TILE - 2, TILE - 2, 2, shade(ICE, 22));
  }
  // 壁の上
  {
    const c = cell(T.wallTop);
    c.rect(0, 0, TILE, TILE, shade(WALL, -52));
    const rnd = lcg(5);
    for (let i = 0; i < 30; i++) c.set(rnd() * TILE, rnd() * TILE, shade(WALL, -52 + (rnd() < 0.5 ? 8 : -8)));
    c.rect(0, TILE - 2, TILE, 2, shade(WALL, -66));
  }
  // 壁の正面：氷のブロックを積んだ壁
  {
    const c = cell(T.wallFace);
    c.rect(0, 0, TILE, TILE, WALL);
    for (let y = 0; y < 24; y += 8) {
      c.rect(0, y, TILE, 1, shade(WALL, -34));
      const off = (y / 8) % 2 === 0 ? 0 : 8;
      for (let x = off; x < TILE; x += 16) c.rect(x, y, 1, 8, shade(WALL, -34));
      c.rect(0, y + 1, TILE, 1, shade(WALL, 22));
    }
    c.rect(0, 24, TILE, 8, shade(WALL, -44));
    c.rect(0, 24, TILE, 2, shade(WALL, -8));
  }
  // 氷の柱：床の上に立つ、通れない結晶（背景は透明）
  {
    const c = cell(T.pillar);
    c.ellipse(16, 28, 10, 3, [20, 40, 80, 70]);
    const body = [168, 228, 252];
    for (let y = 1; y < 28; y++) {
      const half = y < 12 ? Math.round(1 + (y - 1) * 0.9) : y > 23 ? 10 - Math.round((y - 23) * 0.6) : 10;
      c.rect(16 - half, y, half * 2, 1, body);
      c.set(16 - half, y, [70, 120, 180]);
      c.set(16 + half - 1, y, [70, 120, 180]);
    }
    c.rect(7, 12, 4, 12, [214, 244, 255]);
    c.rect(21, 12, 4, 12, [112, 176, 226]);
    c.line(12, 8, 12, 22, [255, 255, 255]);
    c.line(16, 3, 16, 10, [226, 248, 255]);
  }
  // 壁の飾り：壁の正面に生えた氷の結晶（背景は透明）
  {
    const c = cell(T.crystal);
    for (const [x, h, col] of [[10, 12, [190, 238, 255]], [16, 18, [214, 246, 255]], [22, 10, [160, 220, 250]]]) {
      for (let j = 0; j < h; j++) {
        const half = Math.max(1, Math.round(3 - (j / h) * 2));
        c.rect(x - half, 24 - j, half * 2, 1, col);
      }
      c.set(x, 24 - h, [255, 255, 255]);
    }
  }
  return img;
}

// ── 絵：物（岩・板・扉・階段・魔法陣・台座）と人 ──────────────────────
const still = (draw) => {
  const one = canvas(TILE, TILE);
  draw(one);
  const out = image(TILE * 3, TILE * 4);
  for (let row = 0; row < 4; row++) for (let p = 0; p < 3; p++) blit(out, one, p * TILE, row * TILE);
  return out;
};
const GOLD = [236, 200, 96];
/** 押せる岩：氷の床や柱（水色）と見分けがつくように、暗い青灰色の石のブロックにして、凍った霜をまとわせる。 */
const rockBlock = () =>
  still((d) => {
    d.ellipse(16, 28, 12, 3, [10, 24, 56, 110]);
    const edge = [34, 44, 76];
    d.rect(4, 8, 24, 20, edge);
    for (const [x, y] of [[4, 8], [27, 8], [4, 27], [27, 27]]) d.set(x, y, [0, 0, 0, 0]);
    d.rect(5, 9, 22, 18, [98, 116, 160]);
    d.rect(5, 9, 22, 5, [158, 176, 214]);
    d.rect(5, 9, 4, 18, [126, 144, 188]);
    d.rect(23, 14, 4, 13, [70, 84, 124]);
    d.rect(5, 23, 22, 4, [70, 84, 124]);
    // 霜（白い斑点）と、石の割れ目
    for (const [x, y] of [[8, 10], [13, 11], [19, 10], [22, 12], [7, 15], [10, 20]]) d.rect(x, y, 2, 1, [226, 240, 255]);
    d.line(14, 15, 17, 19, edge);
    d.line(17, 19, 15, 23, edge);
    d.line(20, 17, 22, 21, edge);
  });
const plate = (on) =>
  still((d) => {
    const ring = on ? GOLD : [84, 120, 170];
    const fill = on ? [255, 240, 170] : [66, 92, 138];
    d.ellipse(16, 18, 13, 9, shade(ring, -50));
    d.ellipse(16, 18, 12, 8, ring);
    d.ellipse(16, 18, 9, 6, fill);
    for (const [x, y] of [[16, 14], [16, 22], [11, 18], [21, 18]]) d.set(x, y, on ? [255, 255, 255] : [150, 190, 235]);
    if (on) d.ellipse(16, 18, 5, 3, [255, 255, 235]);
  });
const door = () =>
  still((d) => {
    d.rect(1, 0, 30, 32, [44, 66, 108]);
    d.rect(3, 2, 26, 30, [112, 168, 220]);
    d.rect(3, 2, 26, 3, [200, 238, 255]);
    d.rect(3, 2, 3, 30, [168, 214, 248]);
    d.rect(16, 2, 1, 30, [60, 96, 150]);
    for (const [x, y] of [[7, 6], [24, 6], [7, 28], [24, 28]]) d.disc(x, y, 1, [226, 248, 255]);
    d.disc(16, 17, 5, GOLD);
    d.disc(16, 17, 3, shade(GOLD, -70));
    d.rect(15, 18, 2, 6, shade(GOLD, -70));
  });
/** 階段：`up` は上へのぼる（段の幅が上へ向かって狭くなる）、そうでなければ下へおりる。 */
const stairs = (up) =>
  still((d) => {
    d.rect(0, 0, 32, 32, [0, 0, 0, 0]);
    for (let i = 0; i < 5; i++) {
      const y = up ? 24 - i * 5 : 4 + i * 5;
      const inset = up ? i * 2 : 8 - i * 2;
      d.rect(3 + inset, y, 26 - inset * 2, 5, shade([176, 204, 236], up ? -i * 8 : -i * 26));
      d.rect(3 + inset, y, 26 - inset * 2, 1, [236, 248, 255]);
      d.rect(3 + inset, y + 4, 26 - inset * 2, 1, [70, 96, 140]);
    }
    d.rect(2, up ? 0 : 4, 1, 26, [70, 96, 140]);
    d.rect(29, up ? 0 : 4, 1, 26, [70, 96, 140]);
  });
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
const pedestal = (withOrb) =>
  still((d) => {
    d.ellipse(16, 28, 11, 3, [10, 30, 70, 90]);
    d.rect(7, 20, 18, 8, [96, 120, 168]);
    d.rect(7, 20, 18, 2, [182, 206, 240]);
    d.rect(9, 14, 14, 7, [128, 154, 204]);
    d.rect(9, 14, 14, 2, [200, 220, 248]);
    if (withOrb) {
      d.disc(16, 9, 7, [150, 36, 20]);
      d.disc(16, 9, 6, [238, 98, 36]);
      d.disc(16, 8, 4, [255, 176, 70]);
      d.disc(14, 6, 2, [255, 244, 190]);
    }
  });
const PROPS = { rock: 0, plateOff: 1, plateOn: 2, door: 3, stairsUp: 4, stairsDown: 5, rune: 6, orb: 7, pedestal: 8 };

// ── イベント ──────────────────────────────────────────────────────────
const FLASH_ICE = { r: 190, g: 230, b: 255, a: 0.55 };
const FLASH_WARM = { r: 255, g: 190, b: 90, a: 0.7 };

const idx = (room) => ROOMS.findIndex((r) => r.id === room.id);
const OPEN = (room) => `sw_open_${room.id}`;
const PLATE = (room, i) => `sw_plate_${room.id}_${i}`;
const rockId = (room, i) => (room.marks.rock.length === 1 ? "ev_rock" : `ev_rock_${"ab"[i]}`);

const HINTS = {
  map_slide: ["氷の床は つるつるだ。いちど 滑りだしたら、\\C[6]壁・氷の柱・雪の床\\C[0]に ぶつかるまで 止まれない。", "雪の床は 滑らない。氷の柱の 手前や、\n雪の床で 止まって、次の 向きを 考えよう。"],
  map_rock1: ["\\C[6]岩\\C[0]は 押すと 1マスだけ 動く。引くことは できない。\n氷の上でも 岩は 滑らないぞ。", "岩を \\C[6]感圧板\\C[0]に のせると、仕掛けが 動く。\n岩の むこうがわに まわりこむのが 難しい……。"],
  map_rock2: ["板は 2つ。岩も 2つ。どちらの 板にも 岩が のると 扉が 開く。", "岩を 壁ぎわに 押しつけると 動かせなくなる。\n動かせなくなったら、ここの 魔法陣で もとに もどせる。"],
};

function events(room, layout, assets) {
  const props = (name) => ({ asset: assets["props.png"].id, index: PROPS[name], direction: "down" });
  const people = assets["people.png"].id;
  const i = idx(room);
  const { marks } = layout;
  const out = [];
  const stairPos = (arr) => arr[0];
  const hasRocks = marks.rock.length > 0;

  // 入口の間：はじめに一度だけ
  if (room.id === "map_hall") {
    out.push(
      event("ev_intro", "はじまり", { x: START.x, y: START.y }, [
        page({
          trigger: "autorun",
          priority: "below",
          through: true,
          commands: [
            text("雪山の 奥の \\C[6]氷の神殿\\C[0]。村を すくう 「炎のしずく」は、\nこの 神殿の 最奥に ねむっている。"),
            text("ふぶきの せいで、もう 引き返せない。\n案内人に 話しかけてから、奥へ すすもう。"),
            cmd("ControlSelfSwitch", { key: "A", value: true }),
          ],
        }),
        page({ conditions: [{ kind: "selfSwitch", key: "A", value: true }], priority: "below", through: true, commands: [] }),
      ]),
    );
    // 案内人：氷・岩・仕掛け・やり直しの説明
    const tips = [
      ["氷の床は つるつる 滑る。歩きだすと、\\C[6]壁・氷の柱・岩\\C[0]に ぶつかるか、\n\\C[6]雪の床\\C[0]に 着くまで 止まれない。", "滑っているあいだは 操作できん。\n止まる場所を 考えてから 踏みだすんじゃ。"],
      ["\\C[6]岩\\C[0]は 押すと 1マス 動く。引くことは できんし、\n壁ぎわに 押しつけると もう 動かせん。", "氷の上でも 岩は 滑らん。\n滑る床では、岩が \\C[6]止まる目印\\C[0]にも なる。"],
      ["岩を 床の \\C[6]感圧板\\C[0]に のせると、仕掛けが 動く。\n板が ぜんぶ 押されると、扉が 開くんじゃ。", "いちど 開いた 扉は 開いたままじゃ。\n階段や 台座、扉の上には 岩は 押せんぞ。"],
      ["岩のある 部屋の 入口には \\C[6]魔法陣\\C[0]が ある。\nそこで 決定ボタンを 押せば、岩を もとの 位置に もどせる。", "メニューから 「ロード」すれば、部屋に 入ったときの\n状態から やり直せる（場所移動のたびに 自動で 保存される）。"],
    ];
    out.push(
      event("ev_guide", "案内人", marks.guide[0], [
        page({
          graphic: { asset: people, index: 1, direction: "down" },
          commands: [
            text("ようこそ、旅の人。氷の神殿は 頭を つかう 神殿じゃ。\n何を 知りたい？"),
            cmd("ShowChoices", { choices: ["滑る床", "押せる岩", "仕掛け", "やり直し", "やめる"], cancel: 4 }),
            ...tips.flatMap(([a, b], n) => [cmd("ChoiceBranch", { index: n }), text(a, 1), text(b, 1)]),
            cmd("ChoiceBranch", { index: 4 }),
            endBranch(),
            text("では、気をつけてな。奥へ すすむ階段は 上じゃ。"),
          ],
        }),
      ]),
    );
  }

  // 階段：進む（上）と戻る（下）
  if (marks.up.length > 0) {
    const next = ROOMS[i + 1];
    out.push(
      event("ev_up", "奥への階段", stairPos(marks.up), [
        page({
          graphic: props("stairsUp"),
          trigger: "touch",
          priority: "below",
          through: true,
          commands: [cmd("TransferPlayer", { mapId: next.id, x: START.x, y: START.y, dir: "up", fade: "black" })],
        }),
      ]),
    );
  }
  // 戻る階段は、通れない（滑ってきても手前で止まる）。階段の方へ歩いて突き当たると、前の部屋へ戻る
  const prev = ROOMS[i - 1];
  out.push(
    event("ev_down", "戻る階段", stairPos(marks.down), [
      page({
        graphic: props("stairsDown"),
        trigger: "touch",
        commands:
          prev === undefined
            ? [text("外は ふぶきで、とても 出られそうに ない。\n炎のしずくを 見つけるまで 帰れないのだ。")]
            : [cmd("TransferPlayer", { mapId: prev.id, x: 7, y: 3, dir: "down", fade: "black" })],
      }),
    ]),
  );

  // 岩・感圧板・扉・魔法陣
  if (hasRocks) {
    const rocks = marks.rock.map((p, n) => ({ ...p, id: rockId({ ...room, marks }, n) }));
    const plates = marks.plate;
    out.push(
      ...rocks.map((r) =>
        event(r.id, "岩", r, [
          page({
            graphic: props("rock"),
            pushable: true,
            commands: [text("氷のかたまりだ。冷たくて 重い。\n正面から 押せば 動かせそうだ。")],
          }),
        ]),
      ),
    );

    // 感圧板：岩が上にあるあいだ、板のスイッチが入る。扉が開いたら、板は光ったまま動かなくなる
    const covered = (p) => rocks.map((r) => `(evx("${r.id}") == ${p.x} && evy("${r.id}") == ${p.y})`).join(" || ");
    plates.forEach((p, n) => {
      const sp = PLATE(room, n + 1);
      out.push(
        event(`ev_plate_${n + 1}`, `感圧板${n + 1}`, p, [
          hidden({ conditions: [sw(OPEN(room), false), sw(sp, false)], graphic: props("plateOff"), commands: [ifExpr(covered(p)), setSwitch(sp, true, 1), endBranch()] }),
          hidden({ conditions: [sw(OPEN(room), false), sw(sp)], graphic: props("plateOn"), commands: [ifExpr(`!(${covered(p)})`), setSwitch(sp, false, 1), endBranch()] }),
          hidden({ conditions: [sw(OPEN(room))], graphic: props("plateOn"), commands: [] }),
        ]),
      );
    });

    // 板がぜんぶ押されたら、扉が開く（開いたままになる）
    const allPressed = plates.map((_, n) => `s("${PLATE(room, n + 1)}")`).join(" && ");
    out.push(
      event("ev_logic", "しかけ", { x: 0, y: 0 }, [
        hidden({
          conditions: [sw(OPEN(room), false)],
          commands: [
            ifExpr(allPressed),
            setSwitch(OPEN(room), true, 1),
            flash(FLASH_ICE, 18, 1),
            cmd("ShakeScreen", { power: 4, duration: 30, wait: false }, 1),
            text("\\C[6]ゴゴゴゴ……\\C[0]\nどこかで 重い 扉が 開く 音がした。", 1),
            endBranch(),
          ],
        }),
      ]),
    );

    marks.door.forEach((p) =>
      out.push(
        event("ev_door", "氷の扉", p, [
          page({
            conditions: [sw(OPEN(room), false)],
            graphic: props("door"),
            commands: [text("分厚い 氷の扉。ぴったり 閉ざされている。\n床の \\C[6]感圧板\\C[0]に 何か 重い物を のせると、開きそうだ。")],
          }),
          page({ conditions: [sw(OPEN(room))], priority: "below", through: true, commands: [] }),
        ]),
      ),
    );

    // 入口の魔法陣：岩をもとの位置にもどす／ヒント
    const home = Object.fromEntries(rocks.map((r) => [r.id, { x: r.x, y: r.y }]));
    out.push(
      event("ev_rune", "魔法陣", { x: START.x, y: START.y }, [
        page({
          graphic: props("rune"),
          priority: "below",
          through: true,
          commands: [
            text("足元の 魔法陣が かすかに 光っている。"),
            cmd("ShowChoices", { choices: ["岩を もとに もどす", "ヒントを 読む", "やめる"], cancel: 2 }),
            cmd("ChoiceBranch", { index: 0 }),
            flash(FLASH_ICE, 14, 1),
            ...rocks.map((r) => cmd("SetEventLocation", { target: r.id, x: home[r.id].x, y: home[r.id].y, dir: "retain" }, 1)),
            text(rocks.length === 1 ? "岩が もとの 位置に もどった。" : "岩が ぜんぶ もとの 位置に もどった。", 1),
            cmd("ChoiceBranch", { index: 1 }),
            ...HINTS[room.id].map((t) => text(t, 1)),
            cmd("ChoiceBranch", { index: 2 }),
            endBranch(),
          ],
        }),
      ]),
    );
  } else if (room.id === "map_slide") {
    // 滑る回廊のヒントは、入口の足元に石碑のように置く
    out.push(
      event("ev_hint", "石碑の文字", { x: START.x, y: START.y }, [
        page({
          trigger: "action",
          priority: "below",
          through: true,
          graphic: props("rune"),
          commands: [text("足元に 文字が きざまれている。"), ...HINTS.map_slide.map((t) => text(t))],
        }),
      ]),
    );
  }

  // 炎のしずくの台座：取ると、エンディング
  if (room.id === "map_orb") {
    out.push(
      event("ev_orb", "炎のしずく", marks.pedestal[0], [
        page({
          conditions: [sw("sw_orb", false)],
          graphic: props("orb"),
          commands: [
            text("台座に、燃えるように 赤い 宝珠が 浮かんでいる。\nこれが 「炎のしずく」だ！"),
            setSwitch("sw_orb", true),
            flash(FLASH_WARM, 40),
            cmd("ShakeScreen", { power: 3, duration: 30, wait: false }),
            text("宝珠を 手に取ると、神殿じゅうの 氷が\nゆっくりと とけはじめた……。"),
            text("雪山に 春が もどってくる。\\C[6]おめでとう！\\C[0]\n（滑る床と 押せる岩を つかいこなした！）"),
            cmd("ReturnToTitle", {}),
          ],
        }),
        page({ conditions: [sw("sw_orb")], graphic: props("pedestal"), commands: [text("台座は からっぽだ。")] }),
      ]),
    );
  }
  return out;
}

// ── 書き出し ──────────────────────────────────────────────────────────

const layouts = Object.fromEntries(ROOMS.map((r) => [r.id, readRoom(r)]));
rmSync(ROOT, { recursive: true, force: true });
const assets = writeAssets(join(ROOT, "assets"), {
  "ice_tileset.png": tileset(),
  "hero.png": character(HERO),
  "people.png": sheet(2, [
    character({ shirt: [54, 124, 84], hair: [34, 30, 40], skin: [240, 200, 160] }),
    character({ shirt: [200, 222, 244], hair: [236, 240, 250], skin: [236, 206, 176] }),
  ]),
  "props.png": sheet(3, [rockBlock(), plate(false), plate(true), door(), stairs(true), stairs(false), rune(), pedestal(true), pedestal(false)]),
});

mkdirSync(join(ROOT, "maps"), { recursive: true });
for (const room of ROOMS) {
  const layout = layouts[room.id];
  const evs = events(room, layout, assets);
  const map = {
    id: room.id,
    width: W,
    height: H,
    tileset: "ts_ice",
    layers: [{ name: "ground", tiles: layout.ground }, { name: "objects", tiles: layout.objects }],
    events: Object.fromEntries(evs.map((e) => [e.id, e])),
  };
  writeFileSync(join(ROOT, "maps", `${room.id}.json`), toJson(map));
}

const rockRooms = ROOMS.filter((r) => layouts[r.id].marks.rock.length > 0);
const project = {
  formatVersion: 1,
  meta: { id: "ice", title: "デモ：氷の神殿", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" },
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
  tilesets: { ts_ice: { id: "ts_ice", name: "氷の神殿", image: { asset: assets["ice_tileset.png"].id }, passage: PASSAGE, ice: [T.ice] } },
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
    ...Object.fromEntries(rockRooms.map((r) => [OPEN(r), { name: `${r.name}の扉が開いた` }])),
    ...Object.fromEntries(rockRooms.flatMap((r) => layouts[r.id].marks.plate.map((_, n) => [PLATE(r, n + 1), { name: `${r.name}の感圧板${n + 1}が押されている` }]))),
    sw_orb: { name: "炎のしずくを取った" },
  },
  variables: {},
};
writeFileSync(join(ROOT, "project.json"), toJson(project));
console.log(`\n${W}x${H} の部屋 ${ROOMS.length} つ：${ROOMS.map((r) => r.name).join(" → ")}`);
