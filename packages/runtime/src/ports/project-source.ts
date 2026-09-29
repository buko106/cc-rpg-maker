import type { MapData, MapId, Project } from "@rpg/schema";

/** ランタイムがゲーム定義を得る口。マップ本体は遅延ロードされる（`requestMapData`）。 */
export interface ProjectSource {
  project(): Promise<Project>;
  mapData(id: MapId): Promise<MapData>;
  projectHash(): Promise<string>;
}
