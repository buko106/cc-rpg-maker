import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { loadRawProject, projectRepositoryContract } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { createIdbProjectRepository } from "./idb.js";
import { createMemoryBackend, createMemoryProjectRepository } from "./memory.js";
import { createRepository } from "./repository.js";
import { writeZip } from "./zip.js";

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

  it("importZip の commit が失敗したら、書きかけのアセットも残さず、io エラーを返す", async () => {
    const backend = createMemoryBackend();
    let fail = false;
    const flaky = { ...backend, commit: (id: string, batch: Parameters<typeof backend.commit>[1]) => (fail ? Promise.reject(new Error("容量が足りない (quota)")) : backend.commit(id, batch)) };
    const repo = createRepository(flaky);
    const doc = await repo.create("a");
    const zip = await repo.exportZip(doc.project.meta.id);
    if (!zip.ok) throw new Error("export に失敗");
    fail = true;
    const r = await repo.importZip(zip.value);
    expect(r).toEqual({ ok: false, error: { kind: "quota" } });
    expect((await repo.list()).map((m) => m.id)).toEqual([doc.project.meta.id]);
  });

  it("exportZip は保存されたマップが欠けていると schema エラー、バックエンドが例外を投げたら io", async () => {
    const backend = createMemoryBackend();
    const repo = createRepository({ ...backend, getMap: () => Promise.resolve(undefined) });
    const doc = await repo.create("a");
    const r = await repo.exportZip(doc.project.meta.id);
    expect(!r.ok && r.error.kind).toBe("schema");
    const broken = createRepository({ ...backend, getProject: () => Promise.reject(new Error("読めない")) });
    expect(await broken.exportZip(doc.project.meta.id)).toEqual({ ok: false, error: { kind: "io", message: "読めない" } });
  });

  describe("古い formatVersion（v1 のフィクスチャ）", () => {
    const old = loadRawProject("minimal"); // formatVersion 1
    const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

    it("importZip は v1 の ZIP を現行のフォーマットに変換して保存する", async () => {
      const repo = createMemoryProjectRepository();
      const zip = writeZip([
        { name: "project.json", bytes: enc(old.project) },
        ...Object.entries(old.maps).map(([id, json]) => ({ name: `maps/${id}.json`, bytes: enc(json) })),
      ]);
      const r = await repo.importZip(zip);
      expect(r.ok && r.value.formatVersion).toBe(2);
      if (!r.ok) return;
      const loaded = await repo.load(r.value.id);
      expect(loaded.ok && loaded.value.project.formatVersion).toBe(2);
      expect(loaded.ok && loaded.value.project.system.plugins).toEqual([]);
      expect(loaded.ok && Object.keys(loaded.value.maps)).toEqual(["map_start"]);
    });

    it("load は v1 で保存されていた文書を変換し、直ちに保存し直す（revision が 1 進む。2 回目以降は保存し直さない）", async () => {
      const backend = createMemoryBackend();
      const project = { ...(old.project as Record<string, any>) };
      const id = "old-project";
      await backend.commit(id, {
        project,
        maps: { map_start: old.maps["map_start"] },
        meta: { title: "old", updatedAt: "2026-01-01T00:00:00.000Z", formatVersion: 1, revision: 4, sizeBytes: 1, mapSizes: { map_start: 1 } },
      });
      const repo = createRepository(backend);
      const first = await repo.load(id);
      expect(first.ok && first.value.revision).toBe(5);
      expect(first.ok && first.value.project.formatVersion).toBe(2);
      expect((await backend.getProject(id) as { formatVersion: number }).formatVersion).toBe(2);
      expect((await backend.getMeta(id))?.formatVersion).toBe(2);
      const second = await repo.load(id);
      expect(second.ok && second.value.revision).toBe(5);
    });
  });
});
