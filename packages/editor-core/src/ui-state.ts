import type { EventId, MapId } from "@rpg/schema";
import type { ProjectDocument } from "@rpg/project-store";

export type Tool = "pencil" | "eraser" | "fill" | "event" | "select";

export type Selection = { kind: "none" } | { kind: "event"; eventId: EventId };

/** エディタセッションの表示状態（文書には保存されない）。 */
export interface EditorUiState {
  currentMap: MapId | undefined;
  currentLayer: number;
  tool: Tool;
  /** タイルパレットで選んでいるタイル */
  tile: number;
  selection: Selection;
  zoom: number;
}

/** 文書を開いたときの表示状態：開始マップ、下層、鉛筆。 */
export function initialUiState(doc: ProjectDocument): EditorUiState {
  const first = Object.keys(doc.project.maps)[0] as MapId | undefined;
  const start = Object.hasOwn(doc.project.maps, doc.project.system.startMap) ? doc.project.system.startMap : first;
  return { currentMap: start, currentLayer: 0, tool: "pencil", tile: 1, selection: { kind: "none" }, zoom: 1 };
}
