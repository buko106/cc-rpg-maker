import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { projectRepositoryContract } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { createIdbProjectRepository } from "./idb.js";
import { createMemoryBackend, createMemoryProjectRepository } from "./memory.js";
import { createRepository } from "./repository.js";

projectRepositoryContract("memory", () => createMemoryProjectRepository());
projectRepositoryContract("idb (fake-indexeddb)", () => createIdbProjectRepository({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange }));

describe("createIdbProjectRepository", () => {
  it("開き直しても保存内容が残る", async () => {
    const factory = new IDBFactory();
    const a = createIdbProjectRepository({ indexedDB: factory, keyRange: IDBKeyRange, dbName: "x" });
    const doc = await a.create("残る");
    const b = createIdbProjectRepository({ indexedDB: factory, keyRange: IDBKeyRange, dbName: "x" });
    const loaded = await b.load(doc.project.meta.id);
    expect(loaded.ok && loaded.value).toEqual(doc);
    expect((await b.assets(doc.project.meta.id).get(Object.keys(doc.project.assets.entries)[0] as never))?.byteLength).toBeGreaterThan(0);
  });
});

describe("createRepository（共通の振る舞い）", () => {
  it("[inv-2] commit が失敗したら直前の状態が残る（原子性）", async () => {
    const backend = createMemoryBackend();
    let failNext = false;
    const flaky = {
      ...backend,
      commit: (id: string, batch: Parameters<typeof backend.commit>[1]) => (failNext ? Promise.reject(new Error("書き込み中に失敗")) : backend.commit(id, batch)),
    };
    const repo = createRepository(flaky);
    const doc = await repo.create("a");
    failNext = true;
    const r = await repo.save({ ...doc, project: { ...doc.project, meta: { ...doc.project.meta, title: "変更" } } });
    expect(r).toEqual({ ok: false, error: { kind: "io", message: "書き込み中に失敗" } });
    failNext = false;
    const loaded = await repo.load(doc.project.meta.id);
    expect(loaded.ok && loaded.value).toEqual(doc);
  });

  it("容量超過は quota に分類する", async () => {
    const backend = createMemoryBackend();
    let full = false;
    const repo = createRepository({
      ...backend,
      commit: (id, batch) => {
        if (full) return Promise.reject(Object.assign(new Error("full"), { name: "QuotaExceededError" }));
        return backend.commit(id, batch);
      },
    });
    const doc = await repo.create("a");
    full = true;
    expect(await repo.save(doc)).toEqual({ ok: false, error: { kind: "quota" } });
  });

  it("changedMaps に無いマップは書き込みバッチに含まれない", async () => {
    const backend = createMemoryBackend();
    const written: string[][] = [];
    const repo = createRepository({
      ...backend,
      commit: (id, batch) => {
        written.push(Object.keys(batch.maps));
        return backend.commit(id, batch);
      },
    });
    const doc = await repo.create("a");
    await repo.save(doc, { changedMaps: [] });
    await repo.save(doc);
    expect(written).toEqual([["map_001"], [], ["map_001"]]);
  });

  it("新しい formatVersion のデータは schema エラー", async () => {
    const backend = createMemoryBackend();
    const repo = createRepository(backend);
    const doc = await repo.create("a");
    const raw = (await backend.getProject(doc.project.meta.id)) as { formatVersion: number };
    await backend.commit(doc.project.meta.id, { project: { ...raw, formatVersion: 99 }, maps: {}, meta: (await backend.getMeta(doc.project.meta.id))! });
    const r = await repo.load(doc.project.meta.id);
    expect(!r.ok && r.error.kind === "schema" && r.error.error.kind).toBe("newer-format");
  });

  it("id と now を注入できる", async () => {
    const repo = createRepository(createMemoryBackend(), { now: () => Date.UTC(2026, 0, 2), idSource: { now: () => 0, random: () => 0 } });
    const doc = await repo.create("t");
    expect(doc.project.meta.createdAt).toBe("2026-01-02T00:00:00.000Z");
    expect(doc.project.meta.id).toBe("prj_00000000000000000000000000");
  });
});
