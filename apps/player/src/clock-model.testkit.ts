import type { MapData, Tileset } from "@rpg/schema";

/**
 * 時の番人の回廊（fixtures/projects/v1/clock）の「規則のモデル」。マップのデータ（タイル・イベント・番人の移動ルート）から部屋を読み取り、
 * エンジンと同じ規則で 1 手ずつ進める。ソルバ（BFS）で最短の手順を求め、実際のエンジンで 1 手ずつ再生して、
 * モデルとエンジンの位置が毎手そろうことをテストで確かめる（clock-fixture.test.ts）。`tools/make-clock-demo.mjs` で部屋を設計するときにも使う。
 *
 * 規則（`pace: "playerStep"` の移動ルート。docs/03-interpreter.md）：
 * - プレイヤーの 1 手＝歩く（岩を押す）か、決定ボタンで足踏み（その場で待つ）。通れなかった手は数えない。
 * - 手のたびに、番人がルートの次の 1 手を、プレイヤーより後に、事件の定義順に行う：歩く（通れなければその場）・待つ・向きを変えて待つ。
 *   番人が歩く先にプレイヤーが居ると、つかまる。
 * - みんなが動いたあと、番人の視界（向いている方向の直線 sight タイル。壁・岩・ほかの番人がさえぎる）にプレイヤーが居ると、つかまる。
 * - 出口のタイルに着いたら、その部屋は抜けた（出口の扉は、岩が載らない）。
 */
export type Dir = "up" | "down" | "left" | "right";
export type Move = Dir | "wait";

const VEC: Record<Dir, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const BIT: Record<Dir, number> = { down: 1, left: 2, right: 4, up: 8 };
const REV: Record<Dir, Dir> = { up: "down", down: "up", left: "right", right: "left" };
export const MOVES: readonly Move[] = ["up", "right", "down", "left", "wait"];

/** 番人の 1 手：歩く（`m`）か、待つ（`face` があれば、その向きにして）。 */
export type Act = { m: Dir } | { face?: Dir };

export interface GuardDef {
  id: string;
  x: number;
  y: number;
  dir: Dir;
  sight: number;
  acts: Act[];
}
export interface Room {
  id: string;
  w: number;
  h: number;
  /** 通行フラグ（タイル単位）。 */
  pass: (x: number, y: number, dir: Dir) => boolean;
  /** 動かない通常プライオリティのイベント（階段・案内人など）。通れず、岩も載せられない。 */
  statics: Set<number>;
  exit: number;
  start: { x: number; y: number };
  guards: GuardDef[];
  rocks: { id: string; x: number; y: number }[];
}

export interface State {
  player: number;
  rocks: number[];
  /** 番人ごとの [位置, 向き]。 */
  guards: [number, Dir][];
  /** 手数（番人のルートの位置は、これで決まる）。 */
  t: number;
}

const bitMask = (d: Dir): number => BIT[d];

/** 番人の移動ルートの steps を、1 手ずつの行動に直す（`pageRouteCommands` の展開と同じ数え方）。 */
export function actsOf(steps: readonly { kind: string; dir?: string; frames?: number; value?: number }[]): Act[] {
  const acts: Act[] = [];
  let after: "none" | "wait" | "move" = "none";
  for (const st of steps) {
    if (st.kind === "move") {
      if (st.dir !== "up" && st.dir !== "down" && st.dir !== "left" && st.dir !== "right") throw new Error(`番人の move は 4 方向だけ（${st.dir}）`);
      acts.push({ m: st.dir });
      after = "move";
    } else if (st.kind === "wait") {
      for (let i = 0; i < (st.frames ?? 0); i++) acts.push({});
      if ((st.frames ?? 0) > 0) after = "wait";
    } else if (st.kind === "turn") {
      // 待ったすぐあとの turn は、その手のうちに向きが変わる。歩いたすぐあと・ルートの頭の turn は、視界の判定とずれるので使わない
      if (after !== "wait") throw new Error("turn は wait のすぐあとにだけ置ける");
      (acts[acts.length - 1] as { face?: Dir }).face = st.dir as Dir;
    } else if (st.kind === "speed") {
      if (st.value !== 4) throw new Error("番人の速さは 4（プレイヤーと同じ）");
    }
  }
  return acts;
}

export function roomOf(maps: Record<string, MapData>, tileset: Tileset, id: string): Room {
  const map = maps[id]!;
  const { width: w, height: h } = map;
  const pass = (x: number, y: number, dir: Dir): boolean => {
    for (const layer of map.layers) {
      const tile = layer.tiles[y * w + x] ?? 0;
      if (tile === 0) continue;
      if (((tileset.passage[tile] ?? 15) & bitMask(dir)) === 0) return false;
    }
    return true;
  };
  const room: Room = { id, w, h, pass, statics: new Set(), exit: -1, start: { x: -1, y: -1 }, guards: [], rocks: [] };
  for (const ev of Object.values(map.events)) {
    const k = ev.y * w + ev.x;
    const first = ev.pages[0]!;
    if (ev.id.startsWith("ev_guard")) {
      const route = first.moveRoute;
      if (route === undefined || route.pace !== "playerStep" || !route.repeat) throw new Error(`${ev.id}: ターン制の繰り返しルートが必要`);
      room.guards.push({ id: ev.id, x: ev.x, y: ev.y, dir: first.graphic!.direction as Dir, sight: first.sightRange ?? 4, acts: actsOf(route.steps) });
    } else if (ev.pages.some((p) => p.pushable === true)) room.rocks.push({ id: ev.id, x: ev.x, y: ev.y });
    else if (ev.id === "ev_exit") room.exit = k;
    else if (ev.id === "ev_stairs") room.statics.add(k);
    else if (first.priority === "same" && !first.through && first.graphic !== undefined) room.statics.add(k);
  }
  const entry = Object.values(map.events).find((e) => e.id === "ev_stairs");
  if (entry !== undefined) room.start = { x: entry.x, y: entry.y - 1 };
  return room;
}

const inside = (r: Room, x: number, y: number): boolean => x >= 0 && y >= 0 && x < r.w && y < r.h;

/** `from` のタイルから `dir` へ進めるか（タイルの通行・ほかのイベントがふさいでいないか）。 */
function canMove(r: Room, from: number, dir: Dir, blockers: ReadonlySet<number>): boolean {
  const x = from % r.w;
  const y = Math.floor(from / r.w);
  const [dx, dy] = VEC[dir];
  const nx = x + dx;
  const ny = y + dy;
  if (!inside(r, nx, ny)) return false;
  if (!r.pass(x, y, dir) || !r.pass(nx, ny, REV[dir])) return false;
  return !blockers.has(ny * r.w + nx);
}

export function initial(r: Room): State {
  return { player: r.start.y * r.w + r.start.x, rocks: r.rocks.map((k) => k.y * r.w + k.x), guards: r.guards.map((g) => [g.y * r.w + g.x, g.dir]), t: 0 };
}

const lcm = (a: number, b: number): number => {
  let x = a;
  let y = b;
  while (y) [x, y] = [y, x % y];
  return (a / x) * b;
};
const period = (r: Room): number => r.guards.reduce((p, g) => lcm(p, Math.max(1, g.acts.length)), 1);

/** 番人が、いまの位置・向きで、プレイヤーを見ているか。 */
function sees(r: Room, g: GuardDef, s: State, i: number): boolean {
  const [pos, dir] = s.guards[i]!;
  if (pos === s.player) return true;
  const blockers = blockersOf(r, s, i);
  const [dx, dy] = VEC[dir];
  let at = pos;
  for (let n = 0; n < g.sight; n++) {
    if (!canMove(r, at, dir, blockers)) return false;
    at += dy * r.w + dx;
    if (at === s.player) return true;
  }
  return false;
}

/** 通行をふさぐ通常のイベントのタイル（岩・ほかの番人・動かないイベント）。`skip` は番人の番号（自分は除く）。 */
function blockersOf(r: Room, s: State, skip = -1): Set<number> {
  const set = new Set<number>(r.statics);
  for (const k of s.rocks) set.add(k);
  s.guards.forEach(([k], i) => {
    if (i !== skip) set.add(k);
  });
  return set;
}

export interface Outcome {
  state: State;
  caught: boolean;
  /** つかまった理由：番人の歩く先に居た（`touch`）か、視界に入っていた（`sight`）か。 */
  cause?: "touch" | "sight";
  done: boolean;
}

/** プレイヤーの 1 手と、そのあとの番人の動き。打てない手は `undefined`。 */
export function play(r: Room, s: State, move: Move): Outcome | undefined {
  let player = s.player;
  let rocks = s.rocks;
  if (move !== "wait") {
    const [dx, dy] = VEC[move];
    const x = s.player % r.w;
    const y = Math.floor(s.player / r.w);
    const target = (y + dy) * r.w + (x + dx);
    const rockAt = rocks.indexOf(target);
    // 通れる所か、先が通れる岩（その先に、触れると何か起こる・動かないイベントが無いこと）だけ
    if (!inside(r, x + dx, y + dy) || !r.pass(x, y, move) || !r.pass(x + dx, y + dy, REV[move])) return undefined;
    if (rockAt >= 0) {
      if (!canMove(r, target, move, blockersOf(r, s))) return undefined;
      const beyond = target + dy * r.w + dx;
      if (beyond === r.exit) return undefined;
      rocks = rocks.map((k, i) => (i === rockAt ? beyond : k));
    } else if (blockersOf(r, s).has(target)) return undefined;
    player = target;
  }
  const t = s.t + 1;
  const guards = s.guards.map(([k, d]) => [k, d] as [number, Dir]);
  const next: State = { player, rocks, guards, t: t % period(r) };
  // 番人が、順に 1 手
  for (let i = 0; i < r.guards.length; i++) {
    const g = r.guards[i]!;
    if (g.acts.length === 0) continue;
    const act = g.acts[(t - 1) % g.acts.length]!;
    if ("m" in act) {
      const blockers = blockersOf(r, next, i);
      const [dx, dy] = VEC[act.m];
      const here = next.guards[i]![0];
      const to = here + dy * r.w + dx;
      next.guards[i] = [here, act.m];
      if (canMove(r, here, act.m, blockers)) {
        if (to === player) return { state: next, caught: true, cause: "touch", done: false };
        next.guards[i] = [to, act.m];
      }
    } else if (act.face !== undefined) next.guards[i] = [next.guards[i]![0], act.face];
  }
  const caught = r.guards.some((g, i) => sees(r, g, next, i)) && player !== r.exit;
  return { state: next, caught, ...(caught ? { cause: "sight" as const } : {}), done: player === r.exit };
}

export const key = (s: State): string => `${s.player}|${s.rocks.join(",")}|${s.guards.map(([k, d]) => `${k}${d[0]}`).join(",")}|${s.t}`;

export interface Solution {
  moves: Move[];
  states: State[];
}

/** つかまらずに出口へ行く最短の手順（BFS）。見つからなければ `undefined`。`limit` は調べる状態数の上限。 */
export function solve(r: Room, opts: { limit?: number; moves?: readonly Move[] } = {}): Solution | undefined {
  const first = initial(r);
  first.t = 0;
  const prev = new Map<string, { from: string; move: Move; state: State } | null>([[key(first), null]]);
  let queue: State[] = [first];
  const limit = opts.limit ?? 3_000_000;
  const moves = opts.moves ?? MOVES;
  while (queue.length > 0 && prev.size < limit) {
    const next: State[] = [];
    for (const s of queue) {
      for (const move of moves) {
        const o = play(r, s, move);
        if (o === undefined || o.caught) continue;
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

/** はじめの状態から、`cause` の理由でつかまる最短の手順（BFS。つかまらずに出口へ着く道は通らない）。 */
export function solveCatch(r: Room, cause: "touch" | "sight", opts: { limit?: number; from?: State } = {}): Move[] | undefined {
  const first = opts.from ?? initial(r);
  const prev = new Map<string, { from: string; move: Move } | null>([[key(first), null]]);
  let queue: State[] = [first];
  const limit = opts.limit ?? 400_000;
  while (queue.length > 0 && prev.size < limit) {
    const next: State[] = [];
    for (const s of queue) {
      for (const move of MOVES) {
        const o = play(r, s, move);
        if (o === undefined || o.done) continue;
        if (o.caught) {
          if (o.cause !== cause) continue;
          const out: Move[] = [move];
          for (let cur: string | undefined = key(s); cur !== undefined; ) {
            const p = prev.get(cur);
            if (p === null || p === undefined) break;
            out.push(p.move);
            cur = p.from;
          }
          return out.reverse();
        }
        const k = key(o.state);
        if (prev.has(k)) continue;
        prev.set(k, { from: key(s), move });
        next.push(o.state);
      }
    }
    queue = next;
  }
  return undefined;
}

/** 手順を 1 手ずつ進めたときの状態の列（つかまる・打てない手があれば、その手でやめて `ok: false`）。 */
export function replay(r: Room, moves: readonly Move[]): { ok: boolean; states: State[] } {
  let s = initial(r);
  const states: State[] = [];
  for (const m of moves) {
    const o = play(r, s, m);
    if (o === undefined || o.caught) return { ok: false, states };
    s = o.state;
    states.push(s);
  }
  return { ok: true, states };
}

/** 出口まで行く手順の数え上げ用：最初の状態で、番人にすでに見られていないか（部屋に入った瞬間につかまらないこと）。 */
export function seenAtStart(r: Room): boolean {
  const s = initial(r);
  return r.guards.some((g, i) => sees(r, g, s, i));
}
