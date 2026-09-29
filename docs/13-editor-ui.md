# 13. `@rpg/editor-ui`（apps/editor-ui） — エディタ UI

## 責務
- `EditorSession`（12）を操作する React UI。
- マップエディタ（タイル描画、イベント配置）、データベースエディタ、イベントコマンドエディタ、システム設定、アセット管理、テストプレイ。
- 結線（composition root）：`ProjectRepository`、`AssetSource`、`Runtime` の具象アダプタを生成する唯一の場所。

## 非責務
- 編集のロジック（すべて `editor-core` のコマンド）。UI は「どのコマンドを発行するか」だけを決める。
- ゲームの実行（`runtime` を埋め込むだけ）。

## 依存が許されるパッケージ
`@rpg/editor-core`, `@rpg/runtime`, `@rpg/plugin-api`, `@rpg/schema`, `@rpg/core`（`CommandRegistry` のメタ）、任意のアダプタ。

## 技術選定
- React 18 + Zustand（`EditorSession.subscribe` をストアに橋渡し）。UI 状態のうちセッションに属さない一時状態（ダイアログ開閉など）のみ Zustand に持つ。
- マップ描画は `render-canvas2d` を**エディタ用にも再利用**する：`editor-core` が `MapData` → `FrameSpec` へ投影する `projectMapForEditor()` を持ち（グリッド・イベント枠・選択枠を `ui` ノードとして追加）、Renderer で描く。
- スタイル：CSS Modules。デザインシステムは `frontend-design` スキルに従う。

## 画面構成
| 画面 | 主なコンポーネント | 発行するコマンド |
|---|---|---|
| マップツリー | `MapTree` | `createMap`, `deleteMap`, `setUi({currentMap})` |
| マップキャンバス | `MapCanvas`（Renderer 埋め込み）, `TilePalette`, `LayerBar`, `ToolBar` | `paintTiles`, `fillTiles`, `createEvent`, `moveEvent` |
| イベントエディタ | `EventDialog`, `PageTabs`, `PageConditions`, `CommandList`, `CommandForm` | `setEventPage`, `insertCommands`, `replaceCommand`, `removeCommands` |
| データベース | `DatabaseDialog` → タブごとに `EntityList` + `EntityForm` | `upsertEntity`, `deleteEntity` |
| システム | `SystemForm` | `setSystem` |
| アセット | `AssetBrowser`（ドロップでインポート） | `registerAsset`, `unregisterAsset` |
| テストプレイ | `PlaytestPanel` | なし（`session.projectSource()` で Runtime 起動） |
| 診断 | `DiagnosticsPanel` | なし（`session.validate()`） |

## CommandForm の自動生成
- `CommandRegistry.list()` の各 `CommandHandler.params`（zod）から**フォームを自動生成**する（`zod` の `description`/`meta` を利用）。
- 型 → ウィジェットの対応：`ActorId` → アクター選択、`SwitchId` → スイッチ選択、`string` with `meta.multiline` → テキストエリア、`string` with `meta.formula` → 式エディタ（05 の `parse` でリアルタイム検証）。
- 特殊なフォームが必要なコマンド（`ShowText`, `SetMoveRoute`）は `formOverrides: Record<code, Component>` で差し替え可能。プラグインも同じ仕組みで差し替えられる（14）。

## テストプレイ
- `createRuntime` に `projectSource: session.projectSource()`, `saves: createMemorySaveRepository(...)`, `assets: session.assetSource()` を渡す。**本番セーブは汚さない**。
- 「現在位置からテストプレイ」は `runtime.dispatch({ type: "startGame", ... })` の直後に `TransferPlayer` を dispatch する。
- ランタイムは別 `<iframe>` または同一ページ内 canvas。初期実装は同一ページ。`Web Worker` 化はマイルストーン後半。

## 不変条件
1. UI コンポーネントは `ProjectDocument` を直接変更しない（すべて `session.execute`）。lint ルールで `doc.` への代入を禁止。
2. どの画面からでも `Ctrl+Z` / `Ctrl+Shift+Z` が `session.undo/redo` に到達する。
3. 未保存で閉じようとしたら確認する（`beforeunload`）。

## テスト要件
- コンポーネントテスト（Vitest + Testing Library）：各画面が正しいコマンドを `execute` に渡すこと（`EditorSession` はモック）。
- `CommandForm` 自動生成：組み込み全コマンドについてフォームがクラッシュせず描画され、入力値が `params` の zod を通ること（スナップショット）。
- E2E（Playwright）：新規プロジェクト → タイル描画 → イベント作成（`ShowText`）→ 保存 → リロード → テストプレイでメッセージが出る。

## 完了条件
- 上記 E2E が通る。
- 全画面がキーボード操作可能（アクセシビリティ最低限）。
