import type { AssetId, AssetManifest } from "@rpg/runtime";

/** アセットのバイナリ本体の取得口。デコードやキャッシュはここでは行わない。 */
export interface AssetBytesSource {
  /** 無ければ `undefined`。通信失敗などは reject。 */
  getBytes(id: AssetId): Promise<ArrayBuffer | undefined>;
  has(id: AssetId): Promise<boolean>;
}

export type MemoryBytesSource = AssetBytesSource & { put(id: AssetId, bytes: ArrayBuffer): void };

export function createMemoryBytesSource(entries: Record<AssetId, ArrayBuffer> = {}): MemoryBytesSource {
  const store = new Map<AssetId, ArrayBuffer>(Object.entries(entries) as [AssetId, ArrayBuffer][]);
  return {
    getBytes: (id) => Promise.resolve(store.get(id)),
    has: (id) => Promise.resolve(store.has(id)),
    put(id, bytes) {
      store.set(id, bytes);
    },
  };
}

const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/mp4": "m4a",
  "application/json": "json",
};

/** ファイル名の拡張子（`hero.png` → `png`）。無ければ MIME から推測する。 */
export function assetExtension(entry: { name: string; mime: string }): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(entry.name);
  return m?.[1]?.toLowerCase() ?? MIME_EXTENSIONS[entry.mime] ?? "bin";
}

export interface HttpBytesSourceOptions {
  /** 既定は `globalThis.fetch`。 */
  fetch?: typeof fetch;
}

/**
 * `baseUrl/{id}.{ext}` から取得する（配布版。ファイル名がハッシュなので不変 = キャッシュ可能）。
 * マニフェストに無い ID は `undefined`（通信しない）。404 も `undefined`、それ以外のエラーは reject。
 */
export function createHttpBytesSource(baseUrl: string, manifest: AssetManifest, options: HttpBytesSourceOptions = {}): AssetBytesSource {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const urlOf = (id: AssetId): string | undefined => {
    const entry = Object.hasOwn(manifest.entries, id) ? manifest.entries[id] : undefined;
    return entry === undefined ? undefined : `${base}${id}.${assetExtension(entry)}`;
  };
  return {
    async getBytes(id) {
      const url = urlOf(id);
      if (url === undefined) return undefined;
      const res = await (options.fetch ?? fetch)(url);
      if (res.status === 404) return undefined;
      if (!res.ok) throw new Error(`asset ${id}: HTTP ${res.status} (${url})`);
      return res.arrayBuffer();
    },
    has: (id) => Promise.resolve(urlOf(id) !== undefined),
  };
}
