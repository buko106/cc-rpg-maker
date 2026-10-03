import type { EventCommand, EventId, MapEvent, MapId } from "@rpg/schema";
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
  /** コピー／切り取りしたイベントコマンド（ブロックを切らない行の並び。字下げは 0 始まり。文書には保存されず、イベントやページをまたいで貼れる） */
  commandClipboard: readonly EventCommand[] | undefined;
  /** イベントツールで空いたセルに置くもの：ひな形の ID（`undefined` は空のイベント） */
  eventTemplate: string | undefined;
  /** 最近追加したイベントコマンドの code（新しい順、重複なし。コマンドの追加画面の「最近使ったもの」） */
  recentCommands: readonly string[];
  /** 最近選んだタイルの番号（新しい順、重複なし。タイルパレットの「最近使ったもの」） */
  recentTiles: readonly number[];
}

/** `recentCommands` に残す数。 */
export const RECENT_COMMANDS_LIMIT = 6;

/** `code` を先頭にした最近使ったコマンドの一覧。 */
export const withRecentCommand = (recent: readonly string[], code: string): string[] => [code, ...recent.filter((c) => c !== code)].slice(0, RECENT_COMMANDS_LIMIT);

/** `recentTiles` に残す数。 */
export const RECENT_TILES_LIMIT = 8;

/** `tile` を先頭にした最近使ったタイルの一覧。 */
export const withRecentTile = (recent: readonly number[], tile: number): number[] => [tile, ...recent.filter((t) => t !== tile)].slice(0, RECENT_TILES_LIMIT);

/** 文書を開いたときの表示状態：開始マップ、下層、鉛筆。 */
export function initialUiState(doc: ProjectDocument): EditorUiState {
  const first = Object.keys(doc.project.maps)[0] as MapId | undefined;
  const start = Object.hasOwn(doc.project.maps, doc.project.system.startMap) ? doc.project.system.startMap : first;
  return { currentMap: start, currentLayer: 0, tool: "pencil", tile: 1, selection: { kind: "none" }, zoom: 1, clipboard: undefined, commandClipboard: undefined, eventTemplate: undefined, recentCommands: [], recentTiles: [] };
}
