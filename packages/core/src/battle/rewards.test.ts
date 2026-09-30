import { battleKit, beginBattle } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { createRandom } from "../random.js";
import { LEVEL_MAX } from "./battlers.js";
import { applyRewards, expToReach, gainExp } from "./rewards.js";

const kit = battleKit();
const { ctx } = kit;
const hero = kit.state.actors["actor_hero" as never]!;

describe("expToReach", () => {
  it("is 0 for level 1 and strictly increasing", () => {
    expect(expToReach(1)).toBe(0);
    expect(expToReach(2)).toBe(30);
    expect(expToReach(3)).toBe(100);
    for (let l = 2; l <= LEVEL_MAX; l++) expect(expToReach(l)).toBeGreaterThan(expToReach(l - 1));
  });
});

describe("gainExp", () => {
  it("adds exp without a level up below the threshold", () => {
    expect(gainExp(ctx, hero, 29)).toEqual({ actor: { ...hero, exp: 29 }, levelUps: [] });
  });
  it("can gain several levels at once and lists each one", () => {
    const r = gainExp(ctx, hero, 100);
    expect(r.actor.level).toBe(3);
    expect(r.levelUps).toEqual([{ actor: "actor_hero", level: 2 }, { actor: "actor_hero", level: 3 }]);
  });
  it("raises current HP/MP by the maximum's growth only when alive", () => {
    const k = battleKit({ mutate: (p) => { p.database.classes["class_hero" as never]!.params.mhp.growth = 10; } });
    const alive = gainExp(k.ctx, { ...hero, hp: 50 }, 30).actor;
    expect(alive.hp).toBe(60);
    expect(gainExp(k.ctx, { ...hero, hp: 0 }, 30).actor.hp).toBe(0);
  });
  it("stops at the level cap", () => {
    expect(gainExp(ctx, hero, 10_000_000).actor.level).toBe(LEVEL_MAX);
  });
});

describe("applyRewards", () => {
  const troop = (id: string) => kit.project.database.troops[id as never]!;

  it("sums exp and gold over the whole troop, gives full exp to each living member and stocks the drops", () => {
    const s = beginBattle(kit, "tr_slimes");
    const r = applyRewards(s, troop("tr_slimes"), ctx);
    expect(r.exp).toBe(24);
    expect(r.gold).toBe(16);
    expect(r.drops).toEqual(["potion", "potion"]); // rate 1
    expect(r.state.party.gold).toBe(16);
    expect(r.state.party.items).toEqual({ potion: 4 });
    expect(r.state.actors["actor_hero" as never]!.exp).toBe(24);
    expect(r.state.actors["actor_mage" as never]!.exp).toBe(24);
  });

  it("skips fallen members when handing out exp", () => {
    const s = beginBattle(kit, "tr_slime");
    const down = { ...s, actors: { ...s.actors, actor_mage: { ...s.actors["actor_mage" as never]!, hp: 0 } } };
    const r = applyRewards(down, troop("tr_slime"), ctx);
    expect(r.state.actors["actor_hero" as never]!.exp).toBe(12);
    expect(r.state.actors["actor_mage" as never]!.exp).toBe(0);
  });

  it("rolls drops by rate from the battle random stream and persists it", () => {
    const k = battleKit({ mutate: (p) => { (p.database.enemies["slime" as never] as { drops: unknown[] }).drops = [{ item: "potion", rate: 0.5 }]; } });
    const s = beginBattle(k, "tr_slime");
    let drops = 0;
    for (let i = 0; i < 200; i++) {
      const seeded = { ...s, battle: { ...s.battle!, rng: createRandom(`seed-${i}`).serialize() } };
      const r = applyRewards(seeded, k.project.database.troops["tr_slime" as never]!, k.ctx);
      drops += r.drops.length;
      expect(r.state.battle!.rng).not.toEqual(seeded.battle.rng); // ストリームが進む
      expect(r.state.rng).toEqual(seeded.rng); // マップの乱数には触れない
    }
    expect(drops).toBeGreaterThan(70);
    expect(drops).toBeLessThan(130);
  });

  it("ignores enemies missing from the database and works outside a battle", () => {
    const r = applyRewards(kit.state, { id: "tr_x" as never, name: "x", members: [{ enemy: "nobody" as never, x: 0, y: 0 }, { enemy: "slime" as never, x: 0, y: 0 }], pages: [] }, ctx);
    expect(r.exp).toBe(12);
    expect(r.state.actors["actor_hero" as never]!.exp).toBe(12);
    expect(r.state.rng).not.toEqual(kit.state.rng); // 戦闘外では通常の乱数から引く
  });
});
