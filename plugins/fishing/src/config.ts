import { z } from "@rpg/plugin-api";

const int = z.number().int();

/** 竿。持っている中で `zone` が最も大きいものを使う（持っていなければ `baseZone`）。`zone` は、巻き上げのバーの長さに対する、当たり判定の幅の割合。 */
const rodEntry = z.strictObject({ item: z.string(), name: z.string(), zone: z.number().min(0.05).max(0.9) });

/** エサ。持っている中で `rare` が最も大きいものを、振るたびに 1 つ使う。`bite` は、あたりが来るまでの時間にかける倍率（小さいほど早い）、`rare` は、手ごわい魚（難しさ 2 以上）の出やすさにかける倍率。 */
const baitEntry = z.strictObject({ item: z.string(), name: z.string(), bite: z.number().min(0.2).max(3).default(1), rare: z.number().min(0.1).max(10).default(1) });

/** 魚。`item` はアイテム（釣ると持ち物に入る。売る・食べるはアイテムの仕組みのまま）。`size` は大きさ（cm）の範囲、`points` は大会の基本の点数。 */
const fishEntry = z.strictObject({
  key: z.string().min(1),
  item: z.string(),
  name: z.string(),
  size: z.tuple([z.number().min(0), z.number().min(0)]),
  points: int.min(0),
  weight: z.number().min(0.01).default(1),
  /** 釣れる場所（`Cast` の `spot`）。 */
  spots: z.array(z.string().min(1)).min(1),
  /** 1（おとなしい）〜 5（暴れる）。 */
  difficulty: int.min(1).max(5).default(1),
});

/**
 * プラグインの設定（`system.plugins` の `params`）。
 * 竿・エサ・魚はデータベースのアイテムとして持つ（店で売る・メニューで食べるは、ふつうのアイテムのまま）。
 */
export const configSchema = z.strictObject({
  /** 竿を持っていないときの当たり判定の幅。 */
  baseZone: z.number().min(0.05).max(0.9).default(0.2),
  rods: z.array(rodEntry).default([]),
  baits: z.array(baitEntry).default([]),
  fish: z.array(fishEntry).min(1),
  tournament: z
    .strictObject({
      /** 制限時間（秒）。ゲームのタイマー（`ControlTimer`）で数える。 */
      seconds: int.min(10).max(3600).default(120),
      /** 競う相手。`skill` は、制限時間の間に取る点数のめやす（実際は 7 〜 13 割でばらつく）。 */
      rivals: z.array(z.strictObject({ name: z.string(), skill: int.min(0) })).default([]),
      /** 順位ごとの賞金（1 位から）。足りない順位は 0。 */
      prizes: z.array(int.min(0)).default([]),
      /** 1 位のときにもらうアイテム。 */
      trophy: z.string().optional(),
    })
    .prefault({}),
  /** 結果を残す変数（`variables` のキー）。 */
  vars: z
    .strictObject({
      /** プラグインがイベントを呼ぶための変数（1 = 制限時間が来た）。大会の進行役の自動実行ページが見る。 */
      event: z.string().default("var_fishing_event"),
      /** 釣ったことのある魚の種類の数。 */
      species: z.string().default("var_fishing_species"),
      /** 最後の大会の順位（0 = まだ出ていない）。 */
      rank: z.string().default("var_fishing_rank"),
      /** 最後の大会の点数。 */
      score: z.string().default("var_fishing_score"),
      /** 大会で 1 位になった回数。 */
      wins: z.string().default("var_fishing_wins"),
    })
    .prefault({}),
});

export type Config = z.infer<typeof configSchema>;
export type FishEntry = Config["fish"][number];
export type RodEntry = Config["rods"][number];
export type BaitEntry = Config["baits"][number];

export function parseConfig(params: Readonly<Record<string, unknown>>): { ok: true; config: Config } | { ok: false; message: string } {
  const r = configSchema.safeParse(params);
  if (!r.success) {
    const issue = r.error.issues[0];
    return { ok: false, message: `plugin fishing の設定が不正: ${issue?.path.join(".") ?? ""} ${issue?.message ?? ""}`.trim() };
  }
  const bad = r.data.fish.find((f) => f.size[0] > f.size[1]);
  if (bad !== undefined) return { ok: false, message: `plugin fishing の設定が不正: fish.${bad.key}.size は [小さい方, 大きい方] の順に書く` };
  const dup = r.data.fish.find((f, i) => r.data.fish.findIndex((g) => g.key === f.key) !== i);
  if (dup !== undefined) return { ok: false, message: `plugin fishing の設定が不正: fish の key ${dup.key} が重なっている` };
  return { ok: true, config: r.data };
}
