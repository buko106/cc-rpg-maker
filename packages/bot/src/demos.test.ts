import { loadFixtureProject } from "@rpg/test-utils";
import { initialState, startBattle, step } from "@rpg/core";
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
