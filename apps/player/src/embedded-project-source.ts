import { parseMapData, parseProject } from "@rpg/schema";
import type { MapData, MapId, Project } from "@rpg/schema";
import type { ProjectSource } from "@rpg/runtime";

/** 単一 HTML に埋め込まれたゲーム（エクスポータの `EmbeddedGame`）。 */
export interface EmbeddedData {
  project: unknown;
  maps: Record<string, unknown>;
  /** AssetId → base64 */
  assets: Record<string, string>;
  /** `project.json` のバイト列の sha256（hex）。省略時は `project` を JSON にした文字列から求める。 */
  projectHash?: string;
}

const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * 埋め込まれたゲームを読む `ProjectSource`（通信しない）。検証は HTTP 版と同じ（`parseProject` / `parseMapData`）。
 * 不正なデータや、プロジェクトに無いマップの要求は reject する。
 */
export function createEmbeddedProjectSource(data: EmbeddedData): ProjectSource {
  let loaded: Promise<{ project: Project; hash: string; formatVersion: number }> | undefined;
  const load = (): Promise<{ project: Project; hash: string; formatVersion: number }> =>
    (loaded ??= (async () => {
      const parsed = parseProject(data.project);
      if (!parsed.ok) throw new Error(`埋め込みのプロジェクトが不正: ${JSON.stringify(parsed.error)}`);
      const hash = data.projectHash ?? hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(data.project))));
      return { project: parsed.value, hash, formatVersion: (data.project as { formatVersion: number }).formatVersion };
    })());

  return {
    project: async () => (await load()).project,
    projectHash: async () => (await load()).hash,
    async mapData(id: MapId): Promise<MapData> {
      const { project, formatVersion } = await load();
      if (!Object.hasOwn(project.maps, id)) throw new Error(`マップ ${id} はプロジェクトに無い`);
      if (!Object.hasOwn(data.maps, id)) throw new Error(`マップ ${id} のデータが埋め込まれていない`);
      const parsed = parseMapData(data.maps[id], formatVersion);
      if (!parsed.ok) throw new Error(`マップ ${id} が不正: ${JSON.stringify(parsed.error)}`);
      return parsed.value;
    },
  };
}
