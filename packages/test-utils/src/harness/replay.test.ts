import { describe, expect, it } from "vitest";
import { expandInputs, getPath, hashState, stableStringify } from "./replay.js";
import { loadFixtureProject } from "./project.js";
import { initialState } from "@rpg/core";

describe("expandInputs", () => {
  it("expands hold / press / wait into per-frame inputs", () => {
    const frames = expandInputs([{ hold: "right", frames: 3 }, { press: "ok" }, { wait: 2 }]);
    expect(frames).toHaveLength(6);
    expect([...frames[0]!.triggered]).toEqual(["right"]); // 押下開始は最初のフレームだけ
    expect([...frames[1]!.triggered]).toEqual([]);
    expect([...frames[2]!.pressed]).toEqual(["right"]);
    expect([...frames[3]!.pressed, ...frames[3]!.triggered]).toEqual(["ok", "ok"]);
    expect([...frames[4]!.pressed]).toEqual([]);
  });

  it("handles zero-length holds and waits", () => {
    expect(expandInputs([{ hold: "up", frames: 0 }, { wait: 0 }])).toEqual([]);
  });
});

describe("stableStringify / hashState", () => {
  it("does not depend on key order", () => {
    expect(stableStringify({ b: 1, a: { d: 1, c: 2 } })).toBe(stableStringify({ a: { c: 2, d: 1 }, b: 1 }));
    expect(stableStringify({ a: [{ y: 1, x: 2 }] })).toBe('{"a":[{"x":2,"y":1}]}');
  });

  it("hashes equal states equally and different states differently", () => {
    const { ctx } = loadFixtureProject("minimal");
    const s = initialState(ctx, "a");
    expect(hashState(s)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashState({ ...s })).toBe(hashState(s));
    expect(hashState(initialState(ctx, "b"))).not.toBe(hashState(s));
    expect(hashState({ ...s, tick: 1 })).not.toBe(hashState(s));
  });
});

describe("getPath", () => {
  const root = { a: { b: [10, { c: "x" }] }, n: null };
  it.each<[string, unknown]>([
    ["a.b.0", 10],
    ["a.b.1.c", "x"],
    ["n", null],
    ["a.missing", undefined],
    ["a.b.5", undefined],
    ["n.x", undefined],
    ["constructor", undefined],
    ["a.__proto__", undefined],
  ])("%s", (path, expected) => {
    expect(getPath(root, path)).toEqual(expected);
  });
});
