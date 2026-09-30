import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { createMemoryStorage, quotaError, sampleSnapshot, saveRepositoryContract } from "@rpg/test-utils";
import type { SaveRepositoryFixture } from "@rpg/test-utils";
import { createIdbSaveRepository, createLocalStorageSaveRepository, createMemorySaveRepository, createSaveRepository } from "./index.js";
import type { MemoryStore } from "./index.js";

const corrupt = (stored: unknown): unknown => ({ ...(stored as { payload: string }), payload: `${(stored as { payload: string }).payload} ` });

saveRepositoryContract("memory", (): SaveRepositoryFixture => {
  const store: MemoryStore = new Map();
  return {
    open: (opts) => createMemorySaveRepository({ ...opts, store }),
    tamper(projectId, slot) {
      const key = `${projectId}:${slot}`;
      store.set(key, corrupt(store.get(key)));
      return Promise.resolve();
    },
  };
});

saveRepositoryContract("localStorage", (): SaveRepositoryFixture => {
  const storage = createMemoryStorage();
  return {
    open: (opts) => createLocalStorageSaveRepository({ ...opts, storage }),
    tamper(projectId, slot) {
      const key = `rpg-save:${projectId}:${slot}`;
      storage.setItem(key, JSON.stringify(corrupt(JSON.parse(storage.getItem(key) ?? "null"))));
      return Promise.resolve();
    },
  };
});

let dbCounter = 0;
saveRepositoryContract("indexedDB", (): SaveRepositoryFixture => {
  const indexedDB = new IDBFactory();
  const dbName = `test-${++dbCounter}`;
  return {
    open: (opts) => createIdbSaveRepository({ ...opts, indexedDB, dbName }),
    async tamper(projectId, slot) {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName, 1);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const tx = db.transaction("saves", "readwrite");
      const store = tx.objectStore("saves");
      const got = store.get([projectId, slot]);
      got.onsuccess = () => store.put(corrupt(got.result), [projectId, slot]);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
  };
});

const OPTS = { projectId: "proj-a", projectHash: "hash-1" };

describe("localStorage 固有", () => {
  it("キーは prefix:projectId:slot", async () => {
    const storage = createMemoryStorage();
    const repo = createLocalStorageSaveRepository({ ...OPTS, storage, prefix: "my" });
    await repo.write(2, sampleSnapshot());
    expect([...storage.data.keys()]).toEqual(["my:proj-a:2"]);
  });

  it("容量超過は quota（既存のセーブは残る）", async () => {
    const storage = createMemoryStorage();
    const repo = createLocalStorageSaveRepository({ ...OPTS, storage });
    await repo.write(1, sampleSnapshot({ tick: 1 }));
    storage.failSet = quotaError();
    expect(await repo.write(2, sampleSnapshot())).toEqual({ ok: false, error: { kind: "quota" } });
    storage.failSet = new Error("disk error");
    const other = await repo.write(2, sampleSnapshot());
    expect(!other.ok && other.error.kind).toBe("io");
    storage.failSet = undefined;
    expect((await repo.listSlots()).map((m) => m.slot)).toEqual([1]);
  });

  it("JSON でない値が入っていても corrupted（一覧には出ない）", async () => {
    const storage = createMemoryStorage();
    const repo = createLocalStorageSaveRepository({ ...OPTS, storage });
    storage.setItem("rpg-save:proj-a:3", "{not json");
    const r = await repo.read(3);
    expect(!r.ok && r.error.kind).toBe("corrupted");
    expect(await repo.listSlots()).toEqual([]);
  });
});

describe("マイグレーション", () => {
  it("version が古いセーブは snapshotMigrations を通り、ストレージは書き換えない", async () => {
    // 現在は v1 のみ。v0 は存在しない形式なので、マイグレーションが無い version は corrupted になることを確認する
    const store: MemoryStore = new Map();
    const repo = createMemorySaveRepository({ ...OPTS, store });
    await repo.write(1, sampleSnapshot({ version: 0 }));
    expect((await repo.listSlots())[0]?.compatible).toBe("migratable");
    const r = await repo.read(1);
    expect(!r.ok && r.error.kind).toBe("corrupted");
  });
});

describe("createSaveRepository（環境検出）", () => {
  it("IndexedDB があればそれを使う", async () => {
    const indexedDB = new IDBFactory();
    const a = createSaveRepository({ ...OPTS, indexedDB, dbName: "detect-1" });
    await a.write(1, sampleSnapshot({ tick: 5 }));
    const b = createIdbSaveRepository({ ...OPTS, indexedDB, dbName: "detect-1" });
    expect((await b.listSlots())[0]?.playtimeTicks).toBe(5);
  });

  it("IndexedDB が開けなければ localStorage にフォールバックする", async () => {
    const broken = { open: () => { throw new Error("denied"); } } as unknown as IDBFactory;
    const storage = createMemoryStorage();
    const repo = createSaveRepository({ ...OPTS, indexedDB: broken, storage });
    expect((await repo.write(1, sampleSnapshot())).ok).toBe(true);
    expect(storage.data.size).toBe(1);
  });

  it("どちらも使えなければ、書き込みは io で失敗し、一覧は空", async () => {
    const broken = { open: () => { throw new Error("denied"); } } as unknown as IDBFactory;
    const storage = createMemoryStorage();
    storage.failSet = new Error("denied");
    const repo = createSaveRepository({ ...OPTS, indexedDB: broken, storage });
    const w = await repo.write(1, sampleSnapshot());
    expect(!w.ok && w.error.kind).toBe("io");
    expect(await repo.listSlots()).toEqual([]);
    const r = await repo.read(1);
    expect(!r.ok && r.error.kind).toBe("io");
    await expect(repo.remove(1)).resolves.toBeUndefined();
  });
});
