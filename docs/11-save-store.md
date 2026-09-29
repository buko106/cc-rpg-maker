# 11. `@rpg/save-store` — SaveRepository（セーブデータの永続化）

## 責務
- `SaveSnapshot`（02 で定義）のスロット単位の保存・読込・一覧・削除。
- 整合性（チェックサム）と互換性（`version`, `projectHash`）の検証。
- スナップショットのマイグレーション（`core.snapshotMigrations` を呼ぶ）。
- ファイルとしての書き出し/取り込み（プレイヤーがセーブデータを持ち運ぶため）。

## 非責務
- `GameState` の直列化方法。→ `core.toSnapshot`
- ゲーム定義の保存。→ 10

## 依存が許されるパッケージ
`@rpg/core`（`SaveSnapshot`, `snapshotMigrations`, `SNAPSHOT_VERSION` のみ）。

## 公開インターフェース

### ポート（`runtime` からも re-export される）
```ts
export interface SlotMeta {
  slot: number; savedAt: string; playtimeTicks: number;
  preview: SaveSnapshot["preview"]; version: number; projectHash: string;
  compatible: "yes" | "migratable" | "no";   // list 時に判定
}

export interface SaveRepository {
  listSlots(): Promise<SlotMeta[]>;
  read(slot: number): Promise<Result<SaveSnapshot, SaveStoreError>>;    // migrate 済み
  write(slot: number, snap: SaveSnapshot): Promise<Result<void, SaveStoreError>>;
  remove(slot: number): Promise<void>;
  exportSlot(slot: number): Promise<Blob>;                              // .rpgsave（JSON + checksum）
  importSlot(slot: number, blob: Blob): Promise<Result<SlotMeta, SaveStoreError>>;
}

export type SaveStoreError =
  | { kind: "notFound" } | { kind: "corrupted"; detail: string }
  | { kind: "incompatible"; reason: "newerVersion" | "projectMismatch" }
  | { kind: "io"; message: string } | { kind: "quota" };

export interface SaveRepositoryOpts {
  projectId: string; projectHash: string;
  allowProjectMismatch?: boolean;            // 開発中は true にして警告のみ
  maxSlots?: number;                         // 既定 20。slot 0 はオートセーブ
}
```

### アダプタ
```ts
export function createMemorySaveRepository(opts: SaveRepositoryOpts): SaveRepository;
export function createIdbSaveRepository(opts: SaveRepositoryOpts & { dbName?: string }): SaveRepository;
export function createLocalStorageSaveRepository(opts: SaveRepositoryOpts & { prefix?: string }): SaveRepository;  // IndexedDB 不可環境の fallback
export function createSaveRepository(opts: SaveRepositoryOpts): SaveRepository;   // 環境検出して idb → localStorage の順に選ぶ
```

## 保存フォーマット
```ts
interface StoredSave {
  envelope: 1;
  checksum: string;              // sha256(payload)
  payload: string;               // JSON.stringify(SaveSnapshot)。将来 gzip を許可（envelope: 2）
}
```
IndexedDB キー：`[projectId, slot]`。localStorage キー：`${prefix}:${projectId}:${slot}`。

## 実装指針
- `write` は `snap.projectId !== opts.projectId` なら `incompatible`。
- `read` は checksum 不一致で `corrupted`。`version > SNAPSHOT_VERSION` で `incompatible: newerVersion`。`version < SNAPSHOT_VERSION` は `snapshotMigrations` を適用（ストレージは書き換えない：書き換えは次回 `write` で行う）。
- `projectHash` 不一致は既定で `incompatible: projectMismatch`、`allowProjectMismatch` なら `compatible: "migratable"` とし読込を許可。
- `listSlots` は payload 全体を parse せず `preview` のみ取り出せるよう、`StoredSave` に `meta: SlotMeta` を別フィールドで持つ（上記 envelope に追加）。
- `quota` 検出時は `slot 0`（オートセーブ）を対象に容量確保を試みない。エラーを返して UI に委ねる。

## 不変条件
1. `write(s, snap)` → `read(s)` は `snap` と deep-equal。
2. 改ざんされた `payload` は `corrupted` で拒否される。
3. 異なる `projectId` のスナップショットは `write` できない。
4. `importSlot(s, exportSlot(s))` は同じ内容。
5. `listSlots` は `read` を伴わずに完了する（性能不変条件：payload を parse しない）。

## テスト要件
- 契約テスト `contracts/saveRepository.contract.ts`：不変条件 1〜5。`memory`, `idb`(`fake-indexeddb`), `localStorage`(jsdom) を Node で実行。
- マイグレーション：`fixtures/saves/v{old}/*.rpgsave` の read。
- 互換判定：`version`/`projectHash` の各組み合わせ。
- quota：`localStorage.setItem` に例外を注入。

## 完了条件
- `memory`, `idb`, `localStorage` が契約テストを通る。
- 06 の `requestSave`/`requestLoad` と接続され、`apps/player` でセーブ→リロード→ロードが動く。
