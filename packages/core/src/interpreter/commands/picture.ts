import { assetRefSchema, nonNegativeInt } from "@rpg/schema";
import * as z from "zod";
import type { Effect } from "../../effects.js";
import { defineCommand } from "../handler.js";
import type { CommandResult } from "../handler.js";

/** ピクチャの番号。同じ番号で出し直すと置き換わり、大きい番号ほど手前に描かれる。 */
const pictureId = z.number().int().min(1).max(20);
const x = z.number().int().default(0);
const y = z.number().int().default(0);
const opacity = z.number().min(0).max(1).default(1);
/** 倍率（1 = 原寸）。 */
const scale = z.number().min(0.05).max(8).default(1);
const wait = z.boolean().default(false);

const fx = (effect: Effect, frames: number, waits: boolean): CommandResult => ({
  effects: [effect],
  control: waits && frames > 0 ? { kind: "wait", wait: { kind: "frames", left: frames } } : { kind: "next" },
});

/** 一枚絵（立ち絵・カットイン・背景）を画面に出す。見た目だけの状態で、セーブされない。 */
export const showPicture = defineCommand({
  code: "ShowPicture",
  params: z.strictObject({
    id: pictureId,
    image: assetRefSchema,
    x,
    y,
    origin: z.enum(["topLeft", "center"]).default("topLeft"),
    opacity,
    scale,
    duration: nonNegativeInt.default(0),
    wait,
  }),
  meta: {
    label: "ピクチャの表示",
    category: "画面",
    describe: (p) => `ピクチャ ${p.id} を表示：(${p.x}, ${p.y})`,
    refs: (p) => [{ kind: "asset", id: p.image.asset }],
  },
  run: (p) =>
    fx({ kind: "showPicture", id: p.id, asset: p.image.asset, x: p.x, y: p.y, origin: p.origin, opacity: p.opacity, scale: p.scale, durationTicks: p.duration }, p.duration, p.wait),
});

/** 出ているピクチャを、位置・不透明度・倍率ごと動かす。出ていないときは何もしない。 */
export const movePicture = defineCommand({
  code: "MovePicture",
  params: z.strictObject({ id: pictureId, x, y, opacity, scale, duration: nonNegativeInt.default(30), wait }),
  meta: { label: "ピクチャの移動", category: "画面", describe: (p) => `ピクチャ ${p.id} を移動：(${p.x}, ${p.y})、${p.duration}フレーム`, refs: () => [] },
  run: (p) => fx({ kind: "movePicture", id: p.id, x: p.x, y: p.y, opacity: p.opacity, scale: p.scale, durationTicks: p.duration }, p.duration, p.wait),
});

export const erasePicture = defineCommand({
  code: "ErasePicture",
  params: z.strictObject({ id: pictureId }),
  meta: { label: "ピクチャの消去", category: "画面", describe: (p) => `ピクチャ ${p.id} を消去`, refs: () => [] },
  run: (p) => ({ effects: [{ kind: "erasePicture", id: p.id }], control: { kind: "next" } }),
});
