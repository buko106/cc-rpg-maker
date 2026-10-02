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
  z.strictObject({ kind: z.literal("move"), dir: z.union([directionSchema, z.enum(["random", "toward", "away", "chase"])]) }),
  z.strictObject({ kind: z.literal("turn"), dir: directionSchema }),
  z.strictObject({ kind: z.literal("wait"), frames: nonNegativeInt }),
  z.strictObject({ kind: z.literal("speed"), value: z.number().int().min(1).max(6) }),
]);
export type MoveStep = z.infer<typeof moveStepSchema>;

export const moveRouteSchema = z.strictObject({
  repeat: z.boolean(),
  skippable: z.boolean(),
  steps: z.array(moveStepSchema),
  /**
   * ルートの進み方。`frames`（既定）は時間で進む。`playerStep` は、プレイヤーが 1 手（歩く・押す・決定ボタンで足踏み）打つたびに進む
   * ターン制：`move` は 1 手につき 1 歩、`wait` の `frames` は待つ手数、`turn` と `speed` は時間がかからない。通れないときはその手をあきらめる。
   */
  pace: z.enum(["frames", "playerStep"]).optional(),
});
export type MoveRoute = z.infer<typeof moveRouteSchema>;

export const eventPageSchema = z.strictObject({
  /** すべて満たすと有効 */
  conditions: z.array(pageConditionSchema),
  graphic: z.strictObject({ asset: assetIdSchema.meta({ ref: "asset", assetKind: "image" }), index: nonNegativeInt, direction: directionSchema.meta({ initial: "down" }) }).optional(),
  /**
   * いつ始まるか。`touch` はプレイヤーから触れたとき（突き当たる・上に乗る）、`eventTouch` はそれに加えて、
   * このイベント（通常プライオリティ）が移動ルートでプレイヤーの居るタイルへ進もうとしたとき（向こうから触れてきたとき）。
   * `eventSight` は `eventTouch` に加えて、プレイヤーが `sightRange` タイル以内の正面に見えたとき（見張りの視界）。
   */
  trigger: z.enum(["action", "touch", "eventTouch", "eventSight", "autorun", "parallel"]),
  /** `eventSight` の視界の長さ（タイル数、既定 4）。向いている方向の直線で、通れないタイル・イベントがあるとそこでさえぎられる。 */
  sightRange: z.number().int().min(1).max(20).optional(),
  through: z.boolean(),
  priority: z.enum(["below", "same", "above"]),
  /**
   * 押せるイベント（岩・箱など）。プレイヤーが突き当たると、押した向きに 1 タイル動く（その先が通れるときだけ）。
   * 通常プライオリティ（`same`）で `through` でないページに意味がある。
   */
  pushable: z.boolean().optional(),
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
    /** ランダムエンカウント。歩くたびに（`encounterStep` 歩に 1 回ほど）、`weight` の比でトループを選んで戦闘になる。省略または空 = 出ない。 */
    encounters: z.array(z.strictObject({ troop: troopIdSchema, weight: z.number().positive() })).optional(),
    /** ランダムエンカウントの平均歩数。省略 = 30。戦闘（逃走を含む）の直後は、この半分ほどは遭遇しない。 */
    encounterStep: z.number().int().min(1).max(999).optional(),
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
