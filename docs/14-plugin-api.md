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
    eventTemplate(template: EventTemplate): void;   // イベントのひな形（12）。id は `plugin:<name>/<id>` になる
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

## 実装メモ（M7 で確定した点）
- **`loadPlugins(mods, registry, opts)`**（doc の `host` 引数ではなく、コミット先の `PluginRegistry`）。`dependsOn` の順（同じ深さは入力の順）に読み込み、名前が不正・重複・依存が無い・循環・依存先の失敗は `failed`。`register` は一時置き場（`Staged`）に登録を溜める `PluginHost` を受け取り、成功したときにだけ衝突を調べて（コマンドの code、式関数は組み込み + 読み込み済みと突き合わせる）コミットする。例外（同期・非同期）・衝突・`register` の外で host を使ったときは、そのプラグインは何も残さない。**`register` が終わったあとに `host` を使うと例外**（ロールバックできなくなるため）。
- **`PluginHost`**：doc のとおり（`commands.add` は `plugin:<name>/<code>` に接頭辞、`formulas.addFn`、`battle.setRules`（読み込み順に上書き）、`effects.on(name, handler)`（同じ名前に複数の受け口）、`projection.after(scene, fn)`、`editor?.commandForm` / `editor?.diagnostics`、`log`）に、`name` と `params`（`system.plugins` の設定）を足した。`editor` はエディタの中で読み込んだときだけある。
- **`toRuntimeExtensions(registry, logger)`** が `RuntimeExtensions`（06）を作る。**`selectPlugins(catalog, refs)`** は、ビルドに入っているプラグイン（catalog）と `system.plugins` を突き合わせ、書かれていない依存先を足し、入っていないもの・バージョン違いを警告にする。プラグイン作者向けに `defineCommand` / `warn` / `z` と型だけを再エクスポート。「プラグインは `GameState` の `locals` と `variables` だけを書き換える」は、型では強制していない（`state` は読み取り専用の型で渡す。書き込みは `dispatch` / コマンドの結果を通す）。
- **サンプルプラグイン**は `fixtures/plugins/` ではなく、ワークスペースのパッケージ `@rpg/plugin-samples`（`plugin-api` にだけ依存 = 第三者のプラグインと同じ立場を、依存ルールで強制）：`hud`（マップの左上/右上に所持金。`projection.after` だけ。設定 `label` / `corner`）と `custom-command`（独自コマンド `RandomGold`、式関数 `twice`、`plugin` Effect の受け口、エディタの診断）。
- **結線**：`apps/player` は `PlayerConfig.plugins`（ビルドに入っているプラグイン。`main.ts` は `samplePlugins`）から、プロジェクトの `system.plugins` で有効にされたものだけを読み込む（読み込めなくてもゲームは始まり、警告だけ）。`apps/editor-ui` は `EditorEnv` にカタログ・診断・専用フォーム・`createExtensions(refs)` を持ち、エディタでは全部入りで読み込み（コマンドが一覧に出る）、テストプレイでは `system.plugins` に従って読み込み直す。システム設定に「プラグイン」タブ（有効/無効と設定の JSON）。`editor-core` は、プラグインのコマンドを使っているのに有効になっていないと `pluginNotEnabled` の警告を出し、`EditorSessionDeps.diagnostics` でプラグインの診断を足す（例外を投げても他の診断は出る）。
- **テスト**：ローダ（依存順・循環・ロールバック・衝突・遅延登録・エディタ用の登録）、`toRuntimeExtensions`、`selectPlugins`、サンプルの統合（実プロジェクト `fixtures/projects/v2/plugin-demo` をランタイムで動かす。共有の乱数で同じシードなら同じ額）、**不変条件 1**（プラグイン 0 個と no-op 1 個で、demo のリプレイの状態ハッシュ・Effect・警告が一致）、エディタ（プラグインタブ・コマンド一覧・専用フォーム・診断・テストプレイ）、E2E `e2e/plugins.spec.ts`（エディタでプラグインを有効にして独自コマンドを置き、エディタのテストプレイと、書き出したゲーム（別オリジン）の両方で HUD と所持金が動く）。
- **未対応**：プラグインの実行時の読み込み（URL からの動的 import。ビルドに同梱したものだけ）、プラグインのサンドボックス、コマンドの専用フォームの実例（仕組みとテストだけ）。

## 実装メモ（イベントのひな形）
- **`host.editor.eventTemplate(template)`**：イベントのひな形（`EventTemplate`、12）を足す。`id` は接頭辞なしで書き、`plugin:<name>/<id>` として登録される（書式はコマンドの code と同じ。不正な id・同じ id の二重登録はそのプラグインの失敗で、何も残さない）。登録内容は `PluginRegistry.editor.eventTemplates`、エディタでは `EditorEnv.pluginEventTemplates` として、組み込みのひな形の後ろに「置くイベント」に並ぶ。ゲームの中（エディタ以外）で読み込んだときは `host.editor` が無いので登録されない。
- プラグイン作者向けに `defineEventTemplate` と型（`EventTemplate` / `EventDraft`）を再エクスポートした。入力フォームは `input` の zod から作られる（見出しは `.meta({ title })`）。
- **サンプル**：`custom-command` に「くじ引き」（`plugin:custom-command/lottery`。`RandomGold` を使い、1 回引いたらセルフスイッチ A で別のセリフ）。テスト：`plugin-api.test.ts`（接頭辞・不正な id・二重登録）、`plugin-samples.test.ts`（くじ引きの形・ゲームの中では登録されない）、editor-ui の `EventTemplateDialog.test.tsx`（「置くイベント」に並んで置ける）。

## 実装メモ（プラグインの分岐・ループのコマンド）
プラグインのコマンドも、`meta.block`（`CommandBlock`。03 の「実装メモ（ブロックの構造）」）を書けば、エディタで組み込みの分岐と同じように扱える：開始を追加すると区切りと終端が一緒に入り、ブロックごと消す・動かす・コピーできる。区切り・終端は追加の一覧に出ず、単独では扱えない。内部用のコマンドは `meta.internal`。
- **書き方**（型 `CommandBlock` を再エクスポートしている）：開始 = `block: { role: "open", close, bodyFirst, dividers(p) }`、区切り = `block: { role: "divider" }`、終端 = `block: { role: "close" }`。**`close` と `dividers` が返す `code` は、接頭辞の付いた完全な code**（`plugin:<name>/EndPick` のように。`commands.add` が接頭辞を付けるのは登録する `code` だけ）。
- **実行はプラグインの責任**：`meta.block` はエディタのための情報。実行時に本体を飛ばす・戻るのは、コマンドの `run` が `control`（`skipBlock` / `jump`）と `setBranch` で行う（組み込みの `Else` / `ChoiceBranch` / `EndBranch` / `EndLoop` と同じ流儀）。
- **テスト**：editor-ui の `plugins.test.tsx`（分岐コマンドの追加・区切りの数の同期・区切りは単独で扱えない・ブロックごと削除）、editor-core の `command-blocks.test.ts`。

## 実装メモ（プラグインの保存領域）
- **`GameState.pluginState`**（02）：プラグインは、自分の名前（`host.name`）のキーだけを読み書きする。書き込み口は、コマンドの結果の `state`（`withPluginState(state, name, value)` で作る。`@rpg/plugin-api` から再エクスポート）。読み取りは `pluginStateOf(state, name)`（コマンドの `c.state` からも、`projection.after` の `state` からも読める）。値は JSON にできるもの（`JsonValue` を再エクスポート）で、セーブに含まれる。上の「プラグインが書き換えてよいのは `locals` と `variables` だけ」の取り決めは、この領域まで広がった（型では強制していない）。
- **コマンドで状態を変える**：コマンドの `run` は、完全な `GameState` を返せる（`pluginState` のほか、`mapTiles`・`actors`・`party`・`map.player` など）。プラグインが触ってよいと決めてあるのは、そのプラグインの設計文書（18）に書いたものだけ。コマンドからほかのコマンドを呼ぶには、`control: { kind: "call", commands }` を返す（呼び出した列が終わると、続きから戻る）。**並列イベントの中から `TransferPlayer` を呼んではいけない**：場所移動は、元のマップの並列イベントのインタプリタをすべて終わらせるので、移動を待っている並列イベント自身も消え、明転が終わらない。移動する前提のコマンドは、通常のイベント（自動実行・話しかけ）から呼ぶ。
- **`projection.after` は `Ctx`（データベース）を受け取らない**：描くのに必要な値（最大 HP・設定・絵の位置など）は、`host.params`（設定）と `pluginState`（コマンドが毎ターン書いておく）から取る。FrameSpec の `layers` を差し込むときは、タイルの層とキャラクターの層（`sprites`、`z` が 100・200・300）の間に、`z` の小さい順になるよう並べる。

