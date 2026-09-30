import type { Action, BattleRules, CommandCtx, CommandHandler, CommandResult, Effect, FormulaFn, GameState, ProjectView } from "@rpg/core";
import type { Diagnostic, EventDraft, EventTemplate } from "@rpg/editor-core";
import type { EffectApi, FrameSpec, Logger, MapData, MapId, Project, SceneKind } from "@rpg/runtime";
import type { z } from "zod";

export type { Action, BattleRules, CommandCtx, CommandHandler, CommandResult, Diagnostic, Effect, EffectApi, EventDraft, EventTemplate, FormulaFn, FrameSpec, GameState, Logger, ProjectView, SceneKind };

/** エディタの診断フックが受け取る文書（読み取り専用）。 */
export interface PluginDocument {
  readonly project: Project;
  readonly maps: Readonly<Record<MapId, MapData>>;
}

/** `commands.add` に渡すハンドラ。`code` は接頭辞なしで書く（`plugin:<name>/<code>` として登録される）。 */
export type PluginCommand<P> = Omit<CommandHandler<P>, "code" | "params"> & { code: string; params: z.ZodType<P> };

export type EffectHandler = (payload: unknown, api: EffectApi) => void;
export type ProjectionHook = (frame: FrameSpec, state: GameState) => FrameSpec;
export type DiagnosticsFn = (doc: PluginDocument) => Diagnostic[];

export interface PluginModule {
  /** 一意。コマンドの code の接頭辞（`plugin:<name>/`）になる。英数字・`_`・`-` の 1〜64 文字。 */
  readonly name: string;
  readonly version: string;
  readonly dependsOn?: readonly string[];
  register(host: PluginHost): void | Promise<void>;
}

/**
 * プラグインが `register` の間だけ使える登録口。登録はいったん一時置き場に溜まり、`register` が成功したときにだけ反映される
 * （失敗したプラグインは何も残さない）。`register` が終わったあとに呼ぶと例外。
 */
export interface PluginHost {
  readonly name: string;
  /** プロジェクトの `system.plugins` に書かれた、このプラグインの設定。 */
  readonly params: Readonly<Record<string, unknown>>;
  readonly commands: {
    add<P>(handler: PluginCommand<P>): void;
  };
  readonly formulas: {
    addFn(name: string, fn: FormulaFn, opts?: { sideEffect?: boolean }): void;
  };
  readonly battle: {
    /** 戦闘の計算式（命中・会心・行動順・逃走）を差し替える。複数のプラグインは読み込み順に上書きし合う。 */
    setRules(patch: Partial<BattleRules>): void;
  };
  readonly effects: {
    /** `plugin` Effect（`{ kind: "plugin", name, payload }`）の受け口。同じ `name` に複数の受け口を登録できる。 */
    on(name: string, handler: EffectHandler): void;
  };
  readonly projection: {
    /** そのシーンの `FrameSpec` の後処理（HUD の追加など）。読み込み順に適用される。 */
    after(scene: SceneKind, fn: ProjectionHook): void;
  };
  /** エディタの中で読み込まれたときだけ存在する。 */
  readonly editor?: {
    /** コマンドの設定フォームを差し替える（コンポーネントの型は editor-ui が決める）。 */
    commandForm(code: string, component: unknown): void;
    diagnostics(fn: DiagnosticsFn): void;
    /**
     * イベントのひな形を足す（エディタのイベントツールの「置くイベント」に出る）。`id` は接頭辞なしで書く
     * （`plugin:<name>/<id>` として登録される）。入力フォームは `input` の zod から作られる。
     */
    eventTemplate(template: EventTemplate): void;
  };
  readonly log: Logger;
}

/** 読み込みに成功したプラグインの登録内容（読み込み順）。 */
export interface PluginRegistry {
  readonly commands: CommandHandler<any>[];
  readonly formulas: { name: string; fn: FormulaFn; sideEffect: boolean }[];
  battleRules: Partial<BattleRules>;
  readonly effectHandlers: Map<string, EffectHandler[]>;
  readonly projectionHooks: { scene: SceneKind; fn: ProjectionHook }[];
  readonly editor: { commandForms: Map<string, unknown>; diagnostics: DiagnosticsFn[]; eventTemplates: EventTemplate[] };
  /** 読み込みに成功したプラグインの名前（読み込み順）。 */
  readonly loaded: string[];
}

export interface LoadResult {
  loaded: string[];
  failed: { name: string; error: unknown }[];
}

export interface LoadOptions {
  logger?: Logger;
  /** プラグイン名 → `system.plugins` の `params`。 */
  params?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** エディタの中で読み込むなら真（`host.editor` が付く）。 */
  editor?: boolean;
}
