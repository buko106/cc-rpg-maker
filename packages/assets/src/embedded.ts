import type { AssetId } from "@rpg/runtime";
import type { AssetBytesSource } from "./bytes-source.js";

function decodeBase64(base64: string): ArrayBuffer {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/**
 * base64 で埋め込まれたアセットを読む `AssetBytesSource`（単一 HTML の配布物。通信しない）。
 * デコードは `getBytes` が呼ばれたときに行い、呼ぶたびに新しい `ArrayBuffer` を返す（呼び出し側が転送・変更しても影響しない）。
 */
export function createEmbeddedBytesSource(assets: Readonly<Record<string, string>>): AssetBytesSource {
  const has = (id: AssetId): boolean => Object.hasOwn(assets, id);
  return {
    getBytes: (id) => Promise.resolve(has(id) ? decodeBase64(assets[id]!) : undefined),
    has: (id) => Promise.resolve(has(id)),
  };
}
