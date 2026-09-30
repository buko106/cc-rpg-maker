import type { GameState } from "../index.js";
import { battleKit, beginBattle } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { createRandom } from "../random.js";
import { chooseEnemyAction } from "./ai.js";

const withActions = (actions: unknown[], enemy = "slime") => {
  const kit = battleKit({
    mutate: (p) => {
      const e = p.database.enemies[enemy as never] as unknown as { actions: unknown[] };
      e.actions = actions;
    },
  });
  const state = beginBattle(kit, enemy === "slime" ? "tr_slime" : "tr_spider");
  return { kit, state };
};

const tally = (state: GameState, ctx: Parameters<typeof chooseEnemyAction>[2], n = 1000) => {
  const rng = createRandom("ai-stats");
  const counts: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const a = chooseEnemyAction(state.battle!.enemies["e:0"]!, state, ctx, rng);
    const key = a.kind === "attack" ? "attack" : String(a.skillId);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
};

describe("chooseEnemyAction", () => {
  it("picks by rating weight among the actions within 3 of the best (1000 trials)", () => {
    // rating 5 / 4 / 2 → 下限 5-3=2 なので 2 は除外。重みは 5→3、4→2 で 60% : 40%
    const { kit, state } = withActions([
      { skill: "sk_bite", rating: 5 },
      { skill: "sk_poison", rating: 4 },
      { skill: "sk_lullaby", rating: 2 },
    ]);
    const c = tally(state, kit.ctx);
    expect(c["sk_lullaby"]).toBeUndefined();
    expect(c["sk_bite"]! / 1000).toBeGreaterThan(0.54);
    expect(c["sk_bite"]! / 1000).toBeLessThan(0.66);
    expect(c["sk_poison"]! / 1000).toBeGreaterThan(0.34);
    expect(c["sk_poison"]! / 1000).toBeLessThan(0.46);
  });

  it("always picks the only candidate and targets a living member of the opposing side", () => {
    const { kit, state } = withActions([{ skill: "sk_bite", rating: 5 }]);
    const rng = createRandom("t");
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const a = chooseEnemyAction(state.battle!.enemies["e:0"]!, state, kit.ctx, rng);
      expect(a).toMatchObject({ subject: "e:0", kind: "skill", skillId: "sk_bite" });
      seen.add(a.targets[0]!);
    }
    expect([...seen].sort()).toEqual(["actor_hero", "actor_mage"]);
    // 倒れた味方は狙わない
    const down = { ...state, battle: { ...state.battle!, allies: { ...state.battle!.allies, actor_hero: { ...state.battle!.allies["actor_hero"]!, hp: 0 } } } };
    for (let i = 0; i < 50; i++) expect(chooseEnemyAction(down.battle!.enemies["e:0"]!, down, kit.ctx, rng).targets).toEqual(["actor_mage"]);
  });

  it("falls back to a basic attack when no action qualifies", () => {
    const { kit, state } = withActions([]);
    const a = chooseEnemyAction(state.battle!.enemies["e:0"]!, state, kit.ctx, createRandom("f"));
    expect(a).toMatchObject({ subject: "e:0", kind: "attack" });
    expect(a.targets).toHaveLength(1);
  });

  it("honours conditions (expressions over the acting enemy and the turn)", () => {
    const { kit, state } = withActions([
      { skill: "sk_bite", rating: 5, condition: "a.hp < a.mhp / 2" },
      { skill: "sk_poison", rating: 5, condition: "turn >= 2" },
      { skill: "sk_lullaby", rating: 1 },
    ]);
    // 満タン・1 ターン目：条件を満たすのは sk_lullaby だけ
    expect(tally(state, kit.ctx, 50)).toEqual({ sk_lullaby: 50 });
    const hurt = { ...state, battle: { ...state.battle!, turn: 2, enemies: { "e:0": { ...state.battle!.enemies["e:0"]!, hp: 5 } } } };
    const c = tally(hurt, kit.ctx, 200);
    expect(c["sk_lullaby"]).toBeUndefined();
    expect(Object.keys(c).sort()).toEqual(["sk_bite", "sk_poison"]);
  });

  it("ignores conditions that do not evaluate to a boolean or fail to parse, and skills it cannot afford", () => {
    const { kit, state } = withActions([
      { skill: "sk_bite", rating: 5, condition: "1 + 1" },
      { skill: "sk_poison", rating: 5, condition: "a.hp <" },
      { skill: "sk_fire", rating: 5 },
    ]);
    // sk_fire は MP 3 が要るがスライムの MP は 0 → 候補なしで通常攻撃
    expect(tally(state, kit.ctx, 20)).toEqual({ attack: 20 });
  });

  it("picks targets by scope: self, all, and allies on its own side", () => {
    const { kit, state } = withActions([{ skill: "sk_focus", rating: 5 }]);
    expect(chooseEnemyAction(state.battle!.enemies["e:0"]!, state, kit.ctx, createRandom("s")).targets).toEqual(["e:0"]);
    const all = withActions([{ skill: "sk_lullaby", rating: 5 }]);
    expect(chooseEnemyAction(all.state.battle!.enemies["e:0"]!, all.state, all.kit.ctx, createRandom("s")).targets).toEqual(["actor_hero", "actor_mage"]);
  });

  it("is deterministic for the same random state", () => {
    const { kit, state } = withActions([{ skill: "sk_bite", rating: 5 }, { skill: "sk_poison", rating: 5 }]);
    const run = () => Array.from({ length: 20 }, ((rng) => () => chooseEnemyAction(state.battle!.enemies["e:0"]!, state, kit.ctx, rng))(createRandom("d")));
    expect(run()).toEqual(run());
  });
});
