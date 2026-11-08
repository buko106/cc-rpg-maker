import { nonNegativeInt } from "@rpg/schema";
import * as z from "zod";
import type { Effect } from "../../effects.js";
import { defineCommand } from "../handler.js";
import type { CommandResult } from "../handler.js";

/** 色は r/g/b が 0〜255、a が 0〜1。 */
const rgb = z.number().min(0).max(255);
const color = z.strictObject({ r: rgb, g: rgb, b: rgb, a: z.number().min(0).max(1) });
const duration = nonNegativeInt.default(30);
const wait = z.boolean().default(false);

/** 画面効果を発行し、`wait` が真で時間があるならその分だけ待つ。効果の実行そのものは runtime（見た目だけの状態）。 */
const fx = (effect: Effect, frames: number, waits: boolean): CommandResult => ({
  effects: [effect],
  control: waits && frames > 0 ? { kind: "wait", wait: { kind: "frames", left: frames } } : { kind: "next" },
});

export const shakeScreen = defineCommand({
  code: "ShakeScreen",
  params: z.strictObject({ power: z.number().min(0).max(20).default(5), duration, wait }),
  meta: { label: "画面のシェイク", category: "画面", describe: (p) => `シェイク：強さ ${p.power}、${p.duration}フレーム`, refs: () => [] },
  run: (p) => fx({ kind: "screenShake", power: p.power, durationTicks: p.duration }, p.duration, p.wait),
});

export const flashScreen = defineCommand({
  code: "FlashScreen",
  params: z.strictObject({ color: color.default({ r: 255, g: 255, b: 255, a: 1 }), duration, wait }),
  meta: { label: "画面のフラッシュ", category: "画面", describe: (p) => `フラッシュ：${p.duration}フレーム`, refs: () => [] },
  run: (p) => fx({ kind: "screenFlash", color: p.color, durationTicks: p.duration }, p.duration, p.wait),
});

/** 画面の色調を変える（`a` = 0 で元に戻る）。 */
export const tintScreen = defineCommand({
  code: "TintScreen",
  params: z.strictObject({ color, duration, wait }),
  meta: { label: "画面の色調変更", category: "画面", describe: (p) => `色調変更：${p.duration}フレーム`, refs: () => [] },
  run: (p) => fx({ kind: "screenTint", color: p.color, durationTicks: p.duration }, p.duration, p.wait),
});

export const fadeout = defineCommand({
  code: "Fadeout",
  params: z.strictObject({ duration, wait: z.boolean().default(true) }),
  meta: { label: "画面のフェードアウト", category: "画面", describe: (p) => `フェードアウト：${p.duration}フレーム`, refs: () => [] },
  run: (p) => fx({ kind: "screenFade", to: 1, durationTicks: p.duration }, p.duration, p.wait),
});

export const fadein = defineCommand({
  code: "Fadein",
  params: z.strictObject({ duration, wait: z.boolean().default(true) }),
  meta: { label: "画面のフェードイン", category: "画面", describe: (p) => `フェードイン：${p.duration}フレーム`, refs: () => [] },
  run: (p) => fx({ kind: "screenFade", to: 0, durationTicks: p.duration }, p.duration, p.wait),
});

/** 天気（雨・雪・花びら・ほこり・蛍）を降らせる。`none` で止む。マップを移っても続くので、止めるまで降る。 */
export const setWeather = defineCommand({
  code: "SetWeather",
  params: z.strictObject({ weather: z.enum(["none", "rain", "snow", "petals", "dust", "fireflies"]).default("rain"), intensity: z.number().int().min(1).max(10).default(5) }),
  meta: {
    label: "天気の変更",
    category: "画面",
    describe: (p) => (p.weather === "none" ? "天気：止める" : `天気：${WEATHER_LABELS[p.weather]}（強さ ${p.intensity}）`),
    refs: () => [],
  },
  run: (p) => fx({ kind: "setWeather", weather: p.weather, intensity: p.intensity }, 0, false),
});

const WEATHER_LABELS = { rain: "雨", snow: "雪", petals: "花びら", dust: "ほこり", fireflies: "蛍" } as const;
