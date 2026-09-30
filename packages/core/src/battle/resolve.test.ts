import type { GameState } from "../index.js";
import { battleKit, beginBattle } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { isAlive } from "./battlers.js";
import { resolveAction, resolveTargets } from "./resolve.js";
import { defaultBattleRules } from "./rules.js";
import type { BattleAction, Battler, BattleState } from "./state.js";

const kit = battleKit();
const sure: Ctx = { ...kit.ctx, battleRules: { ...defaultBattleRules, hitRate: () => 1, critRate: () => 0 } };

/** 味方 2 人 + スライム 2 匹の戦闘。 */
const start = (troop = "tr_slimes"): GameState => beginBattle(kit, troop);
const patch = (s: GameState, f: (b: BattleState) => Partial<BattleState>): GameState => ({ ...s, battle: { ...s.battle!, ...f(s.battle!) } });
const setBattler = (s: GameState, id: string, over: Partial<Battler>): GameState =>
  patch(s, (b) => (id.startsWith("e:") ? { enemies: { ...b.enemies, [id]: { ...b.enemies[id]!, ...over } } } : { allies: { ...b.allies, [id]: { ...b.allies[id]!, ...over } } }));
const battler = (s: GameState, id: string): Battler => (id.startsWith("e:") ? s.battle!.enemies[id]! : s.battle!.allies[id]!);
const act = (s: GameState, a: BattleAction, ctx = sure) => resolveAction(s, a, ctx);
const skillAct = (subject: string, skillId: string, targets: string[] = []): BattleAction => ({ subject, kind: "skill", skillId: skillId as never, targets });

describe("resolveTargets", () => {
  const s = start();
  const b = s.battle!;
  it("maps each scope for a player-side subject", () => {
    expect(resolveTargets(b, "actor_hero", "none", [])).toEqual([]);
    expect(resolveTargets(b, "actor_hero", "self", [])).toEqual(["actor_hero"]);
    expect(resolveTargets(b, "actor_hero", "one-enemy", ["e:1"])).toEqual(["e:1"]);
    expect(resolveTargets(b, "actor_hero", "all-enemies", [])).toEqual(["e:0", "e:1"]);
    expect(resolveTargets(b, "actor_hero", "one-ally", ["actor_mage"])).toEqual(["actor_mage"]);
    expect(resolveTargets(b, "actor_hero", "all-allies", [])).toEqual(["actor_hero", "actor_mage"]);
    expect(resolveTargets(b, "actor_hero", "one-dead-ally", [])).toEqual([]);
  });
  it("swaps the sides for an enemy subject", () => {
    expect(resolveTargets(b, "e:0", "one-enemy", ["actor_mage"])).toEqual(["actor_mage"]);
    expect(resolveTargets(b, "e:0", "all-enemies", [])).toEqual(["actor_hero", "actor_mage"]);
    expect(resolveTargets(b, "e:0", "all-allies", [])).toEqual(["e:0", "e:1"]);
  });
  it("retargets to the first living opponent when the chosen one has fallen", () => {
    const dead = setBattler(s, "e:0", { hp: 0 });
    expect(resolveTargets(dead.battle!, "actor_hero", "one-enemy", ["e:0"])).toEqual(["e:1"]);
    expect(resolveTargets(setBattler(dead, "e:1", { hp: 0 }).battle!, "actor_hero", "one-enemy", ["e:0"])).toEqual([]);
    expect(resolveTargets(setBattler(s, "actor_mage", { hp: 0 }).battle!, "actor_hero", "one-dead-ally", [])).toEqual(["actor_mage"]);
  });
});

describe("resolveAction", () => {
  it("attack damages the chosen enemy and logs the action and the damage", () => {
    const r = act(start(), { subject: "actor_hero", kind: "attack", targets: ["e:1"] });
    expect(r.log[0]).toEqual({ kind: "action", subject: "actor_hero", action: "attack" });
    expect(r.log.some((e) => e.kind === "damage" && e.target === "e:1")).toBe(true);
    expect(battler(r.state, "e:1").hp).toBe(0); // 112 ± 10% ≥ 30
    expect(r.log.some((e) => e.kind === "defeated" && e.target === "e:1")).toBe(true);
    expect(battler(r.state, "e:0").hp).toBe(30);
  });

  it("a fallen subject does nothing but logs that it cannot act (invariant 2)", () => {
    const s = setBattler(start(), "actor_hero", { hp: 0 });
    const r = act(s, { subject: "actor_hero", kind: "attack", targets: ["e:0"] });
    expect(r.log).toEqual([{ kind: "cannotAct", subject: "actor_hero", reason: "dead" }]);
    expect(r.state).toBe(s);
  });

  it("a subject under a restricting state cannot act", () => {
    const s = setBattler(start(), "e:0", { states: [{ id: "st_sleep" as never, turns: 2 }] });
    const r = act(s, { subject: "e:0", kind: "attack", targets: ["actor_hero"] });
    expect(r.log).toEqual([{ kind: "cannotAct", subject: "e:0", reason: "state" }]);
    expect(battler(r.state, "actor_hero").hp).toBe(100);
  });

  it("skills spend MP; too little MP means nothing happens", () => {
    const s = start();
    const r = act(s, skillAct("actor_mage", "sk_fire", ["e:0"]));
    expect(battler(r.state, "actor_mage").mp).toBe(17);
    expect(battler(r.state, "e:0").hp).toBe(0);
    const poor = setBattler(s, "actor_mage", { mp: 2 });
    const r2 = act(poor, skillAct("actor_mage", "sk_fire", ["e:0"]));
    expect(r2.log).toEqual([{ kind: "cannotAct", subject: "actor_mage", reason: "mp" }]);
    expect(r2.state).toBe(poor);
    expect(act(s, skillAct("actor_mage", "sk_nope", ["e:0"])).log).toEqual([{ kind: "cannotAct", subject: "actor_mage", reason: "skill" }]);
  });

  it("area skills hit every living enemy and skip the fallen", () => {
    const s = setBattler(start("tr_slimes"), "e:0", { hp: 0 });
    const strong = setBattler(setBattler(s, "e:1", { hp: 999, params: { ...s.battle!.enemies["e:1"]!.params, mhp: 999 } }), "actor_mage", { mp: 20 });
    const r = act(strong, skillAct("actor_mage", "sk_meteor"));
    expect(r.log.filter((e) => e.kind === "damage").map((e) => (e as { target: string }).target)).toEqual(["e:1"]);
  });

  it("healing skills restore HP up to the maximum and never above it", () => {
    let s = setBattler(start(), "actor_hero", { hp: 10 });
    const r = act(s, skillAct("actor_mage", "sk_heal", ["actor_hero"]));
    expect(battler(r.state, "actor_hero").hp).toBeGreaterThan(60);
    expect(battler(r.state, "actor_hero").hp).toBeLessThanOrEqual(100);
    expect(r.log.some((e) => e.kind === "heal" && e.stat === "hp" && e.target === "actor_hero")).toBe(true);
    s = setBattler(s, "actor_hero", { hp: 99 });
    expect(battler(act(s, skillAct("actor_mage", "sk_heal", ["actor_hero"])).state, "actor_hero").hp).toBe(100);
  });

  it("items are consumed from the party stock and apply their effects", () => {
    const s = setBattler(start(), "actor_hero", { hp: 20 });
    const r = act(s, { subject: "actor_hero", kind: "item", itemId: "potion" as never, targets: ["actor_hero"] });
    expect(battler(r.state, "actor_hero").hp).toBe(70);
    expect(r.state.party.items).toEqual({ potion: 1 });
    const last = act({ ...r.state, party: { ...r.state.party, items: { potion: 1 } as never } }, { subject: "actor_hero", kind: "item", itemId: "potion" as never, targets: ["actor_hero"] });
    expect(last.state.party.items).toEqual({});
    expect(act(last.state, { subject: "actor_hero", kind: "item", itemId: "potion" as never, targets: ["actor_hero"] }).log).toEqual([
      { kind: "cannotAct", subject: "actor_hero", reason: "item" },
    ]);
  });

  it("adds a state (refreshing rather than duplicating), removes it, and respects a 0% chance", () => {
    const s = start("tr_spider");
    const poisoned = act(s, skillAct("e:0", "sk_poison", ["actor_hero"])).state;
    expect(battler(poisoned, "actor_hero").states).toEqual([{ id: "st_poison", turns: 3 }]);
    const aged = setBattler(poisoned, "actor_hero", { states: [{ id: "st_poison" as never, turns: 1 }] });
    const again = act(aged, skillAct("e:0", "sk_poison", ["actor_hero"]));
    expect(battler(again.state, "actor_hero").states).toEqual([{ id: "st_poison", turns: 3 }]);
    expect(again.log.filter((e) => e.kind === "state")).toEqual([]); // 二度目は新規付与ではない
    const cleansed = act(again.state, skillAct("actor_mage", "sk_cleanse", ["actor_hero"]));
    expect(battler(cleansed.state, "actor_hero").states).toEqual([]);
    expect(cleansed.log).toContainEqual({ kind: "state", target: "actor_hero", state: "st_poison", added: false });

    const never = battleKit({
      mutate: (p) => {
        (p.database.skills["sk_poison" as never] as { effects: unknown[] }).effects = [{ kind: "addState", state: "st_poison", chance: 0 }];
      },
    });
    const ns = beginBattle(never, "tr_spider");
    expect(battler(act(ns, skillAct("e:0", "sk_poison", ["actor_hero"]), never.ctx).state, "actor_hero").states).toEqual([]);
  });

  it("buffs stack up to ±2 and are logged only when they change", () => {
    let s = start();
    for (let i = 0; i < 4; i++) s = act(s, skillAct("actor_hero", "sk_focus")).state;
    expect(battler(s, "actor_hero").buffs).toEqual({ atk: 2 });
    expect(act(s, skillAct("actor_hero", "sk_focus")).log.filter((e) => e.kind === "buff")).toEqual([]);
  });

  it("revives a fallen ally with the given HP (and only with a dead-ally scope)", () => {
    const s = setBattler(start(), "actor_hero", { hp: 0 });
    const r = act(s, skillAct("actor_mage", "sk_revive", ["actor_hero"]));
    expect(battler(r.state, "actor_hero").hp).toBe(20);
    expect(isAlive(battler(r.state, "actor_hero"))).toBe(true);
    expect(r.log).toContainEqual({ kind: "revived", target: "actor_hero" });
    // 通常の回復スキルでは蘇生できない（戦闘不能の対象は選ばれず、生きている味方に差し替わる）
    const heal = act(s, skillAct("actor_mage", "sk_heal", ["actor_hero"]));
    expect(battler(heal.state, "actor_hero").hp).toBe(0);
  });

  it("clears states and buffs when a battler falls", () => {
    const s = setBattler(start(), "e:0", { states: [{ id: "st_poison" as never, turns: 3 }], buffs: { atk: 1 } });
    const r = act(s, { subject: "actor_hero", kind: "attack", targets: ["e:0"] });
    expect(battler(r.state, "e:0")).toMatchObject({ hp: 0, states: [], buffs: {} });
  });

  it("guarding halves the incoming damage but always leaves at least 1", () => {
    const s = beginBattle(kit, "tr_brute");
    const plain = act(s, { subject: "e:0", kind: "attack", targets: ["actor_hero"] });
    const g = act(act(s, { subject: "actor_hero", kind: "guard", targets: [] }).state, { subject: "e:0", kind: "attack", targets: ["actor_hero"] });
    const dmg = (r: { log: { kind: string; amount?: number }[] }) => r.log.find((e) => e.kind === "damage")!.amount!;
    expect(dmg(g)).toBeLessThan(dmg(plain));
    expect(g.state.battle!.guarding).toEqual(["actor_hero"]);
  });

  it("escape fails when the battle forbids it", () => {
    const s = beginBattle(kit, "tr_slime", { canEscape: false });
    const r = act(s, { subject: "actor_hero", kind: "escape", targets: [] });
    expect(r.log.at(-1)).toEqual({ kind: "escape", success: false });
    expect(r.state.battle!.phase).toBe("input");
  });

  it("reports (rather than throws on) unusable effects and bad formulas", () => {
    const k = battleKit({
      mutate: (p) => {
        const skills = p.database.skills as Record<string, { formula: string; effects: unknown[] }>;
        skills["sk_bite"]!.formula = "a.nope";
        skills["sk_focus"]!.effects = [{ kind: "commonEvent", id: "ce_x" }, { kind: "addState", state: "st_missing", chance: 1 }];
      },
    });
    const s = beginBattle(k, "tr_slime");
    const bad = resolveAction(s, skillAct("e:0", "sk_bite", ["actor_hero"]), k.ctx);
    expect(bad.warnings).toHaveLength(1);
    expect(bad.state.battle!.allies["actor_hero"]!.hp).toBe(100);
    const odd = resolveAction(s, { subject: "actor_hero", kind: "skill", skillId: "sk_focus" as never, targets: [] }, k.ctx);
    expect(odd.warnings).toHaveLength(2); // 戦闘中のコモンイベント効果は未対応 + 未定義の状態
  });

  it("advances only the battle random stream", () => {
    const s = start();
    const r = act(s, { subject: "actor_hero", kind: "attack", targets: ["e:0"] });
    expect(r.state.rng).toEqual(s.rng);
    expect(r.state.battle!.rng).not.toEqual(s.battle!.rng);
  });

  it("does nothing when there is no battle", () => {
    const r = resolveAction(kit.state, { subject: "actor_hero", kind: "attack", targets: [] }, kit.ctx);
    expect(r).toEqual({ state: kit.state, log: [], warnings: [] });
  });
});
