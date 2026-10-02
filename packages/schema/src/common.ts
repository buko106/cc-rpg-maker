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

/** 歩く速さの段階（1〜6）。1 段階ごとに 2 倍（4 で 16 フレーム/タイル、5 で 8、3 で 32）。 */
export const speedLevelSchema = z.number().int().min(1).max(6);

/**
 * 足元のタイル・ゲームの状態によって変わる、歩く速さへの影響。
 * `speed` は段階の増減（マイナスで遅く、プラスで速く。省略 = 0）、`noDash` が真なら走れない。
 */
export const speedEffectSchema = z.strictObject({
  // `title` はエディタのフォームの見出し（検証には影響しない）
  speed: z.number().int().min(-5).max(5).optional().meta({ title: "歩く速さの増減（段階。マイナスで遅く）" }),
  noDash: z.boolean().optional(),
});
export type SpeedEffect = z.infer<typeof speedEffectSchema>;
