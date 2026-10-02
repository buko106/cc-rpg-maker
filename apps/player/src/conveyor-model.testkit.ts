import type { MapData, MapEvent, Tileset } from "@rpg/schema";

/**
 * 工場のベルトコンベア（fixtures/projects/v1/conveyor）の「規則のモデル」。マップのデータ（タイル・イベント・タイルセットの `conveyor` の表）から
 * 部屋を読み取り、エンジンと同じ規則で 1 手ずつ進める。ソルバ（BFS）で最短の手順を求め、実際のエンジンで 1 手ずつ再生して、
 * モデルとエンジンの位置が毎手そろうことをテストで確かめる（conveyor-fixture.test.ts）。`tools/make-conveyor-demo.mjs` で部屋を設計するときにも使う。
 *
 * 規則（docs/02-core-state.md「実装メモ（ベルトコンベア）」）：
 * - プレイヤーの 1 手＝方向キーで 1 歩あるいは箱を 1 つ押す（通れなかった手は数えない）か、隣のレバーを引く（決定ボタン）。
 * - 歩き出した 1 歩に合わせて、ベルトの上の箱が、1 タイルずつ（その上のベルトの向きに）いっせいに運ばれる。いま押した箱は運ばれない。
 *   同じタイルを目指したら、イベントの定義順で先のものだけが動く。行き先が壁・通れないイベント・プレイヤー・触れると何かが起こるイベントのタイル・
 *   止まっている箱なら、その場に残る（行き先の箱も運ばれて行き先をあけるなら動ける。入れかわりはしない）。
 * - 歩き終えた足元がベルトなら、プレイヤーと箱が、いっせいにもう 1 タイル運ばれる（プレイヤーが動けなければ、箱も動かない）。ベルトに着き続ける限り続く。
 * - 出荷口（`ev_dock_*`）の上に箱が載ると、箱は出荷されて（消えて）その出荷口は済み。すべて済むと出口の扉（`ev_exit` に 2 ページあるとき）が開く。
 *   出荷口はただの床（ベルトではない）で、プレイヤーも上に立てる（出荷口に運ばれても、そこから歩き出せる）。
 * - レバー（`ev_lever_*`）を引くたびに、そのレバーの `ChangeMapTile` が（0 番目のページ = 引く前の、1 番目のページ = 引いたあとの）タイルを入れ替える。時間はかからない。
 * - 出口のタイルに着いたら、その部屋は抜けた。
 */
export type Dir = "up" | "down" | "left" | "right";
/** 1 手：方向キー、または `pull<番号>`（隣のレバーを引く）。 */
export type Move = Dir | `pull${number}`;

const VEC: Record<Dir, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const BIT: Record<Dir, number> = { down: 1, left: 2, right: 4, up: 8 };
const REV: Record<Dir, Dir> = { up: "down", down: "up", left: "right", right: "left" };
const DIRS: readonly Dir[] = ["up", "right", "down", "left"];

interface LeverCell {
  layer: number;
  cell: number;
  /** レバーを引いたあと（入れ替えたあと）のタイル。引く前は、マップの定義のタイル。 */
  tile: number;
}
export interface Lever {
  id: string;
  x: number;
  y: number;
  cells: LeverCell[];
}
export interface Room {
  id: string;
  w: number;
  h: number;
  layers: number[][];
  passage: number[];
  /** タイル番号 → ベルトの向き。 */
  belts: Record<number, Dir>;
  /** ベルトの効き方：`carryPlayer` / `carryBoxes` を偽にすると、ベルトはプレイヤー / 箱を運ばない（ただの床）。`walk` を偽にすると、ベルトのタイルは壁。 */
  carryPlayer: boolean;
  carryBoxes: boolean;
  walk: boolean;
  /** 動かない通常プライオリティのイベント（レバー・階段・案内人）と、触れる・話しかけると何かが起こるイベントのタイル（箱を載せない）。 */
  statics: Set<number>;
  interactive: Set<number>;
  exit: number;
  /** 出口に扉（閉じているページ）があるか。 */
  locked: boolean;
  docks: number[];
  start: { x: number; y: number };
  boxes: { id: string; x: number; y: number }[];
  levers: Lever[];
  /** レバーを引けるか（偽にすると、レバーのある部屋でも引けない）。 */
  pull: boolean;
}

export interface State {
  player: number;
  /** 箱の位置（出荷された箱は -1）。 */
  boxes: number[];
  /** 引いたレバーのビット。 */
  mask: number;
  /** 済みの出荷口のビット。 */
  latch: number;
}

type ChangeTile = { code: string; params: { layer?: number; x: number; y: number; width?: number; height?: number; tile: number } };

/** 部屋のマップを読み取る。 */
export function roomOf(maps: Record<string, MapData>, tileset: Tileset, id: string): Room {
  const map = maps[id]!;
  const { width: w, height: h } = map;
  const room: Room = {
    id,
    w,
    h,
    layers: map.layers.map((l) => [...l.tiles]),
    passage: [...tileset.passage],
    belts: Object.fromEntries(Object.entries(tileset.conveyor ?? {}).map(([tile, dir]) => [Number(tile), dir as Dir])),
    carryPlayer: true,
    carryBoxes: true,
    walk: true,
    statics: new Set(),
    interactive: new Set(),
    exit: -1,
    locked: false,
    docks: [],
    start: { x: -1, y: -1 },
    boxes: [],
    levers: [],
    pull: true,
  };
  const ordered = Object.values(map.events) as MapEvent[];
  for (const ev of ordered) {
    const k = ev.y * w + ev.x;
    const first = ev.pages[0]!;
    if (ev.id.startsWith("ev_box")) {
      if (!ev.pages.some((p) => p.pushable === true)) throw new Error(`${ev.id}: pushable なページが必要`);
      room.boxes.push({ id: ev.id, x: ev.x, y: ev.y });
    } else if (ev.id.startsWith("ev_dock")) room.docks.push(k);
    else if (ev.id === "ev_exit") {
      room.exit = k;
      room.locked = ev.pages.length > 1;
      room.interactive.add(k);
    } else if (ev.id.startsWith("ev_lever")) {
      const index = room.levers.length;
      const cells: LeverCell[] = [];
      for (const c of first.commands as unknown as ChangeTile[]) {
        if (c.code !== "ChangeMapTile") continue;
        const { layer = 0, x, y, width = 1, height = 1, tile } = c.params;
        for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) cells.push({ layer, cell: (y + j) * w + (x + i), tile });
      }
      room.levers.push({ id: `${ev.id}#${index}`, x: ev.x, y: ev.y, cells });
      room.statics.add(k);
      room.interactive.add(k);
    } else if (ev.id === "ev_stairs") {
      room.statics.add(k);
      room.interactive.add(k);
    } else if (first.priority === "same" && !first.through && first.graphic !== undefined) {
      room.statics.add(k);
      room.interactive.add(k);
    }
  }
  const entry = ordered.find((e) => e.id === "ev_stairs");
  if (entry !== undefined) room.start = { x: entry.x, y: entry.y - 1 };
  return room;
}

/** 条件を変えた部屋（ベルトにプレイヤー / 箱を運ばせない・乗れなくする・レバーを引けなくする）。 */
export const variant = (r: Room, o: { carryPlayer?: boolean; carryBoxes?: boolean; walk?: boolean; pull?: boolean }): Room => ({ ...r, ...o });

const inside = (r: Room, x: number, y: number): boolean => x >= 0 && y >= 0 && x < r.w && y < r.h;

/** いまのタイル（レバーで入れ替えたあとを含む）。 */
function tileAt(r: Room, mask: number, layer: number, cell: number): number {
  let tile = r.layers[layer]![cell] ?? 0;
  r.levers.forEach((lv, i) => {
    if ((mask & (1 << i)) === 0) return;
    for (const c of lv.cells) if (c.layer === layer && c.cell === cell) tile = c.tile;
  });
  return tile;
}

/** そのタイルのベルトの向き（ベルトのタイルを持つ、いちばん上のレイヤの向き）。 */
export function beltOf(r: Room, mask: number, cell: number): Dir | undefined {
  for (let l = r.layers.length - 1; l >= 0; l--) {
    const tile = tileAt(r, mask, l, cell);
    if (tile !== 0 && Object.hasOwn(r.belts, tile)) return r.belts[tile];
  }
  return undefined;
}

const isBeltTile = (r: Room, mask: number, cell: number): boolean => beltOf(r, mask, cell) !== undefined;

/** タイルの通行フラグだけで、(cell) から `dir` へ進めるか（マップの外・歩けないベルトも見る）。 */
function connect(r: Room, mask: number, cell: number, dir: Dir): boolean {
  const x = cell % r.w;
  const y = Math.floor(cell / r.w);
  const [dx, dy] = VEC[dir];
  if (!inside(r, x + dx, y + dy)) return false;
  const to = (y + dy) * r.w + (x + dx);
  const open = (c: number, d: Dir): boolean => {
    for (let l = 0; l < r.layers.length; l++) {
      const tile = tileAt(r, mask, l, c);
      if (tile === 0) continue;
      if (((r.passage[tile] ?? 15) & BIT[d]) === 0) return false;
    }
    return true;
  };
  if (!open(cell, dir) || !open(to, REV[dir])) return false;
  // ベルトに乗れない版：ベルトのタイルは壁
  if (!r.walk && isBeltTile(r, mask, to)) return false;
  return true;
}

export function initial(r: Room): State {
  return { player: r.start.y * r.w + r.start.x, boxes: r.boxes.map((b) => b.y * r.w + b.x), mask: 0, latch: 0 };
}

/** 出口の扉が開いているか（扉が無い部屋は、いつでも開いている）。 */
const exitOpen = (r: Room, latch: number): boolean => !r.locked || latch === (1 << r.docks.length) - 1;

const step = (r: Room, cell: number, dir: Dir): number => {
  const [dx, dy] = VEC[dir];
  return cell + dy * r.w + dx;
};

interface Plan {
  player: Dir | undefined;
  boxes: (Dir | undefined)[];
}

/**
 * ベルトの上にあるものをいっせいに 1 タイル運ぶ計画。`carryPlayer` ならプレイヤーも、`skip` の箱は運ばない。
 * 候補（ベルトの上のもの）を、(1) 通行・触れるイベントのあるタイル・同じタイルを目指す先約で外し、(2) 行き先に居るものが動かない・入れかわる、
 * を、変わらなくなるまで外していく。
 */
function plan(r: Room, s: State, carryPlayer: boolean, skip: number): Plan {
  type Mover = { who: number; from: number; dir: Dir }; // who: -1 = プレイヤー、0.. = 箱
  const movers: Mover[] = [];
  if (carryPlayer && r.carryPlayer) {
    const d = beltOf(r, s.mask, s.player);
    if (d !== undefined) movers.push({ who: -1, from: s.player, dir: d });
  }
  if (r.carryBoxes) {
    s.boxes.forEach((k, i) => {
      if (i === skip || k < 0) return;
      const d = beltOf(r, s.mask, k);
      if (d !== undefined) movers.push({ who: i, from: k, dir: d });
    });
  }
  const claimed = new Set<number>();
  let alive = movers.filter((m) => {
    const to = step(r, m.from, m.dir);
    if (!connect(r, s.mask, m.from, m.dir)) return false;
    if (m.who >= 0 && r.interactive.has(to)) return false;
    if (claimed.has(to)) return false;
    claimed.add(to);
    return true;
  });
  const fixed = (k: number): boolean => r.statics.has(k) || (r.locked && k === r.exit && !exitOpen(r, s.latch));
  for (let changed = true; changed; ) {
    changed = false;
    alive = alive.filter((m) => {
      const to = step(r, m.from, m.dir);
      if (fixed(to)) return (changed = true), false;
      // 行き先に居る「人」（プレイヤー・箱）
      const occupants: number[] = [];
      if (s.player === to && m.who !== -1) occupants.push(-1);
      s.boxes.forEach((k, i) => {
        if (k === to && i !== m.who) occupants.push(i);
      });
      for (const o of occupants) {
        const other = alive.find((n) => n.who === o);
        if (other === undefined || step(r, other.from, other.dir) === m.from) return (changed = true), false;
      }
      return true;
    });
  }
  const out: Plan = { player: undefined, boxes: s.boxes.map(() => undefined) };
  for (const m of alive) {
    if (m.who === -1) out.player = m.dir;
    else out.boxes[m.who] = m.dir;
  }
  return out;
}

/** 出荷口に載った箱を出荷する（箱は消えて、その出荷口は済みになる）。 */
function ship(r: Room, st: State): State {
  let latch = st.latch;
  let changed = false;
  const boxes = st.boxes.map((k) => {
    const d = k < 0 ? -1 : r.docks.indexOf(k);
    if (d < 0) return k;
    latch |= 1 << d;
    changed = true;
    return -1;
  });
  return changed ? { ...st, boxes, latch } : st;
}

function applyPlan(r: Room, s: State, p: Plan): State {
  const player = p.player === undefined ? s.player : step(r, s.player, p.player);
  const boxes = s.boxes.map((k, i) => (p.boxes[i] === undefined ? k : step(r, k, p.boxes[i]!)));
  return ship(r, { player, boxes, mask: s.mask, latch: s.latch });
}

export interface Outcome {
  state: State;
  /** 出口に着いた。 */
  done: boolean;
  /** この手で、プレイヤーが運ばれた歩数（ベルトに着いてからの追加の歩数）。 */
  rides: number;
}

/** 運ばれ続けて止まらない（輪になったベルトに乗った）ときの、歩数の上限。 */
const RIDE_LIMIT = 200;

/** プレイヤーの 1 手。打てない手は `undefined`。 */
export function play(r: Room, s: State, move: Move): Outcome | undefined {
  if (move.startsWith("pull")) {
    const i = Number(move.slice(4));
    const lv = r.levers[i];
    if (!r.pull || lv === undefined) return undefined;
    const px = s.player % r.w;
    const py = Math.floor(s.player / r.w);
    if (Math.abs(px - lv.x) + Math.abs(py - lv.y) !== 1) return undefined;
    return { state: { ...s, mask: s.mask ^ (1 << i) }, done: false, rides: 0 };
  }
  const dir = move as Dir;
  if (!connect(r, s.mask, s.player, dir)) return undefined;
  const to = step(r, s.player, dir);
  const fixed = (k: number): boolean => r.statics.has(k) || (r.locked && k === r.exit && !exitOpen(r, s.latch));
  if (fixed(to)) return undefined;
  let pushed = -1;
  let boxes = s.boxes;
  const at = boxes.indexOf(to);
  if (at >= 0) {
    // 箱を押す：その先へ通れて、ほかの箱・動かないイベント・触れると何かが起こるイベントのタイルでないこと
    const beyond = step(r, to, dir);
    if (!connect(r, s.mask, to, dir) || fixed(beyond) || boxes.includes(beyond) || r.interactive.has(beyond)) return undefined;
    boxes = boxes.map((k, i) => (i === at ? beyond : k));
    pushed = at;
  }
  let cur: State = { ...s, player: to, boxes };
  cur = ship(r, cur);
  // 歩き出した 1 歩に合わせて、ベルトの上の箱が運ばれる（プレイヤーは自分で歩いたので運ばれない）
  cur = applyPlan(r, cur, plan(r, cur, false, pushed));
  let rides = 0;
  for (;;) {
    if (cur.player === r.exit) return { state: cur, done: true, rides };
    if (!isBeltTile(r, cur.mask, cur.player) || !r.carryPlayer) break;
    const p = plan(r, cur, true, -1);
    if (p.player === undefined) break;
    cur = applyPlan(r, cur, p);
    rides++;
    if (rides > RIDE_LIMIT) return undefined;
  }
  return { state: cur, done: false, rides };
}

export const key = (s: State): string => `${s.player}|${s.boxes.join(",")}|${s.mask}|${s.latch}`;

/** この部屋で打てる手。 */
export const movesOf = (r: Room): readonly Move[] => [...DIRS, ...r.levers.map((_, i) => `pull${i}` as Move)];

export interface Solution {
  moves: Move[];
  states: State[];
}

/** 出口へ行く最短の手順（BFS）。見つからなければ `undefined`。`limit` は調べる状態数の上限。 */
export function solve(r: Room, opts: { limit?: number; from?: State } = {}): Solution | undefined {
  const first = opts.from ?? initial(r);
  const prev = new Map<string, { from: string; move: Move; state: State } | null>([[key(first), null]]);
  let queue: State[] = [first];
  const limit = opts.limit ?? 3_000_000;
  const moves = movesOf(r);
  while (queue.length > 0 && prev.size < limit) {
    const next: State[] = [];
    for (const s of queue) {
      for (const move of moves) {
        const o = play(r, s, move);
        if (o === undefined) continue;
        const k = key(o.state);
        if (prev.has(k)) continue;
        prev.set(k, { from: key(s), move, state: o.state });
        if (o.done) {
          const out: Move[] = [];
          const states: State[] = [];
          for (let cur: string | undefined = k; cur !== undefined; ) {
            const p = prev.get(cur);
            if (p === null || p === undefined) break;
            out.push(p.move);
            states.push(p.state);
            cur = p.from;
          }
          return { moves: out.reverse(), states: states.reverse() };
        }
        next.push(o.state);
      }
    }
    queue = next;
  }
  return undefined;
}

/** `from` から、`goal` を満たす状態（出口に着いた状態は除く）へ行く最短の手順（BFS）。 */
export function reach(r: Room, goal: (s: State) => boolean, opts: { from?: State; limit?: number } = {}): Move[] | undefined {
  const first = opts.from ?? initial(r);
  if (goal(first)) return [];
  const prev = new Map<string, { from: string; move: Move } | null>([[key(first), null]]);
  let queue: State[] = [first];
  const limit = opts.limit ?? 3_000_000;
  const moves = movesOf(r);
  while (queue.length > 0 && prev.size < limit) {
    const next: State[] = [];
    for (const s of queue) {
      for (const move of moves) {
        const o = play(r, s, move);
        if (o === undefined || o.done) continue;
        const k = key(o.state);
        if (prev.has(k)) continue;
        prev.set(k, { from: key(s), move });
        if (goal(o.state)) {
          const out: Move[] = [];
          for (let cur: string | undefined = k; cur !== undefined; ) {
            const p = prev.get(cur);
            if (p === null || p === undefined) break;
            out.push(p.move);
            cur = p.from;
          }
          return out.reverse();
        }
        next.push(o.state);
      }
    }
    queue = next;
  }
  return undefined;
}

/** 手順を 1 手ずつ進めたときの状態の列（打てない手があれば、その手でやめて `ok: false`）。 */
export function replay(r: Room, moves: readonly Move[]): { ok: boolean; states: State[]; rides: number[] } {
  let s = initial(r);
  const states: State[] = [];
  const rides: number[] = [];
  for (const m of moves) {
    const o = play(r, s, m);
    if (o === undefined) return { ok: false, states, rides };
    s = o.state;
    states.push(s);
    rides.push(o.rides);
  }
  return { ok: true, states, rides };
}

export interface Analysis {
  /** 到達できる状態の数（出口に着いた状態は数えない）。 */
  reachable: number;
  /** 出口に着ける状態の数。 */
  solvable: number;
  /** 詰んだ状態（出口に着けない）の数。 */
  stuck: number;
  /** はじまりから、詰みへ入る最短の手順（詰みが無ければ `undefined`）。 */
  trap: Move[] | undefined;
  /** プレイヤーが入口（はじまりの場所）へ戻れない状態の数（階段でやり直せない）。 */
  cutOff: number;
  /** はじまりから、入口へ戻れない状態へ入る最短の手順（無ければ `undefined`）。 */
  cutOffPath: Move[] | undefined;
}

/**
 * 到達できる状態をすべて調べる：出口に着ける状態・詰んだ状態・入口へ戻れない状態。
 * `limit` を超えたら調べきれないので `undefined`。
 */
export function analyze(r: Room, opts: { limit?: number } = {}): Analysis | undefined {
  const limit = opts.limit ?? 1_500_000;
  const first = initial(r);
  const id = new Map<string, number>([[key(first), 0]]);
  const states: State[] = [first];
  const parent: { from: number; move: Move }[] = [{ from: -1, move: "up" }];
  const edges: number[][] = [];
  const goal: boolean[] = [false];
  const moves = movesOf(r);
  for (let i = 0; i < states.length; i++) {
    if (states.length > limit) return undefined;
    const out: number[] = [];
    for (const move of moves) {
      const o = play(r, states[i]!, move);
      if (o === undefined) continue;
      if (o.done) {
        goal[i] = true;
        continue;
      }
      const k = key(o.state);
      let j = id.get(k);
      if (j === undefined) {
        j = states.length;
        id.set(k, j);
        states.push(o.state);
        parent.push({ from: i, move });
        goal.push(false);
      }
      out.push(j);
    }
    edges[i] = out;
  }
  const back = (seed: (i: number) => boolean): boolean[] => {
    const rev: number[][] = states.map(() => []);
    edges.forEach((es, i) => es.forEach((j) => rev[j]!.push(i)));
    const ok = states.map((_, i) => seed(i));
    const stack = ok.flatMap((v, i) => (v ? [i] : []));
    while (stack.length > 0) {
      const j = stack.pop()!;
      for (const i of rev[j]!) if (!ok[i]) {
        ok[i] = true;
        stack.push(i);
      }
    }
    return ok;
  };
  const home = r.start.y * r.w + r.start.x;
  const canWin = back((i) => goal[i] === true);
  const canHome = back((i) => states[i]!.player === home);
  const stuck = canWin.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
  const pathTo = (target: number): Move[] => {
    const out: Move[] = [];
    for (let cur = target; parent[cur]!.from >= 0; cur = parent[cur]!.from) out.push(parent[cur]!.move);
    return out.reverse();
  };
  // 詰みのうち、はじまりから最短（BFS の順で最初）のもの
  const trap = stuck.length > 0 ? pathTo(stuck[0]!) : undefined;
  const cut = canHome.findIndex((v) => !v);
  return {
    reachable: states.length,
    solvable: canWin.filter(Boolean).length,
    stuck: stuck.length,
    trap,
    cutOff: canHome.filter((v) => !v).length,
    cutOffPath: cut >= 0 ? pathTo(cut) : undefined,
  };
}

