import type { CommandRegistry } from "@rpg/core";
import type { EventTemplate } from "@rpg/editor-core";
import { createPluginRegistry, loadPlugins, selectPlugins, toRuntimeExtensions } from "@rpg/plugin-api";
import type { DiagnosticsFn, PluginModule, PluginRefLike } from "@rpg/plugin-api";
import type { Logger, RuntimeExtensions } from "@rpg/runtime";
import type { ComponentType } from "react";
import type { CommandFormOverrideProps } from "./command-form.js";

/** `EditorEnv` のうち、プラグインに関わる部分。 */
export interface PluginEnv {
  /** ビルドに入っているプラグイン（プロジェクトの `system.plugins` で有効にする）。 */
  pluginCatalog: readonly PluginModule[];
  /** プラグインが登録したエディタ用の診断（セッションの `validate()` に足す）。 */
  pluginDiagnostics: readonly DiagnosticsFn[];
  /** プラグインが足したイベントのひな形（組み込みのひな形の後ろに並ぶ）。 */
  pluginEventTemplates: readonly EventTemplate[];
  /** プラグインのコマンドの専用フォーム（コマンド code → コンポーネント）。 */
  pluginForms: Readonly<Record<string, ComponentType<CommandFormOverrideProps>>>;
  /** プロジェクトが有効にしているプラグインから、テストプレイ用のランタイム拡張を作る（プロジェクトごとに読み込み直す）。 */
  createExtensions(refs: readonly PluginRefLike[], logger?: Logger): Promise<RuntimeExtensions>;
  /** カタログの読み込みに失敗したプラグイン（エディタでの編集用の読み込み。画面に知らせる）。 */
  pluginFailures: readonly { name: string; error: unknown }[];
}

/**
 * ビルドに入っているプラグインを、エディタ用に読み込む（`host.editor` 付き）。コマンドは `commands`（エディタの登録簿）に加える。
 * エディタでは「全部入り」で読み込み、プロジェクトが有効にしているかは診断（`pluginNotEnabled`）で知らせる。
 * テストプレイでは `createExtensions` が、プロジェクトの一覧に従って読み込み直す。
 */
export async function createPluginEnv(catalog: readonly PluginModule[], commands: CommandRegistry, logger?: Logger): Promise<PluginEnv> {
  const registry = createPluginRegistry();
  const result = await loadPlugins(catalog, registry, { editor: true, ...(logger === undefined ? {} : { logger }) });
  for (const c of registry.commands) commands.register(c);
  return {
    pluginCatalog: catalog,
    pluginDiagnostics: registry.editor.diagnostics,
    pluginEventTemplates: registry.editor.eventTemplates,
    pluginForms: Object.fromEntries(registry.editor.commandForms) as PluginEnv["pluginForms"],
    pluginFailures: result.failed,
    async createExtensions(refs, log) {
      const selection = selectPlugins(catalog, refs);
      const runtimeRegistry = createPluginRegistry();
      for (const w of selection.warnings) log?.warn(w);
      await loadPlugins(selection.modules, runtimeRegistry, { params: selection.params, ...(log === undefined ? {} : { logger: log }) });
      return toRuntimeExtensions(runtimeRegistry, log);
    },
  };
}
