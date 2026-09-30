import { z } from "zod";
import { assetIdSchema, actorIdSchema, eventIdSchema, idRecord, itemIdSchema, mapIdSchema, switchIdSchema, tilesetIdSchema, troopIdSchema, variableIdSchema } from "./ids.js";
import type { EventId } from "./ids.js";
import { audioRefSchema, directionSchema, nonNegativeInt } from "./common.js";
import { eventCommandSchema } from "./command.js";

export const mapMetaSchema = z.strictObject({
  id: mapIdSchema,
  name: z.string(),
  parent: mapIdSchema.optional(),
  order: z.number().int(),
});
export type MapMeta = z.infer<typeof mapMetaSchema>;

export const pageConditionSchema = z.discriminatedUnion("kind", [
  // `initial` はエディタで新しく作るときの初期値（検証には影響しない）
  z.strictObject({ kind: z.literal("switch"), id: switchIdSchema, value: z.boolean().meta({ initial: true }) }),
  z.strictObject({ kind: z.literal("variable"), id: variableIdSchema, op: z.enum([">=", "==", "<="]), value: z.number() }),
  z.strictObject({ kind: z.literal("selfSwitch"), key: z.enum(["A", "B", "C", "D"]), value: z.boolean().meta({ initial: true }) }),
  z.strictObject({ kind: z.literal("item"), id: itemIdSchema }),
  z.strictObject({ kind: z.literal("actor"), id: actorIdSchema }),
]);
export type PageCondition = z.infer<typeof pageConditionSchema>;

export const moveStepSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("move"), dir: z.union([directionSchema, z.enum(["random", "toward", "away"])]) }),
  z.strictObject({ kind: z.literal("turn"), dir: directionSchema }),
  z.strictObject({ kind: z.literal("wait"), frames: nonNegativeInt }),
  z.strictObject({ kind: z.literal("speed"), value: z.number().int().min(1).max(6) }),
]);
export type MoveStep = z.infer<typeof moveStepSchema>;

export const moveRouteSchema = z.strictObject({
  repeat: z.boolean(),
  skippable: z.boolean(),
  steps: z.array(moveStepSchema),
});
export type MoveRoute = z.infer<typeof moveRouteSchema>;

export const eventPageSchema = z.strictObject({
  /** すべて満たすと有効 */
  conditions: z.array(pageConditionSchema),
  graphic: z.strictObject({ asset: assetIdSchema.meta({ ref: "asset", assetKind: "image" }), index: nonNegativeInt, direction: directionSchema }).optional(),
  trigger: z.enum(["action", "touch", "autorun", "parallel"]),
  through: z.boolean(),
  priority: z.enum(["below", "same", "above"]),
  moveRoute: moveRouteSchema.optional(),
  commands: z.array(eventCommandSchema),
});
export type EventPage = z.infer<typeof eventPageSchema>;

export const mapEventSchema = z.strictObject({
  id: eventIdSchema,
  name: z.string(),
  x: nonNegativeInt,
  y: nonNegativeInt,
  /** 後ろのページほど優先 */
  pages: z.array(eventPageSchema),
});
export type MapEvent = z.infer<typeof mapEventSchema>;

const tileValue = z.number().int().min(0).max(0xffff);
export const tileLayerSchema = z.strictObject({
  name: z.string(),
  /** `width * height` 個。0 = 空。JSON 上は number[]、メモリ上は Uint16Array でもよい。 */
  tiles: z.union([z.instanceof(Uint16Array) as z.ZodType<Uint16Array>, z.array(tileValue)]),
});
export type TileLayer = z.infer<typeof tileLayerSchema>;

export const MapDataSchema = z
  .strictObject({
    id: mapIdSchema,
    width: z.number().int().min(1),
    height: z.number().int().min(1),
    tileset: tilesetIdSchema,
    /** 描画順。長さ >= 1 */
    layers: z.array(tileLayerSchema).min(1),
    events: idRecord<EventId, typeof mapEventSchema>(mapEventSchema),
    bgm: audioRefSchema.optional(),
    encounters: z.array(z.strictObject({ troop: troopIdSchema, weight: z.number().positive() })).optional(),
  })
  .superRefine((map, ctx) => {
    const cells = map.width * map.height;
    map.layers.forEach((layer, i) => {
      if (layer.tiles.length !== cells) {
        ctx.addIssue({
          code: "custom",
          path: ["layers", i, "tiles"],
          message: `tiles の長さは width*height = ${cells} でなければならない（実際: ${layer.tiles.length}）`,
        });
      }
    });
    for (const [key, ev] of Object.entries(map.events)) {
      if (key !== ev.id) ctx.addIssue({ code: "custom", path: ["events", key, "id"], message: `キー ${key} と id ${ev.id} が一致しない` });
      if (ev.x >= map.width || ev.y >= map.height) {
        ctx.addIssue({ code: "custom", path: ["events", key], message: `イベント位置 (${ev.x},${ev.y}) がマップ外` });
      }
    }
  });
export type MapData = z.infer<typeof MapDataSchema>;
