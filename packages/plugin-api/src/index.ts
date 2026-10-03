/**
 * @rpg/plugin-api — プラグイン境界と PluginHost。
 *
 * 設計: docs/14-plugin-api.md
 * プラグインが触れてよい型・関数だけをここから再エクスポートする（内部の型は漏らさない）。
 */
import * as zod from "zod";

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
export { getVar, heroOf, setVar } from "./state.js";
export { ui } from "./ui.js";
/**
 * プラグインが params / config を書くための zod。`export * as z` や `export { z }` で名前空間ごと出すと、バンドラがロケール等を含む全体を残してしまう（player.js が約 350KB 増える）ので、
 * 使うものを名指しした値として出す。足りない部品が要るときは、ここに足す。
 */
export const z = {
  any: zod.any,
  array: zod.array,
  boolean: zod.boolean,
  discriminatedUnion: zod.discriminatedUnion,
  enum: zod.enum,
  literal: zod.literal,
  null: zod.null,
  number: zod.number,
  record: zod.record,
  string: zod.string,
  strictObject: zod.strictObject,
  tuple: zod.tuple,
  union: zod.union,
  unknown: zod.unknown,
};
export declare namespace z {
  export type infer<T> = zod.infer<T>;
  export type input<T> = zod.input<T>;
  export type output<T> = zod.output<T>;
  export type ZodType<Output = unknown, Input = unknown> = zod.ZodType<Output, Input>;
}
