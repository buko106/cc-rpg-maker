# 01. `@rpg/schema` — プロジェクトデータ型・バリデーション・マイグレーション

## 責務
- ゲーム定義（Project）の**唯一の正**となる TypeScript 型と zod スキーマを提供する。
- JSON との相互変換（parse / serialize）と検証。
- フォーマットバージョン管理とマイグレーション。
- 参照整合性の検証に必要な「参照グラフ」の抽出ヘルパ。

## 非責務
- ゲームの意味論（ダメージ計算、イベント実行）。→ `core`
- 永続化（どこに保存するか）。→ `project-store`
- 編集操作（Undo/Redo）。→ `editor-core`

## 依存が許されるパッケージ
なし（`zod` のみ外部依存）。`tsconfig.lib` に `DOM` を含めない。

## 公開インターフェース

### ID 型
```ts
export type MapId = Brand<string, "MapId">;
export type EventId = Brand<string, "EventId">;
export type TilesetId = Brand<string, "TilesetId">;
export type ActorId = Brand<string, "ActorId">;
export type ClassId = Brand<string, "ClassId">;
export type SkillId = Brand<string, "SkillId">;
export type ItemId = Brand<string, "ItemId">;
export type EnemyId = Brand<string, "EnemyId">;
export type TroopId = Brand<string, "TroopId">;
export type CommonEventId = Brand<string, "CommonEventId">;
export type AssetId = Brand<string, "AssetId">;   // 内容ハッシュ（sha256 先頭16桁）
export type SwitchId = Brand<string, "SwitchId">;
export type VariableId = Brand<string, "VariableId">;

export function newId<T extends string>(prefix: string): Brand<string, T>; // ulid ベース
```

### Project
```ts
export const CURRENT_FORMAT_VERSION = 1 as const;

export interface Project {
  formatVersion: number;
  meta: { id: string; title: string; createdAt: string; updatedAt: string };
  system: SystemSettings;
  maps: Record<MapId, MapMeta>;         // 本体は MapData として別ファイル
  tilesets: Record<TilesetId, Tileset>;
  database: Database;
  assets: AssetManifest;
  switches: Record<SwitchId, { name: string }>;
  variables: Record<VariableId, { name: string }>;
}

export interface Database {
  actors: Record<ActorId, Actor>;
  classes: Record<ClassId, Class>;
  skills: Record<SkillId, Skill>;
  items: Record<ItemId, Item>;
  enemies: Record<EnemyId, Enemy>;
  troops: Record<TroopId, Troop>;
  commonEvents: Record<CommonEventId, CommonEvent>;
}

export interface SystemSettings {
  startMap: MapId; startX: number; startY: number;
  initialParty: ActorId[];
  tileSize: 16 | 32 | 48;
  screen: { width: number; height: number };
  bgm: { title?: AudioRef; battle?: AudioRef };
  terms: Record<string, string>;         // UI文言
}
```

### Map（別ファイル）
```ts
export interface MapMeta { id: MapId; name: string; parent?: MapId; order: number }

export interface MapData {
  id: MapId;
  width: number; height: number;
  tileset: TilesetId;
  layers: TileLayer[];                    // 描画順。長さ >= 1
  events: Record<EventId, MapEvent>;
  bgm?: AudioRef;
  encounters?: { troop: TroopId; weight: number }[];
}

export interface TileLayer { name: string; tiles: Uint16Array | number[] }  // width*height、0 = 空

export interface MapEvent {
  id: EventId; name: string; x: number; y: number;
  pages: EventPage[];                     // 後ろのページほど優先
}

export interface EventPage {
  conditions: PageCondition[];            // すべて満たすと有効
  graphic?: { asset: AssetId; index: number; direction: Direction };
  trigger: "action" | "touch" | "autorun" | "parallel";
  through: boolean; priority: "below" | "same" | "above";
  moveRoute?: MoveRoute;
  commands: EventCommand[];
}

export type PageCondition =
  | { kind: "switch"; id: SwitchId; value: boolean }
  | { kind: "variable"; id: VariableId; op: ">=" | "==" | "<="; value: number }
  | { kind: "selfSwitch"; key: "A" | "B" | "C" | "D"; value: boolean }
  | { kind: "item"; id: ItemId }
  | { kind: "actor"; id: ActorId };
```

### EventCommand
```ts
export interface EventCommand {
  code: string;                           // 例 "ShowText", "ControlSwitches", "plugin:foo/Bar"
  params: Record<string, unknown>;        // コマンドごとのスキーマは CommandHandler が定義（03）
  indent: number;                         // 分岐ネストの深さ
}
```
`schema` は `code`/`params` の中身を検証しない。検証は `core` のコマンドレジストリが持つ zod スキーマで行う。`schema` は「構造として正しい」ことだけを保証する。

### Database エンティティ（抜粋）
```ts
export interface Actor { id: ActorId; name: string; classId: ClassId; initialLevel: number;
  face?: AssetRef; walk?: AssetRef; equips: Partial<Record<EquipSlot, ItemId>> }
export interface Class { id: ClassId; name: string; params: ParamCurve; skills: { level: number; skill: SkillId }[] }
export interface Skill { id: SkillId; name: string; mpCost: number; scope: Scope;
  formula: string;                        // 05-expression.md の式言語
  effects: SkillEffect[]; animation?: AssetRef }
export interface Item { id: ItemId; name: string; kind: "consumable" | "weapon" | "armor" | "key";
  price: number; formula?: string; effects: SkillEffect[]; params?: Partial<Record<Param, number>> }
export interface Enemy { id: EnemyId; name: string; params: Record<Param, number>;
  actions: { skill: SkillId; condition?: string; rating: number }[]; drops: Drop[]; exp: number; gold: number }
export interface Troop { id: TroopId; name: string; members: { enemy: EnemyId; x: number; y: number }[];
  pages: { condition: TroopCondition; commands: EventCommand[] }[] }
export interface CommonEvent { id: CommonEventId; name: string;
  trigger: "none" | "autorun" | "parallel"; switch?: SwitchId; commands: EventCommand[] }

export type Param = "mhp" | "mmp" | "atk" | "def" | "mat" | "mdf" | "agi" | "luk";
export type AssetRef = { asset: AssetId };
export type AudioRef = { asset: AssetId; volume: number; pitch: number; loop: boolean };
```

### AssetManifest
```ts
export interface AssetManifest {
  entries: Record<AssetId, { name: string; kind: "image" | "audio" | "font" | "data";
                             mime: string; size: number; width?: number; height?: number }>;
}
```
アセットの**バイナリ本体は schema に含めない**。`AssetId`（内容ハッシュ）で参照し、実体は `assets` / `project-store` が扱う。

### zod スキーマと parse
```ts
export const ProjectSchema: z.ZodType<Project>;
export const MapDataSchema: z.ZodType<MapData>;

export function parseProject(json: unknown): Result<Project, SchemaError>;   // migrate を含む
export function parseMapData(json: unknown, formatVersion: number): Result<MapData, SchemaError>;
export function serializeProject(p: Project): unknown;                        // JSON 化可能な plain object
export function serializeMapData(m: MapData): unknown;
```

### マイグレーション
```ts
export interface Migration {
  from: number; to: number;               // to === from + 1
  migrateProject(p: unknown): unknown;
  migrateMap(m: unknown): unknown;
}
export const migrations: readonly Migration[];
export function migrateTo(json: unknown, target: number): Result<unknown, SchemaError>;
```
- `parseProject` は `formatVersion < CURRENT` なら自動でマイグレーションを順次適用し、その後スキーマ検証する。
- `formatVersion > CURRENT` はエラー（`SchemaError.kind === "newer-format"`）。

### 参照グラフ
```ts
export type RefTarget = { kind: "actor" | "skill" | "item" | "enemy" | "troop" | "map" | "commonEvent" | "asset" | "switch" | "variable"; id: string };
export function collectRefs(p: Project, maps: Record<MapId, MapData>, resolveCommandRefs: (c: EventCommand) => RefTarget[]): { from: string; to: RefTarget }[];
export function findDanglingRefs(...): RefTarget[];
```
コマンド内の参照はコマンド定義側が知っているため、`resolveCommandRefs` を注入する。

## 不変条件
1. `serializeProject(parseProject(j).value)` は `j`（マイグレーション後）と deep-equal。
2. 任意の `fixtures/projects/v{n}/*.json` は `parseProject` で成功し、`formatVersion === CURRENT` になる。
3. `MapData.layers[i].tiles.length === width * height`。
4. すべての `Record<Id, T>` で `key === value.id`。
5. `AssetId` は本体バイナリの sha256 先頭16桁と一致する（`assets` パッケージで検証、schema は形式のみ検査）。

## テスト要件
- zod スキーマの正常系・異常系（欠落・型違い・不正ID）。
- ラウンドトリップのプロパティテスト（fast-check の arbitrary を `test-utils/arbitraries/schema.ts` に置き、他パッケージも利用する）。
- 各 `Migration` について `fixtures/projects/v{from}/` → `v{to}/expected/` の比較テスト。
- `findDanglingRefs` のテーブル駆動テスト。

## 完了条件
- 上記の公開インターフェースがすべてエクスポートされ、型テスト（`tsd` または `expectTypeOf`）が通る。
- `fixtures/projects/v1/minimal.json`（マップ1枚・アクター1人・イベント1つ）が作成され、parse できる。
- 依存ルール検査で `DOM` 参照ゼロ。

## 実装メモ（M1 で確定した点）
- **型は zod スキーマから導出**する（`z.infer`）。ID はブランド型、`Record<Id, T>` のキーは `[A-Za-z0-9_-]{1,64}`（`:` を含めない。セルフスイッチのキー `${MapId}:${EventId}:${key}` を曖昧さなく分解するため）。`AssetId` は `[0-9a-f]{16}`。
- **未知のキーはエラー**（`z.strictObject`）。typo を検出し、不変条件 1（ラウンドトリップ）を成り立たせるため。
- `newId(prefix, source?)` は `IdSource`（`now()` / `random()`）を任意で受け取る。省略時は `Date.now` と Web Crypto。
- ドキュメントで未定義だった型の定義：`Tileset { id, name, image?, passage: number[] }`（`passage[tileId]` は通行可能方向のビットマスク：下=1, 左=2, 右=4, 上=8。範囲外は全方向可）、`ParamCurve = Record<Param, { base, growth }>`（レベル `L` で `base + growth*(L-1)`）、`Scope`、`SkillEffect`（`recoverHp` / `recoverMp` / `commonEvent`）、`Drop`、`TroopCondition`、`MoveRoute`、`EquipSlot`。
- `RefTarget.kind` に `"class"` と `"tileset"` を追加（Actor→Class、Map→Tileset の参照を扱うため）。
- `migrateTo` / `migrateMapTo` は `registry` 引数を取れる（テスト用）。実マイグレーションは v1 が最初なので空。
- フィクスチャは `fixtures/projects/v1/<name>/{project.json, maps/*.json}`（フォルダ形式）。`minimal`（マップ1・アクター1・イベント1）と `transfer-demo`（2マップ）がある。
- `MapData` は `events` の位置がマップ内であることも検証する。

## 実装メモ（M4 で確定した点）
- **`Database.states`**（新規・必須）：`State { id, name, restriction: "none" | "cannotAct", turns, paramRates, hpRegen }`。`turns` は継続ターン数（0 は戦闘が終わるまで）、`paramRates` はパラメータの倍率（`Partial<Record<Param, number>>`、0 以上）、`hpRegen` はターン終了時の最大 HP に対する増減の割合（-1〜1。負で毒）。ID は `StateId`。参照の種類に `state` を追加。
- **`SkillEffect`** に `addState { state, chance }`（`chance` は 0〜1）、`removeState { state }`、`buff { param, level }`（`param` は `atk def mat mdf agi luk`、`level` は -2〜+2 の整数）を追加。`Enemy.graphic?: AssetRef`（戦闘画面の絵。省略時は名前の箱）を追加。`collectRefs` はこれらの参照（状態・絵）も拾う。
- 形式バージョンは 1 のまま（公開前なので）。`fixtures/projects/v1/*/project.json` に `"states": {}` を足した。

## 実装メモ（M5 で確定した点）
- ID の zod スキーマにメタデータを付けた：`idSchema<T>(ref?)` が `schema.meta()` に `{ ref: "actor" | "map" | … }` を載せる（`assetIdSchema` は `{ ref: "asset" }`、`assetRefSchema` の `asset` は `assetKind: "image"`、`audioRefSchema` の `asset` は `assetKind: "audio"`）。値の検証には影響しない。エディタが「これは何の ID か」を知ってフォームの選択肢を出すためのもの（13）。

## 実装メモ（M7 で確定した点）
- **`formatVersion` を 2 に上げた**：`system.plugins: { name, version, params }[]`（プロジェクトが使うプラグイン。`name` は英数字・`_`・`-` の 1〜64 文字、`params` は各プラグインが解釈する）を必須で追加した。最初の実マイグレーション `v1 → v2`（`system.plugins = []` を足す。既にあれば残す。マップは変えない）を `migrations` に登録した。`fixtures/projects/v1/*` は旧形式のまま残してあり、読み込むと v2 になる（`parseProject` のテストは「マイグレーション済みの JSON と一致する」ことを確かめる）。プラグインを使う現行形式のフィクスチャは `fixtures/projects/v2/plugin-demo`。
- `parseMapData(json, formatVersion)` の `formatVersion` は、**書き出されたままの**（マイグレーション前の）値。プレイヤーの `ProjectSource`（HTTP / 埋め込み）は、`project.json` の生の `formatVersion` を覚えて渡す。
