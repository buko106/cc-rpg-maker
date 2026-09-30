import { createFakeDirectory, projectRepositoryContract } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { createDirectoryBackend } from "./directory.js";
import { createFsaProjectRepository, createOpfsProjectRepository, openOpfsProjectRepository, pickFsaProjectRepository } from "./fs-repositories.js";
import { createRepository } from "./repository.js";

// ディレクトリ（OPFS / File System Access API）上の永続層。ブラウザの API はメモリ上のフェイクで置き換えて、共通の契約テストにかける。
// 実ブラウザの OPFS は e2e/opfs.spec.ts で確かめる。
projectRepositoryContract("opfs (fake directory)", () => createOpfsProjectRepository(createFakeDirectory()));
projectRepositoryContract("fsa (fake directory)", () => createFsaProjectRepository(createFakeDirectory()));

describe("ディレクトリ上のレイアウト", () => {
  it("<id>/project.json・meta.json・maps/<mapId>.json・assets/<assetId>.bin に置く", async () => {
    const dir = createFakeDirectory();
    const repo = createOpfsProjectRepository(dir);
    const doc = await repo.create("レイアウト");
    const id = doc.project.meta.id;
    const assetIds = Object.keys(doc.project.assets.entries);
    expect(dir.paths()).toEqual([`${id}/assets/${assetIds[0]}.bin`, ...(assetIds.slice(1).map((a) => `${id}/assets/${a}.bin`)), `${id}/maps/map_001.json`, `${id}/meta.json`, `${id}/project.json`].sort());
  });

  it("別のツールが `<assetId>.png` の名前で置いたアセットも読める。削除は拡張子を問わない", async () => {
    const dir = createFakeDirectory();
    const backend = createDirectoryBackend(dir);
    const project = await dir.getDirectoryHandle("p", { create: true });
    const assets = await project.getDirectoryHandle("assets", { create: true });
    const w = await (await assets.getFileHandle("0123456789abcdef.png", { create: true })).createWritable();
    await w.write(new Uint8Array([1, 2, 3]).buffer);
    await w.close();
    expect(new Uint8Array((await backend.getAsset("p", "0123456789abcdef" as never))!)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await backend.getAsset("p", "fedcba9876543210" as never)).toBeUndefined();
    await backend.deleteAsset("p", "0123456789abcdef" as never);
    expect(dir.paths()).toEqual([]);
    await expect(backend.deleteAsset("nothing", "0123456789abcdef" as never)).resolves.toBeUndefined();
  });

  it("一覧：meta.json が無い・壊れているフォルダと、ファイルは無視する", async () => {
    const dir = createFakeDirectory();
    const repo = createOpfsProjectRepository(dir);
    const doc = await repo.create("本物");
    await dir.getDirectoryHandle("empty-folder", { create: true });
    const broken = await dir.getDirectoryHandle("broken", { create: true });
    const w = await (await broken.getFileHandle("meta.json", { create: true })).createWritable();
    await w.write("{oops");
    await w.close();
    await (await dir.getFileHandle("stray.txt", { create: true })).createWritable().then((x) => x.close());
    expect((await repo.list()).map((m) => m.id)).toEqual([doc.project.meta.id]);
  });

  it("危険な名前（パスの区切り・..）は受け付けない", async () => {
    const backend = createDirectoryBackend(createFakeDirectory());
    for (const bad of ["../x", "a/b", "", ".", ".."]) {
      await expect(backend.getMeta(bad)).rejects.toThrow(/使えない/);
      await expect(backend.removeProject(bad)).rejects.toThrow(/使えない/);
    }
    await expect(backend.getMap("ok", "../evil")).resolves.toBeUndefined(); // フォルダが無いので undefined（検査はフォルダの後）
    await expect(backend.putAsset("ok", "../evil" as never, new ArrayBuffer(1))).rejects.toThrow(/使えない/);
  });

  it("存在しないプロジェクトは undefined / notFound。project.json が無ければ getProject は例外", async () => {
    const dir = createFakeDirectory();
    const backend = createDirectoryBackend(dir);
    expect(await backend.getMeta("nothing")).toBeUndefined();
    await expect(backend.getProject("nothing")).rejects.toThrow(/project.json が無い/);
    await backend.removeProject("nothing"); // 何もしない
    expect(await createRepository(backend).load("nothing")).toMatchObject({ ok: false });
  });

  it("書き込みが途中で失敗すると、そのファイルは元のまま。meta.json が最後なので revision も進まない", async () => {
    const dir = createFakeDirectory();
    const repo = createOpfsProjectRepository(dir);
    const doc = await repo.create("失敗");
    // マップの書き込みを 1 回失敗させる
    dir.failNextWrite(new Error("ディスクが壊れた"));
    const r = await repo.save({ ...doc, project: { ...doc.project, meta: { ...doc.project.meta, title: "変更" } } });
    expect(r).toEqual({ ok: false, error: { kind: "io", message: "ディスクが壊れた" } });
    const loaded = await repo.load(doc.project.meta.id);
    expect(loaded.ok && loaded.value).toEqual(doc);
  });

  it("容量超過（QuotaExceededError）は quota になる", async () => {
    const dir = createFakeDirectory();
    const repo = createOpfsProjectRepository(dir);
    const doc = await repo.create("容量");
    const quota = Object.assign(new Error("full"), { name: "QuotaExceededError" });
    dir.failNextWrite(quota);
    expect(await repo.save(doc)).toEqual({ ok: false, error: { kind: "quota" } });
  });

  it("プロジェクトを消すとフォルダごと消え、アセットも残らない", async () => {
    const dir = createFakeDirectory();
    const repo = createFsaProjectRepository(dir);
    const doc = await repo.create("消す");
    await repo.remove(doc.project.meta.id);
    expect(dir.paths()).toEqual([]);
  });
});

describe("ブラウザ API の入口", () => {
  it("OPFS が無い環境では openOpfsProjectRepository は reject する", async () => {
    await expect(openOpfsProjectRepository()).rejects.toThrow(/OPFS/);
  });

  it("File System Access API が無い環境では pickFsaProjectRepository は reject する", async () => {
    await expect(pickFsaProjectRepository()).rejects.toThrow(/File System Access/);
  });

  it("showDirectoryPicker があれば、選ばれたフォルダを保存先にする", async () => {
    const dir = createFakeDirectory();
    const g = globalThis as { showDirectoryPicker?: unknown };
    g.showDirectoryPicker = () => Promise.resolve(dir);
    try {
      const repo = await pickFsaProjectRepository();
      const doc = await repo.create("選んだフォルダ");
      expect(dir.paths().some((p) => p.startsWith(`${doc.project.meta.id}/`))).toBe(true);
    } finally {
      delete g.showDirectoryPicker;
    }
  });

  it("navigator.storage.getDirectory があれば、その下の rpg-projects を使う", async () => {
    const root = createFakeDirectory();
    const g = globalThis as { navigator?: unknown };
    const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { value: { storage: { getDirectory: () => Promise.resolve(root) } }, configurable: true });
    try {
      const repo = await openOpfsProjectRepository();
      const doc = await repo.create("OPFS");
      expect(root.paths().every((p) => p.startsWith("rpg-projects/"))).toBe(true);
      expect(root.paths().some((p) => p.includes(doc.project.meta.id))).toBe(true);
    } finally {
      if (original) Object.defineProperty(globalThis, "navigator", original);
      else delete g.navigator;
    }
  });
});
