/**
 * @rpg/editor-core — EditorCommand、Undo/Redo、整合性チェック。
 *
 * 設計: docs/12-editor-core.md
 */
export { cmd } from "./commands/index.js";
export { applyOps, blockOwner, blockSpan, commandTemplate, copyRows, insertionPoint, isPart, moveSpan, pasteRows, removalRange, selectionSpan, syncDividers } from "./command-blocks.js";
export type { BlockRegistry, CommandOp, MoveResult, Span } from "./command-blocks.js";
export { blankLayers, defaultPage, eventCommand, TABLE_KIND } from "./commands/index.js";
export type { Anchor, NewMapData, PaintTilesCommand, TileCell } from "./commands/index.js";
export { batch, defineEdit } from "./command.js";
export type { EditorCommand, EditSpec } from "./command.js";
export type { Diagnostic, EditError, Impact } from "./errors.js";
export { commandRefResolver, describeFrom, kindLabel, validateDoc } from "./diagnostics.js";
export { COALESCE_MS, createEditorSession, UNDO_LIMIT } from "./session.js";
export type { DocProjectSource, EditorSession, EditorSessionDeps, ExecuteOptions, SaveStatus, Timers } from "./session.js";
export { initialUiState, RECENT_COMMANDS_LIMIT, withRecentCommand } from "./ui-state.js";
export type { EditorUiState, Selection, Tool } from "./ui-state.js";
export { BUILTIN_EVENT_TEMPLATES, characterImage, defineEventTemplate, splitMessages, WANDER_ROUTE } from "./templates.js";
export type { EventDraft, EventTemplate } from "./templates.js";
