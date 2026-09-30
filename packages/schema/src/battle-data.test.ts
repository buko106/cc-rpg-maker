import { loadRawProject } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { parseProject, serializeProject } from "./index.js";

function raw(): Record<string, any> {
  return structuredClone(loadRawProject("minimal").project as Record<string, any>);
}

const state = { id: "st_poison", name: "毒", restriction: "none", turns: 3, paramRates: { atk: 0.5 }, hpRegen: -0.1 };
const skill = (effects: unknown[]) => ({ id: "sk", name: "s", mpCost: 0, scope: "one-enemy", formula: "1", effects });

function with_(mutate: (p: Record<string, any>) => void): ReturnType<typeof parseProject> {
  const p = raw();
  mutate(p);
  return parseProject(p);
}

describe("battle data in the schema (states, skill effects, enemy graphic)", () => {
  it("accepts states, the new skill effects and an enemy graphic, and round-trips them", () => {
    const p = raw();
    p.database.states = { st_poison: state, st_sleep: { id: "st_sleep", name: "眠り", restriction: "cannotAct", turns: 0, paramRates: {}, hpRegen: 0 } };
    p.database.skills = {
      sk: skill([
        { kind: "addState", state: "st_poison", chance: 0.5 },
        { kind: "removeState", state: "st_sleep" },
        { kind: "buff", param: "atk", level: -2 },
        { kind: "recoverHp", value: 1 },
      ]),
    };
    p.database.enemies = {
      en: { id: "en", name: "e", graphic: { asset: "0123456789abcdef" }, params: { mhp: 1, mmp: 0, atk: 1, def: 1, mat: 1, mdf: 1, agi: 1, luk: 1 }, actions: [], drops: [], exp: 0, gold: 0 },
    };
    const r = parseProject(p);
    expect(r.ok).toBe(true);
    if (r.ok) expect(serializeProject(r.value)).toEqual(p);
  });

  it("requires the states table (it is part of the database)", () => {
    expect(with_((p) => delete p.database.states).ok).toBe(false);
  });

  it.each([
    ["chance above 1", { kind: "addState", state: "st_poison", chance: 1.5 }],
    ["negative chance", { kind: "addState", state: "st_poison", chance: -0.1 }],
    ["buff level above +2", { kind: "buff", param: "atk", level: 3 }],
    ["buff level fractional", { kind: "buff", param: "atk", level: 0.5 }],
    ["buff on max HP", { kind: "buff", param: "mhp", level: 1 }],
    ["removeState without a state", { kind: "removeState" }],
    ["unknown effect kind", { kind: "explode" }],
  ])("rejects a skill effect with %s", (_name, effect) => {
    expect(with_((p) => (p.database.skills = { sk: skill([effect]) })).ok).toBe(false);
  });

  it.each([
    ["unknown restriction", { restriction: "frozen" }],
    ["negative duration", { turns: -1 }],
    ["fractional duration", { turns: 1.5 }],
    ["negative rate", { paramRates: { atk: -1 } }],
    ["unknown param in rates", { paramRates: { hp: 1 } }],
    ["hpRegen above 1", { hpRegen: 2 }],
    ["an extra key", { icon: 3 }],
  ])("rejects a state with %s", (_name, patch) => {
    expect(with_((p) => (p.database.states = { st_poison: { ...state, ...patch } })).ok).toBe(false);
  });

  it("requires a state's key to equal its id", () => {
    const r = with_((p) => (p.database.states = { st_other: state }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r.error)).toContain("database.states");
  });
});
