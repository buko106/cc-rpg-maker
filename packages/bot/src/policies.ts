import { enemyBattlers, isAlive, partyBattlers } from "@rpg/core";
import type { Battler } from "@rpg/core";
import type { Item, Skill } from "@rpg/schema";
import type { BattleChoice, BattlePolicy } from "./driver.js";

/** 生きている敵のうち、HP がいちばん少ないもの（同じなら並びの先）。 */
const weakestEnemy = (enemies: readonly Battler[]): Battler | undefined => enemies.reduce<Battler | undefined>((a, e) => (a === undefined || e.hp < a.hp ? e : a), undefined);

/** 通常攻撃だけ（いちばん弱った敵を狙う）。いちばん素朴な遊び方の目安。 */
export const attackPolicy: BattlePolicy = ({ battle }) => {
  const target = weakestEnemy(enemyBattlers(battle).filter(isAlive));
  return { kind: "attack", ...(target === undefined ? {} : { target: target.id }) };
};

/** 防御だけ。負けるまでの流れ（全滅・敗北イベント）を見るのに使う。 */
export const guardPolicy: BattlePolicy = () => ({ kind: "guard" });

/** HP を回復するスキルか（効果に HP 回復があるか、味方向けで式が負＝回復）。 */
export function healsHp(skill: Pick<Skill, "scope" | "formula" | "effects">): boolean {
  if (skill.effects.some((e) => e.kind === "recoverHp")) return true;
  const toAlly = skill.scope === "one-ally" || skill.scope === "all-allies" || skill.scope === "self";
  return toAlly && /^\s*(?:0\s*)?-/.test(skill.formula);
}

const hpRate = (b: Battler): number => b.hp / Math.max(1, b.params.mhp);
const isOffensive = (skill: Skill): boolean => (skill.scope === "one-enemy" || skill.scope === "all-enemies") && skill.formula.trim() !== "";
const itemHeals = (item: Item): boolean => item.effects.some((e) => e.kind === "recoverHp");

/** `smartPolicy` の調整値。 */
export interface SmartPolicyOptions {
  /** この割合（最大 HP に対する）を下回った味方を回復する。既定 0.5。 */
  healBelow?: number;
  /** 回復アイテムを使ってよいか。既定 true。 */
  useItems?: boolean;
}

/**
 * ふつうに遊ぶ人の目安になる作戦。どのゲームのデータにも使えるように、スキルの種類だけを見て決める。
 * 1. 倒れた味方がいて、蘇生のスキル（`one-dead-ally`）が使えるなら蘇生する。
 * 2. HP が `healBelow` を下回った味方が 2 人以上なら全体回復、1 人なら単体回復（回復のスキル。無ければ回復アイテム）。
 * 3. 敵を狙うスキルのうち消費 MP がいちばん大きいもの（敵が 2 体以上なら全体攻撃を優先）。回復役は回復に要る MP を残す。
 * 4. それも無ければ通常攻撃。対象はいつも、いちばん弱った敵。
 */
export function smartPolicy(options: SmartPolicyOptions = {}): BattlePolicy {
  const healBelow = options.healBelow ?? 0.5;
  const useItems = options.useItems ?? true;
  return ({ battle, actor, skills, items }): BattleChoice => {
    const allies = partyBattlers(battle);
    const enemies = enemyBattlers(battle).filter(isAlive);
    const target = weakestEnemy(enemies);
    const affordable = skills.filter((s) => s.mpCost <= actor.mp);
    const dead = allies.filter((a) => !isAlive(a));
    const revive = affordable.find((s) => s.scope === "one-dead-ally");
    if (dead.length > 0 && revive !== undefined) return { kind: "skill", skill: revive.id, target: dead[0]!.id };

    const hurt = allies.filter((a) => isAlive(a) && hpRate(a) < healBelow).sort((a, b) => hpRate(a) - hpRate(b));
    if (hurt.length > 0) {
      const heals = affordable.filter(healsHp);
      const all = heals.find((s) => s.scope === "all-allies");
      if (hurt.length >= 2 && all !== undefined) return { kind: "skill", skill: all.id };
      const one = heals.find((s) => s.scope === "one-ally") ?? (hurt[0]!.id === actor.id ? heals.find((s) => s.scope === "self") : undefined);
      if (one !== undefined) return { kind: "skill", skill: one.id, ...(one.scope === "one-ally" ? { target: hurt[0]!.id } : {}) };
      const potion = useItems ? items.find(itemHeals) : undefined;
      if (potion !== undefined) return { kind: "item", item: potion.id, target: hurt[0]!.id };
    }

    // 回復役は、回復に要るいちばん安い MP を残して攻撃のスキルを使う
    const reserve = Math.min(Infinity, ...skills.filter(healsHp).map((s) => s.mpCost));
    const spendable = affordable.filter((s) => isOffensive(s) && !healsHp(s) && (reserve === Infinity || actor.mp - s.mpCost >= reserve));
    const pool = enemies.length >= 2 && spendable.some((s) => s.scope === "all-enemies") ? spendable.filter((s) => s.scope === "all-enemies") : spendable;
    const best = pool.reduce<Skill | undefined>((a, s) => (a === undefined || s.mpCost > a.mpCost ? s : a), undefined);
    const aim = target === undefined ? {} : { target: target.id };
    if (best !== undefined) return { kind: "skill", skill: best.id, ...(best.scope === "one-enemy" ? aim : {}) };
    return { kind: "attack", ...aim };
  };
}

/** 名前で選べる作戦（CLI など）。 */
export const POLICIES: Readonly<Record<string, BattlePolicy>> = { smart: smartPolicy(), attack: attackPolicy, guard: guardPolicy };
