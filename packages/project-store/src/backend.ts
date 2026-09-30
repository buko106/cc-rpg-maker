import type { AssetId } from "@rpg/schema";

/** ストアに持つ、プロジェクトごとの管理情報。 */
export interface StoredMeta {
  title: string;
  updatedAt: string;
  formatVersion: number;
  revision: number;
  sizeBytes: number;
  /** 保存されているマップ ID → JSON の大きさ。キーの集合が「ストアにあるマップ」。 */
  mapSizes: Record<string, number>;
}

/** 1 回の保存で原子的に書く内容。`maps` の値が `null` のマップは削除する。 */
export interface CommitBatch {
  project: unknown;
  maps: Record<string, unknown | null>;
  meta: StoredMeta;
}

/**
 * 永続層の最小の口。`memory` / `idb` が実装し、`createRepository` が ProjectRepository の
 * 振る舞い（検証・楽観ロック・部分保存・マイグレーション）を共通で載せる。
 * 値は JSON にできる plain object（`serializeProject` / `serializeMapData` の結果）。
 */
export interface StoreBackend {
  listMeta(): Promise<{ id: string; meta: StoredMeta }[]>;
  getMeta(id: string): Promise<StoredMeta | undefined>;
  getProject(id: string): Promise<unknown>;
  getMap(id: string, mapId: string): Promise<unknown>;
  /** project・マップ・meta を全か無かで書く。失敗したら何も書かれていないこと。 */
  commit(id: string, batch: CommitBatch): Promise<void>;
  /** プロジェクトの全データ（アセットを含む）を消す。無ければ何もしない。 */
  removeProject(id: string): Promise<void>;
  putAsset(id: string, assetId: AssetId, bytes: ArrayBuffer): Promise<void>;
  getAsset(id: string, assetId: AssetId): Promise<ArrayBuffer | undefined>;
  deleteAsset(id: string, assetId: AssetId): Promise<void>;
}
