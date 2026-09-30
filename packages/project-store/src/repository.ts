import { CURRENT_FORMAT_VERSION, err, newId, ok, parseMapData, parseProject, serializeMapData, serializeProject } from "@rpg/schema";
import type { AssetId, IdSource, MapData, MapId, Result } from "@rpg/schema";
import type { CommitBatch, StoreBackend, StoredMeta } from "./backend.js";
import type { ProjectAssetStore, ProjectDocument, ProjectMeta, ProjectRepository, ProjectStoreError, SaveOptions } from "./ports/projectRepository.js";
import { createTemplate } from "./template.js";
import { assetEntryOf, extensionOf, hashBytes } from "./util.js";
import { readZip, writeZip } from "./zip.js";
import type { ZipFile } from "./zip.js";

export interface RepositoryOptions {
  /** 現在時刻（Unix ms）。既定は `Date.now`。テストで固定する。 */
  now?: () => number;
  /** 新しいプロジェクト ID の乱数・時刻の供給源。 */
  idSource?: IdSource;
}

/** 例外を `ProjectStoreError` に直す。容量超過（`QuotaExceededError`）だけ `quota`、他は `io`。 */
export function toStoreError(e: unknown): ProjectStoreError {
  const name = typeof e === "object" && e !== null ? (e as { name?: unknown }).name : undefined;
  const message = e instanceof Error ? e.message : String(e);
  if (name === "QuotaExceededError" || /quota/i.test(message)) return { kind: "quota" };
  return { kind: "io", message };
}

const isoOf = (ms: number): string => new Date(ms).toISOString();

function metaOf(stored: StoredMeta, id: string): ProjectMeta {
  return { id, title: stored.title, updatedAt: stored.updatedAt, formatVersion: stored.formatVersion, sizeBytes: stored.sizeBytes };
}

/** ProjectRepository の共通実装。永続化だけを `StoreBackend` に任せる。 */
export function createRepository(backend: StoreBackend, opts: RepositoryOptions = {}): ProjectRepository {
  const now = opts.now ?? Date.now;

  /** 文書を検証し、書き込みバッチを組んで commit する。 */
  async function commitDoc(id: string, doc: ProjectDocument, previous: StoredMeta | undefined, mapsToWrite: readonly MapId[] | undefined, revision: number): Promise<Result<StoredMeta, ProjectStoreError>> {
    const serializedProject = serializeProject(doc.project);
    const checked = parseProject(serializedProject);
    if (!checked.ok) return err({ kind: "schema", error: checked.error });

    const known = Object.keys(doc.project.maps).sort();
    const held = Object.keys(doc.maps).sort();
    if (known.join("\n") !== held.join("\n")) {
      return err({ kind: "schema", error: { kind: "invalid", issues: [{ path: "maps", message: `project.maps (${known.join(",")}) と maps (${held.join(",")}) のマップが一致しない` }] } });
    }

    const stored = previous?.mapSizes ?? {};
    const write = new Set<string>(mapsToWrite ?? known);
    for (const mapId of known) if (!Object.hasOwn(stored, mapId)) write.add(mapId);
    const batchMaps: Record<string, unknown | null> = {};
    const mapSizes: Record<string, number> = {};
    for (const mapId of known) {
      if (!write.has(mapId)) {
        mapSizes[mapId] = stored[mapId] ?? 0;
        continue;
      }
      const map = doc.maps[mapId as MapId];
      if (map === undefined) continue; // 上の照合で保証済み
      const json = serializeMapData(map);
      const parsed = parseMapData(json, CURRENT_FORMAT_VERSION);
      if (!parsed.ok || map.id !== mapId) {
        return err({ kind: "schema", error: parsed.ok ? { kind: "invalid", issues: [{ path: `maps.${mapId}.id`, message: `キー ${mapId} と id ${map.id} が一致しない` }] } : parsed.error });
      }
      batchMaps[mapId] = json;
      mapSizes[mapId] = JSON.stringify(json).length;
    }
    for (const mapId of Object.keys(stored)) if (!Object.hasOwn(mapSizes, mapId)) batchMaps[mapId] = null;

    const assetBytes = Object.values(doc.project.assets.entries).reduce((sum, e) => sum + e.size, 0);
    const meta: StoredMeta = {
      title: doc.project.meta.title,
      updatedAt: isoOf(now()),
      formatVersion: doc.project.formatVersion,
      revision,
      sizeBytes: JSON.stringify(serializedProject).length + Object.values(mapSizes).reduce((a, b) => a + b, 0) + assetBytes,
      mapSizes,
    };
    const batch: CommitBatch = { project: serializedProject, maps: batchMaps, meta };
    try {
      await backend.commit(id, batch);
    } catch (e) {
      return err(toStoreError(e));
    }
    return ok(meta);
  }

  async function load(id: string): Promise<Result<ProjectDocument, ProjectStoreError>> {
    try {
      const meta = await backend.getMeta(id);
      if (meta === undefined) return err({ kind: "notFound" });
      const rawProject = await backend.getProject(id);
      const project = parseProject(rawProject);
      if (!project.ok) return err({ kind: "schema", error: project.error });
      const formatVersion = (rawProject as { formatVersion: number }).formatVersion;
      const maps: Record<string, MapData> = {};
      for (const mapId of Object.keys(project.value.maps)) {
        const rawMap = await backend.getMap(id, mapId);
        if (rawMap === undefined) return err({ kind: "schema", error: { kind: "invalid", issues: [{ path: `maps.${mapId}`, message: "マップのデータが無い" }] } });
        const map = parseMapData(rawMap, formatVersion);
        if (!map.ok) return err({ kind: "schema", error: map.error });
        maps[mapId] = map.value;
      }
      const doc: ProjectDocument = { project: project.value, maps: maps as Record<MapId, MapData>, revision: meta.revision };
      if (formatVersion === CURRENT_FORMAT_VERSION) return ok(doc);
      // マイグレーションした文書は、次回以降のコストを避けるため直ちに保存し直す。
      const saved = await commitDoc(id, doc, meta, undefined, meta.revision + 1);
      return saved.ok ? ok({ ...doc, revision: saved.value.revision }) : saved;
    } catch (e) {
      return err(toStoreError(e));
    }
  }

  async function save(doc: ProjectDocument, saveOpts: SaveOptions = {}): Promise<Result<{ revision: number }, ProjectStoreError>> {
    const id = doc.project.meta.id;
    try {
      const meta = await backend.getMeta(id);
      if (meta === undefined) return err({ kind: "notFound" });
      if (saveOpts.expectedRevision !== undefined && saveOpts.expectedRevision !== meta.revision) {
        return err({ kind: "conflict", currentRevision: meta.revision });
      }
      const saved = await commitDoc(id, doc, meta, saveOpts.changedMaps, meta.revision + 1);
      return saved.ok ? ok({ revision: saved.value.revision }) : saved;
    } catch (e) {
      return err(toStoreError(e));
    }
  }

  function assets(id: string): ProjectAssetStore {
    return {
      async put(bytes, name, kind) {
        const assetId = await hashBytes(bytes);
        await backend.putAsset(id, assetId, bytes);
        return { id: assetId, entry: assetEntryOf(bytes, name, kind) };
      },
      get: (assetId) => backend.getAsset(id, assetId),
      remove: (assetId) => backend.deleteAsset(id, assetId),
      bytesSource: () => ({
        getBytes: (assetId: AssetId) => backend.getAsset(id, assetId),
        has: async (assetId: AssetId) => (await backend.getAsset(id, assetId)) !== undefined,
      }),
    };
  }

  /** 検証に失敗した ZIP のエラー。 */
  const badZip = (path: string, message: string): Result<never, ProjectStoreError> => err({ kind: "schema", error: { kind: "invalid", issues: [{ path, message }] } });

  async function exportZip(id: string): Promise<Result<Uint8Array<ArrayBuffer>, ProjectStoreError>> {
    try {
      const meta = await backend.getMeta(id);
      if (meta === undefined) return err({ kind: "notFound" });
      const rawProject = await backend.getProject(id);
      const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value, null, 2));
      const files: ZipFile[] = [{ name: "project.json", bytes: json(rawProject) }];
      const project = rawProject as { maps?: Record<string, unknown>; assets?: { entries?: Record<string, { name?: string; mime?: string }> } };
      for (const mapId of Object.keys(project.maps ?? {}).sort()) {
        const rawMap = await backend.getMap(id, mapId);
        if (rawMap === undefined) return badZip(`maps.${mapId}`, "マップのデータが無い");
        files.push({ name: `maps/${mapId}.json`, bytes: json(rawMap) });
      }
      for (const [assetId, entry] of Object.entries(project.assets?.entries ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
        const bytes = await backend.getAsset(id, assetId as AssetId);
        if (bytes !== undefined) files.push({ name: `assets/${assetId}${extensionOf(entry)}`, bytes: new Uint8Array(bytes) });
      }
      files.push({ name: "meta.json", bytes: json({ revision: meta.revision, updatedAt: meta.updatedAt, formatVersion: meta.formatVersion }) });
      return ok(writeZip(files));
    } catch (e) {
      return err(toStoreError(e));
    }
  }

  async function importZip(zip: Uint8Array | ArrayBuffer): Promise<Result<ProjectMeta, ProjectStoreError>> {
    let files: Map<string, Uint8Array>;
    try {
      files = await readZip(zip);
    } catch (e) {
      return badZip("zip", e instanceof Error ? e.message : String(e));
    }
    // ルート直下でも、1 段のフォルダの下でもよい（一番浅い project.json を探す）
    const roots = [...files.keys()].filter((n) => n === "project.json" || n.endsWith("/project.json")).sort((a, b) => a.length - b.length);
    if (roots[0] === undefined) return badZip("project.json", "ZIP に project.json が無い");
    const prefix = roots[0].slice(0, -"project.json".length);
    const parseJson = (name: string): { ok: true; value: unknown } | { ok: false; message: string } => {
      const bytes = files.get(name);
      if (bytes === undefined) return { ok: false, message: "ファイルが無い" };
      try {
        return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
      } catch (e) {
        return { ok: false, message: `JSON として読めない: ${e instanceof Error ? e.message : String(e)}` };
      }
    };

    const rawProject = parseJson(`${prefix}project.json`);
    if (!rawProject.ok) return badZip("project.json", rawProject.message);
    const project = parseProject(rawProject.value);
    if (!project.ok) return err({ kind: "schema", error: project.error });
    const formatVersion = (rawProject.value as { formatVersion: number }).formatVersion;

    const maps: Record<string, MapData> = {};
    for (const mapId of Object.keys(project.value.maps)) {
      const raw = parseJson(`${prefix}maps/${mapId}.json`);
      if (!raw.ok) return badZip(`maps/${mapId}.json`, raw.message);
      const map = parseMapData(raw.value, formatVersion);
      if (!map.ok) return err({ kind: "schema", error: map.error });
      maps[mapId] = map.value;
    }

    // アセットは名前ではなく内容で検証する（ID = 内容ハッシュ）。マニフェストに載っていないファイルは取り込まない。
    const assetFiles = new Map<string, Uint8Array>();
    for (const [name, bytes] of files) {
      const m = name.startsWith(`${prefix}assets/`) ? /^([0-9a-f]{16})(?:\.[A-Za-z0-9]+)?$/.exec(name.slice(`${prefix}assets/`.length)) : null;
      if (m?.[1] !== undefined) assetFiles.set(m[1], bytes);
    }
    const imported: { id: AssetId; bytes: ArrayBuffer }[] = [];
    for (const assetId of Object.keys(project.value.assets.entries)) {
      const bytes = assetFiles.get(assetId);
      if (bytes === undefined) continue;
      const copy = bytes.slice().buffer as ArrayBuffer;
      const actual = await hashBytes(copy);
      if (actual !== assetId) return badZip(`assets/${assetId}`, `内容のハッシュ（${actual}）が ID と一致しない`);
      imported.push({ id: assetId as AssetId, bytes: copy });
    }

    const id = newId<"ProjectId">("prj", opts.idSource);
    const at = isoOf(now());
    const doc: ProjectDocument = {
      project: { ...project.value, meta: { ...project.value.meta, id, updatedAt: at } },
      maps: maps as Record<MapId, MapData>,
      revision: 1,
    };
    try {
      for (const a of imported) await backend.putAsset(id, a.id, a.bytes);
      const saved = await commitDoc(id, doc, undefined, undefined, 1);
      if (!saved.ok) {
        await backend.removeProject(id);
        return saved;
      }
      return ok(metaOf(saved.value, id));
    } catch (e) {
      await backend.removeProject(id).catch(() => undefined);
      return err(toStoreError(e));
    }
  }

  return {
    async list() {
      const all = await backend.listMeta();
      return all.map(({ id, meta }) => metaOf(meta, id)).sort((a, b) => (a.updatedAt === b.updatedAt ? a.id.localeCompare(b.id) : b.updatedAt.localeCompare(a.updatedAt)));
    },
    async create(title) {
      const id = newId<"ProjectId">("prj", opts.idSource);
      const template = createTemplate(id, title, isoOf(now()));
      for (const a of template.assets) await backend.putAsset(id, a.id, a.bytes);
      const saved = await commitDoc(id, template.doc, undefined, undefined, 1);
      if (!saved.ok) throw new Error(`プロジェクトを作れない: ${JSON.stringify(saved.error)}`);
      return { ...template.doc, revision: 1 };
    },
    load,
    save,
    async remove(id) {
      await backend.removeProject(id);
    },
    assets,
    exportZip,
    importZip,
  };
}
