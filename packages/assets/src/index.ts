/**
 * @rpg/assets — AssetSource ポートの実装、ローダ、キャッシュ。
 *
 * 設計: docs/09-assets.md
 * M2 で実装済み：`memory` / `http` のバイト列ソースと、キャッシュ付き `AssetSource`。
 * M5 で `opfs` / `zip`（読み込み）を追加。`embedded` は M6（エクスポート）。
 */
export { createAssetSource } from "./asset-source.js";
export type { AssetSourceOptions, CachedAssetSource } from "./asset-source.js";
export { assetExtension, createHttpBytesSource, createMemoryBytesSource } from "./bytes-source.js";
export type { AssetBytesSource, HttpBytesSourceOptions, MemoryBytesSource } from "./bytes-source.js";
export { hashAsset } from "./hash.js";
export { createOpfsBytesSource } from "./opfs.js";
export { createZipBytesSource, crc32, readZip, writeZip } from "./zip.js";
export type { ZipFile } from "./zip.js";
