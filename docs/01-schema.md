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
