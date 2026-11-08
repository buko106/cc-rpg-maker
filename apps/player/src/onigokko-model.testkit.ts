import type { MapData, Tileset } from "@rpg/schema";

/**
 * からくり迷宮の鬼ごっこ（fixtures/projects/v1/onigokko）の「規則のモデル」。マップのデータ（タイル・イベント・鬼の移動ルート）から部屋を読み取り、
 * エンジンと同じ規則で 1 手ずつ進める。ソルバ（BFS）で最短の手順を求め、実際のエンジンで 1 手ずつ再生して、
 * モデルとエンジンの位置が毎手そろうことをテストで確かめる（onigokko-fixture.test.ts）。`tools/make-onigokko-demo.mjs` で部屋を設計するときにも使う。
 *
 * 規則（`pace: "playerStep"` の移動ルート。docs/03-interpreter.md）：
 * - プレイヤーの 1 手＝歩く（岩を押す）か、決定ボタンで足踏み（その場で待つ）。通れなかった手は数えない。
 * - 手のたびに、鬼（`ev_oni_*`。`eventTouch`）と逃げるからくり狐（`ev_fox_*`。`touch`）が、ルートの次の 1 手を、プレイヤーより後に、イベントの定義順に行う。
 *   歩く向きは `move` の `dir` で決まる：4 方向はそのまま、`toward` はプレイヤーとの差の大きい軸の側（同じなら左右）、`away` はその逆、
 *   `chase` は通れる道をたどる最短経路の最初の 1 歩（幅優先。同じ長さなら 下・左・右・上 の順。たどり着けなければ `toward`）。
 *   どれも、通れなければその手はその場で向きだけ変える（`packages/core` の `pickDirection` / `chaseDirection` と同じ）。
 * - 鬼が歩く先にプレイヤーが居ると、つかまる。プレイヤーが鬼にぶつかっても、つかまる。
 * - プレイヤーが狐にぶつかると（手には数えない）、狐の持っていた鍵が手に入り、狐は消える。
 * - みんなが動いたあと、プレイヤーが鍵のタイルに居れば、鍵を取る。鍵を取ると、同じ色の扉が開く（その手の鬼の動きには間に合わない）。
 * - 通行をふさぐもの：壁・柱・岩・鬼・狐・閉じた扉・入口の階段。鍵と出口は、鬼も歩いて通れる（岩は載せられない）。
 * - 出口のタイルに着いたら、その部屋は抜けた。
 */
export type Dir = "up" | "down" | "left" | "right";
export type Move = Dir | "wait";
/** 鬼の 1 手の向き。`undefined` は待つ。 */
export type Act = Dir | "toward" | "away" | "chase" | undefined;

const VEC: Record<Dir, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const BIT: Record<Dir, number> = { down: 1, left: 2, right: 4, up: 8 };
const REV: Record<Dir, Dir> = { up: "down", down: "up", left: "right", right: "left" };
/** `chaseDirection` が同じ長さの経路を選ぶ順。 */
const SEARCH_ORDER: readonly Dir[] = ["down", "left", "right", "up"];
export const MOVES: readonly Move[] = ["up", "right", "down", "left", "wait"];

export interface MoverDef {
  id: string;
  x: number;
  y: number;
  dir: Dir;
  /** `catch`＝鬼（触れるとつかまる）、`flee`＝からくり狐（ぶつかると鍵が手に入る）。 */
  role: "catch" | "flee";
  /** 狐が持っている鍵（鍵の番号）。 */
  key?: number;
  acts: Act[];
}
export interface Room {
  id: string;
  w: number;
  h: number;
  /** 通行フラグ（タイル単位）。 */
  pass: (x: number, y: number, dir: Dir) => boolean;
  /** 動かない通常プライオリティのイベント（入口の階段など）。通れず、岩も載せられない。 */
  statics: Set<number>;
  exit: number;
  start: { x: number; y: number };
  movers: MoverDef[];
  rocks: { id: string; x: number; y: number }[];
  /** 鍵（`key` は番号。スイッチごとに 0, 1, …）。 */
  keys: { id: string; at: number; key: number }[];
  doors: { id: string; at: number; key: number }[];
  /** 鍵の番号 → スイッチの ID。 */
  switches: string[];
}

export interface State {
  player: number;
  rocks: number[];
  /** 鬼・狐ごとの [位置, 向き]。 */
  movers: [number, Dir][];
  /** 持っている鍵（ビット）。 */
  keys: number;
  /** 手数（鬼のルートの位置は、これで決まる。周期で割った余り）。 */
  t: number;
}

type Step = { kind: string; dir?: string; frames?: number; value?: number };

/** 鬼の移動ルートの steps を、1 手ずつの行動に直す（`routeSteps` の展開と同じ数え方：`move` は 1 手、`wait` は `frames` 手）。 */
export function actsOf(steps: readonly Step[]): Act[] {
  const acts: Act[] = [];
  for (const st of steps) {
    if (st.kind === "move") {
      if (st.dir === "random" || st.dir === undefined) throw new Error("random の動きはモデルにできない");
      acts.push(st.dir as Act);
    } else if (st.kind === "wait") for (let i = 0; i < (st.frames ?? 0); i++) acts.push(undefined);
    else if (st.kind === "speed") {
      if (st.value !== 4) throw new Error("鬼の速さは 4（プレイヤーと同じ）");
    } else throw new Error(`鬼のルートに ${st.kind} は使わない`);
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
      if (((tileset.passage[tile] ?? 15) & BIT[dir]) === 0) return false;
    }
    return true;
  };
  const room: Room = { id, w, h, pass, statics: new Set(), exit: -1, start: { x: -1, y: -1 }, movers: [], rocks: [], keys: [], doors: [], switches: [] };
  const keyOf = (sw: string): number => {
    if (!room.switches.includes(sw)) room.switches.push(sw);
    return room.switches.indexOf(sw);
  };
  const switchOf = (ev: MapData["events"][keyof MapData["events"]]): string => {
    const c = ev.pages[0]!.conditions[0];
    if (c?.kind !== "switch" || c.value) throw new Error(`${ev.id}: 鍵のスイッチが OFF の間だけのページ`);
    return c.id;
  };
  for (const ev of Object.values(map.events)) {
    const k = ev.y * w + ev.x;
    const first = ev.pages[0]!;
    if (ev.id.startsWith("ev_oni_") || ev.id.startsWith("ev_fox_")) {
      const route = first.moveRoute;
      if (route === undefined || route.pace !== "playerStep" || !route.repeat) throw new Error(`${ev.id}: ターン制の繰り返しルートが必要`);
      const fox = ev.id.startsWith("ev_fox_");
      room.movers.push({
        id: ev.id,
        x: ev.x,
        y: ev.y,
        dir: first.graphic!.direction as Dir,
        role: fox ? "flee" : "catch",
        ...(fox ? { key: keyOf(switchOf(ev)) } : {}),
        acts: actsOf(route.steps),
      });
    } else if (ev.pages.some((p) => p.pushable === true)) room.rocks.push({ id: ev.id, x: ev.x, y: ev.y });
    else if (ev.id.startsWith("ev_key_")) room.keys.push({ id: ev.id, at: k, key: keyOf(switchOf(ev)) });
    else if (ev.id.startsWith("ev_door_")) room.doors.push({ id: ev.id, at: k, key: keyOf(switchOf(ev)) });
    else if (ev.id === "ev_exit") room.exit = k;
    else if (first.priority === "same" && !first.through) room.statics.add(k);
  }
  const entry = Object.values(map.events).find((e) => e.id === "ev_stairs");
  if (entry !== undefined) room.start = { x: entry.x, y: entry.y - 1 };
  return room;
}

/** 部屋の写し（岩を取り除く・鬼を差しかえるなど、仕掛けが必須かを確かめるため）。 */
export const withRoom = (r: Room, patch: Partial<Room>): Room => ({ ...r, ...patch });

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

const step = (r: Room, from: number, dir: Dir): number => from + VEC[dir][1] * r.w + VEC[dir][0];

export function initial(r: Room): State {
  return { player: r.start.y * r.w + r.start.x, rocks: r.rocks.map((k) => k.y * r.w + k.x), movers: r.movers.map((m) => [m.y * r.w + m.x, m.dir]), keys: 0, t: 0 };
}

const lcm = (a: number, b: number): number => {
  let x = a;
  let y = b;
  while (y) [x, y] = [y, x % y];
  return (a / x) * b;
};
const period = (r: Room): number => r.movers.reduce((p, m) => lcm(p, Math.max(1, m.acts.length)), 1);

/** 狐が、まだ部屋に居るか（鍵を取られると消える）。 */
const present = (r: Room, s: State, i: number): boolean => {
  const m = r.movers[i]!;
  return m.role === "catch" || (s.keys & (1 << m.key!)) === 0;
};

/** 通行をふさぐ通常のイベントのタイル（岩・鬼・狐・閉じた扉・動かないイベント）。`skip` は鬼・狐の番号（自分は除く）。 */
function blockersOf(r: Room, s: State, skip = -1): Set<number> {
  const set = new Set<number>(r.statics);
  for (const k of s.rocks) set.add(k);
  s.movers.forEach(([k], i) => {
    if (i !== skip && present(r, s, i)) set.add(k);
  });
  for (const d of r.doors) if ((s.keys & (1 << d.key)) === 0) set.add(d.at);
  return set;
}

/** 岩を載せられないタイル（触れると何か起こるイベント：まだ取っていない鍵・出口）。 */
function interactive(r: Room, s: State, at: number): boolean {
  return at === r.exit || r.keys.some((k) => k.at === at && (s.keys & (1 << k.key)) === 0);
}

/** `from` から `to` への最短経路の最初の 1 歩（`chaseDirection` と同じ幅優先・同じ探索順）。たどり着けなければ `undefined`。 */
export function chaseDir(r: Room, from: number, to: number, blockers: ReadonlySet<number>): Dir | undefined {
  if (from === to) return undefined;
  const seen = new Set<number>([from]);
  let frontier: { at: number; first: Dir | undefined }[] = [{ at: from, first: undefined }];
  while (frontier.length > 0) {
    const next: typeof frontier = [];
    for (const { at, first } of frontier) {
      for (const dir of SEARCH_ORDER) {
        if (!canMove(r, at, dir, blockers)) continue;
        const k = step(r, at, dir);
        if (seen.has(k)) continue;
        seen.add(k);
        const head = first ?? dir;
        if (k === to) return head;
        next.push({ at: k, first: head });
      }
    }
    frontier = next;
  }
  return undefined;
}

/** 鬼・狐の 1 手の向き（`pickDirection` と同じ）。 */
function pick(r: Room, act: Exclude<Act, undefined>, at: number, facing: Dir, player: number, blockers: ReadonlySet<number>): Dir {
  if (act !== "toward" && act !== "away" && act !== "chase") return act;
  const dx = (player % r.w) - (at % r.w);
  const dy = Math.floor(player / r.w) - Math.floor(at / r.w);
  if (dx === 0 && dy === 0) return facing;
  if (act === "chase") {
    const path = chaseDir(r, at, player, blockers);
    if (path !== undefined) return path;
  }
  const toward: Dir = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
  return act === "away" ? REV[toward] : toward;
}

export interface Outcome {
  state: State;
  caught: boolean;
  /** つかまった理由：鬼が歩いてきた（`touch`）か、プレイヤーが鬼にぶつかった（`bump`）か。 */
  cause?: "touch" | "bump";
  /** 狐をつかまえた（手には数えない）。 */
  grabbed?: boolean;
  done: boolean;
}

/** プレイヤーの 1 手と、そのあとの鬼・狐の動き。打てない手は `undefined`。 */
export function play(r: Room, s: State, move: Move): Outcome | undefined {
  let player = s.player;
  let rocks = s.rocks;
  if (move !== "wait") {
    const [dx, dy] = VEC[move];
    const x = s.player % r.w;
    const y = Math.floor(s.player / r.w);
    if (!inside(r, x + dx, y + dy) || !r.pass(x, y, move) || !r.pass(x + dx, y + dy, REV[move])) return undefined;
    const target = step(r, s.player, move);
    const who = s.movers.findIndex(([k], i) => k === target && present(r, s, i));
    if (who >= 0) {
      const m = r.movers[who]!;
      // 鬼にぶつかると、つかまる。狐にぶつかると、鍵が手に入る（手には数えない。だれも動かない）
      if (m.role === "catch") return { state: s, caught: true, cause: "bump", done: false };
      return { state: { ...s, keys: s.keys | (1 << m.key!) }, caught: false, grabbed: true, done: false };
    }
    const rockAt = rocks.indexOf(target);
    if (rockAt >= 0) {
      // 押せる岩：先が通れて、触れると何か起こるイベントが無いこと
      if (!canMove(r, target, move, blockersOf(r, s))) return undefined;
      const beyond = step(r, target, move);
      if (interactive(r, s, beyond)) return undefined;
      rocks = rocks.map((k, i) => (i === rockAt ? beyond : k));
    } else if (blockersOf(r, s).has(target)) return undefined;
    player = target;
  }
  const t = s.t + 1;
  const next: State = { player, rocks, movers: s.movers.map(([k, d]) => [k, d] as [number, Dir]), keys: s.keys, t: t % period(r) };
  // 鬼・狐が、順に 1 手
  for (let i = 0; i < r.movers.length; i++) {
    const m = r.movers[i]!;
    if (m.acts.length === 0 || !present(r, next, i)) continue;
    const act = m.acts[(t - 1) % m.acts.length];
    if (act === undefined) continue;
    const blockers = blockersOf(r, next, i);
    const [here, facing] = next.movers[i]!;
    const dir = pick(r, act, here, facing, player, blockers);
    const to = step(r, here, dir);
    next.movers[i] = [here, dir];
    if (!canMove(r, here, dir, blockers)) continue;
    if (to === player) {
      // 鬼はプレイヤーに触れて、つかまえる。狐はプレイヤーの居るタイルへは入らない
      if (m.role === "catch") return { state: next, caught: true, cause: "touch", done: false };
      continue;
    }
    next.movers[i] = [to, dir];
  }
  // 歩き終えたところの鍵を取る（同じ色の扉が開く）
  for (const k of r.keys) if (k.at === player) next.keys |= 1 << k.key;
  return { state: next, caught: false, done: player === r.exit };
}

/** 向きを除いた状態の鍵（向きは、つかまるかどうかに関わらない）。 */
export const key = (s: State): string => `${s.player}|${s.rocks.join(",")}|${s.movers.map(([k]) => k).join(",")}|${s.keys}|${s.t}`;

export interface Solution {
  moves: Move[];
  states: State[];
}

/** つかまらずに出口へ行く最短の手順（BFS。狐をつかまえる手も 1 手に数える）。見つからなければ `undefined`。`limit` は調べる状態数の上限。 */
export function solve(r: Room, opts: { limit?: number; moves?: readonly Move[] } = {}): Solution | undefined {
  const first = initial(r);
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
          for (let cur: string | undefined = k; cur !== undefined; ) {
            const p = prev.get(cur);
            if (p === null || p === undefined) break;
            out.push(p.move);
            cur = p.from;
          }
          out.reverse();
          // 向きは経路で変わるので、状態の列は手順を打ち直して求める
          return { moves: out, states: replay(r, out).states };
        }
        next.push(o.state);
      }
    }
    queue = next;
  }
  return undefined;
}

/** はじめの状態（`from`）から、`cause` の理由でつかまる最短の手順（BFS。出口へ着く道は通らない）。 */
export function solveCatch(r: Room, cause: "touch" | "bump", opts: { limit?: number; from?: State } = {}): Move[] | undefined {
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

/** 手順を 1 手ずつ進めたときの状態の列（つかまる・打てない手があれば、その手でやめて `ok: false`）。`from` は始める状態。 */
export function replay(r: Room, moves: readonly Move[], from: State = initial(r)): { ok: boolean; states: State[]; outcome?: Outcome } {
  let s = from;
  const states: State[] = [];
  for (const m of moves) {
    const o = play(r, s, m);
    if (o === undefined || o.caught) return { ok: false, states, ...(o === undefined ? {} : { outcome: o }) };
    s = o.state;
    states.push(s);
  }
  return { ok: true, states };
}
