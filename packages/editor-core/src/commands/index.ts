import { batch } from "../command.js";
import { deleteEntity, deleteTileset, registerAsset, removeSwitch, removeVariable, setSwitchName, setSystem, setVariableName, unregisterAsset, upsertEntity, upsertTileset } from "./database.js";
import { createEvent, createEventFromTemplate, deleteEvent, insertCommands, moveEvent, pasteEvent, removeCommands, removeEventPage, replaceCommand, setEventName, setEventPage } from "./event.js";
import { createMap, deleteMap, fillTiles, paintTiles, resizeMap, setMapMeta, setMapProperties } from "./map.js";

/** コマンドファクトリ。UI が発行できる編集操作は、すべてここにある。 */
export const cmd = {
  // マップ
  paintTiles,
  fillTiles,
  resizeMap,
  createMap,
  deleteMap,
  setMapMeta,
  setMapProperties,
  // イベント
  createEvent,
  createEventFromTemplate,
  pasteEvent,
  moveEvent,
  deleteEvent,
  setEventName,
  setEventPage,
  removeEventPage,
  insertCommands,
  removeCommands,
  replaceCommand,
  // データベース
  upsertEntity,
  deleteEntity,
  // システム・アセット
  setSystem,
  registerAsset,
  unregisterAsset,
  setSwitchName,
  setVariableName,
  removeSwitch,
  removeVariable,
  upsertTileset,
  deleteTileset,
  batch,
} as const;

export { blankLayers } from "./map.js";
export type { Anchor, NewMapData, PaintTilesCommand, TileCell } from "./map.js";
export { defaultPage, eventCommand } from "./event.js";
export { TABLE_KIND } from "./database.js";
