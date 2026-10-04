import { actorIdSchema, equipSlotSchema, itemIdSchema, nonNegativeInt } from "@rpg/schema";
import type { ActorId, RefTarget } from "@rpg/schema";
import * as z from "zod";
import { expToReach, gainExp } from "../../battle/rewards.js";
import { actorParams, LEVEL_MAX } from "../../battle/battlers.js";
import { warn } from "../../effects.js";
import { changeEquip, equipSlotOf } from "../../game/equip.js";
import { selfSwitchKey } from "../../state.js";
import type { ActorState, GameState } from "../../state.js";
import { defineCommand } from "../handler.js";
import type { CommandCtx } from "../handler.js";
import { amount, amountRefs, describeAmount, readAmount } from "./params.js";

const gainOrLose = z.enum(["gain", "lose"]);
const sign = (op: "gain" | "lose"): 1 | -1 => (op === "gain" ? 1 : -1);
const opLabel = { gain: "増やす", lose: "減らす" } as const;

/** 現在のイベントのセルフスイッチを操作する。マップイベント以外から呼ぶと警告してスキップする。 */
export const controlSelfSwitch = defineCommand({
  code: "ControlSelfSwitch",
  params: z.strictObject({ key: z.enum(["A", "B", "C", "D"]), value: z.boolean() }),
  meta: {
    label: "セルフスイッチの操作",
    category: "ゲーム進行",
    describe: (p) => `セルフスイッチ ${p.key} = ${p.value ? "ON" : "OFF"}`,
    refs: () => [],
  },
  run(p, c) {
    const origin = c.interp.origin;
    if (origin.kind !== "mapEvent") return { effects: [warn("ControlSelfSwitch: マップイベント以外では使えない")] };
    const key = selfSwitchKey(origin.mapId, origin.eventId, p.key);
    return { state: { ...c.state, selfSwitches: { ...c.state.selfSwitches, [key]: p.value } } };
  },
});

/** タイマーの開始/停止。`ticks` は残りフレーム（0 になると止まる）。 */
export const controlTimer = defineCommand({
  code: "ControlTimer",
  params: z.strictObject({ op: z.enum(["start", "stop"]), seconds: nonNegativeInt.default(0) }),
  meta: {
    label: "タイマーの操作",
    category: "ゲーム進行",
    describe: (p) => (p.op === "start" ? `タイマー開始：${p.seconds}秒` : "タイマー停止"),
    refs: () => [],
  },
  run: (p, c) => ({ state: { ...c.state, timers: p.op === "start" ? { active: p.seconds > 0, ticks: p.seconds * 60 } : { ...c.state.timers, active: false } } }),
});

export const changeGold = defineCommand({
  code: "ChangeGold",
  params: z.strictObject({ op: gainOrLose, amount }),
  meta: {
    label: "所持金の増減",
    category: "ゲーム進行",
    describe: (p) => `所持金を${describeAmount(p.amount)}だけ${opLabel[p.op]}`,
    refs: (p) => amountRefs(p.amount),
  },
  run(p, c) {
    const gold = Math.max(0, c.state.party.gold + sign(p.op) * readAmount(p.amount, c.state.variables));
    return { state: { ...c.state, party: { ...c.state.party, gold } } };
  },
});

export const changeItems = defineCommand({
  code: "ChangeItems",
  params: z.strictObject({ item: itemIdSchema, op: gainOrLose, amount }),
  meta: {
    label: "アイテムの増減",
    category: "ゲーム進行",
    describe: (p, view) => `${view.project.database.items[p.item]?.name ?? p.item} を${describeAmount(p.amount)}個${opLabel[p.op]}`,
    refs: (p): RefTarget[] => [{ kind: "item", id: p.item }, ...amountRefs(p.amount)],
  },
  run(p, c) {
    if (c.project.item(p.item) === undefined) return { effects: [warn(`ChangeItems: アイテム ${p.item} が存在しない`)] };
    const count = Math.max(0, (c.state.party.items[p.item] ?? 0) + sign(p.op) * readAmount(p.amount, c.state.variables));
    const items = { ...c.state.party.items };
    if (count === 0) delete items[p.item];
    else items[p.item] = count;
    return { state: { ...c.state, party: { ...c.state.party, items } } };
  },
});

/** パーティにアクターを加える/外す。加えるのは末尾。存在しないアクターは警告してスキップ。 */
export const changeParty = defineCommand({
  code: "ChangeParty",
  params: z.strictObject({ actor: actorIdSchema, op: z.enum(["add", "remove"]) }),
  meta: {
    label: "パーティメンバーの入れ替え",
    category: "ゲーム進行",
    describe: (p, view) => `パーティ：${view.project.database.actors[p.actor]?.name ?? p.actor} を${p.op === "add" ? "加える" : "外す"}`,
    refs: (p) => [{ kind: "actor", id: p.actor }],
  },
  run(p, c) {
    if (c.state.actors[p.actor] === undefined) return { effects: [warn(`ChangeParty: アクター ${p.actor} が存在しない`)] };
    const members = c.state.party.members;
    const has = members.includes(p.actor);
    if (p.op === "add" ? has : !has) return {};
    return { state: { ...c.state, party: { ...c.state.party, members: p.op === "add" ? [...members, p.actor] : members.filter((m) => m !== p.actor) } } };
  },
});

const slotLabel = { weapon: "武器", armor: "防具", accessory: "装飾品" } as const;

/**
 * アクターの装備を付け替える。`item` を省略すると、その欄を外す。付けるものはパーティの持ち物から 1 つ減り、外したものは持ち物に戻る
 * （持っていないものは付けられない。先に「アイテムの増減」で渡す）。付けられないときは警告してスキップ。
 */
export const changeEquipment = defineCommand({
  code: "ChangeEquipment",
  params: z.strictObject({ actor: actorIdSchema, slot: equipSlotSchema, item: itemIdSchema.optional() }),
  meta: {
    label: "装備の変更",
    category: "ゲーム進行",
    describe: (p, view) => {
      const who = view.project.database.actors[p.actor]?.name ?? p.actor;
      const what = p.item === undefined ? "外す" : ` ${view.project.database.items[p.item]?.name ?? p.item} にする`;
      return `装備：${who} の${slotLabel[p.slot]}を${what}`;
    },
    refs: (p): RefTarget[] => [{ kind: "actor", id: p.actor }, ...(p.item === undefined ? [] : [{ kind: "item" as const, id: p.item }])],
  },
  run(p, c) {
    if (c.state.actors[p.actor] === undefined) return { effects: [warn(`ChangeEquipment: アクター ${p.actor} が存在しない`)] };
    if (p.item !== undefined && equipSlotOf(c.project.item(p.item)) !== p.slot) {
      return { effects: [warn(`ChangeEquipment: ${p.item} は ${p.slot} の欄に付けられない`)] };
    }
    const next = changeEquip(c.state, c, p.actor, p.slot, p.item);
    if (next === undefined) return { effects: [warn(`ChangeEquipment: ${p.item ?? ""} をパーティが持っていない`)] };
    return { state: next };
  },
});

const actorTarget = z.union([z.literal("party"), actorIdSchema]);
type ActorTarget = z.output<typeof actorTarget>;

function targets(target: ActorTarget, c: CommandCtx): ActorState[] {
  const ids: readonly ActorId[] = target === "party" ? c.state.party.members : [target];
  return ids.flatMap((id) => (Object.hasOwn(c.state.actors, id) ? [c.state.actors[id]!] : []));
}

function withActors(state: GameState, updated: ActorState[]): GameState {
  const actors = { ...state.actors };
  for (const a of updated) actors[a.id] = a;
  return { ...state, actors };
}

const targetRefs = (t: ActorTarget): RefTarget[] => (t === "party" ? [] : [{ kind: "actor", id: t }]);
const describeTarget = (t: ActorTarget): string => (t === "party" ? "パーティ全員" : t);

/** `a` のレベルと装備（`equips`。付け替えていなければ初期装備）での最大 HP/MP。 */
const maxOf = (c: CommandCtx, a: ActorState, param: "mhp" | "mmp"): number => Math.max(1, actorParams(c, a.id, a.level, a.equips)[param]);

/** HP の増減。`allowDeath` が偽なら 1 で止まる（戦闘不能のアクターは変わらない）。 */
export const changeHp = defineCommand({
  code: "ChangeHp",
  params: z.strictObject({ target: actorTarget.default("party"), op: gainOrLose, amount, allowDeath: z.boolean().default(false) }),
  meta: {
    label: "HP の増減",
    category: "ゲーム進行",
    describe: (p) => `${describeTarget(p.target)} の HP を${describeAmount(p.amount)}${opLabel[p.op]}`,
    refs: (p) => [...targetRefs(p.target), ...amountRefs(p.amount)],
  },
  run(p, c) {
    const delta = sign(p.op) * readAmount(p.amount, c.state.variables);
    const updated = targets(p.target, c).map((a) => {
      if (a.hp <= 0 && delta < 0) return a;
      const hp = Math.min(maxOf(c, a, "mhp"), a.hp + delta);
      return { ...a, hp: Math.max(p.allowDeath ? 0 : 1, hp) };
    });
    return { state: withActors(c.state, updated) };
  },
});

export const changeMp = defineCommand({
  code: "ChangeMp",
  params: z.strictObject({ target: actorTarget.default("party"), op: gainOrLose, amount }),
  meta: {
    label: "MP の増減",
    category: "ゲーム進行",
    describe: (p) => `${describeTarget(p.target)} の MP を${describeAmount(p.amount)}${opLabel[p.op]}`,
    refs: (p) => [...targetRefs(p.target), ...amountRefs(p.amount)],
  },
  run(p, c) {
    const delta = sign(p.op) * readAmount(p.amount, c.state.variables);
    const updated = targets(p.target, c).map((a) => ({ ...a, mp: Math.max(0, Math.min(maxOf(c, a, "mmp"), a.mp + delta)) }));
    return { state: withActors(c.state, updated) };
  },
});

/** 経験値を増やす（レベルアップする）。減らす方向は無い。 */
export const changeExp = defineCommand({
  code: "ChangeExp",
  params: z.strictObject({ target: actorTarget.default("party"), amount }),
  meta: {
    label: "経験値の増加",
    category: "ゲーム進行",
    describe: (p) => `${describeTarget(p.target)} の経験値を${describeAmount(p.amount)}増やす`,
    refs: (p) => [...targetRefs(p.target), ...amountRefs(p.amount)],
  },
  run(p, c) {
    const exp = Math.max(0, readAmount(p.amount, c.state.variables));
    return { state: withActors(c.state, targets(p.target, c).map((a) => gainExp(c, a, exp).actor)) };
  },
});

/** レベルを上げ下げする（1〜99）。経験値はそのレベルの下限に合わせ、HP/MP は新しい最大値に収める。 */
export const changeLevel = defineCommand({
  code: "ChangeLevel",
  params: z.strictObject({ target: actorTarget.default("party"), op: gainOrLose, amount }),
  meta: {
    label: "レベルの増減",
    category: "ゲーム進行",
    describe: (p) => `${describeTarget(p.target)} のレベルを${describeAmount(p.amount)}${opLabel[p.op]}`,
    refs: (p) => [...targetRefs(p.target), ...amountRefs(p.amount)],
  },
  run(p, c) {
    const delta = sign(p.op) * readAmount(p.amount, c.state.variables);
    const updated = targets(p.target, c).map((a) => {
      const level = Math.min(LEVEL_MAX, Math.max(1, a.level + delta));
      if (level === a.level) return a;
      const leveled = { ...a, level, exp: expToReach(level) };
      const mhp = maxOf(c, leveled, "mhp");
      const mmp = maxOf(c, leveled, "mmp");
      // 戦闘不能のまま、レベルだけが変わる
      return { ...leveled, hp: a.hp <= 0 ? 0 : Math.min(mhp, Math.max(1, a.hp + (level > a.level ? mhp - maxOf(c, a, "mhp") : 0))), mp: Math.min(mmp, a.mp) };
    });
    return { state: withActors(c.state, updated) };
  },
});
