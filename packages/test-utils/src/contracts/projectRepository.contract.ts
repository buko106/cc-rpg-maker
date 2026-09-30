import { readZip, writeZip } from "@rpg/project-store";
import { describe, expect, it } from "vitest";
import type { MapData, MapId } from "@rpg/schema";
import type { ProjectDocument, ProjectRepository } from "@rpg/project-store";
import type { ContractFactory } from "./contract.js";

/** 内容が一意で、PNG のヘッダを持つ最小のバイト列（幅 3・高さ 2 の PNG 風）。 */
const pngBytes = (): ArrayBuffer => {
  const b = new Uint8Array(32);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(b.buffer).setUint32(16, 3);
  new DataView(b.buffer).setUint32(20, 2);
  return b.buffer;
};

const withMap = (doc: ProjectDocument, id: string, tile: number): ProjectDocument => {
  const mapId = id as MapId;
  const base = Object.values(doc.maps)[0]!;
  const map: MapData = { ...base, id: mapId, layers: base.layers.map((l, i) => ({ ...l, tiles: i === 0 ? l.tiles.map(() => tile) : l.tiles })) };
  return {
    ...doc,
    project: { ...doc.project, maps: { ...doc.project.maps, [mapId]: { id: mapId, name: id, order: 9 } } },
    maps: { ...doc.maps, [mapId]: map },
  };
};

/**
 * ProjectRepository の契約スイート。すべての ProjectRepository アダプタが通さなければならない（docs/10-project-store.md の不変条件）。
 */
export function projectRepositoryContract(name: string, make: ContractFactory<ProjectRepository>): void {
  describe(`ProjectRepository contract: ${name}`, () => {
    it("create は一覧に載り、load で同じ文書（deep-equal）が読める", async () => {
      const repo = await make();
      const doc = await repo.create("はじめてのゲーム");
      expect(doc.revision).toBe(1);
      expect(doc.project.meta.title).toBe("はじめてのゲーム");
      const list = await repo.list();
      expect(list.map((m) => m.id)).toEqual([doc.project.meta.id]);
      expect(list[0]?.title).toBe("はじめてのゲーム");
      const loaded = await repo.load(doc.project.meta.id);
      expect(loaded.ok && loaded.value).toEqual(doc);
    });

    it("[inv-1] save → load でラウンドトリップする", async () => {
      const repo = await make();
      const doc = await repo.create("a");
      const edited = withMap({ ...doc, project: { ...doc.project, meta: { ...doc.project.meta, title: "改題" } } }, "map_002", 3);
      const saved = await repo.save(edited);
      expect(saved).toEqual({ ok: true, value: { revision: 2 } });
      const loaded = await repo.load(doc.project.meta.id);
      expect(loaded.ok && loaded.value).toEqual({ ...edited, revision: 2 });
      expect((await repo.list())[0]?.title).toBe("改題");
    });

    it("[inv-2] expectedRevision が違えば conflict を返し、何も書かない", async () => {
      const repo = await make();
      const doc = await repo.create("a");
      const stale = withMap(doc, "map_002", 3);
      const r = await repo.save(stale, { expectedRevision: 7 });
      expect(r).toEqual({ ok: false, error: { kind: "conflict", currentRevision: 1 } });
      const loaded = await repo.load(doc.project.meta.id);
      expect(loaded.ok && loaded.value).toEqual(doc);
    });

    it("expectedRevision が現在値なら保存でき、revision が 1 進む", async () => {
      const repo = await make();
      const doc = await repo.create("a");
      const first = await repo.save(doc, { expectedRevision: 1 });
      expect(first.ok && first.value.revision).toBe(2);
      const second = await repo.save(doc, { expectedRevision: 2 });
      expect(second.ok && second.value.revision).toBe(3);
    });

    it("changedMaps を指定すると、そのマップだけが書き換わる", async () => {
      const repo = await make();
      const doc = await repo.create("a");
      const first = withMap(withMap(doc, "map_002", 2), "map_003", 2);
      await repo.save(first);
      // 2 つとも書き換えたが、map_002 だけを changedMaps に挙げる
      const edited = withMap(withMap({ ...first, revision: 2 }, "map_002", 4), "map_003", 4);
      await repo.save(edited, { changedMaps: ["map_002" as MapId] });
      const loaded = await repo.load(doc.project.meta.id);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(loaded.value.maps["map_002" as MapId]?.layers[0]?.tiles[0]).toBe(4);
      expect(loaded.value.maps["map_003" as MapId]?.layers[0]?.tiles[0]).toBe(2);
    });

    it("削除したマップは保存で消え、追加したマップは changedMaps に無くても保存される", async () => {
      const repo = await make();
      const doc = await repo.create("a");
      const added = withMap(doc, "map_002", 2);
      await repo.save(added, { changedMaps: [] });
      const afterAdd = await repo.load(doc.project.meta.id);
      expect(afterAdd.ok && Object.keys(afterAdd.value.maps).sort()).toEqual(["map_001", "map_002"]);

      const { ["map_002" as MapId]: _removed, ...rest } = added.maps;
      const { ["map_002" as MapId]: _meta, ...restMeta } = added.project.maps;
      const removed = { ...added, project: { ...added.project, maps: restMeta }, maps: rest };
      await repo.save(removed, { changedMaps: [] });
      const afterRemove = await repo.load(doc.project.meta.id);
      expect(afterRemove.ok && Object.keys(afterRemove.value.maps)).toEqual(["map_001"]);
    });

    it("不正な文書は schema エラーで、何も書かない", async () => {
      const repo = await make();
      const doc = await repo.create("a");
      const broken = { ...doc, project: { ...doc.project, system: { ...doc.project.system, tileSize: 7 as never } } };
      const r = await repo.save(broken);
      expect(!r.ok && r.error.kind).toBe("schema");
      const loaded = await repo.load(doc.project.meta.id);
      expect(loaded.ok && loaded.value).toEqual(doc);
    });

    it("project.maps と maps のマップが食い違う文書は schema エラー", async () => {
      const repo = await make();
      const doc = await repo.create("a");
      const r = await repo.save({ ...doc, maps: {} });
      expect(!r.ok && r.error.kind).toBe("schema");
    });

    it("[inv-4] remove 後の load は notFound、一覧からも消える。存在しない ID の remove は何もしない", async () => {
      const repo = await make();
      const a = await repo.create("a");
      const b = await repo.create("b");
      await repo.remove(a.project.meta.id);
      expect(await repo.load(a.project.meta.id)).toEqual({ ok: false, error: { kind: "notFound" } });
      expect((await repo.list()).map((m) => m.id)).toEqual([b.project.meta.id]);
      await repo.remove("nothing");
      expect((await repo.load(b.project.meta.id)).ok).toBe(true);
    });

    it("存在しないプロジェクトの load / save は notFound", async () => {
      const repo = await make();
      expect(await repo.load("nothing")).toEqual({ ok: false, error: { kind: "notFound" } });
      const doc = await repo.create("a");
      await repo.remove(doc.project.meta.id);
      expect(await repo.save(doc)).toEqual({ ok: false, error: { kind: "notFound" } });
    });

    it("create するたびに別の ID になり、互いに干渉しない", async () => {
      const repo = await make();
      const a = await repo.create("a");
      const b = await repo.create("b");
      expect(a.project.meta.id).not.toBe(b.project.meta.id);
      await repo.save(withMap(a, "map_002", 2));
      const loadedB = await repo.load(b.project.meta.id);
      expect(loadedB.ok && Object.keys(loadedB.value.maps)).toEqual(["map_001"]);
    });

    it("テンプレートのアセットが取り出せる（タイルセットの画像）", async () => {
      const repo = await make();
      const doc = await repo.create("a");
      const id = doc.project.tilesets["ts_default" as never]?.image?.asset;
      expect(id).toBeDefined();
      const bytes = await repo.assets(doc.project.meta.id).get(id!);
      expect(bytes?.byteLength).toBe(doc.project.assets.entries[id!]?.size);
    });

    it("アセット：put の ID は内容ハッシュで、get / has / remove できる。プロジェクトごとに分かれる", async () => {
      const repo = await make();
      const a = await repo.create("a");
      const b = await repo.create("b");
      const store = repo.assets(a.project.meta.id);
      const put = await store.put(pngBytes(), "hero.png", "image");
      expect(put.id).toMatch(/^[0-9a-f]{16}$/);
      expect(put.entry).toEqual({ name: "hero.png", kind: "image", mime: "image/png", size: 32, width: 3, height: 2 });
      expect((await store.put(pngBytes(), "hero2.png", "image")).id).toBe(put.id);

      expect(new Uint8Array((await store.get(put.id))!)).toEqual(new Uint8Array(pngBytes()));
      const source = store.bytesSource();
      expect(await source.has(put.id)).toBe(true);
      expect(new Uint8Array((await source.getBytes(put.id))!)).toEqual(new Uint8Array(pngBytes()));
      expect(await repo.assets(b.project.meta.id).get(put.id)).toBeUndefined();

      await store.remove(put.id);
      expect(await store.get(put.id)).toBeUndefined();
      expect(await source.has(put.id)).toBe(false);
    });

    it("list は更新の新しい順", async () => {
      const repo = await make();
      const a = await repo.create("a");
      await new Promise((r) => setTimeout(r, 5));
      const b = await repo.create("b");
      await new Promise((r) => setTimeout(r, 5));
      await repo.save(a);
      expect((await repo.list()).map((m) => m.id)).toEqual([a.project.meta.id, b.project.meta.id]);
    });

    describe("ZIP の書き出しと読み込み", () => {
      /** ZIP の中身を `名前 → バイト列` で取り出す。 */
      const entries = async (zip: Uint8Array): Promise<Map<string, Uint8Array>> => readZip(zip);
      const prepared = async (repo: ProjectRepository): Promise<{ doc: ProjectDocument; assetId: string }> => {
        const doc = await repo.create("ZIP のゲーム");
        const put = await repo.assets(doc.project.meta.id).put(pngBytes(), "hero.png", "image");
        const edited = withMap({ ...doc, project: { ...doc.project, assets: { entries: { ...doc.project.assets.entries, [put.id]: put.entry } } } }, "map_002", 5);
        await repo.save(edited);
        return { doc: { ...edited, revision: 2 }, assetId: put.id };
      };

      it("exportZip は project.json・maps/・assets/・meta.json のレイアウトで書き出す", async () => {
        const repo = await make();
        const { doc, assetId } = await prepared(repo);
        const r = await repo.exportZip(doc.project.meta.id);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const files = await entries(r.value);
        expect([...files.keys()].sort()).toEqual(
          ["assets/" + assetId + ".png", ...Object.keys(doc.project.assets.entries).filter((id) => id !== assetId).map((id) => `assets/${id}.png`), "maps/map_001.json", "maps/map_002.json", "meta.json", "project.json"].sort(),
        );
        const project = JSON.parse(new TextDecoder().decode(files.get("project.json")!)) as { meta: { id: string; title: string } };
        expect(project.meta).toMatchObject({ id: doc.project.meta.id, title: "ZIP のゲーム" });
        const meta = JSON.parse(new TextDecoder().decode(files.get("meta.json")!)) as { revision: number; formatVersion: number };
        expect(meta).toMatchObject({ revision: 2, formatVersion: doc.project.formatVersion });
        expect(new Uint8Array(files.get(`assets/${assetId}.png`)!)).toEqual(new Uint8Array(pngBytes()));
      });

      it("[inv-3] importZip(exportZip(id)) は、ID だけが新しい等価なプロジェクトを作る（アセットも）", async () => {
        const repo = await make();
        const { doc, assetId } = await prepared(repo);
        const zip = await repo.exportZip(doc.project.meta.id);
        expect(zip.ok).toBe(true);
        if (!zip.ok) return;
        const imported = await repo.importZip(zip.value);
        expect(imported.ok).toBe(true);
        if (!imported.ok) return;
        expect(imported.value.id).not.toBe(doc.project.meta.id);
        expect(imported.value.title).toBe("ZIP のゲーム");

        const loaded = await repo.load(imported.value.id);
        expect(loaded.ok).toBe(true);
        if (!loaded.ok) return;
        expect(loaded.value.revision).toBe(1);
        expect(loaded.value.maps).toEqual(doc.maps);
        expect({ ...loaded.value.project, meta: { ...loaded.value.project.meta, id: "", updatedAt: "" } }).toEqual({ ...doc.project, meta: { ...doc.project.meta, id: "", updatedAt: "" } });
        expect(new Uint8Array((await repo.assets(imported.value.id).get(assetId as never))!)).toEqual(new Uint8Array(pngBytes()));
        // 元のプロジェクトはそのまま
        expect((await repo.list()).map((m) => m.id).sort()).toEqual([doc.project.meta.id, imported.value.id].sort());
        const original = await repo.load(doc.project.meta.id);
        expect(original.ok && original.value).toEqual(doc);
      });

      it("exportZip は存在しないプロジェクトで notFound", async () => {
        const repo = await make();
        expect(await repo.exportZip("nothing")).toEqual({ ok: false, error: { kind: "notFound" } });
      });

      it("importZip は 1 段のフォルダの下にあるレイアウトも読める。ArrayBuffer でもよい", async () => {
        const repo = await make();
        const { doc } = await prepared(repo);
        const zip = await repo.exportZip(doc.project.meta.id);
        if (!zip.ok) throw new Error("export に失敗");
        const files = [...(await entries(zip.value))].map(([name, bytes]) => ({ name: `my-game/${name}`, bytes }));
        const nested = writeZip(files);
        const imported = await repo.importZip(nested.buffer);
        expect(imported.ok).toBe(true);
      });

      it("importZip は ZIP でないもの・project.json が無いもの・JSON が壊れたもの・マップが欠けたものを schema エラーにする", async () => {
        const repo = await make();
        const { doc } = await prepared(repo);
        const zip = await repo.exportZip(doc.project.meta.id);
        if (!zip.ok) throw new Error("export に失敗");
        const files = [...(await entries(zip.value))].map(([name, bytes]) => ({ name, bytes }));
        const enc = (s: string) => new TextEncoder().encode(s);
        const without = (name: string) => files.filter((f) => f.name !== name);
        const replaced = (name: string, text: string) => files.map((f) => (f.name === name ? { name, bytes: enc(text) } : f));

        const cases: [string, Uint8Array | ArrayBuffer, string][] = [
          ["ZIP ではない", enc("not a zip at all"), "zip"],
          ["project.json が無い", writeZip(without("project.json")), "project.json"],
          ["project.json が壊れている", writeZip(replaced("project.json", "{oops")), "project.json"],
          ["マップが欠けている", writeZip(without("maps/map_002.json")), "maps/map_002.json"],
          ["マップが壊れている", writeZip(replaced("maps/map_001.json", "nope")), "maps/map_001.json"],
        ];
        for (const [label, bytes, path] of cases) {
          const r = await repo.importZip(bytes);
          expect(r.ok, label).toBe(false);
          if (r.ok) continue;
          expect(r.error.kind, label).toBe("schema");
          if (r.error.kind === "schema" && r.error.error.kind === "invalid") expect(r.error.error.issues[0]?.path, label).toBe(path);
        }
        // 新しいプロジェクトは何も作られていない
        expect((await repo.list()).map((m) => m.id)).toEqual([doc.project.meta.id]);
      });

      it("importZip は project.json の内容が不正なら schema エラーにし、未来の formatVersion は newer-format", async () => {
        const repo = await make();
        const { doc } = await prepared(repo);
        const zip = await repo.exportZip(doc.project.meta.id);
        if (!zip.ok) throw new Error("export に失敗");
        const files = [...(await entries(zip.value))].map(([name, bytes]) => ({ name, bytes }));
        const project = JSON.parse(new TextDecoder().decode(files.find((f) => f.name === "project.json")!.bytes)) as Record<string, unknown>;
        const withProject = (p: unknown) => writeZip(files.map((f) => (f.name === "project.json" ? { name: f.name, bytes: new TextEncoder().encode(JSON.stringify(p)) } : f)));

        const invalid = await repo.importZip(withProject({ ...project, system: "broken" }));
        expect(!invalid.ok && invalid.error.kind).toBe("schema");
        const newer = await repo.importZip(withProject({ ...project, formatVersion: 9999 }));
        expect(!newer.ok && newer.error.kind === "schema" && newer.error.error.kind).toBe("newer-format");
      });

      it("importZip はアセットの内容が ID（内容ハッシュ）と一致しないと schema エラー。マニフェストに無いファイルは取り込まない", async () => {
        const repo = await make();
        const { doc, assetId } = await prepared(repo);
        const zip = await repo.exportZip(doc.project.meta.id);
        if (!zip.ok) throw new Error("export に失敗");
        const files = [...(await entries(zip.value))].map(([name, bytes]) => ({ name, bytes }));

        const tampered = writeZip(files.map((f) => (f.name === `assets/${assetId}.png` ? { name: f.name, bytes: new Uint8Array([1, 2, 3]) } : f)));
        const bad = await repo.importZip(tampered);
        expect(!bad.ok && bad.error.kind).toBe("schema");
        if (!bad.ok && bad.error.kind === "schema" && bad.error.error.kind === "invalid") expect(bad.error.error.issues[0]?.path).toBe(`assets/${assetId}`);
        expect((await repo.list()).map((m) => m.id)).toEqual([doc.project.meta.id]);

        const stray = writeZip([...files, { name: "assets/0000000000000000.png", bytes: new Uint8Array([9, 9]) }, { name: "readme.txt", bytes: new Uint8Array([1]) }]);
        const ok = await repo.importZip(stray);
        expect(ok.ok).toBe(true);
        if (!ok.ok) return;
        expect(await repo.assets(ok.value.id).get("0000000000000000" as never)).toBeUndefined();
      });

      it("マニフェストにあるがバイト列が無いアセットは、そのまま（バイト列なしで）取り込む", async () => {
        const repo = await make();
        const { doc, assetId } = await prepared(repo);
        const zip = await repo.exportZip(doc.project.meta.id);
        if (!zip.ok) throw new Error("export に失敗");
        const files = [...(await entries(zip.value))].filter(([name]) => name !== `assets/${assetId}.png`).map(([name, bytes]) => ({ name, bytes }));
        const r = await repo.importZip(writeZip(files));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(await repo.assets(r.value.id).get(assetId as never)).toBeUndefined();
        const loaded = await repo.load(r.value.id);
        expect(loaded.ok && loaded.value.project.assets.entries[assetId as never]).toBeDefined();
      });
    });
  });
}
