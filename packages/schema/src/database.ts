import { z } from "zod";
import { assetRefSchema, nonNegativeInt, paramSchema } from "./common.js";
import type { Param } from "./common.js";
import { eventCommandSchema } from "./command.js";
import {
  actorIdSchema,
  classIdSchema,
  commonEventIdSchema,
  enemyIdSchema,
  idRecord,
  itemIdSchema,
  skillIdSchema,
  stateIdSchema,
  switchIdSchema,
  troopIdSchema,
} from "./ids.js";
import type { ActorId, ClassId, CommonEventId, EnemyId, ItemId, SkillId, StateId, TroopId } from "./ids.js";

export const EQUIP_SLOTS = ["weapon", "armor", "accessory"] as const;
export const equipSlotSchema = z.enum(EQUIP_SLOTS);
export type EquipSlot = z.infer<typeof equipSlotSchema>;

/** レベル `L` でのパラメータ = `base + growth * (L - 1)`。 */
export const paramCurveSchema = z.record(paramSchema, z.strictObject({ base: z.number(), growth: z.number() })) as z.ZodType<
  Record<Param, { base: number; growth: number }>
>;
export type ParamCurve = z.infer<typeof paramCurveSchema>;

export const scopeSchema = z.enum(["none", "self", "one-enemy", "all-enemies", "one-ally", "all-allies", "one-dead-ally"]);
export type Scope = z.infer<typeof scopeSchema>;

/** 強化・弱体の対象にできるパラメータ（最大 HP/MP は除く）。 */
export const BUFF_PARAMS = ["atk", "def", "mat", "mdf", "agi", "luk"] as const;
export const buffParamSchema = z.enum(BUFF_PARAMS);
export type BuffParam = z.infer<typeof buffParamSchema>;

export const skillEffectSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("recoverHp"), value: z.number() }),
  z.strictObject({ kind: z.literal("recoverMp"), value: z.number() }),
  /** 対象に状態を付与する。`chance`（0〜1）の確率で成功する。 */
  z.strictObject({ kind: z.literal("addState"), state: stateIdSchema, chance: z.number().min(0).max(1) }),
  z.strictObject({ kind: z.literal("removeState"), state: stateIdSchema }),
  /** 強化/弱体の段階を `level`（-2〜+2 の整数）だけ動かす。段階の合計は -2〜+2 に収まる。 */
  z.strictObject({ kind: z.literal("buff"), param: buffParamSchema, level: z.number().int().min(-2).max(2) }),
  z.strictObject({ kind: z.literal("commonEvent"), id: commonEventIdSchema }),
]);
export type SkillEffect = z.infer<typeof skillEffectSchema>;

export const dropSchema = z.strictObject({ item: itemIdSchema, rate: z.number().min(0).max(1) });
export type Drop = z.infer<typeof dropSchema>;

export const troopConditionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("always") }),
  z.strictObject({ kind: z.literal("turn"), turn: nonNegativeInt }),
  z.strictObject({ kind: z.literal("switch"), id: switchIdSchema }),
]);
export type TroopCondition = z.infer<typeof troopConditionSchema>;

/** 戦闘の状態異常・強化状態。 */
export const stateSchema = z.strictObject({
  id: stateIdSchema,
  name: z.string(),
  /** `cannotAct` の間は行動できない（行動順が来ても何もしない）。 */
  restriction: z.enum(["none", "cannotAct"]),
  /** 継続ターン数。0 は戦闘が終わるまで解除されない。 */
  turns: nonNegativeInt,
  /** パラメータの倍率（1 = 変化なし）。 */
  paramRates: z.partialRecord(paramSchema, z.number().min(0)),
  /** ターン終了時の HP 増減（最大 HP に対する割合。負で毒など）。 */
  hpRegen: z.number().min(-1).max(1),
});
export type State = z.infer<typeof stateSchema>;

const fullParams = z.record(paramSchema, z.number()) as z.ZodType<Record<Param, number>>;

export const actorSchema = z.strictObject({
  id: actorIdSchema,
  name: z.string(),
  classId: classIdSchema,
  initialLevel: z.number().int().min(1),
  face: assetRefSchema.optional(),
  walk: assetRefSchema.optional(),
  equips: z.partialRecord(equipSlotSchema, itemIdSchema),
});
export type Actor = z.infer<typeof actorSchema>;

export const classSchema = z.strictObject({
  id: classIdSchema,
  name: z.string(),
  params: paramCurveSchema,
  skills: z.array(z.strictObject({ level: z.number().int().min(1), skill: skillIdSchema })),
});
export type Class = z.infer<typeof classSchema>;

export const skillSchema = z.strictObject({
  id: skillIdSchema,
  name: z.string(),
  mpCost: nonNegativeInt,
  scope: scopeSchema,
  /** 05-expression.md の式言語 */
  formula: z.string(),
  effects: z.array(skillEffectSchema),
  animation: assetRefSchema.optional(),
  /** 一覧に出す説明文。省略すると式と効果から自動で作る。書いた場合はそのまま出す（`""` なら何も出さない。効果を秘密にしたい・ランダムなときなどに使う）。 */
  description: z.string().meta({ multiline: true }).optional(),
});
export type Skill = z.infer<typeof skillSchema>;

export const itemSchema = z.strictObject({
  id: itemIdSchema,
  name: z.string(),
  kind: z.enum(["consumable", "weapon", "armor", "key"]),
  price: nonNegativeInt,
  formula: z.string().optional(),
  effects: z.array(skillEffectSchema),
  params: z.partialRecord(paramSchema, z.number()).optional(),
  /** 一覧に出す説明文。省略すると効果と能力値から自動で作る。書いた場合はそのまま出す（`""` なら何も出さない。効果を秘密にしたい・ランダムなとき、コモンイベントで効果を作るときなどに使う）。 */
  description: z.string().meta({ multiline: true }).optional(),
});
export type Item = z.infer<typeof itemSchema>;

export const enemySchema = z.strictObject({
  id: enemyIdSchema,
  name: z.string(),
  params: fullParams,
  /** 戦闘画面に描く絵。中心が `Troop.members` の座標に来る。省略時は名前だけを表示する。 */
  graphic: assetRefSchema.optional(),
  actions: z.array(z.strictObject({ skill: skillIdSchema, condition: z.string().optional(), rating: z.number() })),
  drops: z.array(dropSchema),
  exp: nonNegativeInt,
  gold: nonNegativeInt,
});
export type Enemy = z.infer<typeof enemySchema>;

export const troopSchema = z.strictObject({
  id: troopIdSchema,
  name: z.string(),
  members: z.array(z.strictObject({ enemy: enemyIdSchema, x: z.number(), y: z.number() })),
  pages: z.array(z.strictObject({ condition: troopConditionSchema, commands: z.array(eventCommandSchema) })),
});
export type Troop = z.infer<typeof troopSchema>;

export const commonEventSchema = z.strictObject({
  id: commonEventIdSchema,
  name: z.string(),
  trigger: z.enum(["none", "autorun", "parallel"]),
  switch: switchIdSchema.optional(),
  commands: z.array(eventCommandSchema),
});
export type CommonEvent = z.infer<typeof commonEventSchema>;

export const databaseSchema = z.strictObject({
  actors: idRecord<ActorId, typeof actorSchema>(actorSchema),
  classes: idRecord<ClassId, typeof classSchema>(classSchema),
  skills: idRecord<SkillId, typeof skillSchema>(skillSchema),
  items: idRecord<ItemId, typeof itemSchema>(itemSchema),
  enemies: idRecord<EnemyId, typeof enemySchema>(enemySchema),
  troops: idRecord<TroopId, typeof troopSchema>(troopSchema),
  states: idRecord<StateId, typeof stateSchema>(stateSchema),
  commonEvents: idRecord<CommonEventId, typeof commonEventSchema>(commonEventSchema),
});
export type Database = z.infer<typeof databaseSchema>;
