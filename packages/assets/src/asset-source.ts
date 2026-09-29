import { AssetError } from "@rpg/runtime";
import type { AssetId, AssetManifest, AssetSource, AudioHandle, ImageHandle } from "@rpg/runtime";
import type { AssetBytesSource } from "./bytes-source.js";
import { hashAsset } from "./hash.js";

export interface AssetSourceOptions {
  /** 既定は `createImageBitmap`（ブラウザ）。 */
  decodeImage?: (bytes: ArrayBuffer, mime: string) => Promise<ImageHandle>;
  /** 音声のデコード。音声を扱わないなら省略（`loadAudio` は `decodeFailed`）。 */
  decodeAudio?: (bytes: ArrayBuffer) => Promise<AudioHandle>;
  /** 取得したバイト列のハッシュが ID と一致することを検証する（エディタでは true）。 */
  verifyHash?: boolean;
  /** キャッシュの上限（バイト）。超えたら古いものから捨てる。既定は無制限。 */
  maxCacheBytes?: number;
}

export interface CachedAssetSource extends AssetSource {
  preload(ids: readonly AssetId[], onProgress?: (done: number, total: number) => void): Promise<void>;
  evict(id: AssetId): void;
  stats(): { cachedBytes: number; entries: number };
}

interface CacheEntry {
  readonly value: unknown;
  readonly bytes: number;
}

const defaultDecodeImage = async (bytes: ArrayBuffer, mime: string): Promise<ImageHandle> =>
  (await createImageBitmap(new Blob([bytes], { type: mime }))) as unknown as ImageHandle;

/**
 * `AssetBytesSource` の上に、デコード・LRU キャッシュ・同時要求の合流を載せた `AssetSource`。
 * - 同じ ID の `load*` は同じハンドル（キャッシュヒット）。`evict` 後は再ロードする。
 * - 存在しない ID は `AssetError("notFound")` で reject。デコード失敗はキャッシュに残さない（再試行できる）。
 */
export function createAssetSource(bytes: AssetBytesSource, manifest: AssetManifest, options: AssetSourceOptions = {}): CachedAssetSource {
  const maxBytes = options.maxCacheBytes ?? Number.POSITIVE_INFINITY;
  const cache = new Map<AssetId, CacheEntry>(); // Map の挿入順 = 古い順（LRU）
  const inflight = new Map<string, Promise<unknown>>();
  let cachedBytes = 0;

  const drop = (id: AssetId): void => {
    const e = cache.get(id);
    if (e === undefined) return;
    cachedBytes -= e.bytes;
    cache.delete(id);
  };

  const remember = (id: AssetId, value: unknown, size: number): void => {
    drop(id);
    if (size > maxBytes) return; // 1 つで上限を超えるものはキャッシュしない
    cache.set(id, { value, bytes: size });
    cachedBytes += size;
    // 古い順に捨てる（今入れたものは末尾なので最後まで残る）
    for (const [oldId] of cache) {
      if (cachedBytes <= maxBytes) break;
      drop(oldId);
    }
  };

  async function fetchBytes(id: AssetId): Promise<ArrayBuffer> {
    let data: ArrayBuffer | undefined;
    try {
      data = await bytes.getBytes(id);
    } catch (e) {
      throw new AssetError("network", id, `asset ${id}: 取得に失敗: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (data === undefined) throw new AssetError("notFound", id);
    if (options.verifyHash === true) {
      const actual = await hashAsset(data);
      if (actual !== id) throw new AssetError("hashMismatch", id, `asset ${id}: ハッシュが一致しない（実際: ${actual}）`);
    }
    return data;
  }

  async function load<T>(kind: string, id: AssetId, decode: (data: ArrayBuffer) => Promise<T>): Promise<T> {
    const hit = cache.get(id);
    if (hit !== undefined) {
      // LRU：使ったものを末尾（新しい側）へ
      cache.delete(id);
      cache.set(id, hit);
      return hit.value as T;
    }
    const key = `${kind}:${id}`;
    const pending = inflight.get(key);
    if (pending !== undefined) return pending as Promise<T>;

    const p = (async () => {
      const data = await fetchBytes(id);
      let value: T;
      try {
        value = await decode(data);
      } catch (e) {
        if (e instanceof AssetError) throw e;
        throw new AssetError("decodeFailed", id, `asset ${id}: デコードに失敗: ${e instanceof Error ? e.message : String(e)}`);
      }
      remember(id, value, data.byteLength);
      return value;
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  const mimeOf = (id: AssetId): string => (Object.hasOwn(manifest.entries, id) ? manifest.entries[id]?.mime : undefined) ?? "application/octet-stream";

  const source: CachedAssetSource = {
    loadImage: (id) => load("image", id, (data) => (options.decodeImage ?? defaultDecodeImage)(data, mimeOf(id))),
    loadAudio: (id) =>
      load("audio", id, (data) => {
        const decode = options.decodeAudio;
        return decode ? decode(data) : Promise.reject(new Error("decodeAudio が指定されていない"));
      }),
    loadJson: <T>(id: AssetId) => load("json", id, async (data) => JSON.parse(new TextDecoder().decode(data)) as T),
    has: (id) => bytes.has(id),

    async preload(ids, onProgress) {
      let done = 0;
      await Promise.all(
        ids.map(async (id) => {
          const kind = Object.hasOwn(manifest.entries, id) ? manifest.entries[id]?.kind : undefined;
          if (kind === "audio") await source.loadAudio(id);
          else if (kind === "data") await source.loadJson(id);
          else await source.loadImage(id);
          onProgress?.(++done, ids.length);
        }),
      );
    },
    evict: drop,
    stats: () => ({ cachedBytes, entries: cache.size }),
  };
  return source;
}
