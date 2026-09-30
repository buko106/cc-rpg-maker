/**
 * @rpg/save-store — SaveRepository（セーブデータの永続化）。
 *
 * 設計: docs/11-save-store.md
 */
import type { SaveRepository, SaveRepositoryOpts } from "@rpg/runtime";
import { createIdbBackend, openSaveDb } from "./idb.js";
import type { IdbOpts } from "./idb.js";
import { createLocalStorageBackend, storageAvailable } from "./local-storage.js";
import type { LocalStorageOpts } from "./local-storage.js";
import { createRepository } from "./repository.js";
import type { SlotBackend } from "./backend.js";

export { createIdbSaveRepository } from "./idb.js";
export type { IdbOpts } from "./idb.js";
export { createLocalStorageSaveRepository } from "./local-storage.js";
export type { LocalStorageOpts } from "./local-storage.js";
export { createMemorySaveRepository } from "./memory.js";
export type { MemoryStore } from "./memory.js";
export { compatibility, DEFAULT_MAX_SLOTS } from "./repository.js";
export type { SaveRepository, SaveRepositoryOpts, SaveStoreError, SlotMeta } from "@rpg/runtime";

/**
 * 環境を検出して IndexedDB → localStorage の順に選ぶ。どちらも使えなければ、
 * 書き込みが `io` エラーになる（`listSlots` は空）リポジトリを返す。選択は最初の操作で行う。
 */
export function createSaveRepository(opts: SaveRepositoryOpts & IdbOpts & LocalStorageOpts): SaveRepository {
  let chosen: Promise<SlotBackend | undefined> | undefined;
  const choose = async (): Promise<SlotBackend | undefined> => {
    const factory = opts.indexedDB ?? globalThis.indexedDB;
    if (factory !== undefined) {
      try {
        return createIdbBackend(opts.projectId, await openSaveDb(factory, opts.dbName ?? "rpg-saves"));
      } catch {
        // IndexedDB が使えない環境（プライベートモード等）：localStorage へ
      }
    }
    const storage = opts.storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
    return storageAvailable(storage) ? createLocalStorageBackend(opts.projectId, { ...opts, storage }) : undefined;
  };
  return createRepository(() => (chosen ??= choose()), opts);
}
