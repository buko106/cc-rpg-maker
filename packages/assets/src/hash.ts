import type { AssetId } from "@rpg/runtime";

/** アセットの内容ハッシュ：sha256 の先頭 16 桁（hex）。`AssetId` の形式（docs/01-schema.md）。 */
export async function hashAsset(bytes: ArrayBuffer): Promise<AssetId> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  let hex = "";
  for (const b of new Uint8Array(digest).subarray(0, 8)) hex += b.toString(16).padStart(2, "0");
  return hex as AssetId;
}
