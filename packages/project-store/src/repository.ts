import { CURRENT_FORMAT_VERSION, err, newId, ok, parseMapData, parseProject, serializeMapData, serializeProject } from "@rpg/schema";
import type { AssetId, IdSource, MapData, MapId, Result } from "@rpg/schema";
import type { CommitBatch, StoreBackend, StoredMeta } from "./backend.js";
import type { ProjectAssetStore, ProjectDocument, ProjectMeta, ProjectRepository, ProjectStoreError, SaveOptions } from "./ports/projectRepository.js";
import { createTemplate } from "./template.js";
import { assetEntryOf, hashBytes } from "./util.js";

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
  };
}
