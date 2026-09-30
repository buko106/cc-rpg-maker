import { createFormulaRegistry, registerBuiltinFns } from "@rpg/core";
import type { CommandHandler } from "@rpg/core";
import { noopLogger } from "@rpg/runtime";
import type { BattleRules, DiagnosticsFn, EffectHandler, EventTemplate, FormulaFn, LoadOptions, LoadResult, PluginHost, PluginModule, PluginRegistry, ProjectionHook, SceneKind } from "./types.js";

const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const COMMAND_CODE = /^[A-Za-z][A-Za-z0-9_]*$/;

/** `register` の間に溜めた登録。成功したときにだけ `PluginRegistry` に反映される。 */
interface Staged {
  commands: CommandHandler<any>[];
  formulas: { name: string; fn: FormulaFn; sideEffect: boolean }[];
  battle: Partial<BattleRules>;
  effects: { name: string; handler: EffectHandler }[];
  hooks: { scene: SceneKind; fn: ProjectionHook }[];
  forms: { code: string; component: unknown }[];
  diagnostics: DiagnosticsFn[];
  templates: EventTemplate[];
}

/** 登録口。`seal()` のあとに呼ぶと例外（`register` の外で登録できてしまうと、ロールバックできない）。 */
function createStagedHost(mod: PluginModule, opts: LoadOptions): { host: PluginHost; staged: Staged; seal(): void } {
  const staged: Staged = { commands: [], formulas: [], battle: {}, effects: [], hooks: [], forms: [], diagnostics: [], templates: [] };
  let sealed = false;
  const open = (what: string): void => {
    if (sealed) throw new Error(`${mod.name}: register の外で ${what} は呼べない`);
  };
  const fullCode = (code: string, what = "コマンドの code"): string => {
    if (typeof code !== "string" || !COMMAND_CODE.test(code)) throw new Error(`${mod.name}: ${what}が不正: "${String(code)}"`);
    return `plugin:${mod.name}/${code}`;
  };
  const host: PluginHost = {
    name: mod.name,
    params: opts.params?.[mod.name] ?? {},
    commands: {
      add(handler) {
        open("commands.add");
        staged.commands.push({ ...handler, code: fullCode(handler.code) } as CommandHandler<any>);
      },
    },
    formulas: {
      addFn(name, fn, o) {
        open("formulas.addFn");
        staged.formulas.push({ name, fn, sideEffect: o?.sideEffect ?? false });
      },
    },
    battle: {
      setRules(patch) {
        open("battle.setRules");
        Object.assign(staged.battle, patch);
      },
    },
    effects: {
      on(name, handler) {
        open("effects.on");
        staged.effects.push({ name, handler });
      },
    },
    projection: {
      after(scene, fn) {
        open("projection.after");
        staged.hooks.push({ scene, fn });
      },
    },
    ...(opts.editor === true
      ? {
          editor: {
            commandForm(code: string, component: unknown) {
              open("editor.commandForm");
              staged.forms.push({ code: fullCode(code), component });
            },
            diagnostics(fn: DiagnosticsFn) {
              open("editor.diagnostics");
              staged.diagnostics.push(fn);
            },
            eventTemplate(template: EventTemplate) {
              open("editor.eventTemplate");
              staged.templates.push({ ...template, id: fullCode(template.id, "ひな形の id") });
            },
          },
        }
      : {}),
    log: opts.logger ?? noopLogger,
  };
  return { host, staged, seal: () => void (sealed = true) };
}

/** 登録内容が既存の登録と衝突しないか調べる（衝突するなら例外。何も変更しない）。 */
function check(mod: PluginModule, staged: Staged, registry: PluginRegistry): void {
  const codes = new Set(registry.commands.map((c) => c.code));
  for (const c of staged.commands) {
    if (codes.has(c.code)) throw new Error(`${mod.name}: コマンド ${c.code} が二重に登録された`);
    codes.add(c.code);
  }
  // 式関数は、組み込み + すでに読み込んだプラグイン + このプラグインの順に仮の登録簿へ入れて、二重登録を見つける
  const scratch = createFormulaRegistry();
  registerBuiltinFns(scratch);
  for (const f of registry.formulas) scratch.registerFn(f.name, f.fn, { sideEffect: f.sideEffect });
  for (const f of staged.formulas) scratch.registerFn(f.name, f.fn, { sideEffect: f.sideEffect });
  for (const f of staged.forms) if (!staged.commands.some((c) => c.code === f.code)) throw new Error(`${mod.name}: フォームを差し替えるコマンド ${f.code} を、このプラグインは登録していない`);
  const templates = new Set(registry.editor.eventTemplates.map((t) => t.id));
  for (const t of staged.templates) {
    if (templates.has(t.id)) throw new Error(`${mod.name}: ひな形 ${t.id} が二重に登録された`);
    templates.add(t.id);
  }
}

function commit(staged: Staged, registry: PluginRegistry, name: string): void {
  registry.commands.push(...staged.commands);
  registry.formulas.push(...staged.formulas);
  registry.battleRules = { ...registry.battleRules, ...staged.battle };
  for (const e of staged.effects) registry.effectHandlers.set(e.name, [...(registry.effectHandlers.get(e.name) ?? []), e.handler]);
  registry.projectionHooks.push(...staged.hooks);
  for (const f of staged.forms) registry.editor.commandForms.set(f.code, f.component);
  registry.editor.diagnostics.push(...staged.diagnostics);
  registry.editor.eventTemplates.push(...staged.templates);
  registry.loaded.push(name);
}

/**
 * 依存の順（`dependsOn` を先に）に並べる。読み込めないもの（名前が不正・重複・依存が無い・循環）は `failed` に入れる。
 * 同じ深さのものは入力の順を保つ。
 */
function order(mods: readonly PluginModule[]): { ordered: PluginModule[]; failed: LoadResult["failed"] } {
  const failed: LoadResult["failed"] = [];
  const byName = new Map<string, PluginModule>();
  for (const m of mods) {
    if (typeof m.name !== "string" || !NAME.test(m.name)) failed.push({ name: String(m.name), error: new Error(`プラグイン名が不正: "${String(m.name)}"`) });
    else if (byName.has(m.name)) failed.push({ name: m.name, error: new Error(`プラグイン名が重複している: ${m.name}`) });
    else byName.set(m.name, m);
  }
  const ordered: PluginModule[] = [];
  const state = new Map<string, "visiting" | "done" | "failed">();
  const visit = (m: PluginModule, path: string[]): boolean => {
    const s = state.get(m.name);
    if (s === "done") return true;
    if (s === "failed") return false;
    if (s === "visiting") {
      failed.push({ name: m.name, error: new Error(`依存が循環している: ${[...path, m.name].join(" → ")}`) });
      state.set(m.name, "failed");
      return false;
    }
    state.set(m.name, "visiting");
    for (const dep of m.dependsOn ?? []) {
      const d = byName.get(dep);
      if (d === undefined) {
        failed.push({ name: m.name, error: new Error(`依存しているプラグイン ${dep} が無い`) });
        state.set(m.name, "failed");
        return false;
      }
      if (!visit(d, [...path, m.name])) {
        if (state.get(m.name) !== "failed") {
          failed.push({ name: m.name, error: new Error(`依存しているプラグイン ${dep} を読み込めない`) });
          state.set(m.name, "failed");
        }
        return false;
      }
    }
    state.set(m.name, "done");
    ordered.push(m);
    return true;
  };
  for (const m of byName.values()) visit(m, []);
  return { ordered, failed };
}

/**
 * プラグインを依存の順に読み込み、成功したものの登録を `registry` にコミットする。
 * - `register` が例外を投げても（同期でも非同期でも）他は続行し、`failed` に記録する。失敗したプラグインは何も残さない。
 * - 依存先が読み込めなければ、そのプラグインも失敗。循環は失敗。
 * - コマンドは `plugin:<name>/<code>` として登録されるので、組み込みとは衝突しない。
 */
export async function loadPlugins(mods: readonly PluginModule[], registry: PluginRegistry, opts: LoadOptions = {}): Promise<LoadResult> {
  const logger = opts.logger ?? noopLogger;
  const { ordered, failed } = order(mods);
  const loaded: string[] = [];
  const failedNames = new Set(failed.map((f) => f.name));
  for (const mod of ordered) {
    if ((mod.dependsOn ?? []).some((d) => failedNames.has(d))) {
      failed.push({ name: mod.name, error: new Error("依存しているプラグインを読み込めない") });
      failedNames.add(mod.name);
      continue;
    }
    const { host, staged, seal } = createStagedHost(mod, opts);
    try {
      await mod.register(host);
      seal();
      check(mod, staged, registry);
      commit(staged, registry, mod.name);
      loaded.push(mod.name);
    } catch (error) {
      seal();
      failed.push({ name: mod.name, error });
      failedNames.add(mod.name);
      logger.warn(`プラグイン ${mod.name} を読み込めない: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { loaded, failed };
}
