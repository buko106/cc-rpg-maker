import type { AssetId } from "@rpg/schema";
import type { CommitBatch, StoreBackend, StoredMeta } from "./backend.js";
import type { ProjectRepository } from "./ports/projectRepository.js";
import { createRepository } from "./repository.js";
import type { RepositoryOptions } from "./repository.js";

export interface IdbOptions extends RepositoryOptions {
  /** 既定 `rpg-projects`。 */
  dbName?: string;
  /** 既定は `globalThis.indexedDB`。 */
  indexedDB?: IDBFactory;
  /** 既定は `globalThis.IDBKeyRange`（`indexedDB` を差し替えるときは対になるものを渡す）。 */
  keyRange?: typeof IDBKeyRange;
}

const PROJECTS = "projects";
const MAPS = "maps";
const ASSETS = "assets";
const META = "meta";

const request = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB の要求に失敗"));
  });

/** トランザクションの完了を待つ（容量超過などは abort として届く）。 */
const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB のトランザクションに失敗"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB のトランザクションが中断された"));
  });

function openDb(factory: IDBFactory, dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(dbName, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      // projects / meta のキーはプロジェクト ID、maps は [projectId, mapId]、assets は [projectId, assetId]
      for (const name of [PROJECTS, MAPS, ASSETS, META]) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB を開けない"));
    req.onblocked = () => reject(new Error("IndexedDB がブロックされた"));
  });
}

export function createIdbBackend(getDb: () => Promise<IDBDatabase>, keyRange: typeof IDBKeyRange = globalThis.IDBKeyRange): StoreBackend {
  /** `[projectId, *]` のキーをすべて含む範囲。 */
  const rangeOf = (projectId: string): IDBKeyRange => keyRange.bound([projectId], [projectId, []]);
  return {
    async listMeta() {
      const tx = (await getDb()).transaction(META, "readonly");
      const store = tx.objectStore(META);
      const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
      return keys.map((key, i) => ({ id: String(key), meta: values[i] as StoredMeta }));
    },
    async getMeta(id) {
      const tx = (await getDb()).transaction(META, "readonly");
      return (await request<unknown>(tx.objectStore(META).get(id))) as StoredMeta | undefined;
    },
    async getProject(id) {
      const tx = (await getDb()).transaction(PROJECTS, "readonly");
      return request<unknown>(tx.objectStore(PROJECTS).get(id));
    },
    async getMap(id, mapId) {
      const tx = (await getDb()).transaction(MAPS, "readonly");
      return request<unknown>(tx.objectStore(MAPS).get([id, mapId]));
    },
    async commit(id, batch: CommitBatch) {
      const tx = (await getDb()).transaction([PROJECTS, MAPS, META], "readwrite");
      tx.objectStore(PROJECTS).put(batch.project, id);
      const maps = tx.objectStore(MAPS);
      for (const [mapId, value] of Object.entries(batch.maps)) {
        if (value === null) maps.delete([id, mapId]);
        else maps.put(value, [id, mapId]);
      }
      tx.objectStore(META).put(batch.meta, id);
      await done(tx);
    },
    async removeProject(id) {
      const tx = (await getDb()).transaction([PROJECTS, MAPS, ASSETS, META], "readwrite");
      tx.objectStore(PROJECTS).delete(id);
      tx.objectStore(MAPS).delete(rangeOf(id));
      tx.objectStore(ASSETS).delete(rangeOf(id));
      tx.objectStore(META).delete(id);
      await done(tx);
    },
    async putAsset(id, assetId: AssetId, bytes) {
      const tx = (await getDb()).transaction(ASSETS, "readwrite");
      tx.objectStore(ASSETS).put(bytes, [id, assetId]);
      await done(tx);
    },
    async getAsset(id, assetId) {
      const tx = (await getDb()).transaction(ASSETS, "readonly");
      return (await request<unknown>(tx.objectStore(ASSETS).get([id, assetId]))) as ArrayBuffer | undefined;
    },
    async deleteAsset(id, assetId) {
      const tx = (await getDb()).transaction(ASSETS, "readwrite");
      tx.objectStore(ASSETS).delete([id, assetId]);
      await done(tx);
    },
  };
}

/** IndexedDB 上の ProjectRepository。DB は最初の操作で開く。 */
export function createIdbProjectRepository(opts: IdbOptions = {}): ProjectRepository {
  const factory = opts.indexedDB ?? globalThis.indexedDB;
  let db: Promise<IDBDatabase> | undefined;
  const getDb = (): Promise<IDBDatabase> => {
    db ??= openDb(factory, opts.dbName ?? "rpg-projects");
    // 開けなかったときは覚えず、次の操作でやり直す
    db.catch(() => {
      db = undefined;
    });
    return db;
  };
  return createRepository(createIdbBackend(getDb, opts.keyRange), opts);
}

export type { StoredMeta };
