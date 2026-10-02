import { z } from "@rpg/plugin-api";

const int = z.number().int();
const sprite = z.strictObject({ sx: int.min(0), sy: int.min(0) });
const floors = z.tuple([int.min(1), int.min(1)]);
const common = { key: z.string().min(1), floors: floors.default([1, 99]), weight: int.min(1).default(1), sprite };

/** 出る敵。`enemy` はデータベースの敵（ステータス・経験値・ドロップはそこから読む）。`sprite` は `sprites.asset` の中の絵（左上のピクセル）。 */
const enemyEntry = z.strictObject({
  enemy: z.string(),
  floors: floors.default([1, 99]),
  weight: int.min(1).default(1),
  sprite,
  /** `fast` は 1 ターンに 2 回、`slow` は 1 ターンおき（2 ターンに 1 回）に動く。 */
  act: z.enum(["normal", "fast", "slow"]).default("normal"),
  /** 最後の階だけに、1 体だけ出る。 */
  boss: z.boolean().default(false),
});

/** 落ちている物。`item` はアイテム（持ち物に入る）、`food` は拾うとすぐ食べて満腹度が増える、`gold` は所持金、`seed` は拾うとすぐ攻撃力が上がる。 */
const itemEntry = z.discriminatedUnion("kind", [
  z.strictObject({ ...common, kind: z.literal("item"), item: z.string() }),
  z.strictObject({ ...common, kind: z.literal("food"), name: z.string(), amount: int.min(1) }),
  z.strictObject({ ...common, kind: z.literal("gold"), min: int.min(1), max: int.min(1) }),
  z.strictObject({ ...common, kind: z.literal("seed"), name: z.string(), atk: int.min(1).default(1) }),
]);

/**
 * プラグインの設定（`system.plugins` の `params`）。
 * ひな形のマップ（`floorMap`）は、幅 × 高さがここの `width` × `height` と同じで、全マスが `tiles.rock` で、
 * 「マップの並列イベント 1 つ（`plugin:dungeon/Tick` を呼ぶ）」だけを置いたもの。フロアの地形は、入るたびに `mapTiles` に書き込む。
 */
export const configSchema = z.strictObject({
  floorMap: z.string(),
  width: int.min(24).max(96),
  height: int.min(18).max(96),
  /** 最後の階（階段の代わりに宝がある）。 */
  goalFloor: int.min(2).max(99).default(7),
  /** 倒れたとき・宝を持ち帰ったときに戻る場所。 */
  home: z.strictObject({ map: z.string(), x: int.min(0), y: int.min(0), dir: z.enum(["up", "down", "left", "right"]).default("down") }),
  tiles: z.strictObject({ rock: int.min(1), wallFace: int.min(1), floor: z.array(int.min(1)).min(1), stairs: int.min(1), treasure: int.min(1) }),
  sprites: z.strictObject({
    asset: z.string(),
    /** 1 つの絵の大きさ（ピクセル）。 */
    size: int.min(1).default(32),
    /** ドロップなど、`items` に無い物の絵。 */
    drop: sprite,
  }),
  /** 入るときに、レベル 1・HP 全回復にして、持ち物を `startItems` だけにする。 */
  resetOnEnter: z.boolean().default(true),
  startItems: z.record(z.string(), int.min(1)).default({}),
  belly: z
    .strictObject({
      max: int.min(1).default(100),
      /** 何ターンで満腹度が 1 減るか。 */
      interval: int.min(1).default(4),
      hungry: int.min(0).default(30),
      weak: int.min(0).default(10),
      /** 満腹度 0 の間、1 ターンごとに受けるダメージ。 */
      starveDamage: int.min(1).default(1),
    })
    .prefault({}),
  /** 何ターンで HP が 1 回復するか（満腹度が 0 でないとき）。 */
  regenInterval: int.min(1).default(6),
  /** 敵の数：`base + floor(階 * perFloor) + 0〜spread`。 */
  monsters: z.strictObject({ base: int.min(0).default(3), perFloor: z.number().min(0).default(0.5), spread: int.min(0).default(2) }).prefault({}),
  /** 落ちている物の数：`base + 0〜spread`。 */
  loot: z.strictObject({ base: int.min(0).default(4), spread: int.min(0).default(2) }).prefault({}),
  /** 敵がプレイヤーに気づく距離（歩いて何歩か）。 */
  sight: int.min(1).default(9),
  /** 宝を持ち帰ったときにもらえるお金。 */
  clearGold: int.min(0).default(0),
  /** ダンジョンの結果を残す変数（`variables` のキー）とスイッチ。 */
  vars: z
    .strictObject({
      /** プラグインがイベントを呼ぶための変数（0 = 何もない、1 = 倒れた、2 = 宝を手に入れた）。ひな形のマップのコントローラが見る。 */
      event: z.string().default("var_dungeon_event"),
      /** 最も深く降りた階。 */
      best: z.string().default("var_dungeon_best"),
      /** 最後の結果（1 = 倒れた、2 = 宝を持ち帰った）。 */
      result: z.string().default("var_dungeon_result"),
      /** 宝を持ち帰った回数。 */
      clears: z.string().default("var_dungeon_clears"),
    })
    .prefault({}),
  enemies: z.array(enemyEntry).min(1),
  items: z.array(itemEntry),
});

export type Config = z.infer<typeof configSchema>;
export type EnemyEntry = Config["enemies"][number];
export type ItemEntry = Config["items"][number];

export function parseConfig(params: Readonly<Record<string, unknown>>): { ok: true; config: Config } | { ok: false; message: string } {
  const r = configSchema.safeParse(params);
  if (r.success) return { ok: true, config: r.data };
  const issue = r.error.issues[0];
  return { ok: false, message: `plugin dungeon の設定が不正: ${issue?.path.join(".") ?? ""} ${issue?.message ?? ""}`.trim() };
}
