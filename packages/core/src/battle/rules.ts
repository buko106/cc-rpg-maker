import type { Skill } from "@rpg/schema";
import type { Random } from "../random.js";
import type { Battler, BattleAction, BattlerId } from "./state.js";

/**
 * 命中・会心・行動順・逃走の計算。プラグインで差し替えられるよう `Ctx` 経由で注入する。
 * 戦闘者は実効パラメータ（強化/弱体・状態の補正済み）で渡される。
 */
export interface BattleRules {
  /** 命中率（0〜1）。回復など味方に使う効果では呼ばれない。 */
  hitRate(a: Battler, b: Battler, skill: Skill): number;
  /** 会心率（0〜1）。 */
  critRate(a: Battler, b: Battler, skill: Skill): number;
  /** 行動順を決める。同じ入力と乱数状態なら同じ並びを返す。 */
  sortQueue(actions: readonly BattleAction[], battlers: Readonly<Record<BattlerId, Battler>>, rng: Random): BattleAction[];
  /** 逃走の成功率（0〜1）。 */
  escapeRate(party: readonly Battler[], enemies: readonly Battler[]): number;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);

const average = (xs: readonly number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

export const defaultBattleRules: BattleRules = {
  hitRate: (a, b) => clamp(0.95 + (a.params.luk - b.params.luk) * 0.005, 0.5, 1),
  critRate: (a, b) => clamp(0.04 + (a.params.luk - b.params.luk) * 0.002, 0, 0.5),

  sortQueue(actions, battlers, rng) {
    // 行動ごとに「敏捷性 + 揺らぎ」を 1 回だけ引く（引く順は入力順なので決定論的）。同値は入力順を保つ。
    const keyed = actions.map((action, index) => {
      const agi = battlers[action.subject]?.params.agi ?? 0;
      const priority = action.kind === "guard" ? 1000 : 0;
      return { action, index, speed: priority + agi + rng.int(0, Math.floor(agi / 4)) };
    });
    keyed.sort((x, y) => y.speed - x.speed || x.index - y.index);
    return keyed.map((k) => k.action);
  },

  escapeRate(party, enemies) {
    const p = average(party.map((b) => b.params.agi));
    const e = average(enemies.map((b) => b.params.agi));
    return clamp(0.5 * (p / Math.max(1, e)), 0, 1);
  },
};
