import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createRandom, restoreRandom, xoshiro128ss } from "./random.js";

describe("xoshiro128**", () => {
  it("matches the reference implementation for state [1,2,3,4]", () => {
    // 参照実装（Blackman & Vigna）の出力
    const s: [number, number, number, number] = [1, 2, 3, 4];
    const out = Array.from({ length: 10 }, () => xoshiro128ss(s));
    expect(out).toEqual([11520, 0, 5927040, 70819200, 2031721883, 1637235492, 1287239034, 3734860849, 3729100597, 4258142804]);
  });
});

describe("Random", () => {
  it("produces a fixed sequence for a known seed (regression: changing this breaks all replays)", () => {
    const r = createRandom("rpg");
    const values = Array.from({ length: 10 }, () => r.next());
    expect(values).toMatchInlineSnapshot(`
      [
        0.6467719469219446,
        0.0036600905004888773,
        0.9529036991298199,
        0.2053963749203831,
        0.4927251872140914,
        0.7024482146371156,
        0.7596347439102829,
        0.9557477785274386,
        0.12461890443228185,
        0.6515521060209721,
      ]
    `);
  });

  it("[inv-6] serialize → restore yields the same continuation", () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 0, max: 50 }), (seed, consumed) => {
        const a = createRandom(seed);
        for (let i = 0; i < consumed; i++) a.next();
        const b = restoreRandom(JSON.parse(JSON.stringify(a.serialize())));
        expect(Array.from({ length: 20 }, () => b.next())).toEqual(Array.from({ length: 20 }, () => a.next()));
      }),
    );
  });

  it("is deterministic per seed and differs across seeds", () => {
    const seq = (seed: string) => {
      const r = createRandom(seed);
      return Array.from({ length: 5 }, () => r.next());
    };
    expect(seq("a")).toEqual(seq("a"));
    expect(seq("a")).not.toEqual(seq("b"));
  });

  it("next() is in [0,1)", () => {
    fc.assert(
      fc.property(fc.string(), (seed) => {
        const r = createRandom(seed);
        for (let i = 0; i < 100; i++) {
          const x = r.next();
          expect(x >= 0 && x < 1).toBe(true);
        }
      }),
    );
  });

  it("int() stays within [min,max] and covers the range", () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: -50, max: 50 }), fc.integer({ min: 0, max: 20 }), (seed, min, span) => {
        const r = createRandom(seed);
        for (let i = 0; i < 50; i++) {
          const x = r.int(min, min + span);
          expect(Number.isInteger(x) && x >= min && x <= min + span).toBe(true);
        }
      }),
    );
    const r = createRandom("cover");
    const seen = new Set(Array.from({ length: 200 }, () => r.int(1, 6)));
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("int() rejects invalid ranges", () => {
    const r = createRandom("x");
    expect(() => r.int(2, 1)).toThrow(RangeError);
    expect(() => r.int(0.5, 2)).toThrow(RangeError);
    expect(r.int(3, 3)).toBe(3);
  });

  it("pick() returns an element and rejects empty arrays", () => {
    const r = createRandom("p");
    for (let i = 0; i < 20; i++) expect(["a", "b", "c"]).toContain(r.pick(["a", "b", "c"]));
    expect(() => r.pick([])).toThrow(RangeError);
  });

  it("fork() is independent of the parent's consumption, deterministic per label, and does not disturb the parent", () => {
    const a = createRandom("s");
    const b = createRandom("s");
    for (let i = 0; i < 10; i++) b.next();
    expect(a.fork("battle").next()).toBe(b.fork("battle").next());
    expect(a.fork("battle").next()).not.toBe(a.fork("other").next());

    const c = createRandom("s");
    const d = createRandom("s");
    c.fork("x").next();
    expect(c.next()).toBe(d.next());
  });

  it("restoreRandom rejects corrupted states", () => {
    expect(() => restoreRandom({ seed: "x", s: [0, 0, 0, 0] })).toThrow(RangeError);
    expect(() => restoreRandom({ seed: "x", s: [1, 2, 3] as never })).toThrow(RangeError);
    expect(() => restoreRandom({ seed: "x", s: [1, 2, 3, -1] })).toThrow(RangeError);
    expect(() => restoreRandom({ seed: "x", s: [1, 2, 3, 1.5] })).toThrow(RangeError);
  });
});
