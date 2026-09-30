import { err, ok } from "@rpg/schema";
import type { Item, Result, Skill, SwitchId, VariableId } from "@rpg/schema";
import type { Ctx } from "../ctx-types.js";
import { evaluate, parse } from "../expression/index.js";
import type { EvalError, Scope } from "../expression/index.js";
import type { Random } from "../random.js";
import type { GameState } from "../state.js";
import { battlerView, effective, ITEM_SCOPE } from "./battlers.js";
import { defaultBattleRules } from "./rules.js";
import type { Battler, DamageResult } from "./state.js";

/** 会心のときのダメージ倍率。 */
export const CRITICAL_MULTIPLIER = 2;
/** ダメージのばらつき（±%）。 */
export const DAMAGE_VARIANCE_PERCENT = 10;

const isSkill = (x: Skill | Item): x is Skill => "scope" in x;

/** 敵に向けた効果か（命中・会心・最低ダメージ 0 の対象）。 */
export const isHostileScope = (scope: Skill["scope"]): boolean => scope === "one-enemy" || scope === "all-enemies";

/**
 * スキル/アイテムの式でダメージを計算する。`a` は使う側、`b` は受ける側（どちらも実効パラメータで評価する）。
 * 乱数の消費順は「命中 → ばらつき → 会心」で固定（外れたときは命中の 1 回だけ）。
 * 敵に向けた効果は 0 未満にならず、味方に向けた効果は負の値（= 回復）を返しうる。
 * 式が評価できないときは `Err`（呼び出し側が警告を出して 0 として扱う）。
 * `game` を渡すと式の `v(id)` / `s(id)` が使える（省略時は 0 / false）。
 */
export function calcDamage(
  skill: Skill | Item,
  a: Battler,
  b: Battler,
  ctx: Ctx,
  rng: Random,
  game?: Pick<GameState, "variables" | "switches">,
): Result<DamageResult, EvalError> {
  const scope = isSkill(skill) ? skill.scope : ITEM_SCOPE;
  const formula = skill.formula ?? "";
  const rules = ctx.battleRules ?? defaultBattleRules;
  const ea = effective(ctx, a);
  const eb = effective(ctx, b);
  const hostile = isHostileScope(scope);

  if (hostile && rng.next() >= rules.hitRate(ea, eb, isSkill(skill) ? skill : SKILL_FOR_ITEM)) {
    return ok({ amount: 0, critical: false, hit: false });
  }

  let base = 0;
  if (formula.trim() !== "") {
    const parsed = parse(formula);
    if (!parsed.ok) return err({ kind: "argument", message: `構文エラー: ${parsed.error.message}`, pos: parsed.error.pos });
    const evalScope: Scope = {
      vars: { a: battlerView(ea), b: battlerView(eb) },
      variable: (id: VariableId) => (game !== undefined && Object.hasOwn(game.variables, id) ? (game.variables[id] as number) : 0),
      switch: (id: SwitchId) => game !== undefined && Object.hasOwn(game.switches, id) && game.switches[id] === true,
      rng,
      mode: "formula",
    };
    const r = evaluate(parsed.value, evalScope, ctx.formulas);
    if (!r.ok) return r;
    if (typeof r.value.value !== "number") return err({ kind: "typeMismatch", message: "ダメージ式が数値を返さなかった", pos: 0 });
    base = r.value.value;
  }

  let amount = base;
  if (amount !== 0) amount = Math.round(amount * (1 + rng.int(-DAMAGE_VARIANCE_PERCENT, DAMAGE_VARIANCE_PERCENT) / 100));

  let critical = false;
  if (hostile && amount > 0 && rng.next() < rules.critRate(ea, eb, isSkill(skill) ? skill : SKILL_FOR_ITEM)) {
    critical = true;
    amount = Math.round(amount * CRITICAL_MULTIPLIER);
  }
  if (hostile) amount = Math.max(0, amount);
  return ok({ amount, critical, hit: true });
}

/** アイテムをルールに渡すときの仮のスキル。 */
const SKILL_FOR_ITEM: Skill = { id: "item" as Skill["id"], name: "", mpCost: 0, scope: ITEM_SCOPE, formula: "", effects: [] };
