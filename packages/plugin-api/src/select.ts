import type { PluginModule } from "./types.js";

/** `Project.system.plugins` の 1 要素（schema の `PluginRef` と同じ形）。 */
export interface PluginRefLike {
  readonly name: string;
  readonly version: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface Selection {
  /** 読み込む順（プロジェクトに書かれた順。依存先は含まれていなければ足される）。 */
  modules: PluginModule[];
  /** プラグイン名 → `system.plugins` の `params`。 */
  params: Record<string, Record<string, unknown>>;
  /** 利用者に知らせたいこと：入っていないプラグイン、バージョンの違いなど。 */
  warnings: string[];
}

/**
 * プロジェクトの `system.plugins`（使うプラグイン）と、ビルドに入っているプラグイン一覧（catalog）を突き合わせる。
 * catalog に無いものは飛ばして警告する。`dependsOn` の依存先が catalog にあれば、書かれていなくても加える。
 */
export function selectPlugins(catalog: readonly PluginModule[], refs: readonly PluginRefLike[]): Selection {
  const byName = new Map(catalog.map((m) => [m.name, m]));
  const modules: PluginModule[] = [];
  const params: Selection["params"] = {};
  const warnings: string[] = [];
  const add = (m: PluginModule): void => {
    if (modules.includes(m)) return;
    for (const dep of m.dependsOn ?? []) {
      const d = byName.get(dep);
      if (d !== undefined) add(d);
    }
    modules.push(m);
  };
  for (const ref of refs) {
    const m = byName.get(ref.name);
    if (m === undefined) {
      warnings.push(`プラグイン ${ref.name}（${ref.version}）はこのビルドに入っていない`);
      continue;
    }
    if (m.version !== ref.version) warnings.push(`プラグイン ${ref.name} のバージョンが違う（プロジェクト ${ref.version}、ビルド ${m.version}）`);
    params[ref.name] = { ...ref.params };
    add(m);
  }
  return { modules, params, warnings };
}
