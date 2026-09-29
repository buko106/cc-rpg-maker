# 10. `@rpg/project-store` — ProjectRepository（ゲーム定義の永続化）

## 責務
- エディタが扱う `Project` + `MapData` + アセットバイナリの保存・読込・一覧・削除。
- インポート/エクスポート（ZIP）。
- 読込時のマイグレーション（`schema.migrateTo` を呼ぶ）。
- 自動保存のための部分保存とバージョン（楽観ロック）。

## 非責務
- セーブデータ。→ 11
- 編集操作。→ 12
- 配布形式の生成。→ 15（本パッケージの `export` を利用する）

## 依存が許されるパッケージ
`@rpg/schema`。アダプタは `DOM` 型使用可。ポート型ファイル（`ports/projectRepository.ts`）は `DOM` を含めない。

## 公開インターフェース

### ポート
```ts
export interface ProjectMeta { id: string; title: string; updatedAt: string; formatVersion: number; sizeBytes: number }

export interface ProjectDocument {
  project: Project;
  maps: Record<MapId, MapData>;              // load 時は全マップを含める（必要なら将来 lazy 化）
  revision: number;                          // 楽観ロック。save のたびに +1
}

export interface ProjectRepository {
  list(): Promise<ProjectMeta[]>;
  create(title: string): Promise<ProjectDocument>;       // テンプレート（fixtures/projects/v1/template）から生成
  load(id: string): Promise<Result<ProjectDocument, ProjectStoreError>>;
  save(doc: ProjectDocument, opts?: { changedMaps?: MapId[]; expectedRevision?: number }): Promise<Result<{ revision: number }, ProjectStoreError>>;
  remove(id: string): Promise<void>;
  assets(id: string): ProjectAssetStore;
  exportZip(id: string): Promise<Blob>;
  importZip(zip: Blob): Promise<Result<ProjectMeta, ProjectStoreError>>;
}

export interface ProjectAssetStore {
  put(bytes: ArrayBuffer, name: string, kind: AssetKind): Promise<{ id: AssetId; entry: AssetManifest["entries"][AssetId] }>;
  get(id: AssetId): Promise<ArrayBuffer | undefined>;
  remove(id: AssetId): Promise<void>;
  bytesSource(): AssetBytesSource;           // 09 と接続
}

export type ProjectStoreError =
  | { kind: "notFound" } | { kind: "conflict"; currentRevision: number }
  | { kind: "schema"; error: SchemaError } | { kind: "io"; message: string } | { kind: "quota" };
```

### アダプタ
```ts
export function createMemoryProjectRepository(): ProjectRepository;                 // テスト・テストプレイ用
export function createIdbProjectRepository(dbName?: string): ProjectRepository;      // IndexedDB（既定）
export function createOpfsProjectRepository(root: FileSystemDirectoryHandle): ProjectRepository;
export function createFsaProjectRepository(dir: FileSystemDirectoryHandle): ProjectRepository;  // File System Access API：ユーザー指定フォルダ
```

## 保存レイアウト（OPFS / FSA / ZIP 共通）
```
<project-id>/
  project.json            ← Project（maps は MapMeta のみ）
  maps/<mapId>.json       ← MapData
  assets/<assetId>.<ext>  ← バイナリ
  meta.json               ← { revision, updatedAt, formatVersion }
```
IndexedDB はオブジェクトストア `projects`, `maps`（key: `[projectId, mapId]`）, `assets`（key: `[projectId, assetId]`）, `meta`。

## 実装指針
- `save` は `expectedRevision` が与えられ現在値と異なれば `conflict` を返し何も書かない。
- `changedMaps` が与えられたときはそのマップのみ書き換える（自動保存の負荷軽減）。
- `load` は `parseProject` によりマイグレーションを実行し、**マイグレーション後の文書を即座に保存し直す**（次回以降のコストを避ける）。
- `importZip` は ZIP 内の `assets/` について `hashAsset` で ID を検証し、不一致は `schema` エラーとする。
- 書込みは「一時キー/一時ファイルに書いてからリネーム」で原子性を確保する。
- `quota` は `navigator.storage.estimate()` と例外種別から判定。

## 不変条件
1. `save` → `load` で `project`/`maps` が deep-equal（ラウンドトリップ）。
2. `expectedRevision` 不一致時は書込みが一切起きない。
3. `importZip(exportZip(id))` は `id` と等価な内容の新規プロジェクトを作る（ID は新規）。
4. `remove` 後の `load` は `notFound`。
5. 古い `formatVersion` の ZIP を `importZip` すると `CURRENT_FORMAT_VERSION` に変換されて保存される。

## テスト要件
- 契約テスト `contracts/projectRepository.contract.ts`：上記不変条件をすべてカバー。`memory` と `idb`（`fake-indexeddb`）は Node で実行、`opfs`/`fsa` は Playwright で実行。
- マイグレーション統合：`fixtures/projects/v{old}/*.zip` の import。
- 原子性：書込み途中で例外を注入し、`load` が直前の状態を返すこと。
- 部分保存：`changedMaps` 指定時に他マップの `updatedAt` が変わらないこと。

## 完了条件
- `memory`, `idb` が契約テストを通る。
- `apps/editor-ui` から新規作成→保存→リロード→再開が動く。
- `opfs`/`fsa` は後続マイルストーン。
