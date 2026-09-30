import type { SaveRepository, SaveRepositoryOpts } from "@rpg/runtime";
import type { SlotBackend } from "./backend.js";
import { createRepository } from "./repository.js";

export interface LocalStorageOpts {
  /** キーの接頭辞。既定 `rpg-save`。キーは `${prefix}:${projectId}:${slot}`。 */
  prefix?: string;
  /** 既定は `globalThis.localStorage`。 */
  storage?: Storage;
}

/** `Storage` が実際に読み書きできるか（プライベートモード等で例外になる環境を弾く）。 */
export function storageAvailable(storage: Storage | undefined): storage is Storage {
  if (storage === undefined) return false;
  try {
    const key = "__rpg_probe__";
    storage.setItem(key, "1");
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function createLocalStorageBackend(projectId: string, opts: LocalStorageOpts = {}): SlotBackend {
  const storage = opts.storage ?? globalThis.localStorage;
  const key = (slot: number): string => `${opts.prefix ?? "rpg-save"}:${projectId}:${slot}`;
  return {
    get(slot) {
      const text = storage.getItem(key(slot));
      if (text === null) return Promise.resolve(undefined);
      try {
        return Promise.resolve(JSON.parse(text) as unknown);
      } catch {
        return Promise.resolve(text); // 壊れた保存は形の検証で corrupted になる
      }
    },
    put(slot, value) {
      try {
        storage.setItem(key(slot), JSON.stringify(value));
        return Promise.resolve();
      } catch (e) {
        return Promise.reject(e);
      }
    },
    delete(slot) {
      storage.removeItem(key(slot));
      return Promise.resolve();
    },
  };
}

/** localStorage 上の SaveRepository（IndexedDB が使えない環境の代替）。容量超過は `quota`。 */
export function createLocalStorageSaveRepository(opts: SaveRepositoryOpts & LocalStorageOpts): SaveRepository {
  const backend = createLocalStorageBackend(opts.projectId, opts);
  return createRepository(() => Promise.resolve(backend), opts);
}
