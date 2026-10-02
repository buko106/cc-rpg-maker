import { z } from "zod";
import { actorIdSchema, idRecord, mapIdSchema, tilesetIdSchema } from "./ids.js";
import type { AssetId, MapId, SwitchId, TilesetId, VariableId } from "./ids.js";
import { assetRefSchema, audioRefSchema, nonNegativeInt, speedEffectSchema, speedLevelSchema } from "./common.js";
import { databaseSchema } from "./database.js";
import { mapMetaSchema, stateConditionSchema } from "./map.js";

/** 現在のフォーマットバージョン。`Project` / `MapData` の構造を変えるときは上げ、マイグレーションを追加する。 */
export const CURRENT_FORMAT_VERSION = 2 as const;

export const tilesetSchema = z.strictObject({
  id: tilesetIdSchema,
  name: z.string(),
  image: assetRefSchema.optional(),
  /**
   * タイル ID をインデックスとする通行可能方向のビットマスク（下=1, 左=2, 右=4, 上=8）。
   * 範囲外のタイルは全方向通行可（15）として扱う。
   */
  passage: z.array(z.number().int().min(0).max(15)),
  /**
   * 氷（滑る床）のタイル ID。歩いてこのタイルに着くと、同じ向きに止まるまで（壁・通れないイベント・向こうの接触イベントに突き当たるまで）滑り続ける。
   * どのレイヤにあっても滑る。省略 = 滑るタイルは無い。
   */
  ice: z.array(z.number().int().min(1)).optional(),
  /**
   * 足元のタイルによる歩く速さの変化（砂地・沼など）。キーはタイル ID（`1` 以上の整数を文字列にしたもの）。
   * プレイヤーが歩き出すとき、いま立っているタイルがどのレイヤにあっても効く。複数のタイルが重なれば、`speed` は足し合わせ、`noDash` はどれか 1 つでも真なら走れない。
   * 省略 = 変化なし。
   */
  terrain: z.record(z.string().regex(/^[1-9][0-9]*$/), speedEffectSchema).optional(),
});
export type Tileset = z.infer<typeof tilesetSchema>;

/**
 * ゲームの状態による歩く速さの変化（空腹だと遅い、など）。`when` がすべて成り立っているとき効く（空 = いつでも）。
 * 条件は、イベントのページと同じ種類（スイッチ・変数・所持品・パーティ。セルフスイッチは除く）。
 */
export const speedRuleSchema = z.strictObject({
  when: z.array(stateConditionSchema).meta({ title: "条件（すべて満たすとき。空ならいつでも）" }),
  speed: speedEffectSchema.shape.speed,
  noDash: speedEffectSchema.shape.noDash,
});
export type SpeedRule = z.infer<typeof speedRuleSchema>;

export const pluginRefSchema = z.strictObject({
  /** `PluginModule.name`。コマンドの code の接頭辞（`plugin:<name>/`）になる。 */
  name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  version: z.string(),
  params: z.record(z.string(), z.unknown()),
});
export type PluginRef = z.infer<typeof pluginRefSchema>;

export const systemSettingsSchema = z
  .strictObject({
    startMap: mapIdSchema,
    startX: nonNegativeInt,
    startY: nonNegativeInt,
    initialParty: z.array(actorIdSchema),
    tileSize: z.union([z.literal(16), z.literal(32), z.literal(48)]),
    screen: z.strictObject({ width: z.number().int().min(1), height: z.number().int().min(1) }),
    bgm: z.strictObject({ title: audioRefSchema.optional(), battle: audioRefSchema.optional() }),
    /** メインメニューに「セーブ」を出すか。省略 = 出す。`false` でも、イベントの `SaveGame`（セーブポータル）からはセーブできる。 */
    menuSave: z.boolean().optional(),
    /** メインメニューに「スキル」（回復スキルのフィールド使用）を出すか。省略 = 出さない。 */
    menuSkill: z.boolean().optional(),
    /** オートセーブ（スロット 0）。省略 = しない。`onTransfer` は場所移動のたびに保存する（docs/06-runtime.md）。 */
    autosave: z.strictObject({ onTransfer: z.boolean() }).optional(),
    /**
     * 向きだけ変える操作（振り向き）。省略 = 無効。
     * `true` のとき、いま向いている方向と違う方向キーを**押した瞬間**は、移動せずその向きに変わるだけ（手数にも数えない）。そのまま押し続ける・もう一度押すと歩き出す。
     */
    turnInPlace: z.boolean().optional(),
    /** 歩く速さ（1〜6。4 が標準）。省略 = 変えない（マップの `walkSpeed` があればそれに従う）。マップに入るたびに、マップの `walkSpeed`、無ければこの値になる。 */
    walkSpeed: speedLevelSchema.optional(),
    /**
     * 走る機能。省略 = 走れない（操作パッドにも走るボタンは出ない）。
     * 方向キーを押しながら Shift（ゲームパッドは X / RT、スマホは操作パッドの走るボタン）で、歩く速さを `bonus` 段階（既定 1）速くする。
     * マップの `noDash`、足元のタイル（`Tileset.terrain`）、状態（`speedRules`）の `noDash` で、走れない場所・状態を決める。
     */
    dash: z.strictObject({ bonus: z.number().int().min(1).max(3).optional().meta({ title: "走ると速くなる段階（既定 1）" }) }).optional(),
    /** ゲームの状態による歩く速さの変化。省略 = なし。 */
    speedRules: z.array(speedRuleSchema).optional(),
    /** UI 文言 */
    terms: z.record(z.string(), z.string()),
    /** このプロジェクトが使うプラグイン（docs/14-plugin-api.md）。`params` は各プラグインが解釈する。 */
    plugins: z.array(pluginRefSchema),
  })
  // エディタ用のメタデータ：開始位置をマップのクリックで選べる（検証には影響しない）
  .meta({ location: { map: "startMap", x: "startX", y: "startY" } });
export type SystemSettings = z.infer<typeof systemSettingsSchema>;

export const assetEntrySchema = z.strictObject({
  name: z.string(),
  kind: z.enum(["image", "audio", "font", "data"]),
  mime: z.string(),
  size: nonNegativeInt,
  width: nonNegativeInt.optional(),
  height: nonNegativeInt.optional(),
});
export type AssetEntry = z.infer<typeof assetEntrySchema>;

/** アセットのバイナリ本体は含めない。`AssetId`（内容ハッシュ）で参照し、実体は `assets` / `project-store` が扱う。 */
export const assetManifestSchema = z.strictObject({
  entries: z.record(z.string().regex(/^[0-9a-f]{16}$/), assetEntrySchema) as unknown as z.ZodType<Record<AssetId, AssetEntry>>,
});
export type AssetManifest = z.infer<typeof assetManifestSchema>;

const nameOnly = z.strictObject({ name: z.string() });

export const ProjectSchema = z
  .strictObject({
    formatVersion: z.number().int().min(1),
    meta: z.strictObject({
      id: z.string().min(1),
      title: z.string(),
      createdAt: z.iso.datetime({ offset: true }),
      updatedAt: z.iso.datetime({ offset: true }),
    }),
    system: systemSettingsSchema,
    /** 本体は MapData として別ファイル */
    maps: idRecord<MapId, typeof mapMetaSchema>(mapMetaSchema),
    tilesets: idRecord<TilesetId, typeof tilesetSchema>(tilesetSchema),
    database: databaseSchema,
    assets: assetManifestSchema,
    switches: idRecord<SwitchId, typeof nameOnly>(nameOnly),
    variables: idRecord<VariableId, typeof nameOnly>(nameOnly),
  })
  .superRefine((p, ctx) => {
    // 不変条件 4: すべての Record<Id, T> で key === value.id
    const tables: [string, Record<string, { id: string }>][] = [
      ["maps", p.maps],
      ["tilesets", p.tilesets],
      ["database.actors", p.database.actors],
      ["database.classes", p.database.classes],
      ["database.skills", p.database.skills],
      ["database.items", p.database.items],
      ["database.enemies", p.database.enemies],
      ["database.troops", p.database.troops],
      ["database.states", p.database.states],
      ["database.commonEvents", p.database.commonEvents],
    ];
    for (const [table, records] of tables) {
      for (const [key, value] of Object.entries(records)) {
        if (key !== value.id) {
          ctx.addIssue({ code: "custom", path: [...table.split("."), key, "id"], message: `キー ${key} と id ${value.id} が一致しない` });
        }
      }
    }
  });
export type Project = z.infer<typeof ProjectSchema>;
