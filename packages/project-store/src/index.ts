/**
 * @rpg/project-store — ProjectRepository（ゲーム定義の永続化）。
 *
 * 設計: docs/10-project-store.md
 * M5 で実装済み：`memory` / `idb` アダプタ、共通の `createRepository`、テンプレート。
 * M6：`exportZip` / `importZip`。M7：`opfs` / `fsa`（ディレクトリ上の永続層）。
 */
export type { CommitBatch, StoreBackend, StoredMeta } from "./backend.js";
export { createDirectoryBackend } from "./directory.js";
export { createFsaProjectRepository, createOpfsProjectRepository, openOpfsProjectRepository, pickFsaProjectRepository } from "./fs-repositories.js";
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
export { assetEntryOf, extensionOf, hashBytes, imageSize, mimeOf } from "./util.js";
export { crc32, readZip, writeZip } from "./zip.js";
export type { ZipFile } from "./zip.js";
