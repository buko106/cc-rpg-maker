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

## 実装メモ（M5 で確定した点）
- **実装済み**：`ProjectRepository`（`list` / `create` / `load` / `save` / `remove` / `assets`）、`createMemoryProjectRepository`、`createIdbProjectRepository`（`{ indexedDB, keyRange, dbName }` を注入できる。テストは `fake-indexeddb` の対を渡す）。`exportZip` / `importZip`、`opfs` / `fsa` は後続（M6〜M7）で、ポートには載せていない（載せるときに契約テストも足す）。
- **構成**：検証・楽観ロック・部分保存・マイグレーション後の保存し直しは共通の `createRepository(backend)` にあり、永続層は最小の `StoreBackend`（`listMeta` / `getMeta` / `getProject` / `getMap` / `commit` / `removeProject` / アセット 3 操作）だけを実装する。`commit` は project・マップ・meta を 1 回で書く（IndexedDB は 1 トランザクション。メモリは書く前に全部を文字列にしてから反映）。原子性は「`commit` が失敗したら直前の状態が残る」をバックエンドのラッパーで確かめる。
- **`save` の意味**：`expectedRevision` が現在値と違えば `conflict`（何も書かない）。`changedMaps` を指定するとそのマップだけを書き、ストアに無いマップと、文書から消えたマップは常に反映する（指定外の変更は保存されない — 契約テストで固定）。文書は `parseProject` / `parseMapData` で検証してから書く（`schema` エラー）。`project.maps` と `maps` のキーが食い違う文書も `schema` エラー。`revision` は保存のたびに +1、`create` 直後は 1。`QuotaExceededError`（名前または message に quota）は `quota`、他の例外は `io`。
- **`create`** は `createTemplate`（草原 20×15 のマップ 1 枚、勇者 1 人と職業、タイルセット `ts_default`、歩行グラフィック、開始位置 (5,5)、画面 480×320）から作る。画像は demo のものを `tools/make-template-assets.mjs` で `template-assets.ts` に base64 で埋め込んだ。`fixtures/projects/v1/template` は置いていない（コードで生成する）。
- **アセット**：`put` は内容ハッシュ（sha256 先頭 16 桁）を ID にし、PNG / GIF / JPEG のヘッダから幅・高さを読む（DOM に頼らない）。マニフェストへの登録は `registerAsset`（12）の仕事。`hashAsset`（09）と同じ定義を project-store 内にも持つ（project-store は schema にしか依存できないため）。プロジェクトを保存し直しても、使われなくなったアセットのバイト列は消さない（ガベージコレクションは未実装）。
- **未対応**：マイグレーション後の保存し直しの分岐は、現状 `migrations` が空でテストできていない（最初のマイグレーションを足すときに、旧バージョンのフィクスチャ `fixtures/projects/v{old}/` と一緒にテストする）。

## 実装メモ（M6 で確定した点）
- **`exportZip(id)` / `importZip(zip)` をポートに追加**。ポート型に DOM を持ち込まないため、`Blob` ではなく**バイト列**（`Uint8Array` / `ArrayBuffer`）で受け渡す（UI は `new Blob([bytes])` で包む）。`exportZip` は存在しない ID で `notFound` を返すので `Result<..., ProjectStoreError>` を返す。どちらも共通の `createRepository` に実装したので、`memory` / `idb` の両方で契約テストを通る。
- **ZIP のレイアウト**：ルート直下に `project.json` / `maps/<MapId>.json` / `assets/<AssetId>.<ext>` / `meta.json`（`{ revision, updatedAt, formatVersion }`）。書き出しは無圧縮（store）、読み込みは store と deflate。`importZip` は 1 段のフォルダの下にあるレイアウトも読む。
- **`importZip` の検証**：`project.json` を `parseProject`（マイグレーション込み）、マップを `parseMapData` で検証し、壊れた ZIP・JSON・マップの欠落・未来の `formatVersion`（`newer-format`）は `schema` エラー。アセットはマニフェストに載っているものだけを取り込み、**内容ハッシュ（sha256 先頭 16 桁）が ID と一致しなければ `schema` エラー**。バイト列の無いアセットは、マニフェストだけ取り込む。取り込んだプロジェクトは**新しい ID**・`revision` 1・`updatedAt` は取り込み時刻。途中で失敗したら、書きかけのアセットも残さない（`removeProject`）。
- ZIP の読み書き（`zip.ts`）は `@rpg/assets` の `zip.ts` と同じ形式のコピー（project-store は schema にしか依存できないため。`hashAsset` と同じ扱い）。
- **未対応**：古い `formatVersion` の ZIP の import（`migrations` がまだ空なので、テストする対象が無い。最初のマイグレーションを足すときに `fixtures/projects/v{old}/*.zip` と一緒にテストする）、`opfs` / `fsa`（M7）。

## 実装メモ（M7 で確定した点）
- **`opfs` / `fsa` を実装した**：`createOpfsProjectRepository(root)` / `createFsaProjectRepository(dir)`（どちらも `FileSystemDirectoryHandle` 上の `createDirectoryBackend` に共通の `createRepository` を載せたもの）と、入口の `openOpfsProjectRepository(name = "rpg-projects")`（`navigator.storage.getDirectory()` の下）/ `pickFsaProjectRepository()`（`showDirectoryPicker`）。レイアウトは `<id>/project.json` / `meta.json` / `maps/<mapId>.json` / `assets/<assetId>.bin`（別のツールが `<assetId>.png` で置いたものも、拡張子を問わず読める）。ファイル名は安全な文字だけ（`..` や区切りは拒否）。
- **原子性**：1 ファイルの書き込みは `createWritable` が原子的。複数ファイルにまたがる `commit` は マップ → `project.json` → `meta.json` の順で、`meta.json` が最後（コミットの印）。途中で止まっても `revision` は古いままなので、次の `save` の楽観ロックで整合を取り直せる（リネームによる完全な原子性は、ブラウザの対応がそろっていないので採らなかった）。
- **テスト**：`createFakeDirectory()`（test-utils。`NotFoundError` / `TypeMismatchError` / `InvalidModificationError`、`close()` で反映、書き込みの失敗の仕込みまでブラウザに合わせたメモリ上のフェイク）で共通の契約テストにかけ、実ブラウザの OPFS は `e2e/opfs.spec.ts`（作成・保存・楽観ロック・ZIP の往復・削除）で確かめる。`fsa` の `showDirectoryPicker` はユーザー操作が要るので E2E には入れていない（フェイクのフォルダで検証）。
- マイグレーションの統合テストを足した：v1 の ZIP を `importZip` すると v2 で保存され、v1 で保存されていた文書は `load` で変換されて直ちに保存し直される（`revision` +1、2 回目以降は保存し直さない）。
- **エディタ**：`?storage=opfs` で OPFS に保存する（既定は IndexedDB）。フォルダを選ぶ UI は未実装（`pickFsaProjectRepository` は用意してある）。
