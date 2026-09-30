import type { AssetId } from "@rpg/schema";
import type { CommitBatch, StoreBackend, StoredMeta } from "./backend.js";
import type { ProjectRepository } from "./ports/projectRepository.js";
import { createRepository } from "./repository.js";
import type { RepositoryOptions } from "./repository.js";

interface Entry {
  meta: StoredMeta;
  project: string;
  maps: Map<string, string>;
}

/** メモリ上の StoreBackend。値は JSON 文字列で持ち、呼び出し側のオブジェクトとは共有しない。 */
export function createMemoryBackend(): StoreBackend {
  const projects = new Map<string, Entry>();
  // アセットは新規作成時にプロジェクトの commit より先に置かれるので、別に持つ
  const assets = new Map<string, Map<AssetId, ArrayBuffer>>();
  const parse = (s: string | undefined): unknown => (s === undefined ? undefined : JSON.parse(s));
  return {
    listMeta: () => Promise.resolve([...projects].map(([id, e]) => ({ id, meta: structuredClone(e.meta) }))),
    getMeta: (id) => Promise.resolve(structuredClone(projects.get(id)?.meta)),
    getProject: (id) => Promise.resolve(parse(projects.get(id)?.project)),
    getMap: (id, mapId) => Promise.resolve(parse(projects.get(id)?.maps.get(mapId))),
    commit(id, batch: CommitBatch) {
      // 先にすべてを文字列にしてから反映する（途中で失敗しても半端に書かない）
      const project = JSON.stringify(batch.project);
      const writes = Object.entries(batch.maps).map(([mapId, value]) => [mapId, value === null ? null : JSON.stringify(value)] as const);
      const entry = projects.get(id) ?? { meta: batch.meta, project, maps: new Map<string, string>() };
      entry.project = project;
      entry.meta = structuredClone(batch.meta);
      for (const [mapId, json] of writes) {
        if (json === null) entry.maps.delete(mapId);
        else entry.maps.set(mapId, json);
      }
      projects.set(id, entry);
      return Promise.resolve();
    },
    removeProject(id) {
      projects.delete(id);
      assets.delete(id);
      return Promise.resolve();
    },
    putAsset(id, assetId, bytes) {
      const held = assets.get(id) ?? new Map<AssetId, ArrayBuffer>();
      held.set(assetId, bytes.slice(0));
      assets.set(id, held);
      return Promise.resolve();
    },
    getAsset: (id, assetId) => Promise.resolve(assets.get(id)?.get(assetId)?.slice(0)),
    deleteAsset(id, assetId) {
      assets.get(id)?.delete(assetId);
      return Promise.resolve();
    },
  };
}

/** テスト・テストプレイ用のメモリ上の ProjectRepository。 */
export function createMemoryProjectRepository(opts: RepositoryOptions = {}): ProjectRepository {
  return createRepository(createMemoryBackend(), opts);
}
