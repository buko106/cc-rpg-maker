import { z } from "zod";
import { assetIdSchema } from "./ids.js";

export const DIRECTIONS = ["up", "down", "left", "right"] as const;
export const directionSchema = z.enum(DIRECTIONS);
export type Direction = z.infer<typeof directionSchema>;

export const PARAMS = ["mhp", "mmp", "atk", "def", "mat", "mdf", "agi", "luk"] as const;
export const paramSchema = z.enum(PARAMS);
export type Param = z.infer<typeof paramSchema>;

/** 画像アセットへの参照（顔・歩行グラフィック・タイルセットなど）。`assetKind` はエディタの選択肢の絞り込み用メタデータ。 */
export const assetRefSchema = z.strictObject({ asset: assetIdSchema.meta({ ref: "asset", assetKind: "image" }) });
export type AssetRef = z.infer<typeof assetRefSchema>;

export const audioRefSchema = z.strictObject({
  asset: assetIdSchema.meta({ ref: "asset", assetKind: "audio" }),
  volume: z.number().min(0).max(1),
  pitch: z.number().min(0.1).max(4),
  loop: z.boolean(),
});
export type AudioRef = z.infer<typeof audioRefSchema>;

export const nonNegativeInt = z.number().int().min(0);
