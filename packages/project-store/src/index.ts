/**
 * @rpg/project-store — ProjectRepository（ゲーム定義の永続化）。
 *
 * 設計: docs/10-project-store.md
 * M5 で実装済み：`memory` / `idb` アダプタ、共通の `createRepository`、テンプレート。
 * `opfs` / `fsa` / ZIP の入出力は後続（M6〜M7）。
 */
export type { CommitBatch, StoreBackend, StoredMeta } from "./backend.js";
export { createIdbBackend, createIdbProjectRepository } from "./idb.js";
export type { IdbOptions } from "./idb.js";
export { createMemoryBackend, createMemoryProjectRepository } from "./memory.js";
export type {
  AssetKind,
  ProjectAssetStore,
  ProjectBytesSource,
  ProjectDocument,
  ProjectMeta,
  ProjectRepository,
  ProjectStoreError,
  SaveOptions,
} from "./ports/projectRepository.js";
export { createRepository, toStoreError } from "./repository.js";
export type { RepositoryOptions } from "./repository.js";
export { createTemplate, TEMPLATE_MAP_ID, TEMPLATE_MAP_SIZE } from "./template.js";
export type { Template, TemplateAsset } from "./template.js";
export { assetEntryOf, hashBytes, imageSize, mimeOf } from "./util.js";
