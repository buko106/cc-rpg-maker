import type { PluginRegistry } from "./types.js";

/** 空の登録内容。`loadPlugins` がここへ、成功したプラグインの登録をコミットしていく。 */
export function createPluginRegistry(): PluginRegistry {
  return {
    commands: [],
    formulas: [],
    battleRules: {},
    effectHandlers: new Map(),
    projectionHooks: [],
    editor: { commandForms: new Map(), diagnostics: [] },
    loaded: [],
  };
}
