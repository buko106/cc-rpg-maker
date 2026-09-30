import type { SaveSnapshot } from "@rpg/core";
import type { SlotMeta } from "@rpg/runtime";
import { sha256Hex } from "./checksum.js";

/** ストレージに置くメタ情報（`compatible` は一覧を作るときに判定する）。 */
export type StoredMeta = Omit<SlotMeta, "compatible">;

/** 保存フォーマット（docs/11-save-store.md）。`meta` は `listSlots` が payload を parse せずに済むための写し。 */
export interface StoredSave {
  envelope: 1;
  /** sha256(payload) の hex */
  checksum: string;
  /** JSON.stringify(SaveSnapshot) */
  payload: string;
  meta: StoredMeta;
}

/** `.rpgsave` ファイルの中身。`meta` は信用せず、取り込み時に payload から作り直す。 */
export interface SaveFile {
  envelope: 1;
  checksum: string;
  payload: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function isSaveFile(v: unknown): v is SaveFile {
  return isRecord(v) && v.envelope === 1 && typeof v.checksum === "string" && typeof v.payload === "string";
}

export function isStoredSave(v: unknown): v is StoredSave {
  if (!isSaveFile(v)) return false;
  const meta = (v as unknown as { meta?: unknown }).meta;
  return isRecord(meta) && typeof meta.slot === "number" && typeof meta.savedAt === "string" && typeof meta.version === "number" && typeof meta.projectHash === "string";
}

export const metaOf = (slot: number, snap: SaveSnapshot): StoredMeta => ({
  slot,
  savedAt: snap.savedAt,
  playtimeTicks: snap.playtimeTicks,
  preview: snap.preview,
  version: snap.version,
  projectHash: snap.projectHash,
});

export async function encode(slot: number, snap: SaveSnapshot): Promise<StoredSave> {
  const payload = JSON.stringify(snap);
  return { envelope: 1, checksum: await sha256Hex(payload), payload, meta: metaOf(slot, snap) };
}
