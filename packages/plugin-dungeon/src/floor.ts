import type { Config, EnemyEntry, ItemEntry } from "./config.js";
import { cellOf, FLOOR, generateFloor, inRoom } from "./generate.js";
import type { Floor, Pt } from "./generate.js";
import type { EnemyState, FloorItem } from "./model.js";
import { seeded } from "./rng.js";
import type { Rand } from "./rng.js";

/** 階ごとのシード。 */
export const floorSeed = (seed: string, floor: number): string => `${seed}:${floor}`;

const within = (range: readonly [number, number], floor: number): boolean => floor >= range[0] && floor <= range[1];

/** 重みつきの抽選。候補が無ければ `undefined`。 */
export function pickWeighted<T extends { readonly weight: number }>(pool: readonly T[], rnd: Rand): T | undefined {
  const total = pool.reduce((n, e) => n + e.weight, 0);
  if (total === 0) return undefined;
  let r = rnd.next() * total;
  for (const e of pool) {
    r -= e.weight;
    if (r < 0) return e;
  }
  return pool[pool.length - 1];
}

export interface Population {
  readonly enemies: EnemyState[];
  readonly items: FloorItem[];
}

/**
 * フロアに敵と落ちている物を置く（部屋の床の、開始位置・階段・ほかの物と重ならないマスに）。敵は開始位置の近く（歩いて 2 歩以内）には置かない。
 * 最後の階には、`boss` の敵を 1 体、宝の近くに置く。同じシード・階・設定からは、同じ配置ができる。
 * @param mhpOf 敵の最大 HP（データベースから読む）。
 */
export function populateFloor(floor: Floor, floorNo: number, seed: string, cfg: Config, mhpOf: (enemy: string) => number): Population {
  const rnd = seeded(`pop:${floorSeed(seed, floorNo)}`);
  const final = floorNo >= cfg.goalFloor;
  const taken = new Set<number>([cellOf(floor.width, floor.start), cellOf(floor.width, floor.goal)]);
  const cells: Pt[] = [];
  for (const r of floor.rooms) {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (floor.grid[y * floor.width + x] === FLOOR) cells.push({ x, y });
  }
  const free = (): Pt[] => cells.filter((p) => !taken.has(cellOf(floor.width, p)));
  const take = (p: Pt): void => void taken.add(cellOf(floor.width, p));
  const nearStart = (p: Pt): boolean => Math.abs(p.x - floor.start.x) + Math.abs(p.y - floor.start.y) <= 2;

  const enemies: EnemyState[] = [];
  let nextId = 1;
  const spawn = (entry: EnemyEntry, p: Pt): void => {
    take(p);
    const mhp = mhpOf(entry.enemy);
    enemies.push({ id: nextId++, kind: entry.enemy, x: p.x, y: p.y, fx: p.x, fy: p.y, hp: mhp, mhp, t: 0 });
  };

  if (final) {
    const boss = cfg.enemies.find((e) => e.boss);
    if (boss !== undefined) {
      const room = floor.rooms.find((r) => inRoom(r, floor.goal.x, floor.goal.y));
      const near = free().filter((p) => (room === undefined || inRoom(room, p.x, p.y)) && Math.abs(p.x - floor.goal.x) + Math.abs(p.y - floor.goal.y) >= 2);
      const spot = near.length > 0 ? rnd.pick(near) : free().length > 0 ? rnd.pick(free()) : undefined;
      if (spot !== undefined) spawn(boss, spot);
    }
  }
  const pool = cfg.enemies.filter((e) => !e.boss && within(e.floors, floorNo));
  const want = cfg.monsters.base + Math.floor(floorNo * cfg.monsters.perFloor) + rnd.int(0, cfg.monsters.spread);
  for (let i = 0; i < want && pool.length > 0; i++) {
    const spots = free().filter((p) => !nearStart(p));
    const entry = pickWeighted(pool, rnd);
    if (spots.length === 0 || entry === undefined) break;
    spawn(entry, rnd.pick(spots));
  }

  const items: FloorItem[] = [];
  const loot: ItemEntry[] = cfg.items.filter((e) => within(e.floors, floorNo));
  const lootCount = cfg.loot.base + rnd.int(0, cfg.loot.spread);
  for (let i = 0; i < lootCount && loot.length > 0; i++) {
    const spots = free();
    const entry = pickWeighted(loot, rnd);
    if (spots.length === 0 || entry === undefined) break;
    const p = rnd.pick(spots);
    take(p);
    items.push({ key: entry.key, x: p.x, y: p.y, amt: entry.kind === "gold" ? rnd.int(Math.min(entry.min, entry.max), Math.max(entry.min, entry.max)) : 0 });
  }
  return { enemies, items };
}

export interface BuiltFloor {
  readonly floor: Floor;
  readonly population: Population;
}

/** 階を作る（地形 + 敵 + 落ちている物）。シード・階・設定だけで決まる。 */
export function buildFloor(seed: string, floorNo: number, cfg: Config, mhpOf: (enemy: string) => number): BuiltFloor {
  const floor = generateFloor(floorSeed(seed, floorNo), { width: cfg.width, height: cfg.height, final: floorNo >= cfg.goalFloor });
  return { floor, population: populateFloor(floor, floorNo, seed, cfg, mhpOf) };
}
