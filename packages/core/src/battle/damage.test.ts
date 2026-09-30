import type { Item, Skill } from "@rpg/schema";
import { battleKit } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { createRandom } from "../random.js";
import { ATTACK_SKILL } from "./battlers.js";
import type { Ctx } from "../ctx.js";
import { calcDamage, CRITICAL_MULTIPLIER } from "./damage.js";
import { defaultBattleRules } from "./rules.js";
import type { Battler } from "./state.js";

const kit = battleKit();
const { ctx } = kit;
const skill = (id: string) => kit.project.database.skills[id as never]!;

type Over = Omit<Partial<Battler>, "params"> & { params?: Partial<Battler["params"]> };
const battler = (over: Over = {}): Battler => ({
  id: "x",
  name: "x",
  level: 1,
  hp: 100,
  mp: 20,
  states: [],
  buffs: {},
  ...over,
  params: { mhp: 100, mmp: 20, atk: 30, def: 10, mat: 30, mdf: 10, agi: 10, luk: 10, ...over.params },
});

const withRules = (rules: Partial<typeof defaultBattleRules>): Ctx => ({ ...ctx, battleRules: { ...defaultBattleRules, ...rules } });
const always = withRules({ hitRate: () => 1, critRate: () => 0 });
const roll = (s: string, sk: Skill | Item = ATTACK_SKILL, a = battler(), b = battler({ params: { def: 4 } }), c = always) => {
  const r = calcDamage(sk, a, b, c, createRandom(s));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

describe("calcDamage", () => {
  // 式・パラメータのテーブル：ばらつき ±10% を含めた範囲で検証する
  const table: [string, string, Partial<Battler["params"]>, Partial<Battler["params"]>, number][] = [
    ["attack", "a.atk * 4 - b.def * 2", { atk: 30 }, { def: 4 }, 112],
    ["attack vs tough", "a.atk * 4 - b.def * 2", { atk: 30 }, { def: 20 }, 80],
    ["fire", "a.mat * 4 - b.mdf * 2", { mat: 30 }, { mdf: 10 }, 100],
    ["constant", "50", {}, {}, 50],
    ["uses level", "a.level * 10", {}, {}, 10],
  ];
  it.each(table)("%s: %s ≈ %d", (_name, formula, ap, bp, expected) => {
    const sk = { ...ATTACK_SKILL, formula };
    for (let i = 0; i < 20; i++) {
      const v = roll(`t${i}`, sk, battler({ params: ap }), battler({ params: bp }));
      expect(v.hit).toBe(true);
      expect(v.critical).toBe(false);
      expect(v.amount).toBeGreaterThanOrEqual(Math.round(expected * 0.9));
      expect(v.amount).toBeLessThanOrEqual(Math.round(expected * 1.1));
    }
  });

  it("is deterministic for the same random state", () => {
    expect(roll("same")).toEqual(roll("same"));
    const amounts = new Set(Array.from({ length: 30 }, (_, i) => roll(`v${i}`).amount));
    expect(amounts.size).toBeGreaterThan(3); // ばらつきがある
  });

  it("misses when the hit roll fails and consumes only that one roll", () => {
    const rng = createRandom("miss");
    const probe = createRandom("miss");
    const r = calcDamage(ATTACK_SKILL, battler(), battler(), withRules({ hitRate: () => 0 }), rng);
    expect(r).toEqual({ ok: true, value: { amount: 0, critical: false, hit: false } });
    probe.next();
    expect(rng.next()).toBe(probe.next());
  });

  it("doubles the damage on a critical hit", () => {
    const crit = withRules({ hitRate: () => 1, critRate: () => 1 });
    const v = roll("crit", ATTACK_SKILL, battler(), battler({ params: { def: 4 } }), crit);
    expect(v.critical).toBe(true);
    expect(v.amount).toBeGreaterThanOrEqual(Math.round(112 * 0.9 * CRITICAL_MULTIPLIER) - 1);
    expect(v.amount).toBeLessThanOrEqual(Math.round(112 * 1.1 * CRITICAL_MULTIPLIER) + 1);
  });

  it("never returns negative damage against enemies, but returns healing (negative) for ally scopes without a hit roll", () => {
    const weak = roll("weak", { ...ATTACK_SKILL, formula: "a.atk - 999" });
    expect(weak.amount).toBe(0);
    const heal = roll("heal", skill("sk_heal"), battler({ params: { mat: 30 } }), battler(), withRules({ hitRate: () => 0 }));
    expect(heal.hit).toBe(true);
    expect(heal.amount).toBeLessThanOrEqual(-54);
    expect(heal.amount).toBeGreaterThanOrEqual(-66);
  });

  it("treats a blank formula as no damage", () => {
    expect(roll("blank", skill("sk_poison")).amount).toBe(0);
  });

  it("evaluates items with their formula as a single ally target", () => {
    const item = { ...kit.project.database.items["potion" as never]!, formula: "0 - 40" };
    const r = calcDamage(item, battler(), battler(), ctx, createRandom("item"));
    expect(r.ok && r.value.amount).toBeLessThan(0);
  });

  it("reads game variables and switches through v() and s()", () => {
    const sk = { ...ATTACK_SKILL, formula: 's("sw") ? v("power") : 1' };
    const game = { variables: { power: 77 }, switches: { sw: true } } as never;
    const r = calcDamage(sk, battler(), battler(), always, createRandom("v"), game);
    expect(r.ok && r.value.amount).toBeGreaterThanOrEqual(69);
    expect(r.ok && r.value.amount).toBeLessThanOrEqual(85);
    const r2 = calcDamage(sk, battler(), battler(), always, createRandom("v"));
    expect(r2.ok && r2.value.amount).toBe(1);
  });

  it("uses effective parameters: buffs raise and states lower them", () => {
    const base = roll("eff", { ...ATTACK_SKILL, formula: "a.atk" }).amount;
    const buffed = roll("eff", { ...ATTACK_SKILL, formula: "a.atk" }, battler({ buffs: { atk: 2 } })).amount;
    const weak = roll("eff", { ...ATTACK_SKILL, formula: "a.atk" }, battler({ states: [{ id: "st_weak" as never, turns: 0 }] })).amount;
    expect(buffed / base).toBeCloseTo(1.5, 1);
    expect(weak / base).toBeCloseTo(0.5, 1);
  });

  it("returns an error for a formula it cannot evaluate", () => {
    for (const formula of ["a.atk +", "a.secret", "unknown()", "true"]) {
      const r = calcDamage({ ...ATTACK_SKILL, formula }, battler(), battler(), always, createRandom("e"));
      expect(r.ok, formula).toBe(false);
    }
  });
});
