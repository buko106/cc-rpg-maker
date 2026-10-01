import type { ActorId, Item, ItemId, Scope, Skill, SkillId, TroopId } from "@rpg/schema";
import { allyBattler, ITEM_SCOPE, learnedSkills } from "../battle/battlers.js";
import { resolveAction } from "../battle/resolve.js";
import type { BattleAction, BattleState, BattlerId } from "../battle/state.js";
import type { Ctx } from "../ctx-types.js";
import { createRandom } from "../random.js";
import type { GameState } from "../state.js";

/** マップ（メニュー）で使うもの：アイテムか、`user` が使うスキル。 */
export type FieldUse = { readonly kind: "item"; readonly id: ItemId } | { readonly kind: "skill"; readonly id: SkillId; readonly user: ActorId };

/** メニューから使えるスキルの対象の範囲（味方に向けたものだけ）。 */
const FIELD_SCOPES: readonly Scope[] = ["self", "one-ally", "all-allies", "one-dead-ally"];

const hasEffect = (def: Item | Skill): boolean => def.effects.length > 0 || (def.formula ?? "").trim() !== "";

/** メニューから使えるアイテムか（効果のある消耗品。使える相手は一人の味方）。 */
export const fieldItemUsable = (item: Item | undefined): boolean => item !== undefined && item.kind === "consumable" && hasEffect(item);

/** メニューから使えるスキルか（味方に向けた、効果のあるスキル）。 */
export const fieldSkillUsable = (skill: Skill | undefined): boolean => skill !== undefined && FIELD_SCOPES.includes(skill.scope) && hasEffect(skill);

/** 使うものの対象の範囲。見つからなければ `undefined`。 */
export function fieldScope(use: FieldUse, ctx: Pick<Ctx, "project">): Scope | undefined {
  return use.kind === "item" ? (ctx.project.item(use.id) === undefined ? undefined : ITEM_SCOPE) : ctx.project.skill(use.id)?.scope;
}

/** 対象の味方を一人選ぶ必要があるか（`self` と全体は選ばない）。 */
export const needsFieldTarget = (scope: Scope | undefined): boolean => scope === "one-ally" || scope === "one-dead-ally";

/** そのアクターが今使えるスキルのうち、メニューから使えるもの（習得順）。 */
export const fieldSkills = (state: GameState, ctx: Pick<Ctx, "project">, actor: ActorId): Skill[] => {
  const a = Object.hasOwn(state.actors, actor) ? state.actors[actor] : undefined;
  return a === undefined ? [] : learnedSkills(ctx, actor, a.level);
};

/** パーティだけの戦闘状態（敵なし）。戦闘の行動の解決（`resolveAction`）を、メニューでの使用にそのまま使うための入れ物。 */
function fieldBattle(state: GameState, ctx: Ctx): BattleState {
  const allies: Record<BattlerId, NonNullable<ReturnType<typeof allyBattler>>> = {};
  const party: BattlerId[] = [];
  for (const id of state.party.members) {
    const ally = allyBattler(state, ctx, id);
    if (ally === undefined) continue;
    allies[id] = ally;
    party.push(id);
  }
  return {
    troopId: "" as TroopId,
    phase: "input",
    turn: 0,
    enemies: {},
    enemyOrder: [],
    allies,
    party,
    inputCursor: { actorIndex: 0, menu: "command", index: 0, pick: null },
    actions: [],
    queue: [],
    guarding: [],
    log: [],
    popups: [],
    canEscape: false,
    canLose: false,
    rng: createRandom(state.rng.seed).fork(`field:${state.tick}`).serialize(),
    wait: 0,
    result: null,
  };
}

/**
 * マップ（メニュー）でアイテム/スキルを使う。効果は戦闘と同じ解決（`resolveAction`）なので、式・回復・蘇生・MP の消費・アイテムの消費も同じ。
 * `target` は一人を選ぶ範囲のときの対象（`one-ally` は生きている味方、`one-dead-ally` は戦闘不能の味方）。
 * 何も起きない（HP/MP が満タン・MP が足りない・対象が合わない・アイテムが無い）ときは `undefined`（アイテム・MP は減らさない）。
 * 戦闘専用の乱数列（`field:<tick>`）を使い、マップの乱数（`rng`）には触れない。状態異常・強化は戦闘の外には持ち越されないので、HP/MP の回復だけが残る。
 */
export function useOnField(state: GameState, ctx: Ctx, use: FieldUse, target?: ActorId): GameState | undefined {
  const scope = fieldScope(use, ctx);
  if (scope === undefined) return undefined;
  const battle = fieldBattle(state, ctx);
  const user = use.kind === "skill" ? use.user : battle.party.find((id) => (battle.allies[id]?.hp ?? 0) > 0);
  if (user === undefined || !battle.party.includes(user)) return undefined;
  if (use.kind === "skill" ? !fieldSkillUsable(ctx.project.skill(use.id)) : !fieldItemUsable(ctx.project.item(use.id))) return undefined;
  if (needsFieldTarget(scope)) {
    const hp = target === undefined ? undefined : battle.allies[target]?.hp;
    if (hp === undefined || (scope === "one-ally" ? hp <= 0 : hp > 0)) return undefined;
  }

  const action: BattleAction = {
    subject: user,
    kind: use.kind,
    ...(use.kind === "skill" ? { skillId: use.id } : { itemId: use.id }),
    targets: needsFieldTarget(scope) && target !== undefined ? [target] : [],
  };
  const resolved = resolveAction({ ...state, battle }, action, ctx);
  const after = resolved.state.battle;
  // 何も回復しなかった（満タンなど）・使えなかった（MP 不足など）なら、使わなかったことにする
  const useful = resolved.log.some((e) => e.kind === "heal" || e.kind === "revived");
  if (after === undefined || !useful || resolved.log.some((e) => e.kind === "cannotAct" || e.kind === "damage")) return undefined;

  const actors = { ...state.actors };
  for (const id of after.party) {
    const ally = after.allies[id];
    const actor = Object.hasOwn(actors, id) ? actors[id as ActorId] : undefined;
    if (ally === undefined || actor === undefined) continue;
    actors[actor.id] = { ...actor, hp: Math.min(ally.hp, ally.params.mhp), mp: Math.min(ally.mp, ally.params.mmp) };
  }
  return { ...state, actors, party: resolved.state.party };
}
