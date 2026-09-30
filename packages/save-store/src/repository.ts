import { migrateSnapshot, SNAPSHOT_VERSION } from "@rpg/core";
import type { SaveSnapshot } from "@rpg/core";
import { err, ok } from "@rpg/runtime";
import type { Result, SaveRepository, SaveRepositoryOpts, SaveStoreError, SlotMeta } from "@rpg/runtime";
import { isQuotaError } from "./backend.js";
import type { SlotBackend } from "./backend.js";
import { sha256Hex } from "./checksum.js";
import { encode, isSaveFile, isStoredSave, metaOf } from "./stored.js";
import type { SaveFile, StoredMeta } from "./stored.js";

export const DEFAULT_MAX_SLOTS = 20;

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 互換判定（docs/11-save-store.md）。 */
export function compatibility(meta: Pick<StoredMeta, "version" | "projectHash">, opts: SaveRepositoryOpts): SlotMeta["compatible"] {
  if (meta.version > SNAPSHOT_VERSION) return "no";
  if (meta.projectHash !== opts.projectHash) return opts.allowProjectMismatch === true ? "migratable" : "no";
  return meta.version < SNAPSHOT_VERSION ? "migratable" : "yes";
}

/** `SlotBackend` の上に検証・互換判定・マイグレーション・エクスポートを載せた `SaveRepository` を作る。 */
export function createRepository(getBackend: () => Promise<SlotBackend | undefined>, opts: SaveRepositoryOpts): SaveRepository {
  const maxSlots = opts.maxSlots ?? DEFAULT_MAX_SLOTS;
  const inRange = (slot: number): boolean => Number.isInteger(slot) && slot >= 0 && slot < maxSlots;
  const noStorage: SaveStoreError = { kind: "io", message: "セーブデータを保存できるストレージが無い" };

  async function fetchRaw(slot: number): Promise<Result<unknown, SaveStoreError>> {
    if (!inRange(slot)) return err({ kind: "notFound" });
    const backend = await getBackend();
    if (backend === undefined) return err(noStorage);
    try {
      const raw = await backend.get(slot);
      return raw === undefined ? err({ kind: "notFound" }) : ok(raw);
    } catch (e) {
      return err({ kind: "io", message: message(e) });
    }
  }

  /** checksum → parse → 互換判定 → マイグレーション。`file` は保存された payload と checksum。 */
  async function decode(file: SaveFile): Promise<Result<{ snapshot: SaveSnapshot; original: SaveSnapshot }, SaveStoreError>> {
    if ((await sha256Hex(file.payload)) !== file.checksum) return err({ kind: "corrupted", detail: "checksum が一致しない" });
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.payload);
    } catch (e) {
      return err({ kind: "corrupted", detail: message(e) });
    }
    const snap = parsed as Partial<SaveSnapshot> | null;
    if (typeof snap !== "object" || snap === null || typeof snap.version !== "number" || typeof snap.projectHash !== "string" || typeof snap.projectId !== "string") {
      return err({ kind: "corrupted", detail: "スナップショットの形が不正" });
    }
    if (snap.projectId !== opts.projectId) return err({ kind: "incompatible", reason: "projectMismatch" });
    if (snap.version > SNAPSHOT_VERSION) return err({ kind: "incompatible", reason: "newerVersion" });
    if (snap.projectHash !== opts.projectHash && opts.allowProjectMismatch !== true) return err({ kind: "incompatible", reason: "projectMismatch" });
    const migrated = migrateSnapshot(snap, snap.version);
    if (!migrated.ok) return err({ kind: "corrupted", detail: migrated.error.kind === "migration" ? migrated.error.message : migrated.error.kind });
    // 再度 core が version を見てマイグレーションしないよう、最新に揃えて返す
    return ok({ snapshot: { ...(migrated.value as SaveSnapshot), version: SNAPSHOT_VERSION }, original: snap as SaveSnapshot });
  }

  async function store(slot: number, file: SaveFile, snap: SaveSnapshot): Promise<Result<SlotMeta, SaveStoreError>> {
    const backend = await getBackend();
    if (backend === undefined) return err(noStorage);
    const meta = metaOf(slot, snap);
    try {
      await backend.put(slot, { ...file, meta });
    } catch (e) {
      return err(isQuotaError(e) ? { kind: "quota" } : { kind: "io", message: message(e) });
    }
    return ok({ ...meta, compatible: compatibility(meta, opts) });
  }

  return {
    async listSlots() {
      const backend = await getBackend();
      if (backend === undefined) return [];
      const metas: SlotMeta[] = [];
      for (let slot = 0; slot < maxSlots; slot++) {
        let raw: unknown;
        try {
          raw = await backend.get(slot);
        } catch {
          continue;
        }
        // payload は parse しない（性能不変条件）。形の壊れたものは一覧に出さない。
        if (isStoredSave(raw)) metas.push({ ...raw.meta, slot, compatible: compatibility(raw.meta, opts) });
      }
      return metas;
    },

    async read(slot) {
      const raw = await fetchRaw(slot);
      if (!raw.ok) return raw;
      if (!isSaveFile(raw.value)) return err({ kind: "corrupted", detail: "保存形式が不正" });
      const decoded = await decode(raw.value);
      return decoded.ok ? ok(decoded.value.snapshot) : decoded;
    },

    async write(slot, snap) {
      if (!inRange(slot)) return err({ kind: "io", message: `スロット ${slot} は範囲外（0〜${maxSlots - 1}）` });
      if (snap.projectId !== opts.projectId) return err({ kind: "incompatible", reason: "projectMismatch" });
      const written = await store(slot, await encode(slot, snap), snap);
      return written.ok ? ok(undefined) : written;
    },

    async remove(slot) {
      if (!inRange(slot)) return;
      const backend = await getBackend();
      try {
        await backend?.delete(slot);
      } catch {
        // 消せなかった場合は残る。呼び出し側は次の listSlots で知る。
      }
    },

    async exportSlot(slot) {
      const raw = await fetchRaw(slot);
      if (!raw.ok) throw new Error(`exportSlot(${slot}): ${raw.error.kind}`);
      if (!isStoredSave(raw.value)) throw new Error(`exportSlot(${slot}): corrupted`);
      const file: SaveFile = { envelope: 1, checksum: raw.value.checksum, payload: raw.value.payload };
      return new Blob([JSON.stringify(file)], { type: "application/json" });
    },

    async importSlot(slot, blob) {
      if (!inRange(slot)) return err({ kind: "io", message: `スロット ${slot} は範囲外（0〜${maxSlots - 1}）` });
      let file: unknown;
      try {
        file = JSON.parse(await blob.text());
      } catch (e) {
        return err({ kind: "corrupted", detail: message(e) });
      }
      if (!isSaveFile(file)) return err({ kind: "corrupted", detail: ".rpgsave の形式が不正" });
      const decoded = await decode(file);
      if (!decoded.ok) return decoded;
      return store(slot, file, decoded.value.original);
    },
  };
}
