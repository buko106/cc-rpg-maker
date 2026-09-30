import type { AssetEntry, AssetId } from "@rpg/schema";
import type { AssetKind } from "./ports/projectRepository.js";

/** 内容ハッシュ：sha256 の先頭 16 桁（hex）。`@rpg/assets` の `hashAsset` と同じ定義（docs/09-assets.md）。 */
export async function hashBytes(bytes: ArrayBuffer): Promise<AssetId> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  let hex = "";
  for (const b of new Uint8Array(digest).subarray(0, 8)) hex += b.toString(16).padStart(2, "0");
  return hex as AssetId;
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  ogg: "audio/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  json: "application/json",
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
};

/** ファイル名の拡張子から MIME を推測する。分からなければ `application/octet-stream`。 */
export function mimeOf(name: string): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase();
  return (ext === undefined ? undefined : MIME_BY_EXTENSION[ext]) ?? "application/octet-stream";
}

/** PNG / GIF / JPEG のヘッダから画像サイズを読む。読めなければ `undefined`（DOM に頼らない）。 */
export function imageSize(bytes: ArrayBuffer): { width: number; height: number } | undefined {
  const b = new Uint8Array(bytes);
  const view = new DataView(bytes);
  // PNG: 8 バイトのシグネチャ + IHDR（幅・高さは 16..23）
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  // GIF: "GIF8" + 論理画面サイズ（リトルエンディアン）
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  // JPEG: SOF マーカーを探す
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return undefined;
      const marker = b[i + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: view.getUint16(i + 5), width: view.getUint16(i + 7) };
      }
      i += 2 + view.getUint16(i + 2);
    }
  }
  return undefined;
}

export function assetEntryOf(bytes: ArrayBuffer, name: string, kind: AssetKind): AssetEntry {
  const size = kind === "image" ? imageSize(bytes) : undefined;
  return { name, kind, mime: mimeOf(name), size: bytes.byteLength, ...(size === undefined ? {} : size) };
}

export function base64ToBytes(base64: string): ArrayBuffer {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
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

/**
 * アセットを書き出すときの拡張子（`.png` など）。名前の拡張子（英数字 1〜8 文字）を優先し、無ければ MIME から、それも無ければ `.bin`。
 * プレイヤーが `assets/<id>.<ext>` を取りに行くときの規則（`@rpg/assets` の `assetExtension`）と同じでなければならない
 * （`apps/player` のテストで突き合わせている）。
 */
export function extensionOf(entry: { name?: string; mime?: string }): string {
  const fromName = /\.([A-Za-z0-9]{1,8})$/.exec(entry.name ?? "")?.[1];
  return `.${fromName?.toLowerCase() ?? EXTENSION_BY_MIME[entry.mime ?? ""] ?? "bin"}`;
}
