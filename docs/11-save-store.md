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

## 実装メモ（M3 で確定した点）
- **実装済み**：`createMemorySaveRepository` / `createIdbSaveRepository` / `createLocalStorageSaveRepository` / `createSaveRepository`（環境検出）。3 つとも `SlotBackend`（`get` / `put` / `delete` だけの生の置き場。`backend.ts`）を実装し、検証・互換判定・マイグレーション・エラー変換・エクスポート/取り込みは共通の `createRepository`（`repository.ts`）が行う。
- **ポートの置き場所が変わった**：`SaveRepository` / `SlotMeta` / `SaveStoreError` / `SaveRepositoryOpts` は **runtime が定義**する（`packages/runtime/src/ports/saves.ts`。runtime は save-store に依存できないため）。save-store は runtime の型を実装する。依存ルールは `save-store → core, runtime（ポート型のみ）`（`tools/dependency-rules.cjs`、docs/00）。`exportSlot` / `importSlot` の `Blob` は runtime では構造互換の最小型 `BlobLike`。
- **保存フォーマット**：`StoredSave = { envelope: 1, checksum, payload, meta }`（`meta` は `slot` / `savedAt` / `playtimeTicks` / `preview` / `version` / `projectHash`。`compatible` は一覧を作るときに判定）。checksum は payload の sha256（hex、`crypto.subtle`）。IndexedDB のキーは `[projectId, slot]`（DB 名の既定 `rpg-saves`、ストア `saves`）、localStorage のキーは `${prefix}:${projectId}:${slot}`（既定 `rpg-save`）、メモリは `${projectId}:${slot}`。
- **`read` の判定順**：スロット範囲外・空 → `notFound` → 形式が不正 → `corrupted` → checksum 不一致 / JSON 不正 / 形が不正 → `corrupted` → 別 `projectId` → `incompatible(projectMismatch)` → `version` が新しい → `incompatible(newerVersion)` → `projectHash` 不一致（`allowProjectMismatch` でなければ）→ `incompatible(projectMismatch)` → マイグレーション（失敗は `corrupted`）。**返すスナップショットは `version` を現在に揃えてある**（core の `fromSnapshot` が再度マイグレーションしないように）。ストレージは書き換えない。
- **`listSlots`**：`0 … maxSlots-1` を 1 つずつ `get` し、`meta` だけを見る（payload は parse も checksum 検証もしない）。形が壊れたエントリは一覧に出さない。`compatible`：新しい version → `no`、`projectHash` 不一致 → `allowProjectMismatch` なら `migratable`、なければ `no`、古い version → `migratable`、それ以外 `yes`。
- **`write`**：スロット範囲外 → `io`、別 `projectId` → `incompatible(projectMismatch)`。`version` は検査しない（新しい version のセーブを書けてしまうが、読むと `newerVersion`。契約テストがこれを使う）。容量超過（`QuotaExceededError` / `NS_ERROR_DOM_QUOTA_REACHED` / code 22, 1014）→ `quota`、それ以外の例外 → `io`。スロット 0（オートセーブ）の自動削除はしない（M3 ではオートセーブ自体が無い）。
- **`exportSlot` / `importSlot`**：ファイルは `{ envelope: 1, checksum, payload }` の JSON（`meta` は入れない）。取り込みは checksum・形式・`projectId`・互換性を検査し、`meta` は payload から作り直す。**空のスロットの `exportSlot` は reject する**（戻り値が `Result` でないため。取り込みは `Result`）。
- **`createSaveRepository`**：最初の操作で IndexedDB（`indexedDB` を渡せる）を開いてみて、失敗したら localStorage（`storage` を渡せる。読み書きを試して確認）、どちらも使えなければ「書き込みは `io`、`listSlots` は空、`read` は `io`」のリポジトリになる（メモリに黙って逃がさない）。
- **契約テスト**：`saveRepositoryContract(name, make)`（test-utils）。`make` は `SaveRepositoryFixture { open(opts), tamper(projectId, slot) }`（同じ保存先を別の設定で開き直す・保存済みの payload を checksum そのままに書き換える）を返す。`memory` / `localStorage`（test-utils の `createMemoryStorage()`、jsdom は使わない）/ `indexedDB`（`fake-indexeddb`）で不変条件 1〜5 と互換判定（projectHash・newerVersion）・`projectId` ごとの分離・取り込みの拒否を検証する。固有のテスト（キー形式、`quota` の注入、環境検出とフォールバック）は `save-store/src/index.test.ts`。
- **未実装**：オートセーブ（スロット 0）、`fixtures/saves/v{old}/*.rpgsave`（マイグレーションは v1 しか無いので、マイグレーションが無い version は `corrupted` になることだけ確認）、gzip（`envelope: 2`）、`saveScope` は player 側で DB 名・キーの接頭辞に反映するのみ。

## 実装メモ（M4 で確定した点）
- セーブされる状態から `battle` を除いた（戦闘中はセーブできない）。`SerializedGameState` の `scene` はマップのみで、`title` / `menu` / `battle` / `gameover` は `stripTransient` がマップに戻す。`SNAPSHOT_VERSION` は 1 のまま（検証スキーマは変わっていない）。
