import { seeded } from "./rng.js";
import type { Rand } from "./rng.js";

/** フロアのマスの種類（`Floor.grid` の 1 文字）。 */
export const ROCK = "#";
export const FLOOR = ".";
export const STAIRS = ">";
export const TREASURE = "$";

export interface Pt {
  readonly x: number;
  readonly y: number;
}
export interface Room {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}
export interface Floor {
  readonly width: number;
  readonly height: number;
  /** `width * height` 文字（行ごとに左から右）。`#` 岩、`.` 床、`>` 階段、`$` 宝。 */
  readonly grid: string;
  readonly rooms: readonly Room[];
  readonly start: Pt;
  /** 降りる階段（最後の階では宝）の位置。 */
  readonly goal: Pt;
}
export interface GenOptions {
  readonly width: number;
  readonly height: number;
  /** 最後の階。階段の代わりに宝を置く。 */
  readonly final: boolean;
}

/** 区画の数（横 × 縦）。 */
const COLS = 3;
const ROWS = 3;
/** 1 区画の最小の大きさ（これより小さいと、部屋と部屋の間に壁が残らない）。 */
export const MIN_SECTION_W = 8;
export const MIN_SECTION_H = 6;
const MIN_ROOMS = 4;

export const DIRS: readonly Pt[] = [
  { x: 0, y: -1 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 1, y: 0 },
];

export const cellOf = (width: number, p: Pt): number => p.y * width + p.x;
export const inRoom = (r: Room, x: number, y: number): boolean => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
export const walkable = (ch: string | undefined): boolean => ch === FLOOR || ch === STAIRS || ch === TREASURE;

interface Section {
  readonly cx: number;
  readonly cy: number;
  room?: Room;
  /** 通路をつなぐ点（部屋の中のどこか、または部屋のない区画の中継点）。 */
  point: Pt;
}

/** 区画の大きさが足りるか。足りなければ `generateFloor` は例外を投げる。 */
export const sizeOk = (width: number, height: number): boolean => Math.floor(width / COLS) >= MIN_SECTION_W && Math.floor(height / ROWS) >= MIN_SECTION_H;

/**
 * フロアを作る。マップをおよそ 3×3 の区画に分け、区画ごとに部屋か通路の中継点を置き、隣どうしを L 字の通路でつなぐ
 * （全域木に、ループになる辺を少し足す）。そのあと階段（最後の階は宝）とプレイヤーの位置を決める。
 * 同じ `seed` と `opts` からは、いつも同じフロアができる（乱数は `seed` だけで決まる）。
 *
 * 不変条件：床はすべてつながっている。外周は岩のまま。部屋は 2 つ以上ある。開始位置と階段は別の部屋にあって、別のマス。
 */
export function generateFloor(seed: string, opts: GenOptions): Floor {
  const { width, height } = opts;
  if (!sizeOk(width, height)) throw new RangeError(`generateFloor: ${width}×${height} は小さすぎる（区画が ${MIN_SECTION_W}×${MIN_SECTION_H} 以上になる大きさにする）`);
  const rnd = seeded(`floor:${seed}`);
  const sw = Math.floor(width / COLS);
  const sh = Math.floor(height / ROWS);
  const grid: string[] = new Array<string>(width * height).fill(ROCK);

  // 区画ごとに、部屋か中継点
  const sections: Section[] = [];
  for (let cy = 0; cy < ROWS; cy++) for (let cx = 0; cx < COLS; cx++) sections.push({ cx, cy, point: { x: cx * sw + 2, y: cy * sh + 2 } });
  const wantRoom = sections.map(() => rnd.chance(0.78));
  while (wantRoom.filter(Boolean).length < MIN_ROOMS) wantRoom[rnd.int(0, sections.length - 1)] = true;
  sections.forEach((s, i) => {
    if (wantRoom[i] === true) {
      const w = rnd.int(4, sw - 3);
      const h = rnd.int(3, sh - 3);
      const room: Room = { x: rnd.int(s.cx * sw + 1, s.cx * sw + sw - 1 - w), y: rnd.int(s.cy * sh + 1, s.cy * sh + sh - 1 - h), w, h };
      s.room = room;
      s.point = { x: rnd.int(room.x, room.x + w - 1), y: rnd.int(room.y, room.y + h - 1) };
    } else {
      s.point = { x: s.cx * sw + rnd.int(2, sw - 3), y: s.cy * sh + rnd.int(2, sh - 3) };
    }
  });
  for (const s of sections) {
    if (s.room === undefined) continue;
    for (let y = s.room.y; y < s.room.y + s.room.h; y++) for (let x = s.room.x; x < s.room.x + s.room.w; x++) grid[y * width + x] = FLOOR;
  }

  // 通路：全域木（ランダムなプリム法）に、ループの辺を少し足す
  const at = (cx: number, cy: number): number => cy * COLS + cx;
  const edges: [number, number][] = [];
  for (let cy = 0; cy < ROWS; cy++) {
    for (let cx = 0; cx < COLS; cx++) {
      if (cx + 1 < COLS) edges.push([at(cx, cy), at(cx + 1, cy)]);
      if (cy + 1 < ROWS) edges.push([at(cx, cy), at(cx, cy + 1)]);
    }
  }
  const visited = new Set<number>([rnd.int(0, sections.length - 1)]);
  const chosen = new Set<number>();
  while (visited.size < sections.length) {
    const open = edges.map((e, i) => ({ e, i })).filter(({ e }) => visited.has(e[0]) !== visited.has(e[1]));
    const { e, i } = rnd.pick(open);
    chosen.add(i);
    visited.add(e[0]);
    visited.add(e[1]);
  }
  edges.forEach((_, i) => {
    if (!chosen.has(i) && rnd.chance(0.2)) chosen.add(i);
  });
  for (const i of [...chosen].sort((a, b) => a - b)) {
    const [a, b] = edges[i] as [number, number];
    carve(grid, width, (sections[a] as Section).point, (sections[b] as Section).point, rnd.chance(0.5));
  }

  // 開始位置と階段：階段は、開始位置の部屋から遠い部屋（遠い順に 2 つのうちどちらか）
  const rooms = sections.flatMap((s) => (s.room === undefined ? [] : [s.room]));
  const startRoom = rnd.pick(rooms);
  const start = pointIn(startRoom, rnd);
  const dist = distances(grid, width, height, start);
  const others = rooms.filter((r) => r !== startRoom).map((r) => ({ r, d: dist.get(cellOf(width, { x: r.x, y: r.y })) ?? 0 }));
  others.sort((a, b) => b.d - a.d);
  const goalRoom = rnd.pick(others.slice(0, 2)).r;
  const goal = pointIn(goalRoom, rnd);
  grid[cellOf(width, goal)] = opts.final ? TREASURE : STAIRS;

  return { width, height, grid: grid.join(""), rooms, start, goal };
}

const pointIn = (r: Room, rnd: Rand): Pt => ({ x: rnd.int(r.x, r.x + r.w - 1), y: rnd.int(r.y, r.y + r.h - 1) });

/** `a` から `b` へ、L 字（横 → 縦、または縦 → 横）に床を掘る。 */
function carve(grid: string[], width: number, a: Pt, b: Pt, horizontalFirst: boolean): void {
  const hline = (y: number, x0: number, x1: number): void => {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) grid[y * width + x] = FLOOR;
  };
  const vline = (x: number, y0: number, y1: number): void => {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) grid[y * width + x] = FLOOR;
  };
  if (horizontalFirst) {
    hline(a.y, a.x, b.x);
    vline(b.x, a.y, b.y);
  } else {
    vline(a.x, a.y, b.y);
    hline(b.y, a.x, b.x);
  }
}

/** `from` から歩いて着くまでの歩数（歩いて行けないマスは含まない）。 */
export function distances(grid: string | readonly string[], width: number, height: number, from: Pt, blocked?: ReadonlySet<number>): Map<number, number> {
  const dist = new Map<number, number>([[cellOf(width, from), 0]]);
  const queue: Pt[] = [from];
  for (let head = 0; head < queue.length; head++) {
    const p = queue[head] as Pt;
    const d = dist.get(cellOf(width, p)) as number;
    for (const dir of DIRS) {
      const n = { x: p.x + dir.x, y: p.y + dir.y };
      if (n.x < 0 || n.y < 0 || n.x >= width || n.y >= height) continue;
      const k = cellOf(width, n);
      if (dist.has(k) || !walkable(grid[k]) || blocked?.has(k) === true) continue;
      dist.set(k, d + 1);
      queue.push(n);
    }
  }
  return dist;
}

/** フロアの絵に使うタイル番号（タイルセットの何番目か）。 */
export interface TileSet {
  readonly rock: number;
  /** 床の下の岩（壁の正面）。 */
  readonly wallFace: number;
  /** 床の絵の候補（マスごとに決まった 1 つを使う）。 */
  readonly floor: readonly number[];
  readonly stairs: number;
  readonly treasure: number;
}

/** フロアを、タイル番号の書き換え（`mapTiles` の形：`"0:x,y"` → タイル）にする。岩（`rock`）は、ひな形のマップの初期の状態なので書かない。 */
export function floorTiles(floor: Pick<Floor, "width" | "height" | "grid">, tiles: TileSet): Record<string, number> {
  const out: Record<string, number> = {};
  const { width, height, grid } = floor;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ch = grid[y * width + x];
      let tile = tiles.rock;
      if (ch === STAIRS) tile = tiles.stairs;
      else if (ch === TREASURE) tile = tiles.treasure;
      else if (ch === FLOOR) tile = tiles.floor[(x * 7 + y * 13 + ((x * y) % 5)) % tiles.floor.length] as number;
      else if (y + 1 < height && walkable(grid[(y + 1) * width + x])) tile = tiles.wallFace;
      if (tile !== tiles.rock) out[`0:${x},${y}`] = tile;
    }
  }
  return out;
}
