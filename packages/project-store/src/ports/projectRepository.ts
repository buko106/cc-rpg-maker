import type { AssetEntry, AssetId, MapData, MapId, Project, Result, SchemaError } from "@rpg/schema";

/** 一覧に出す要約。 */
export interface ProjectMeta {
  id: string;
  title: string;
  /** ISO 8601。最後に保存した時刻。 */
  updatedAt: string;
  formatVersion: number;
  /** project + maps + アセットの概算バイト数 */
  sizeBytes: number;
}

export interface ProjectDocument {
  project: Project;
  /** `project.maps` のすべてのマップ。キーの集合は `project.maps` と一致する。 */
  maps: Record<MapId, MapData>;
  /** 楽観ロック。保存のたびに +1。 */
  revision: number;
}

export type ProjectStoreError =
  | { kind: "notFound" }
  | { kind: "conflict"; currentRevision: number }
  | { kind: "schema"; error: SchemaError }
  | { kind: "io"; message: string }
  | { kind: "quota" };

export type AssetKind = AssetEntry["kind"];

/**
 * アセットのバイト列の取得口。`@rpg/assets` の `AssetBytesSource` と構造的に同じ
 * （project-store は schema にしか依存できないので、型をここにも置く）。
 */
export interface ProjectBytesSource {
  getBytes(id: AssetId): Promise<ArrayBuffer | undefined>;
  has(id: AssetId): Promise<boolean>;
}

export interface ProjectAssetStore {
  /** 内容ハッシュを ID として保存する。同じ内容は同じ ID（上書きしても害はない）。マニフェストへの登録は `registerAsset` の仕事。 */
  put(bytes: ArrayBuffer, name: string, kind: AssetKind): Promise<{ id: AssetId; entry: AssetEntry }>;
  get(id: AssetId): Promise<ArrayBuffer | undefined>;
  remove(id: AssetId): Promise<void>;
  bytesSource(): ProjectBytesSource;
}

export interface SaveOptions {
  /** 指定したときは、そのマップだけを書き換える（自動保存の負荷軽減）。ストアに無いマップと、削除されたマップは常に反映される。 */
  changedMaps?: readonly MapId[];
  /** 現在の revision と異なれば `conflict` を返し、何も書かない。 */
  expectedRevision?: number;
}

export interface ProjectRepository {
  list(): Promise<ProjectMeta[]>;
  /** テンプレートから新しいプロジェクトを作って保存する（revision 1）。 */
  create(title: string): Promise<ProjectDocument>;
  load(id: string): Promise<Result<ProjectDocument, ProjectStoreError>>;
  save(doc: ProjectDocument, opts?: SaveOptions): Promise<Result<{ revision: number }, ProjectStoreError>>;
  remove(id: string): Promise<void>;
  assets(id: string): ProjectAssetStore;
  /**
   * プロジェクト全体（project.json・maps/・assets/・meta.json）を 1 つの ZIP（無圧縮）にする。
   * ポート型に DOM を持ち込まないので `Blob` ではなくバイト列で返す（UI は `new Blob([bytes])` で包む）。
   */
  exportZip(id: string): Promise<Result<Uint8Array<ArrayBuffer>, ProjectStoreError>>;
  /**
   * `exportZip` で作った（または同じレイアウトの）ZIP から、**新しい ID の**プロジェクトを作る。
   * ルート直下でも、1 段のフォルダの下でもよい。アセットはハッシュ（ID）を検証し、不一致は `schema` エラー。
   * 古い `formatVersion` は現行に変換して保存する。
   */
  importZip(zip: Uint8Array | ArrayBuffer): Promise<Result<ProjectMeta, ProjectStoreError>>;
}
