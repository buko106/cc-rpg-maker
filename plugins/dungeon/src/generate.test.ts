import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildFloor, pickWeighted, populateFloor } from "./floor.js";
import { cellOf, distances, FLOOR, floorTiles, generateFloor, inRoom, MIN_SECTION_H, MIN_SECTION_W, ROCK, sizeOk, STAIRS, TREASURE, walkable } from "./generate.js";
import type { Floor } from "./generate.js";
import type { Config } from "./config.js";
import { TILES, testConfig } from "./config.testkit.js";
import { seeded } from "./rng.js";

const tiles = TILES;
const sizeArb = fc.record({ width: fc.integer({ min: MIN_SECTION_W * 3, max: 64 }), height: fc.integer({ min: MIN_SECTION_H * 3, max: 40 }), final: fc.boolean() });
const seedArb = fc.string({ maxLength: 12 });

const floorCells = (f: Floor): number[] => [...f.grid].flatMap((ch, i) => (walkable(ch) ? [i] : []));

describe("seeded", () => {
  it("同じシードなら同じ列、違うシードなら（たいてい）違う列", () => {
    const a = seeded("x");
    const b = seeded("x");
    expect([a.next(), a.next(), a.next()]).toEqual([b.next(), b.next(), b.next()]);
    expect(seeded("y").next()).not.toBe(seeded("x").next());
  });

  it("int は範囲の両端を含み、pick は空配列で例外", () => {
    const r = seeded("range");
    const seen = new Set(Array.from({ length: 300 }, () => r.int(2, 4)));
    expect([...seen].sort()).toEqual([2, 3, 4]);
    expect(() => r.pick([])).toThrow(RangeError);
    expect(r.chance(0)).toBe(false);
    expect(r.chance(1)).toBe(true);
  });
});

describe("generateFloor", () => {
  it("[inv-1] 同じシードと設定からは、同じフロアができる", () => {
    fc.assert(
      fc.property(seedArb, sizeArb, (seed, opts) => {
        expect(generateFloor(seed, opts)).toEqual(generateFloor(seed, opts));
      }),
      { numRuns: 60 },
    );
  });

  it("[inv-2] 床はすべてつながっていて、開始位置から階段（最後の階は宝）に着ける。外周は岩", () => {
    fc.assert(
      fc.property(seedArb, sizeArb, (seed, opts) => {
        const f = generateFloor(seed, opts);
        expect(f.grid).toHaveLength(opts.width * opts.height);
        const cells = floorCells(f);
        expect(distances(f.grid, f.width, f.height, f.start).size).toBe(cells.length);
        expect(distances(f.grid, f.width, f.height, f.start).has(cellOf(f.width, f.goal))).toBe(true);
        for (let x = 0; x < f.width; x++) expect([f.grid[x], f.grid[(f.height - 1) * f.width + x]]).toEqual([ROCK, ROCK]);
        for (let y = 0; y < f.height; y++) expect([f.grid[y * f.width], f.grid[y * f.width + f.width - 1]]).toEqual([ROCK, ROCK]);
      }),
      { numRuns: 120 },
    );
  });

  it("[inv-2] 開始位置と階段は別の部屋の別のマス。階段は 1 つ（最後の階は宝が 1 つで階段は無い）。部屋は 4 つ以上", () => {
    fc.assert(
      fc.property(seedArb, sizeArb, (seed, opts) => {
        const f = generateFloor(seed, opts);
        const room = (p: { x: number; y: number }) => f.rooms.findIndex((r) => inRoom(r, p.x, p.y));
        expect(room(f.start)).toBeGreaterThanOrEqual(0);
        expect(room(f.goal)).toBeGreaterThanOrEqual(0);
        expect(room(f.start)).not.toBe(room(f.goal));
        expect(f.rooms.length).toBeGreaterThanOrEqual(4);
        expect(f.grid[cellOf(f.width, f.start)]).toBe(FLOOR);
        expect(f.grid[cellOf(f.width, f.goal)]).toBe(opts.final ? TREASURE : STAIRS);
        const count = (ch: string): number => [...f.grid].filter((c) => c === ch).length;
        expect(count(opts.final ? TREASURE : STAIRS)).toBe(1);
        expect(count(opts.final ? STAIRS : TREASURE)).toBe(0);
      }),
      { numRuns: 120 },
    );
  });

  it("階ごと・シードごとに、違う形になる", () => {
    const shapes = new Set(Array.from({ length: 12 }, (_, i) => generateFloor(`run:${i}`, { width: 39, height: 27, final: false }).grid));
    expect(shapes.size).toBeGreaterThan(8);
  });

  it("小さすぎる大きさは例外（区画が足りない）", () => {
    expect(sizeOk(23, 18)).toBe(false);
    expect(sizeOk(24, 17)).toBe(false);
    expect(sizeOk(24, 18)).toBe(true);
    expect(() => generateFloor("s", { width: 20, height: 20, final: false })).toThrow(RangeError);
  });
});

describe("floorTiles", () => {
  it("床・階段・宝・床の下の壁だけを書く（岩は書かない）。壁の正面は、床の 1 つ上のマスだけ", () => {
    const f = generateFloor("tiles", { width: 39, height: 27, final: false });
    const t = floorTiles(f, tiles);
    for (let y = 0; y < f.height; y++) {
      for (let x = 0; x < f.width; x++) {
        const ch = f.grid[y * f.width + x];
        const v = t[`0:${x},${y}`];
        if (ch === STAIRS) expect(v).toBe(5);
        else if (ch === FLOOR) expect([3, 4]).toContain(v);
        else if (walkable(f.grid[(y + 1) * f.width + x])) expect(v).toBe(2);
        else expect(v).toBeUndefined();
      }
    }
  });
});

const cfg: Config = testConfig();
const mhpOf = (id: string): number => (id === "e_dragon" ? 80 : 10);

describe("populateFloor", () => {
  const spawnArb = fc.record({ seed: seedArb, floor: fc.integer({ min: 1, max: 5 }) });

  it("[inv-2] 物（プレイヤー・階段・敵・落ちている物）は、部屋の床の別々のマスに置く。敵は開始位置から離れている", () => {
    fc.assert(
      fc.property(spawnArb, ({ seed, floor }) => {
        const { floor: f, population } = buildFloor(seed, floor, cfg, mhpOf);
        const spots = [f.start, f.goal, ...population.enemies, ...population.items].map((p) => cellOf(f.width, p));
        expect(new Set(spots).size).toBe(spots.length);
        for (const p of [...population.enemies, ...population.items]) {
          expect(f.grid[cellOf(f.width, p)]).toBe(FLOOR);
          expect(f.rooms.some((r) => inRoom(r, p.x, p.y))).toBe(true);
        }
        for (const e of population.enemies) expect(Math.abs(e.x - f.start.x) + Math.abs(e.y - f.start.y)).toBeGreaterThan(2);
      }),
      { numRuns: 100 },
    );
  });

  it("[inv-1] 同じシード・階・設定からは、同じ配置ができる", () => {
    fc.assert(
      fc.property(spawnArb, ({ seed, floor }) => {
        expect(buildFloor(seed, floor, cfg, mhpOf)).toEqual(buildFloor(seed, floor, cfg, mhpOf));
      }),
      { numRuns: 40 },
    );
  });

  it("出る敵は階の範囲に従う。ボスは最後の階だけに 1 体（宝の部屋に）。HP はデータベースの最大 HP", () => {
    for (let n = 0; n < 30; n++) {
      for (let floor = 1; floor <= 5; floor++) {
        const { floor: f, population } = buildFloor(`range:${n}`, floor, cfg, mhpOf);
        for (const e of population.enemies) {
          expect(e.hp).toBe(mhpOf(e.kind));
          if (e.kind === "e_slime") expect(floor).toBeLessThanOrEqual(3);
          if (e.kind === "e_bat") expect(floor).toBeGreaterThanOrEqual(2);
        }
        const bosses = population.enemies.filter((e) => e.kind === "e_dragon");
        expect(bosses).toHaveLength(floor === 5 ? 1 : 0);
        if (floor === 5) expect(f.rooms.find((r) => inRoom(r, f.goal.x, f.goal.y)) && inRoom(f.rooms.find((r) => inRoom(r, f.goal.x, f.goal.y))!, bosses[0]!.x, bosses[0]!.y)).toBe(true);
        for (const i of population.items) {
          if (i.key === "gold") {
            expect(floor).toBeGreaterThanOrEqual(2);
            expect(i.amt).toBeGreaterThanOrEqual(10);
            expect(i.amt).toBeLessThanOrEqual(30);
          }
        }
      }
    }
  });

  it("敵の数は 設定の base + 階 × perFloor + 0〜spread の範囲（置ける場所があれば）", () => {
    const lo = cfg.monsters.base;
    for (let n = 0; n < 20; n++) {
      const { population } = buildFloor(`count:${n}`, 3, cfg, mhpOf);
      expect(population.enemies.length).toBeGreaterThanOrEqual(lo + Math.floor(3 * cfg.monsters.perFloor));
      expect(population.enemies.length).toBeLessThanOrEqual(lo + Math.floor(3 * cfg.monsters.perFloor) + cfg.monsters.spread);
    }
  });

  it("敵の候補が無い階は、敵を置かない（例外にならない）", () => {
    const none = { ...cfg, enemies: cfg.enemies.filter((e) => e.boss) };
    const f = generateFloor("none", { width: 39, height: 27, final: false });
    expect(populateFloor(f, 1, "none", none, mhpOf).enemies).toEqual([]);
  });
});

describe("pickWeighted", () => {
  it("重みに比例して選ぶ。候補が無ければ undefined", () => {
    const r = seeded("w");
    const pool = [{ weight: 9, v: "a" }, { weight: 1, v: "b" }];
    const n = { a: 0, b: 0 };
    for (let i = 0; i < 1000; i++) n[pickWeighted(pool, r)!.v as "a" | "b"]++;
    expect(n.a).toBeGreaterThan(800);
    expect(n.b).toBeGreaterThan(30);
    expect(pickWeighted([], r)).toBeUndefined();
  });
});
