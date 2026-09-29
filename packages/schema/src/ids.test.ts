import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { idSchema, newId } from "./ids.js";
import type { IdSource, MapId } from "./ids.js";

const fixed = (now: number, random = 0): IdSource => ({ now: () => now, random: () => random });

describe("newId", () => {
  it("formats as prefix_ULID (10 time chars + 16 random chars)", () => {
    const id = newId<"MapId">("map", fixed(0, 0));
    expect(id).toBe("map_0000000000" + "0".repeat(16));
    expect(newId("map", fixed(1_700_000_000_000, 0.999999))).toMatch(/^map_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("encodes the timestamp in Crockford base32", () => {
    // 32 ms = "10"
    expect(newId("x", fixed(32, 0))).toBe("x_0000000010" + "0".repeat(16));
  });

  it("is valid according to idSchema", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 47 }), fc.double({ min: 0, max: 0.999999, noNaN: true }), (now, r) => {
        expect(idSchema<"MapId">().safeParse(newId<"MapId">("map", fixed(now, r))).success).toBe(true);
      }),
    );
  });

  it("sorts by time", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 47 }), fc.integer({ min: 1, max: 1_000_000 }), (t, dt) => {
        expect(newId("a", fixed(t)) < newId("a", fixed(t + dt))).toBe(true);
      }),
    );
  });

  it("works with the default source (Web Crypto) and produces distinct ids", () => {
    const a = newId<"MapId">("map");
    const b = newId<"MapId">("map");
    expect(a).not.toBe(b);
    const typed: MapId = a;
    expect(typed).toMatch(/^map_/);
  });

  it("rejects a prefix with unsafe characters", () => {
    expect(() => newId("bad:prefix", fixed(0))).toThrow();
    expect(() => newId("", fixed(0))).not.toThrow();
  });
});
