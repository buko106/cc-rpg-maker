import type { EventId, MapEvent, MapId } from "@rpg/schema";
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
  /** コピー／切り取りしたイベント（スナップショット。文書には保存されず、マップをまたいで貼れる） */
  clipboard: MapEvent | undefined;
  /** 最近追加したイベントコマンドの code（新しい順、重複なし。コマンドの追加画面の「最近使ったもの」） */
  recentCommands: readonly string[];
}

/** `recentCommands` に残す数。 */
export const RECENT_COMMANDS_LIMIT = 6;

/** `code` を先頭にした最近使ったコマンドの一覧。 */
export const withRecentCommand = (recent: readonly string[], code: string): string[] => [code, ...recent.filter((c) => c !== code)].slice(0, RECENT_COMMANDS_LIMIT);

/** 文書を開いたときの表示状態：開始マップ、下層、鉛筆。 */
export function initialUiState(doc: ProjectDocument): EditorUiState {
  const first = Object.keys(doc.project.maps)[0] as MapId | undefined;
  const start = Object.hasOwn(doc.project.maps, doc.project.system.startMap) ? doc.project.system.startMap : first;
  return { currentMap: start, currentLayer: 0, tool: "pencil", tile: 1, selection: { kind: "none" }, zoom: 1, clipboard: undefined, recentCommands: [] };
}
