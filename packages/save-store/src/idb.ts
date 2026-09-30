import type { SaveRepository, SaveRepositoryOpts } from "@rpg/runtime";
import type { SlotBackend } from "./backend.js";
import { createRepository } from "./repository.js";

export interface IdbOpts {
  /** 既定 `rpg-saves`。 */
  dbName?: string;
  /** 既定は `globalThis.indexedDB`。 */
  indexedDB?: IDBFactory;
}

const STORE = "saves";

const request = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB の要求に失敗"));
  });

/** トランザクションの完了を待つ（`put` の容量超過などは abort として届く）。 */
const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB のトランザクションに失敗"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB のトランザクションが中断された"));
  });

export function openSaveDb(factory: IDBFactory, dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(dbName, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB を開けない"));
    req.onblocked = () => reject(new Error("IndexedDB がブロックされた"));
  });
}

/** キーは `[projectId, slot]`。 */
export function createIdbBackend(projectId: string, db: IDBDatabase): SlotBackend {
  const key = (slot: number): IDBValidKey => [projectId, slot];
  return {
    async get(slot) {
      const tx = db.transaction(STORE, "readonly");
      const value = await request<unknown>(tx.objectStore(STORE).get(key(slot)));
      return value;
    },
    async put(slot, value) {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key(slot));
      await done(tx);
    },
    async delete(slot) {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(key(slot));
      await done(tx);
    },
  };
}

/** IndexedDB 上の SaveRepository。DB は最初の操作で開く（開けなければ以降の操作は `io`）。 */
export function createIdbSaveRepository(opts: SaveRepositoryOpts & IdbOpts): SaveRepository {
  const factory = opts.indexedDB ?? globalThis.indexedDB;
  let backend: Promise<SlotBackend | undefined> | undefined;
  const getBackend = (): Promise<SlotBackend | undefined> =>
    (backend ??= openSaveDb(factory, opts.dbName ?? "rpg-saves").then(
      (db) => createIdbBackend(opts.projectId, db),
      () => undefined,
    ));
  return createRepository(getBackend, opts);
}
