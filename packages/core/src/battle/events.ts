import type { TroopCondition } from "@rpg/schema";
import type { GameState } from "../state.js";
import { effectiveParam, isAlive } from "./battlers.js";
import type { ProjectCtx } from "./battlers.js";
import type { BattleState } from "./state.js";

/** 敵グループの `members` の番号 → 戦闘者の ID。 */
export const memberBattlerId = (member: number): string => `e:${member}`;

/** バトルイベントのページの条件を満たしているか（01 の `troopConditionSchema`）。 */
export function troopConditionMet(condition: TroopCondition, state: GameState, b: BattleState, ctx: ProjectCtx): boolean {
  switch (condition.kind) {
    case "always":
      return true;
    case "turn":
      return b.turn === Math.max(1, condition.turn);
    case "switch":
      return Object.hasOwn(state.switches, condition.id) && state.switches[condition.id] === true;
    case "enemyHp": {
      const enemy = b.enemies[memberBattlerId(condition.member)];
      if (enemy === undefined || enemy.hidden || !isAlive(enemy)) return false;
      return enemy.hp * 100 <= effectiveParam(ctx, enemy, "mhp") * condition.percent;
    }
  }
}

/**
 * いま動かすバトルイベントのページ（`Troop.pages` の番号）。まだ動いていないページのうち、条件を満たす最初のもの。
 * 確かめるのは、コマンド入力の間と、行動と行動のあいだ（待ちが明けたところ）だけ。無ければ `undefined`。
 */
export function nextTroopPage(state: GameState, ctx: ProjectCtx): number | undefined {
  const b = state.battle;
  if (b === undefined) return undefined;
  if (b.phase !== "input" && !(b.phase === "resolve" && b.wait === 0)) return undefined;
  const troop = ctx.project.troop(b.troopId);
  if (troop === undefined) return undefined;
  const run = b.eventPagesRun ?? [];
  const index = troop.pages.findIndex((page, i) => !run.includes(i) && page.commands.length > 0 && troopConditionMet(page.condition, state, b, ctx));
  return index < 0 ? undefined : index;
}
