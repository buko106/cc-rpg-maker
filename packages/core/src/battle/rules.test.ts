import { describe, expect, it } from "vitest";
import { createRandom } from "../random.js";
import { defaultBattleRules } from "./rules.js";
import type { Battler, BattleAction } from "./state.js";

const b = (id: string, over: Partial<Battler["params"]> = {}): Battler => ({
  id,
  name: id,
  level: 1,
  hp: 10,
  mp: 0,
  states: [],
  buffs: {},
  params: { mhp: 10, mmp: 0, atk: 10, def: 10, mat: 10, mdf: 10, agi: 10, luk: 10, ...over },
});
const skill = { id: "s", name: "s", mpCost: 0, scope: "one-enemy", formula: "", effects: [] } as never;

describe("defaultBattleRules", () => {
  it("hit rate is 95% at equal luck, rises with the attacker's luck advantage and stays within [50%, 100%]", () => {
    expect(defaultBattleRules.hitRate(b("a"), b("b"), skill)).toBeCloseTo(0.95);
    expect(defaultBattleRules.hitRate(b("a", { luk: 30 }), b("b"), skill)).toBe(1);
    expect(defaultBattleRules.hitRate(b("a", { luk: 0 }), b("b", { luk: 999 }), skill)).toBe(0.5);
  });

  it("critical rate is 4% at equal luck and clamped to [0, 50%]", () => {
    expect(defaultBattleRules.critRate(b("a"), b("b"), skill)).toBeCloseTo(0.04);
    expect(defaultBattleRules.critRate(b("a", { luk: 0 }), b("b", { luk: 999 }), skill)).toBe(0);
    expect(defaultBattleRules.critRate(b("a", { luk: 999 }), b("b"), skill)).toBe(0.5);
  });

  it("escape rate scales with the agility ratio and is clamped to [0, 1]", () => {
    expect(defaultBattleRules.escapeRate([b("a", { agi: 10 })], [b("e", { agi: 10 })])).toBeCloseTo(0.5);
    expect(defaultBattleRules.escapeRate([b("a", { agi: 30 })], [b("e", { agi: 10 })])).toBe(1);
    expect(defaultBattleRules.escapeRate([b("a", { agi: 1 })], [b("e", { agi: 100 })])).toBeCloseTo(0.005);
    expect(defaultBattleRules.escapeRate([], [])).toBe(0);
  });

  describe("sortQueue", () => {
    const table = { fast: b("fast", { agi: 100 }), slow: b("slow", { agi: 1 }), mid: b("mid", { agi: 50 }) };
    const act = (subject: string, kind: BattleAction["kind"] = "attack"): BattleAction => ({ subject, kind, targets: [] });

    it("orders by agility (with a little random spread) and is deterministic for the same random state", () => {
      const actions = [act("slow"), act("fast"), act("mid")];
      const sorted = defaultBattleRules.sortQueue(actions, table, createRandom("q"));
      expect(sorted.map((a) => a.subject)).toEqual(["fast", "mid", "slow"]);
      expect(defaultBattleRules.sortQueue(actions, table, createRandom("q"))).toEqual(sorted);
      expect(actions.map((a) => a.subject)).toEqual(["slow", "fast", "mid"]); // 入力は変更しない
    });

    it("guarding always goes first, and equal speeds keep their input order", () => {
      const equal = { a: b("a", { agi: 0 }), c: b("c", { agi: 0 }), d: b("d", { agi: 0 }) };
      expect(defaultBattleRules.sortQueue([act("c"), act("a"), act("d")], equal, createRandom("q")).map((x) => x.subject)).toEqual(["c", "a", "d"]);
      expect(defaultBattleRules.sortQueue([act("fast"), act("slow", "guard")], table, createRandom("q")).map((x) => x.subject)).toEqual(["slow", "fast"]);
    });

    it("treats an unknown subject as speed 0", () => {
      expect(defaultBattleRules.sortQueue([act("ghost"), act("fast")], table, createRandom("q")).map((x) => x.subject)).toEqual(["fast", "ghost"]);
    });
  });
});
