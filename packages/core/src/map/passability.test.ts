import fc from "fast-check";
import type { Direction, EventId, MapData, Tileset } from "@rpg/schema";
import { describe, expect, it } from "vitest";
import type { Character, EventRuntime } from "../state.js";
import { newCharacter, REVERSE } from "./character.js";
import { canPass, moveCharacter } from "./passability.js";

const DIRS: Direction[] = ["up", "down", "left", "right"];
const BIT = { down: 1, left: 2, right: 4, up: 8 } as const;

/** 3x3。中央 (1,1) から周囲への移動を調べる。tiles は各レイヤの 9 マス。 */
function map3(...layers: number[][]): MapData {
  return {
    id: "m" as never, width: 3, height: 3, tileset: "ts" as never, events: {},
    layers: layers.map((tiles, i) => ({ name: `l${i}`, tiles })),
  };
}
const tileset = (passage: number[]): Tileset => ({ id: "ts" as never, name: "ts", passage });
const OPEN = tileset([15, 15]); // タイル 1 = 全方向通行可
const ground = [1, 1, 1, 1, 1, 1, 1, 1, 1];
const at = (x: number, y: number): Character => newCharacter(x, y, "down");

const event = (o: Omit<Partial<EventRuntime>, "id"> & { id: string; x: number; y: number }): EventRuntime => ({
  ...newCharacter(o.x, o.y, "down"), pageIndex: 0, trigger: "action", priority: "same", ...o, id: o.id as EventId,
});
const events = (...evs: EventRuntime[]): Record<EventId, EventRuntime> => Object.fromEntries(evs.map((e) => [e.id, e]));

describe("canPass: tiles", () => {
  it.each(DIRS)("open ground is passable toward %s", (dir) => {
    expect(canPass(map3(ground), OPEN, {}, at(1, 1), dir)).toBe(true);
  });

  it.each(DIRS)("map edges block %s", (dir) => {
    const edge = { up: at(1, 0), down: at(1, 2), left: at(0, 1), right: at(2, 1) }[dir];
    expect(canPass(map3(ground), OPEN, {}, edge, dir)).toBe(false);
  });

  it.each(DIRS)("a fully blocked target tile blocks %s", (dir) => {
    const target = { up: 1, down: 7, left: 3, right: 5 }[dir];
    const layer = ground.map((t, i) => (i === target ? 2 : t));
    expect(canPass(map3(layer), tileset([15, 15, 0]), {}, at(1, 1), dir)).toBe(false);
  });

  it.each(DIRS)("a source tile that forbids leaving toward %s blocks it (others still pass)", (dir) => {
    const layer = ground.map((t, i) => (i === 4 ? 2 : t));
    const ts = tileset([15, 15, 15 & ~BIT[dir]]);
    for (const d of DIRS) expect(canPass(map3(layer), ts, {}, at(1, 1), d)).toBe(d !== dir);
  });

  it.each(DIRS)("a target tile that forbids entering from the opposite side blocks %s", (dir) => {
    const target = { up: 1, down: 7, left: 3, right: 5 }[dir];
    const layer = ground.map((t, i) => (i === target ? 2 : t));
    const ts = tileset([15, 15, 15 & ~BIT[REVERSE[dir]]]);
    expect(canPass(map3(layer), ts, {}, at(1, 1), dir)).toBe(false);
    // 他の辺からの進入は妨げない
    const other = DIRS.find((d) => d !== dir && d !== REVERSE[dir])!;
    const otherTarget = { up: 1, down: 7, left: 3, right: 5 }[other];
    const layer2 = ground.map((t, i) => (i === otherTarget ? 2 : t));
    expect(canPass(map3(layer2), ts, {}, at(1, 1), other)).toBe(true);
  });

  it("every layer must allow passage (an upper layer can block)", () => {
    const upper = [0, 0, 0, 0, 0, 2, 0, 0, 0]; // (2,1) に障害物
    expect(canPass(map3(ground, upper), tileset([15, 15, 0]), {}, at(1, 1), "right")).toBe(false);
    expect(canPass(map3(ground, upper), tileset([15, 15, 0]), {}, at(1, 1), "left")).toBe(true);
  });

  it("empty tiles (0) are ignored and tiles outside the passage table are passable", () => {
    expect(canPass(map3([0, 0, 0, 0, 0, 0, 0, 0, 0]), tileset([]), {}, at(1, 1), "up")).toBe(true);
    expect(canPass(map3([9, 9, 9, 9, 9, 9, 9, 9, 9]), tileset([15]), {}, at(1, 1), "up")).toBe(true);
  });
});

describe("canPass: events and through", () => {
  const m = map3(ground);
  const east = { x: 2, y: 1 };

  it("a same-priority event with an active page blocks", () => {
    expect(canPass(m, OPEN, events(event({ id: "e", ...east })), at(1, 1), "right")).toBe(false);
  });

  it.each([
    ["below priority", { priority: "below" as const }],
    ["above priority", { priority: "above" as const }],
    ["through event", { through: true }],
    ["no active page", { pageIndex: null }],
  ])("does not block: %s", (_name, override) => {
    expect(canPass(m, OPEN, events(event({ id: "e", ...east, ...override })), at(1, 1), "right")).toBe(true);
  });

  it("an event at another tile does not block", () => {
    expect(canPass(m, OPEN, events(event({ id: "e", x: 0, y: 0 })), at(1, 1), "right")).toBe(true);
  });

  it("an event does not block itself", () => {
    const self = event({ id: "e", x: 1, y: 1 });
    const blocker = event({ id: "f", x: 2, y: 1 });
    expect(canPass(m, OPEN, events(self, blocker), self, "right")).toBe(false);
    expect(canPass(m, OPEN, events(self, blocker), self, "left")).toBe(true);
  });

  it("through characters ignore tiles and events, but not the map edge", () => {
    const ghost: Character = { ...at(1, 1), through: true };
    const blockedTs = tileset([15, 0]);
    const walls = map3([1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(canPass(walls, blockedTs, events(event({ id: "e", ...east })), ghost, "right")).toBe(true);
    expect(canPass(walls, blockedTs, {}, { ...ghost, x: 2 }, "right")).toBe(false);
  });
});

describe("moveCharacter", () => {
  it("moves one tile toward the direction and starts moving (realX/realY lag behind)", () => {
    const c = moveCharacter(at(1, 1), "right", { map: map3(ground), tileset: OPEN, events: {} });
    expect(c).toMatchObject({ x: 2, y: 1, realX: 1, realY: 1, moving: true, direction: "right" });
  });

  it("only turns when blocked", () => {
    const c = moveCharacter(at(2, 1), "right", { map: map3(ground), tileset: OPEN, events: {} });
    expect(c).toMatchObject({ x: 2, y: 1, moving: false, direction: "right" });
  });

  it("[inv-5] changes coordinates if and only if canPass, and by exactly one tile", () => {
    const tilesArb = fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 9, maxLength: 9 });
    const passageArb = fc.array(fc.integer({ min: 0, max: 15 }), { minLength: 3, maxLength: 3 });
    const eventArb = fc.array(
      fc.record({
        x: fc.integer({ min: 0, max: 2 }), y: fc.integer({ min: 0, max: 2 }),
        priority: fc.constantFrom("below", "same", "above" as const), through: fc.boolean(), active: fc.boolean(),
      }),
      { maxLength: 4 },
    );
    fc.assert(
      fc.property(tilesArb, tilesArb, passageArb, eventArb, fc.integer({ min: 0, max: 2 }), fc.integer({ min: 0, max: 2 }), fc.constantFrom(...DIRS), fc.boolean(), (l0, l1, passage, evs, x, y, dir, through) => {
        const map = map3(l0, l1);
        const ts = tileset(passage);
        const runtime = events(...evs.map((e, i) => event({ id: `e${i}`, x: e.x, y: e.y, priority: e.priority, through: e.through, pageIndex: e.active ? 0 : null })));
        const ch: Character = { ...at(x, y), through };
        const moved = moveCharacter(ch, dir, { map, tileset: ts, events: runtime });
        const passable = canPass(map, ts, runtime, ch, dir);
        const distance = Math.abs(moved.x - ch.x) + Math.abs(moved.y - ch.y);
        expect(distance).toBe(passable ? 1 : 0);
        expect(moved.direction).toBe(dir);
        expect(moved.moving).toBe(passable);
      }),
      { numRuns: 500 },
    );
  });
});
