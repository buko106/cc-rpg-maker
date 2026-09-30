import type { ItemId, Troop } from "@rpg/schema";
import type { Ctx } from "../ctx-types.js";
import { paramAt } from "../params.js";
import { restoreRandom } from "../random.js";
import type { ActorState, GameState } from "../state.js";
import { LEVEL_MAX } from "./battlers.js";

/** そのレベルに到達するのに必要な累計経験値（レベル 1 は 0）。 */
export const expToReach = (level: number): number => (level <= 1 ? 0 : 20 * (level - 1) ** 2 + 10 * (level - 1));

export interface LevelUp {
  readonly actor: string;
  readonly level: number;
}

/** 経験値を加えてレベルを上げる。上がった分だけ最大 HP/MP が増え、その差を現在値にも足す（戦闘不能なら足さない）。 */
export function gainExp(ctx: Ctx, actor: ActorState, exp: number): { actor: ActorState; levelUps: LevelUp[] } {
  const total = actor.exp + exp;
  let level = actor.level;
  while (level < LEVEL_MAX && total >= expToReach(level + 1)) level++;
  if (level === actor.level) return { actor: { ...actor, exp: total }, levelUps: [] };

  const def = ctx.project.actor(actor.id);
  const cls = def === undefined ? undefined : ctx.project.class(def.classId);
  const dhp = paramAt(cls, "mhp", level) - paramAt(cls, "mhp", actor.level);
  const dmp = paramAt(cls, "mmp", level) - paramAt(cls, "mmp", actor.level);
  const levelUps: LevelUp[] = [];
  for (let l = actor.level + 1; l <= level; l++) levelUps.push({ actor: actor.id, level: l });
  return {
    actor: { ...actor, exp: total, level, hp: actor.hp > 0 ? actor.hp + Math.max(0, dhp) : 0, mp: actor.mp + Math.max(0, dmp) },
    levelUps,
  };
}

/**
 * 勝利の報酬を反映する：経験値は生きているパーティ全員に（同じ量）、ゴールドは共有、ドロップは確率で判定して所持品へ。
 * ドロップの乱数は `battle.rng`（戦闘中でなければ `state.rng`）から引く。
 */
export function applyRewards(
  state: GameState,
  troop: Troop,
  ctx: Ctx,
): { state: GameState; exp: number; gold: number; drops: ItemId[]; levelUps: LevelUp[] } {
  const rng = restoreRandom(state.battle?.rng ?? state.rng);
  let exp = 0;
  let gold = 0;
  const drops: ItemId[] = [];
  for (const member of troop.members) {
    const enemy = ctx.project.enemy(member.enemy);
    if (enemy === undefined) continue;
    exp += enemy.exp;
    gold += enemy.gold;
    for (const drop of enemy.drops) if (rng.next() < drop.rate) drops.push(drop.item);
  }

  const items = { ...state.party.items };
  for (const id of drops) items[id] = (items[id] ?? 0) + 1;

  const actors = { ...state.actors };
  const levelUps: LevelUp[] = [];
  const members = state.battle === undefined ? state.party.members : state.battle.party;
  for (const id of members) {
    const actor = Object.hasOwn(actors, id) ? actors[id as ActorState["id"]] : undefined;
    if (actor === undefined || actor.hp <= 0) continue;
    const r = gainExp(ctx, actor, exp);
    actors[actor.id] = r.actor;
    levelUps.push(...r.levelUps);
  }

  const party = { ...state.party, gold: state.party.gold + gold, items };
  const next: GameState =
    state.battle === undefined
      ? { ...state, party, actors, rng: rng.serialize() }
      : { ...state, party, actors, battle: { ...state.battle, rng: rng.serialize() } };
  return { state: next, exp, gold, drops, levelUps };
}
