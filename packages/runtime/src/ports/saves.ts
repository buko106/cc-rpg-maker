import type { SaveSnapshot } from "@rpg/core";
import type { Result } from "@rpg/schema";

/** セーブスロットのメタ情報。`listSlots` は payload を parse せずにこれだけを返す。 */
export interface SlotMeta {
  slot: number;
  /** ISO 8601 */
  savedAt: string;
  playtimeTicks: number;
  preview: SaveSnapshot["preview"];
  version: number;
  projectHash: string;
  /** 一覧を作った時点の互換判定。`migratable` は読み込めるが `version` / `projectHash` が現在と違う。 */
  compatible: "yes" | "migratable" | "no";
}

export type SaveStoreError =
  | { kind: "notFound" }
  | { kind: "corrupted"; detail: string }
  | { kind: "incompatible"; reason: "newerVersion" | "projectMismatch" }
  | { kind: "io"; message: string }
  | { kind: "quota" };

/** `Blob` と構造的に互換な最小の型（runtime は DOM の型を使わない）。 */
export interface BlobLike {
  readonly size: number;
  readonly type: string;
  text(): Promise<string>;
}

/**
 * セーブデータの永続化（docs/11-save-store.md）。スロット 0 はオートセーブ用。
 * 失敗しうる操作は `Result` で返し、例外は投げない（`exportSlot` の空スロットを除く）。
 */
export interface SaveRepository {
  /** 保存済みのスロットをスロット番号の昇順で返す。`read` を伴わない。 */
  listSlots(): Promise<SlotMeta[]>;
  /** マイグレーション済みのスナップショットを返す（ストレージは書き換えない）。 */
  read(slot: number): Promise<Result<SaveSnapshot, SaveStoreError>>;
  write(slot: number, snap: SaveSnapshot): Promise<Result<void, SaveStoreError>>;
  remove(slot: number): Promise<void>;
  /** `.rpgsave`（JSON + チェックサム）。空のスロットは reject する。 */
  exportSlot(slot: number): Promise<BlobLike>;
  importSlot(slot: number, blob: BlobLike): Promise<Result<SlotMeta, SaveStoreError>>;
}

export interface SaveRepositoryOpts {
  projectId: string;
  projectHash: string;
  /** 開発中は true にして、`projectHash` が違うセーブも読み込む（`compatible: "migratable"`）。 */
  allowProjectMismatch?: boolean;
  /** スロット数（0 〜 maxSlots-1）。既定 20。 */
  maxSlots?: number;
}
