/**
 * @rpg/plugin-api — プラグイン境界と PluginHost。
 *
 * 設計: docs/14-plugin-api.md
 * プラグインが触れてよい型・関数だけをここから再エクスポートする（内部の型は漏らさない）。
 */
export { toRuntimeExtensions } from "./extensions.js";
export { loadPlugins } from "./load.js";
export { createPluginRegistry } from "./registry.js";
export { selectPlugins } from "./select.js";
export type { PluginRefLike, Selection } from "./select.js";
export type {
  DiagnosticsFn,
  EffectHandler,
  LoadOptions,
  LoadResult,
  PluginCommand,
  PluginDocument,
  PluginHost,
  PluginModule,
  PluginRegistry,
  ProjectionHook,
} from "./types.js";

// プラグインの作者が使うもの（コマンドの定義、Effect の作り方、型）
export { defineCommand, paramAt, pluginStateOf, warn, withPluginState } from "@rpg/core";
export type { Action, BattleRules, CommandBlock, CommandCtx, CommandHandler, CommandResult, Effect, FormulaFn, GameState, JsonValue, ProjectView } from "./types.js";
export type { Diagnostic, EffectApi, EventDraft, EventTemplate, FrameSpec, Logger, SceneKind } from "./types.js";
export { defineEventTemplate } from "@rpg/editor-core";
export type { RGBA, UiNode } from "@rpg/runtime";
export { ui } from "./ui.js";
export { z } from "zod";
