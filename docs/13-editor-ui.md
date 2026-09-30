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

## 実装メモ（M5 で確定した点）
- **起動**：`pnpm editor`（`apps/editor-ui/scripts/build-web.mjs` で `dist-web/` にバンドルして `:4174` で配信）。プロジェクトはブラウザの IndexedDB（`rpg-projects`）。結線（composition root）は `browser-env.ts` だけ。テストは `test-env.tsx`（メモリのリポジトリと null のレンダラ）。`window.__editor`（セッション）と `window.__rpgPlaytest`（テストプレイ中の Runtime）は E2E とデバッグ用。
- **技術選定の変更**：Zustand は使わず、`useSyncExternalStore(session.subscribe, () => session.version)` で `EditorSession` をそのまま購読する（セッションに属さない一時状態は各コンポーネントの `useState`）。スタイルは CSS Modules ではなくプレーンな 1 枚の `styles.css`（トークンをカスタムプロパティにし、ダークテーマは `prefers-color-scheme`）。React は 18。
- **CommandForm の自動生成**（`schema-form/`）：zod の内部表現（`_zod.def`）を読んで `FieldSpec` にし（`describeSchema`）、`SchemaForm` が描く。対応する型：string / number / boolean / enum / literal / object / array / record（enum キーは固定行、`partialRecord` は行ごとに有無、文字列キーは自由に追加）/ union（種類の選択）/ 判別付き union / リテラルだけの union（選択肢）/ optional（チェックで有効化）/ default（新規追加時の初期値に使う）/ イベントコマンド列（専用のリスト）。それ以外は JSON 欄。ID 欄は `schema` の ID スキーマに付けたメタデータ（`.meta({ ref })`、画像・音声の絞り込みは `assetKind`、`ShowText.text` は `multiline`、条件式は `formula`）から、文書の該当テーブルの選択肢を出す。値の検証は zod 自身（`FormEditor`）：有効なときだけ `onCommit`、不正な間は問題を一覧で出して文書には渡さない。Undo などで値が外から変わったら下書きも追随する。式の欄は 05 の `parse` で文法エラーを出す。
- **フォームの差し替え**：`EditorEnv.formOverrides: Record<code, Component>`（プラグインも同じ口を使う）。M5 では空。
- **画面**：マップツリー（追加・設定・削除）、タイルパレット（タイルごとのボタン。選んだタイルの通行方向も編集）、ツールバー（鉛筆・消しゴム・塗りつぶし・イベント・選択、レイヤ、×1/×2、グリッド）、マップキャンバス、イベントダイアログ（名前・ページのタブ・ページ設定・コマンドリスト）、データベース（8 テーブルの一覧とフォーム）、システム（設定・スイッチ・変数）、アセット、診断、テストプレイ。コマンドの追加は分岐の部品を一緒に入れる（条件分岐 = ConditionalBranch / Else / EndBranch、戦闘の処理 = BattleProcessing / ChoiceBranch×3 / EndBranch）。分岐は開始行を消すと丸ごと消え、部品だけは消せない。
- **マップキャンバス**：下のキャンバスにゲームと同じ `Renderer`（`projectMapForEditor` の `FrameSpec`：タイルレイヤとイベントのスプライト）、上のキャンバスにグリッド・イベント枠・選択・ホバー（`drawOverlay`。`FrameSpec` の UI ノードにはしなかった）。ポインタとキーボード（矢印・Enter・O・Delete）から `paintTiles` / `fillTiles` / `createEvent` / `moveEvent` / `deleteEvent` を発行する。速いドラッグでも途切れないよう、前のセルとの間を補間する。
- **テストプレイ**：`startPlaytest(session, deps, start?)`。編集中の文書のスナップショット（`session.projectSource()`）で `createRuntime` を起動し、セーブはメモリ（`createMemorySaveRepository`）。「選択位置から」は開始マップ・位置を差し替えてタイトルを飛ばす（`TransferPlayer` の dispatch はしない）。音は出さない（`audio-null`）。rAF の `Scheduler` は player のものと同じ実装を持っている（共有は M7 で検討）。
- **キーボード・確認**：Ctrl+Z / Ctrl+Shift+Z（Ctrl+Y）/ Ctrl+S はどの画面でも `session` に届く（テストプレイ中はゲームに任せる）。未保存のまま閉じようとすると `beforeunload` で確認。ダイアログは Esc で閉じ、開いたら中の最初の操作部品にフォーカスして、閉じたら戻す。削除で参照が残るときは影響範囲つきの確認を出す。
- **テスト**：フォーム生成（組み込みコマンド全部で描画でき、既定値が `params` の zod を通る）、各画面のコンポーネントテスト（jsdom + Testing Library。`EditorSession` はモックせず、メモリのリポジトリの本物を使う）、`projectMapForEditor` / ヒットテスト / オーバーレイ、`startPlaytest`、E2E（`e2e/editor.spec.ts`：作成 → ドラッグで描画 → Undo/Redo → イベント作成と ShowText → 保存 → リロード → テストプレイでメッセージ、自動保存、データベースと削除の確認）。jsdom に無い `PointerEvent` / `Blob.arrayBuffer` / Canvas の `getContext` は `test-env.tsx` で補う。テストで `session` を直接操作するときは `act()` で包む。
- **未対応**：移動ルートの編集（対応するコマンドが M6）、テストプレイの音、タイルセットの追加・画像差し替え、アセットの一括インポート（ZIP は M6）、矩形選択ツール、キャンバスのスクロール位置を保った拡大、`doc` への代入を禁じる lint ルール（UI は `session.execute` 以外で文書を書き換えない — テストで確認）。

## 実装メモ（M6 で確定した点）
- **配布物の書き出し**（`ExportDialog`）：メニューバーの「配布物を書き出す…」。形式（フォルダ形式の ZIP / 単一 HTML）と「JSON を圧縮する」を選び、書き出す前に `session.save()` で未保存の変更を保存する（保存できなければ書き出さない）。`@rpg/exporter` の `exportGame` を、ストアの内容（`RepoContext` の `repo`）から呼ぶ。`EditorEnv` に `loadPlayerBundle()`（ブラウザでは同じオリジンの `player/player.js` を fetch）と `saveFile(name, bytes, mime)`（ダウンロード）を足した。エディタのビルド（`build-web.mjs`）は `apps/player` の `main.ts` を `dist-web/player/player.js` にもバンドルする。
- **コマンドリスト**：props を `onEdit(ops: CommandOp[])` に一本化した（挿入・削除・差し替えの列。複数なら `cmd.batch` で 1 回の Undo にまとめる）。`Loop` は `EndLoop` と、`ShowChoices` は選択肢の数だけの `ChoiceBranch` と `EndBranch` と一緒に入る。選択肢の数を増減すると、対になる `ChoiceBranch` も増減する（減らすときは余った分岐を本体ごと消す）。`Loop` の直後はループの中に入り、`Loop` / `ShowChoices` は丸ごと消える。`EndLoop` / `MoveStep`（内部用）は単独では追加も削除もできない。
- **移動ルートの編集**は、`SetMoveRoute` コマンドの標準フォーム（手順の配列。種類を選ぶ）で行う。専用のエディタは無い。ページの `moveRoute`（自律移動）は、イベントダイアログの「自律移動（ページが有効な間、勝手に動く）」で、「自律移動する」を入れると初期ルート（ランダムに 1 歩、60 フレーム待つ、を繰り返す）が付き、同じ標準フォームで手順・繰り返し・動けなければ飛ばすを編集する（外すと `moveRoute` を消す）。`e2e/editor.spec.ts` が、入れたイベントがテストプレイで動き出すことを確かめる。
- **未対応**：テストプレイの音、タイルセットの追加・画像差し替え、アセットの一括インポート（ZIP の import は project-store にあるが、UI からはまだ呼べない）、矩形選択、キャンバスのスクロール位置を保った拡大。

## 実装メモ（M7 で確定した点）
- **プラグイン**：システム設定に「プラグイン」タブ（ビルドに入っているプラグインの有効/無効、設定の JSON、入っていないプラグインの一覧と外す操作、読み込めなかったプラグインの表示）。`EditorEnv` は `PluginEnv`（`pluginCatalog` / `pluginDiagnostics` / `pluginForms` / `pluginFailures` / `createExtensions`）を持つ。`createBrowserEnv()` は非同期になった（プラグインの `register` が非同期でもよいため）。詳しくは 14。
- **書き出しダイアログ**に描画方式（自動 / WebGL / Canvas2D）とオフライン対応（フォルダ形式のみ）を追加。
- **保存先**：既定は IndexedDB、`?storage=opfs` で OPFS。File System Access API があるブラウザでは、プロジェクト一覧の「保存先：…」の横の「フォルダを選ぶ…」で利用者のフォルダに切り替えられる（`App` の `pickFolder` / `storageLabel`。選ぶのをやめた `AbortError` は無視し、他の失敗はメッセージに出す）。選んだフォルダはそのタブの間だけ有効で、リロードすると既定の保存先に戻る（`FileSystemDirectoryHandle` の永続化と権限の再確認は未実装）。`e2e/folder.spec.ts` は `showDirectoryPicker` を OPFS のフォルダを返すスタブにして確かめる。

## 実装メモ（イベントのコピー＆ペースト）
- **`MapCanvas`**：選んでいるイベントを Ctrl/⌘ + C（コピー）・X（切り取り）、カーソルのあるセルへ V（貼り付け）。貼ったイベントが選択される。キャンバスの下の「コピー / 切り取り / 貼り付け」ボタンでも同じ（貼り付け先は、最後にカーソルがあったセル。無ければ (0, 0)）。クリップボードの中身（イベント名）は横に出る。重なるセルへの貼り付けは、エディタのお知らせに出して何もしない。
- 編集の実体は `cmd.pasteEvent`（12）で、1 回の貼り付けが 1 回の Undo。テスト：`commands.test.ts`（複製・別マップ・エラー・Undo）、`MapCanvas.test.tsx`（キー・ボタン・重なり）、E2E `e2e/editor.spec.ts`。
