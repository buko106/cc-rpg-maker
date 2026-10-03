import { describe, expect, it } from "vitest";
import { RECENT_REFS_LIMIT, withRecentRef } from "./ui-state.js";

describe("withRecentRef", () => {
  it("種類ごとに、新しい順・重複なしで足し、上限を超えた古いものを落とす", () => {
    let recent: Record<string, readonly string[]> = {};
    recent = withRecentRef(recent, "switch", "sw_1");
    recent = withRecentRef(recent, "variable", "var_1");
    recent = withRecentRef(recent, "switch", "sw_2");
    recent = withRecentRef(recent, "switch", "sw_1");
    expect(recent).toEqual({ switch: ["sw_1", "sw_2"], variable: ["var_1"] });
    for (let i = 0; i < RECENT_REFS_LIMIT + 2; i++) recent = withRecentRef(recent, "switch", `s${i}`);
    expect(recent["switch"]).toHaveLength(RECENT_REFS_LIMIT);
    expect(recent["switch"]![0]).toBe(`s${RECENT_REFS_LIMIT + 1}`);
  });
});
