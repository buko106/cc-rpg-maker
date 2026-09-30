import type { ActorId, BuffParam, Item, ItemId, Param, Skill, SkillId } from "@rpg/schema";
import { PARAMS } from "@rpg/schema";
import type { Ctx } from "../ctx-types.js";
import type { BattlerView } from "../expression/index.js";
import { paramAt } from "../params.js";
import type { GameState } from "../state.js";

/** 戦闘の計算のうち、プロジェクトの定義だけを引くものが受け取る文脈（コマンドの `CommandCtx` でも渡せる）。 */
export type ProjectCtx = Pick<Ctx, "project">;
import type { Battler, BattlerId, EnemyBattler } from "./state.js";

/** 戦闘に出られる味方の最大人数。 */
export const BATTLE_PARTY_MAX = 4;
export const LEVEL_MAX = 99;

/** 強化/弱体 1 段階あたりの倍率の変化（+2 段階で 1.5 倍、-2 段階で 0.5 倍）。 */
const BUFF_STEP = 0.25;

/** 通常攻撃。プロジェクトの DB には無い、組み込みのスキル。 */
export const ATTACK_SKILL: Skill = {
  id: "attack" as Skill["id"],
  name: "攻撃",
  mpCost: 0,
  scope: "one-enemy",
  formula: "a.atk * 4 - b.def * 2",
  effects: [],
};

/** アイテムの対象。`Item` に scope は無いので、味方 1 人に使うものとして扱う。 */
export const ITEM_SCOPE = "one-ally" as const;

export const isAlive = (b: Battler): boolean => b.hp > 0;

/** 味方の id かどうか（敵は `e:` で始まる）。 */
export const isEnemyId = (id: BattlerId): boolean => id.startsWith("e:");

/** 状態・強化を反映した実効パラメータ。 */
export function effectiveParam(ctx: ProjectCtx, b: Battler, param: Param): number {
  const base = b.params[param];
  const buff = param === "mhp" || param === "mmp" ? 0 : (b.buffs[param as BuffParam] ?? 0);
  let rate = 1 + BUFF_STEP * buff;
  for (const entry of b.states) {
    const state = ctx.project.state(entry.id);
    rate *= state?.paramRates[param] ?? 1;
  }
  return Math.max(0, Math.floor(base * rate));
}

/** 実効パラメータに置き換えた戦闘者（ルールや式の評価に渡す）。 */
export function effective<B extends Battler>(ctx: ProjectCtx, b: B): B {
  const params = { ...b.params };
  for (const p of PARAMS) params[p] = effectiveParam(ctx, b, p);
  return { ...b, params };
}

/** 式の `a` / `b` から見える読み取り専用ビュー。`b` は実効パラメータ済みのものを渡す。 */
export const battlerView = (b: Battler): BattlerView => ({
  hp: b.hp,
  mhp: b.params.mhp,
  mp: b.mp,
  mmp: b.params.mmp,
  atk: b.params.atk,
  def: b.params.def,
  mat: b.params.mat,
  mdf: b.params.mdf,
  agi: b.params.agi,
  luk: b.params.luk,
  level: b.level,
  name: b.name,
});

export function hasRestriction(ctx: ProjectCtx, b: Battler): boolean {
  return b.states.some((s) => ctx.project.state(s.id)?.restriction === "cannotAct");
}

/** 行動できる（生きていて、行動を制限する状態が無い）。 */
export const canAct = (ctx: ProjectCtx, b: Battler): boolean => isAlive(b) && !hasRestriction(ctx, b);

/** アクターの装備品のパラメータ加算を含めた基本パラメータ。 */
export function actorParams(ctx: ProjectCtx, actorId: ActorId, level: number): Record<Param, number> {
  const actor = ctx.project.actor(actorId);
  const cls = actor === undefined ? undefined : ctx.project.class(actor.classId);
  const params = {} as Record<Param, number>;
  for (const p of PARAMS) params[p] = paramAt(cls, p, level);
  for (const itemId of Object.values(actor?.equips ?? {})) {
    const add = ctx.project.item(itemId)?.params;
    if (add === undefined) continue;
    for (const p of PARAMS) params[p] += add[p] ?? 0;
  }
  return params;
}

/** 戦闘開始時の味方。HP/MP は `GameState.actors` から。 */
export function allyBattler(state: GameState, ctx: ProjectCtx, actorId: ActorId): Battler | undefined {
  const a = Object.hasOwn(state.actors, actorId) ? state.actors[actorId] : undefined;
  if (a === undefined) return undefined;
  const params = actorParams(ctx, actorId, a.level);
  return {
    id: actorId,
    name: a.name,
    level: a.level,
    hp: Math.min(Math.max(0, a.hp), params.mhp),
    mp: Math.min(Math.max(0, a.mp), params.mmp),
    params,
    states: [],
    buffs: {},
  };
}

export function enemyBattler(ctx: ProjectCtx, index: number, member: { enemy: EnemyBattler["enemyId"]; x: number; y: number }, name: string): EnemyBattler | undefined {
  const def = ctx.project.enemy(member.enemy);
  if (def === undefined) return undefined;
  return {
    id: `e:${index}`,
    name,
    level: 1,
    hp: def.params.mhp,
    mp: def.params.mmp,
    params: def.params,
    states: [],
    buffs: {},
    enemyId: def.id,
    x: member.x,
    y: member.y,
    hidden: false,
  };
}

/** 戦闘者の HP/MP を範囲内（0〜実効の最大値）に収める。 */
export function clampBattler<B extends Battler>(ctx: ProjectCtx, b: B): B {
  const mhp = effectiveParam(ctx, b, "mhp");
  const mmp = effectiveParam(ctx, b, "mmp");
  const hp = Math.min(Math.max(0, Math.round(b.hp)), mhp);
  const mp = Math.min(Math.max(0, Math.round(b.mp)), mmp);
  return hp === b.hp && mp === b.mp ? b : { ...b, hp, mp };
}

/** そのアクターが今使えるスキル（クラスの習得スキルのうちレベルが足りているもの、ID 順ではなく習得順）。 */
export function learnedSkills(ctx: ProjectCtx, actorId: ActorId, level: number): Skill[] {
  const actor = ctx.project.actor(actorId);
  const cls = actor === undefined ? undefined : ctx.project.class(actor.classId);
  const out: Skill[] = [];
  const seen = new Set<SkillId>();
  for (const entry of cls?.skills ?? []) {
    if (entry.level > level || seen.has(entry.skill)) continue;
    const skill = ctx.project.skill(entry.skill);
    if (skill === undefined) continue;
    seen.add(entry.skill);
    out.push(skill);
  }
  return out;
}

/** 戦闘中に使えるアイテム（消耗品で所持数が 1 以上のもの、ID 順）。 */
export function usableItems(state: GameState, ctx: ProjectCtx): Item[] {
  const out: Item[] = [];
  for (const id of Object.keys(state.party.items).sort()) {
    if ((state.party.items[id as ItemId] ?? 0) <= 0) continue;
    const item = ctx.project.item(id as ItemId);
    if (item !== undefined && item.kind === "consumable") out.push(item);
  }
  return out;
}
