import { parseMapData, parseProject } from "@rpg/schema";
import type { MapData, MapId, Project } from "@rpg/schema";
import type { ProjectSource } from "@rpg/runtime";

export interface HttpProjectSourceOptions {
  /** 既定は `globalThis.fetch`。 */
  fetch?: typeof fetch;
}

const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * フォルダ形式の配布物（`project/project.json` と `project/maps/<MapId>.json`）を HTTP で読む `ProjectSource`。
 * `project.json` は一度だけ取得して検証し、`projectHash` はそのバイト列の sha256（hex 全体）。
 * マップはプロジェクトに登録された ID だけを取得し、取得済みのものは覚えておく。
 */
export function createHttpProjectSource(projectUrl: string, options: HttpProjectSourceOptions = {}): ProjectSource {
  const fetchFn = options.fetch ?? fetch;

  const get = async (url: string): Promise<ArrayBuffer> => {
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`${url} を取得できない（HTTP ${res.status}）`);
    return res.arrayBuffer();
  };

  let loaded: Promise<{ project: Project; hash: string }> | undefined;
  const load = (): Promise<{ project: Project; hash: string }> =>
    (loaded ??= (async () => {
      const bytes = await get(projectUrl);
      const parsed = parseProject(JSON.parse(new TextDecoder().decode(bytes)));
      if (!parsed.ok) throw new Error(`project.json が不正: ${JSON.stringify(parsed.error)}`);
      return { project: parsed.value, hash: hex(await crypto.subtle.digest("SHA-256", bytes)) };
    })());

  const maps = new Map<string, Promise<MapData>>();
  const loadMap = async (id: MapId): Promise<MapData> => {
    const { project } = await load();
    if (!Object.hasOwn(project.maps, id)) throw new Error(`マップ ${id} はプロジェクトに無い`);
    const bytes = await get(new URL(`maps/${id}.json`, projectUrl).href);
    const parsed = parseMapData(JSON.parse(new TextDecoder().decode(bytes)), project.formatVersion);
    if (!parsed.ok) throw new Error(`maps/${id}.json が不正: ${JSON.stringify(parsed.error)}`);
    return parsed.value;
  };

  return {
    project: async () => (await load()).project,
    projectHash: async () => (await load()).hash,
    /** 取得したマップは覚えておく（同じマップを読み直さない）。失敗は覚えず、次回やり直せる。 */
    mapData(id: MapId): Promise<MapData> {
      let p = maps.get(id);
      if (p === undefined) {
        p = loadMap(id);
        maps.set(id, p);
        p.catch(() => maps.delete(id));
      }
      return p;
    },
  };
}
