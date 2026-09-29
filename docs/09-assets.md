# 09. `@rpg/assets` — AssetSource とローダ

## 責務
- `runtime` の `AssetSource` ポート実装群と共通のキャッシュ層。
- アセット ID（内容ハッシュ）の計算と検証。
- 画像のデコード（`ImageBitmap`）、音声のデコード（`AudioBuffer`）。
- ソース：HTTP（配布版）、OPFS（エディタのローカル保存）、ZIP（インポート時のメモリ）、Embedded（単一 HTML 配布用の data URL）。

## 非責務
- アセットの一覧（`AssetManifest`）の管理。→ `schema` / `project-store`。
- どのアセットがいつ必要かの判断。→ `runtime`。

## 依存が許されるパッケージ
`@rpg/runtime`（`AssetSource`, `ImageHandle`, `AudioHandle` 型）, `@rpg/schema`（`AssetId`）。`DOM` 型使用可。

## 公開インターフェース
```ts
export async function hashAsset(bytes: ArrayBuffer): Promise<AssetId>;       // sha256 先頭16桁（hex）
export interface AssetBytesSource { getBytes(id: AssetId): Promise<ArrayBuffer | undefined>; has(id: AssetId): Promise<boolean> }

export function createHttpBytesSource(baseUrl: string, manifest: AssetManifest): AssetBytesSource;  // baseUrl/{id}.{ext}
export function createOpfsBytesSource(dir: FileSystemDirectoryHandle): AssetBytesSource;
export function createZipBytesSource(zip: Blob): Promise<AssetBytesSource>;
export function createEmbeddedBytesSource(entries: Record<AssetId, string /* base64 */>): AssetBytesSource;
export function createMemoryBytesSource(entries?: Record<AssetId, ArrayBuffer>): AssetBytesSource & { put(id, bytes): void };

export interface AssetSourceOpts { decodeAudio?: (bytes: ArrayBuffer) => Promise<AudioHandle>; verifyHash?: boolean; maxCacheBytes?: number }
export function createAssetSource(bytes: AssetBytesSource, manifest: AssetManifest, opts?: AssetSourceOpts): AssetSource & {
  preload(ids: AssetId[], onProgress?: (done: number, total: number) => void): Promise<void>;
  evict(id: AssetId): void; stats(): { cachedBytes: number; entries: number };
};
```
`ImageHandle`/`AudioHandle` は `runtime` 側では opaque 型。canvas2d アダプタは `ImageHandle as ImageBitmap` として扱う（実装の合意事項として 07 に記載）。

## 実装指針
- キャッシュは LRU。`maxCacheBytes` 超過で最も古いものから `evict`（現在フレームで参照中のものは `runtime` が `preload` で pin する）。
- `verifyHash: true` のとき取得したバイト列のハッシュが ID と一致しなければ `AssetError.kind === "hashMismatch"`。エディタでは常に true。
- 同じ ID の同時要求は 1 回の fetch に合流（in-flight dedup）。
- デコード失敗はキャッシュに負の結果を残さない（再試行可能）。

## 不変条件
1. `loadImage(id)` を2回呼ぶと同じハンドル（キャッシュヒット）。
2. `evict` 後の `loadImage` は再ロードして成功する。
3. `has` が false の ID に対する `load*` は `AssetError.kind === "notFound"` で reject。
4. `stats().cachedBytes <= maxCacheBytes`（pin 分を除く）。

## テスト要件
- 契約テスト `contracts/assetBytesSource.contract.ts`：`memory`, `zip`, `embedded` は Node で実行。`opfs` は Playwright、`http` は `msw` でモック。
- `hashAsset` の既知ベクタ。
- LRU 退避・同時要求合流・ハッシュ不一致検出。

## 完了条件
- `memory` + 契約テストが完成し、06/07 のテストで使える。
- `http` と `embedded` が `apps/player` で動作する。
- `opfs`, `zip` は 10 と連携して `apps/editor-ui` で動作する。
