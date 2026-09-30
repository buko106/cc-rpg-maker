import type { Skill } from "@rpg/schema";
import type { Ctx } from "../ctx-types.js";
import { evaluate, parse } from "../expression/index.js";
import type { Random } from "../random.js";
import type { GameState } from "../state.js";
import { battlerView, effective, isAlive } from "./battlers.js";
import { enemyBattlers, partyBattlers } from "./helpers.js";
import { resolveTargets } from "./resolve.js";
import type { Battler, BattleAction, EnemyBattler } from "./state.js";

/** 最大の rating からこの差より低い行動は選ばれない（RPG ツクール MV と同じ）。 */
const RATING_WINDOW = 3;

/** 行動の条件式。`a` は行動する敵、`turn` は現在のターン。評価できない・真偽値でないときは偽。 */
function conditionHolds(condition: string | undefined, enemy: EnemyBattler, turn: number, ctx: Ctx, rng: Random): boolean {
  if (condition === undefined || condition.trim() === "") return true;
  const parsed = parse(condition);
  if (!parsed.ok) return false;
  const r = evaluate(
    parsed.value,
    { vars: { a: battlerView(effective(ctx, enemy)), turn }, variable: () => 0, switch: () => false, rng, mode: "condition" },
    ctx.formulas,
  );
  return r.ok && r.value.value === true;
}

/**
 * 敵の行動を選ぶ。条件を満たし MP が足りる行動のうち、最大の `rating` から 3 以内のものを
 * `rating - (最大 - 3)` の重みで選ぶ。候補が無ければ通常攻撃。対象は範囲に応じて生きている相手から無作為に選ぶ。
 */
export function chooseEnemyAction(enemy: EnemyBattler, state: GameState, ctx: Ctx, rng: Random): BattleAction {
  const battle = state.battle;
  const def = ctx.project.enemy(enemy.enemyId);
  const turn = battle?.turn ?? 0;

  const candidates: { skill: Skill; rating: number }[] = [];
  for (const a of def?.actions ?? []) {
    const skill = ctx.project.skill(a.skill);
    if (skill === undefined || skill.mpCost > enemy.mp || a.rating <= 0) continue;
    if (!conditionHolds(a.condition, enemy, turn, ctx, rng)) continue;
    candidates.push({ skill, rating: a.rating });
  }

  const alive = (xs: readonly Battler[]): string[] => xs.filter(isAlive).map((x) => x.id);
  const foes = battle === undefined ? [] : alive(partyBattlers(battle));
  const friends = battle === undefined ? [] : alive(enemyBattlers(battle));
  const randomOf = (ids: readonly string[]): string[] => (ids.length === 0 ? [] : [rng.pick(ids)]);

  if (candidates.length === 0) return { subject: enemy.id, kind: "attack", targets: randomOf(foes) };

  const max = Math.max(...candidates.map((c) => c.rating));
  const floor = max - RATING_WINDOW;
  const pool = candidates.filter((c) => c.rating > floor);
  const total = pool.reduce((sum, c) => sum + (c.rating - floor), 0);
  let roll = rng.next() * total;
  let chosen = pool[pool.length - 1]!;
  for (const c of pool) {
    roll -= c.rating - floor;
    if (roll < 0) {
      chosen = c;
      break;
    }
  }

  const scope = chosen.skill.scope;
  let targets: string[];
  switch (scope) {
    case "one-enemy":
      targets = randomOf(foes);
      break;
    case "one-ally":
      targets = randomOf(friends);
      break;
    case "one-dead-ally":
      targets = battle === undefined ? [] : randomOf(enemyBattlers(battle).filter((x) => !isAlive(x)).map((x) => x.id));
      break;
    default:
      // 全体・自分・なし：対象は解決時に範囲から決まる
      targets = battle === undefined ? [] : resolveTargets(battle, enemy.id, scope, []);
  }
  return { subject: enemy.id, kind: "skill", skillId: chosen.skill.id, targets };
}
