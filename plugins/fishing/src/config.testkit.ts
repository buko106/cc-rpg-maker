// テスト専用：釣りの設定の見本。
import { parseConfig } from "./config.js";
import type { Config } from "./config.js";

export const sampleParams = {
  baseZone: 0.2,
  rods: [
    { item: "item_rod1", name: "つりざお", zone: 0.28 },
    { item: "item_rod2", name: "ぐんじょう竿", zone: 0.36 },
  ],
  baits: [
    { item: "item_worm", name: "ミミズ", bite: 0.8, rare: 1 },
    { item: "item_lure", name: "ルアー", bite: 0.5, rare: 3 },
  ],
  fish: [
    { key: "iwashi", item: "item_iwashi", name: "イワシ", size: [8, 20], points: 6, weight: 12, spots: ["pier"], difficulty: 1 },
    { key: "aji", item: "item_aji", name: "アジ", size: [10, 25], points: 10, weight: 10, spots: ["pier", "rocks"], difficulty: 1 },
    { key: "kasago", item: "item_kasago", name: "カサゴ", size: [15, 35], points: 20, weight: 5, spots: ["rocks"], difficulty: 2 },
    { key: "suzuki", item: "item_suzuki", name: "スズキ", size: [40, 80], points: 60, weight: 3, spots: ["deep"], difficulty: 3 },
    { key: "tai", item: "item_tai", name: "マダイ", size: [40, 90], points: 90, weight: 2, spots: ["deep"], difficulty: 4 },
    { key: "maguro", item: "item_maguro", name: "まぼろしのマグロ", size: [100, 180], points: 250, weight: 0.5, spots: ["deep"], difficulty: 5 },
  ],
  tournament: { seconds: 60, rivals: [{ name: "ゴンさん", skill: 120 }, { name: "ミナ", skill: 80 }], prizes: [1000, 500, 200], trophy: "item_trophy" },
};

export function sampleConfig(patch: (p: Record<string, unknown>) => Record<string, unknown> = (p) => p): Config {
  const r = parseConfig(patch({ ...sampleParams }));
  if (!r.ok) throw new Error(r.message);
  return r.config;
}

/** 決定論的な乱数（mulberry32）。 */
export function rngOf(seed: number): { next(): number } {
  let a = seed >>> 0;
  return {
    next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}
