import type { ActorId, EquipSlot, Item, ItemId, Param } from "@rpg/schema";
import { actorParams } from "../battle/battlers.js";
import type { ProjectCtx } from "../battle/battlers.js";
import type { GameState } from "../state.js";

/** 装備（欄 → アイテム。空いた欄は無い）。 */
export type Equips = Partial<Record<EquipSlot, ItemId>>;

/** アイテムを付ける装備欄。武器は `weapon`、防具は `equipSlot`（省略 = `armor`）。それ以外（消耗品・大事なもの）は付けられない（`undefined`）。 */
export function equipSlotOf(item: Item | undefined): EquipSlot | undefined {
  if (item?.kind === "weapon") return "weapon";
  if (item?.kind === "armor") return item.equipSlot ?? "armor";
  return undefined;
}

const actorStateOf = (state: GameState, actorId: ActorId) => (Object.hasOwn(state.actors, actorId) ? state.actors[actorId] : undefined);

/** アクターのいまの装備。一度も付け替えていなければ、データベースの初期装備（`Actor.equips`）。 */
export function equipsOf(state: GameState, ctx: ProjectCtx, actorId: ActorId): Equips {
  return actorStateOf(state, actorId)?.equips ?? ctx.project.actor(actorId)?.equips ?? {};
}

/** いまのレベルと装備での能力値（装備の加算を含む。戦闘の開始時の値と同じ）。いないアクターは Lv1・初期装備で計算する。 */
export function actorParamsOf(state: GameState, ctx: ProjectCtx, actorId: ActorId): Record<Param, number> {
  return actorParams(ctx, actorId, actorStateOf(state, actorId)?.level ?? 1, equipsOf(state, ctx, actorId));
}

/** `equips` の `slot` を `item` に替えたときの能力値（装備画面で、付け替えたあとの値を見せる）。 */
export function paramsIfEquipped(state: GameState, ctx: ProjectCtx, actorId: ActorId, slot: EquipSlot, item: ItemId | undefined): Record<Param, number> {
  const equips = { ...equipsOf(state, ctx, actorId) };
  if (item === undefined) delete equips[slot];
  else equips[slot] = item;
  return actorParams(ctx, actorId, actorStateOf(state, actorId)?.level ?? 1, equips);
}

/** パーティの持ち物のうち、`slot` に付けられるもの（所持数 1 以上、ID 順）。 */
export function equipCandidates(state: GameState, ctx: ProjectCtx, slot: EquipSlot): ItemId[] {
  return (Object.entries(state.party.items) as [ItemId, number][])
    .filter(([id, count]) => count > 0 && equipSlotOf(ctx.project.item(id)) === slot)
    .map(([id]) => id)
    .sort();
}

/**
 * アクターの `slot` の装備を `item` に付け替える（`undefined` なら外す）。付けるものはパーティの持ち物から 1 つ減り、外したものは持ち物に戻る。
 * 付けられないとき（アクターがいない・持っていない・欄が違う）は `undefined`。同じものなら状態はそのまま。
 * 最大 HP/MP が下がったら、HP/MP をその値までに切り詰める（戦闘不能の HP 0 はそのまま）。
 */
export function changeEquip(state: GameState, ctx: ProjectCtx, actorId: ActorId, slot: EquipSlot, item: ItemId | undefined): GameState | undefined {
  const actor = actorStateOf(state, actorId);
  if (actor === undefined) return undefined;
  const equips: Equips = { ...equipsOf(state, ctx, actorId) };
  const current = equips[slot];
  if (current === item) return state;
  const items = { ...state.party.items };
  if (item !== undefined) {
    const owned = items[item] ?? 0;
    if (owned < 1 || equipSlotOf(ctx.project.item(item)) !== slot) return undefined;
    if (owned === 1) delete items[item];
    else items[item] = owned - 1;
    equips[slot] = item;
  } else {
    delete equips[slot];
  }
  if (current !== undefined) items[current] = (items[current] ?? 0) + 1;
  const params = actorParams(ctx, actorId, actor.level, equips);
  const hp = Math.min(actor.hp, Math.max(1, params.mhp));
  const mp = Math.min(actor.mp, Math.max(0, params.mmp));
  return { ...state, party: { ...state.party, items }, actors: { ...state.actors, [actorId]: { ...actor, equips, hp, mp } } };
}
