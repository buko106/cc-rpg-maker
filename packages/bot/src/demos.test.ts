import { loadFixtureProject } from "@rpg/test-utils";
import { createRandom, initialState, startBattle, step } from "@rpg/core";
import type { GameState } from "@rpg/core";
import { describe, expect, it } from "vitest";
import { battleBotInput, levelSweep, prepareParty, smartPolicy } from "./index.js";

/**
 * デモの難易度の目安（bot の試行）。データを変えて目安から外れたら、`pnpm bot <デモ> --troop <ID> --levels …` で表を見て調整する。
 * 数値は種を固定した試行の結果なので、同じデータなら毎回同じになる。
 */
describe("ほこらの冒険（fixtures/projects/v1/hokora）", () => {
  const { ctx } = loadFixtureProject("hokora");
  const start = initialState(ctx, "hokora-bot");
  const GEAR = { actor_hero: ["wp_iron", "ar_iron"], actor_mina: ["wp_rod", "ar_mage"] };

  it("[calibration] ほこらの主は、Lv3 ではまず勝てず、Lv5 で五分以上、Lv6 ならほぼ勝てる。店の装備をそろえると楽になる", () => {
    const rate = (level: number, equips?: typeof GEAR): number =>
      levelSweep(start, ctx, [level], { troop: "tr_boss", runs: 30, seed: "boss", ...(equips === undefined ? {} : { party: { equips } }) })[0]!.report.winRate;
    expect(rate(3)).toBeLessThanOrEqual(0.1);
    const lv5 = rate(5);
    expect(lv5).toBeGreaterThanOrEqual(0.5);
    expect(lv5).toBeLessThan(0.9);
    expect(rate(6)).toBeGreaterThanOrEqual(0.9);
    // Lv4 では、初めの装備だとまず勝てないが、店の装備なら勝ち目がある
    expect(rate(4, GEAR)).toBeGreaterThan(rate(4) + 0.2);
  });

  it("ほこらの主の戦いでは、名乗り → HP 半分でこうもりの増援 → 25% で変身、の順にバトルイベントが動く", () => {
    let s: GameState = startBattle(prepareParty(start, ctx, { level: 7 }), "tr_boss" as never, { canEscape: false, canLose: true }, ctx);
    const seen: string[] = [];
    const note = (what: string) => {
      if (!seen.includes(what)) seen.push(what);
    };
    const policy = smartPolicy();
    for (let i = 0; i < 20000 && s.scene.kind === "battle"; i++) {
      s = step(s, battleBotInput(s, ctx, policy), ctx).state;
      const b = s.battle;
      if (b === undefined) break;
      if (s.message.open && s.message.text.includes("朽ち果てる")) note("名乗り");
      if (!b.enemies["e:1"]!.hidden && !b.enemies["e:2"]!.hidden) note("増援");
      if (b.enemies["e:0"]!.enemyId === "en_gargoyle_rage") note("変身");
    }
    expect(seen).toEqual(["名乗り", "増援", "変身"]);
    expect(s.scene.kind).toBe("map");
  });
});

describe("バトルタワー（fixtures/projects/v1/tower）", () => {
  const { ctx } = loadFixtureProject("tower");
  const start = initialState(ctx, "tower-bot");
  /** 3F の大グモを倒すと僧侶が加わる。支度金でもらうポーション 3 個を持って挑む。 */
  const party = (troop: string) => ({
    members: ["tr_goblins", "tr_spider", "tr_dummy"].includes(troop) ? ["actor_hero", "actor_mage"] : ["actor_hero", "actor_mage", "actor_cleric"],
    items: { item_potion: 3 },
  });
  const rate = (troop: string, level: number): number => levelSweep(start, ctx, [level], { troop, runs: 30, seed: "tower", party: party(troop) })[0]!.report.winRate;

  it("[calibration] 番人には、ふつうに登って着いたときのレベルなら 8 割ほどは勝て、1 つ下のレベルでは苦しい", () => {
    // ふつうに登ると 2F で Lv1、3F で Lv2、4F で Lv3、5F で Lv4（apps/player/src/tower-fixture.test.ts の通しプレイ）
    expect(rate("tr_goblins", 1)).toBeGreaterThanOrEqual(0.9);
    expect(rate("tr_spider", 2)).toBeGreaterThanOrEqual(0.75);
    expect(rate("tr_spider", 1)).toBeLessThanOrEqual(0.5);
    expect(rate("tr_golem", 3)).toBeGreaterThanOrEqual(0.7);
    expect(rate("tr_golem", 2)).toBeLessThanOrEqual(0.3);
    expect(rate("tr_sorcerer", 4)).toBeGreaterThanOrEqual(0.75);
    expect(rate("tr_sorcerer", 3)).toBeLessThanOrEqual(0.3);
  });

  it("[calibration] 屋上の炎の竜は、着いたとき（Lv5）で 7 割前後、Lv6 ならほぼ勝てる。Lv4 ではまず勝てない", () => {
    expect(rate("tr_dragon", 4)).toBeLessThanOrEqual(0.15);
    const lv5 = rate("tr_dragon", 5);
    expect(lv5).toBeGreaterThanOrEqual(0.55);
    expect(lv5).toBeLessThan(0.9);
    expect(rate("tr_dragon", 6)).toBeGreaterThanOrEqual(0.9);
  });

  /** `troop` と `level` で 1 回戦い、敵の出現と変身を順に書き出す。 */
  function happenings(troop: string, level: number, seed: string): string[] {
    const seeded: GameState = { ...prepareParty(start, ctx, { level, ...party(troop) }), rng: createRandom(seed).serialize() };
    let s = startBattle(seeded, troop as never, { canEscape: false, canLose: true }, ctx);
    const seen: string[] = [];
    let before = s.battle!.enemies;
    const policy = smartPolicy();
    for (let i = 0; i < 20000 && s.scene.kind === "battle"; i++) {
      s = step(s, battleBotInput(s, ctx, policy), ctx).state;
      const now = s.battle?.enemies;
      if (now === undefined) break;
      for (const [id, e] of Object.entries(now)) {
        const was = before[id as keyof typeof before]!;
        if (was.hidden && !e.hidden) seen.push(`出現 ${e.name}`);
        if (was.enemyId !== e.enemyId) seen.push(`変身 ${e.name}`);
      }
      before = now;
    }
    expect(s.scene.kind).toBe("map");
    return seen;
  }

  it("どの番人の戦いにもバトルイベントがあり、増援や変身が起きる", () => {
    for (const troop of ["tr_dummy", "tr_goblins", "tr_spider", "tr_golem", "tr_sorcerer", "tr_dragon"]) {
      expect(ctx.project.troop(troop as never)!.pages.length, troop).toBeGreaterThan(0);
    }
    expect(happenings("tr_goblins", 2, "a")).toEqual(["出現 ちびゴブリン"]);
    expect(happenings("tr_spider", 3, "a")).toEqual(["出現 子グモA", "出現 子グモB"]);
    expect(happenings("tr_golem", 4, "a")).toEqual(["変身 暴走ゴーレム"]);
    expect(happenings("tr_sorcerer", 5, "a")).toEqual(["出現 骸骨兵C", "出現 骸骨兵D"]);
    expect(happenings("tr_dragon", 7, "a")).toEqual(["変身 怒れる炎の竜"]);
  });
});
