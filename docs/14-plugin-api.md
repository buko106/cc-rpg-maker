# 14. `@rpg/plugin-api` — プラグイン境界と PluginHost

## 責務
- サードパーティがゲーム/エディタを拡張するための**唯一の公開 API**。
- プラグインが触れられる型の再エクスポート（内部型は漏らさない）。
- プラグインのロード・順序解決・失敗の隔離。

## 非責務
- サンドボックス（プラグインは信頼されたコードとして同一コンテキストで実行する。将来 iframe/Worker 隔離を検討）。

## 依存が許されるパッケージ
`@rpg/core`, `@rpg/runtime`, `@rpg/editor-core`（それぞれの公開型のみ）。

## 公開インターフェース
```ts
export interface PluginModule {
  readonly name: string;                     // 一意。コマンド code の prefix になる
  readonly version: string;
  readonly dependsOn?: string[];
  register(host: PluginHost): void | Promise<void>;
}

export interface PluginHost {
  readonly commands: {
    add<P>(h: Omit<CommandHandler<P>, "code"> & { code: string }): void;   // code は自動的に `plugin:<name>/<code>` に prefix される
  };
  readonly formulas: { addFn(name: string, fn: FormulaFn, opts?): void };
  readonly battle: { setRules(patch: Partial<BattleRules>): void };
  readonly effects: { on(name: string, handler: (payload: unknown, api: EffectApi) => void): void };   // `plugin` Effect の受け口
  readonly projection: {                      // FrameSpec の後処理（HUD 追加など）
    after(scene: SceneKind, fn: (frame: FrameSpec, state: GameState) => FrameSpec): void;
  };
  readonly editor?: {                         // エディタ内でロードされたときのみ存在
    commandForm(code: string, component: unknown): void;
    diagnostics(fn: (doc: ProjectDocument) => Diagnostic[]): void;
  };
  readonly log: Logger;
}

export interface EffectApi { audio: AudioOut; dispatch(action: Action): void; state(): GameState }

export function loadPlugins(mods: PluginModule[], host: PluginHost): Promise<{ loaded: string[]; failed: { name: string; error: unknown }[] }>;
```

## 実装指針
- `loadPlugins` は `dependsOn` をトポロジカルソートし、循環は `failed` にする。
- 1 つのプラグインの `register` が例外を投げても他は続行し、`failed` に記録する。
- `commands.add` の prefix 付与により組み込みコマンドとの衝突を構造的に防ぐ。
- プラグインは `GameState` の `interpreters[].locals` と `variables` のみ書き換え可能。それ以外は `dispatch` 経由。
- プロジェクトが使用するプラグインは `Project.system.plugins: { name; version; params }[]` に記録する（`schema` に追加：フォーマットバージョン更新）。

## 不変条件
1. プラグインを 0 個ロードした状態と、no-op プラグインを 1 個ロードした状態で同じリプレイが同じ結果になる。
2. 失敗したプラグインは一切登録を残さない（部分登録のロールバック：`register` 中の登録は一時レジストリに溜め、成功時にコミット）。
3. `commands.add` で登録された code は必ず `plugin:` で始まる。

## テスト要件
- サンプルプラグイン `fixtures/plugins/hud/`（HUD を追加）と `fixtures/plugins/custom-command/` を用いた統合テスト。
- 依存順序・循環・失敗隔離・ロールバック。
- 03 の `CommandRegistry` にプラグインコマンドが載り、13 の `CommandForm` で表示されること。

## 完了条件
- 2 つのサンプルプラグインが `apps/player` と `apps/editor-ui` の両方で動作する。
