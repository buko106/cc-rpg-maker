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
- **画面**：マップツリー（追加・設定・削除）、タイルパレット（タイルごとのボタン。選んだタイルの通行方向も編集）、ツールバー（鉛筆・消しゴム・塗りつぶし・イベント・選択、レイヤ、×1/×2、グリッド）、マップキャンバス、イベントダイアログ（名前・ページのタブ・ページ設定・コマンドリスト）、データベース（8 テーブルの一覧とフォーム）、システム（設定・スイッチ・変数）、アセット、診断、テストプレイ。コマンドの追加は分岐の部品を一緒に入れる（条件分岐 = ConditionalBranch / Else / EndBranch、戦闘の処理 = BattleProcessing / ChoiceBranch×3 / EndBranch）。分岐は開始行を消すと丸ごと消え、部品だけは消せない（下の「実装メモ（コマンドの並べ替え・コピー・複数選択）」）。
- **マップキャンバス**：下のキャンバスにゲームと同じ `Renderer`（`projectMapForEditor` の `FrameSpec`：タイルレイヤとイベントのスプライト）、上のキャンバスにグリッド・イベント枠・選択・ホバー（`drawOverlay`。`FrameSpec` の UI ノードにはしなかった）。ポインタとキーボード（矢印・Enter・O・Delete / Backspace）から `paintTiles` / `fillTiles` / `createEvent` / `moveEvent` / `deleteEvent` を発行する。速いドラッグでも途切れないよう、前のセルとの間を補間する。
- **テストプレイ**：`startPlaytest(session, deps, start?)`。編集中の文書のスナップショット（`session.projectSource()`）で `createRuntime` を起動し、セーブはメモリ（`createMemorySaveRepository`）。「選択位置から」は開始マップ・位置を差し替えてタイトルを飛ばす（`TransferPlayer` の dispatch はしない）。音は出さない（`audio-null`）。rAF の `Scheduler` は player のものと同じ実装を持っている（共有は M7 で検討）。
- **キーボード・確認**：Ctrl+Z / Ctrl+Shift+Z（Ctrl+Y）/ Ctrl+S はどの画面でも `session` に届く（テストプレイ中はゲームに任せる）。未保存のまま閉じようとすると `beforeunload` で確認。ダイアログは Esc で閉じ、開いたら中の最初の操作部品にフォーカスして、閉じたら戻す。削除で参照が残るときは影響範囲つきの確認を出す。
- **テスト**：フォーム生成（組み込みコマンド全部で描画でき、既定値が `params` の zod を通る）、各画面のコンポーネントテスト（jsdom + Testing Library。`EditorSession` はモックせず、メモリのリポジトリの本物を使う）、`projectMapForEditor` / ヒットテスト / オーバーレイ、`startPlaytest`、E2E（`e2e/editor.spec.ts`：作成 → ドラッグで描画 → Undo/Redo → イベント作成と ShowText → 保存 → リロード → テストプレイでメッセージ、自動保存、データベースと削除の確認）。jsdom に無い `PointerEvent` / `Blob.arrayBuffer` / Canvas の `getContext` は `test-env.tsx` で補う。テストで `session` を直接操作するときは `act()` で包む。
- **未対応**：移動ルートの編集（対応するコマンドが M6）、テストプレイの音、タイルセットの追加・画像差し替え、アセットの一括インポート（ZIP は M6）、矩形選択ツール、キャンバスのスクロール位置を保った拡大、`doc` への代入を禁じる lint ルール（UI は `session.execute` 以外で文書を書き換えない — テストで確認）。

## 実装メモ（M6 で確定した点）
- **配布物の書き出し**（`ExportDialog`）：メニューバーの「配布物を書き出す…」。形式（フォルダ形式の ZIP / 単一 HTML）と「JSON を圧縮する」を選び、書き出す前に `session.save()` で未保存の変更を保存する（保存できなければ書き出さない）。`@rpg/exporter` の `exportGame` を、ストアの内容（`RepoContext` の `repo`）から呼ぶ。`EditorEnv` に `loadPlayerBundle()`（ブラウザでは同じオリジンの `player/player.js` を fetch）と `saveFile(name, bytes, mime)`（ダウンロード）を足した。エディタのビルド（`build-web.mjs`）は `apps/player` の `main.ts` を `dist-web/player/player.js` にもバンドルする。
- **コマンドリスト**：props を `onEdit(ops: CommandOp[])` に一本化した（挿入・削除・差し替えの列。複数なら `cmd.batch` で 1 回の Undo にまとめる）。`Loop` は `EndLoop` と、`ShowChoices` は選択肢の数だけの `ChoiceBranch` と `EndBranch` と一緒に入る。選択肢の数を増減すると、対になる `ChoiceBranch` も増減する（減らすときは余った分岐を本体ごと消す）。`Loop` の直後はループの中に入り、`Loop` / `ShowChoices` は丸ごと消える。`EndLoop` / `MoveStep`（内部用）は単独では追加も削除もできない。
- **移動ルートの編集**は、`SetMoveRoute` コマンドの標準フォーム（手順の配列。種類を選ぶ）で行う。専用のエディタは無い。ページの `moveRoute`（自律移動）は、イベントダイアログの「自律移動（ページが有効な間、勝手に動く）」で、「自律移動する」を入れると初期ルート（ランダムに 1 歩、60 フレーム待つ、を繰り返す）が付き、同じ標準フォームで手順・繰り返し・動けなければ飛ばすを編集する（外すと `moveRoute` を消す）。`e2e/editor.spec.ts` が、入れたイベントがテストプレイで動き出すことを確かめる。
- **未対応**：テストプレイの音、タイルセットの追加・画像差し替え、アセットの一括インポート（プロジェクト丸ごとの ZIP の読み込みは、後の「実装メモ（サンプルと、編集データの ZIP）」で一覧から呼べるようにした）、矩形選択、キャンバスのスクロール位置を保った拡大。

## 実装メモ（M7 で確定した点）
- **プラグイン**：システム設定に「プラグイン」タブ（ビルドに入っているプラグインの有効/無効、設定の JSON、入っていないプラグインの一覧と外す操作、読み込めなかったプラグインの表示）。`EditorEnv` は `PluginEnv`（`pluginCatalog` / `pluginDiagnostics` / `pluginForms` / `pluginFailures` / `createExtensions`）を持つ。`createBrowserEnv()` は非同期になった（プラグインの `register` が非同期でもよいため）。詳しくは 14。
- **書き出しダイアログ**に描画方式（自動 / WebGL / Canvas2D）とオフライン対応（フォルダ形式のみ）を追加。
- **保存先**：既定は IndexedDB、`?storage=opfs` で OPFS。File System Access API があるブラウザでは、プロジェクト一覧の「保存先：…」の横の「フォルダを選ぶ…」で利用者のフォルダに切り替えられる（`App` の `pickFolder` / `storageLabel`。選ぶのをやめた `AbortError` は無視し、他の失敗はメッセージに出す）。選んだフォルダはそのタブの間だけ有効で、リロードすると既定の保存先に戻る（`FileSystemDirectoryHandle` の永続化と権限の再確認は未実装）。`e2e/folder.spec.ts` は `showDirectoryPicker` を OPFS のフォルダを返すスタブにして確かめる。

## 実装メモ（イベントのコピー＆ペースト）
- **`MapCanvas`**：選んでいるイベントを Ctrl/⌘ + C（コピー）・X（切り取り）、カーソルのあるセルへ V（貼り付け）。貼ったイベントが選択される。キャンバスの下の「コピー / 切り取り / 貼り付け」ボタンでも同じ（貼り付け先は、最後にカーソルがあったセル。無ければ (0, 0)）。クリップボードの中身（イベント名）は横に出る。重なるセルへの貼り付けは、エディタのお知らせに出して何もしない。
- 編集の実体は `cmd.pasteEvent`（12）で、1 回の貼り付けが 1 回の Undo。テスト：`commands.test.ts`（複製・別マップ・エラー・Undo）、`MapCanvas.test.tsx`（キー・ボタン・重なり）、E2E `e2e/editor.spec.ts`。

## 実装メモ（イベント入力の手間を減らす）
コマンドを 1 行ずつ組み立てるときの手間を減らした。文書の形式（`EventCommand` の平らな列）とインタプリタは変えていない。
- **表示**：フォームのラベルを日本語に揃えた（出現条件・すり抜け・プライオリティ・オペランド など。`labels.ts`）。列挙の表示名は、値だけでは決まらないもの（`ControlVariables.op` の 代入（＝）/ 加算（＋）… と `ChangeParty.op` の 加える）をスキーマのメタデータ `.meta({ labels })` に持たせた。union の種類の見出しは、リテラルならその表示名（パーティ全員・キャンセルできない）、ID なら種類の名前（アクター）、ただの文字列なら「直接入力」。リテラルと列挙だけの union（`TransferPlayer.dir` の 向き | そのまま など）は 1 つの選択肢の一覧にまとめる。入力の問題は `conditions.0.id` ではなく「出現条件 1 ID：未設定です」のように出す（空のままの欄は「未設定です」）。
- **トリガの表示名**：`touch` は「プレイヤーから接触」、`eventTouch` は「イベントから接触」（RPG ツクールと同じ呼び方。`labels.ts`）。
- **分岐の行の見出し**：`ChoiceBranch` の行は、分岐の開始行のコマンドの `meta.branchLabel`（03）で「[はい] のとき」「勝ったとき / 逃げたとき / 負けたとき」と出す（開始行は `blockOwner`）。スイッチ・変数は、1 行表示でも名前があれば名前で出す（`ControlSwitches` / `ControlVariables` / `ConditionalBranch`）。
- **有効な初期値**：スキーマのメタデータ `.meta({ initial })` を、新しく作るときの初期値に使う（`.default()` より優先。検証には影響しない）。選択肢は「はい / いいえ」、スイッチの操作・条件分岐・出現条件のスイッチ/セルフスイッチは ON。条件分岐の種類は スイッチ / 変数 / 式 の順にし、既定をスイッチの条件にした。
- **追加を 1 手に**：コマンドを追加すると設定のフォームが開き、最初の欄にフォーカスが移る（文字の欄は中身を選択）。「コマンドの追加」の上の欄で名前・分類を絞り込み、Enter で先頭を追加する（IME の確定の Enter では追加しない）。追加したコマンドは「最近使ったもの」として上に出る（`EditorUiState.recentCommands`、6 件。文書には保存しない）。
- **文章をすぐ追加**：コマンドリストの下の欄。Enter で「文章の表示」を入れる（Shift+Enter で改行、IME の確定の Enter では入れない）。空行で区切ると別々の「文章の表示」になる（`splitMessages`）。選んでいる行の直後（分岐の開始行なら分岐の中）に入り、最後の 1 つが選ばれるので、続けて入れると後ろに並ぶ。1 回の追加は 1 回の Undo。入力欄の中のキーは行の操作（矢印・Delete / Backspace）にしない。
- **スイッチ・変数をその場で作る**：ID 欄の最後の「＋ 新しいスイッチ… / ＋ 新しい変数…」を選ぶと名前の欄が出て、Enter か「作成」で `sw_001` / `var_001` のような空いている連番で作り、そのまま選ぶ（`FormContext.newRef`）。作成は `session.execute(c, { groupWithNext: true })`（12）なので、作ったものを選んだフォームの確定と 1 回の Undo にまとまる。Esc か「やめる」で閉じる。
- **テスト**：`schema-form.test.tsx`（メタデータ・union の見出し・その場の作成）、`command-blocks.test.ts` / `templates.test.ts`（editor-core。`blockOwner` / `splitMessages`）、`EventDialog.test.tsx`（見出し・初期値とフォーカス・絞り込みと最近使ったもの・文章をすぐ追加・スイッチ/変数の作成と Undo・入力の問題の表示）、`session.test.ts`（`groupWithNext`）、`meta.test.ts`（名前での 1 行表示・`branchLabel`）、E2E `e2e/editor.spec.ts`（文章をすぐ追加 → 絞り込みで選択肢 → 分岐の中でスイッチを作成 → Undo/Redo → テストプレイで選んだ分岐のスイッチが入る）。
- **次の段階**：イベントのひな形（下の「実装メモ（イベントのひな形）」）、コマンドリストの並べ替え・コピー＆ペースト・複数選択（その下の「実装メモ（コマンドの並べ替え・コピー・複数選択）」）。

## 実装メモ（イベントのひな形）
よくあるイベントを、いくつかの項目を入れるだけで作れるようにした。ひな形の定義と作成のコマンドは editor-core（12 の「実装メモ（イベントのひな形）」）、プラグインからの追加は 14。
- **置き方**：ツールバーの「置くイベント」で、空のイベントか、ひな形（話しかける人・扉・場所移動・宝箱・商人・敵シンボル、プラグインのもの）を選ぶ（`EditorUiState.eventTemplate`。ひな形を選ぶとイベントツールになる）。ひな形を選んだまま空いたセルをクリック（キーボードでは Enter）すると `EventTemplateDialog` が開き、入力して「作成」でそのセルに置いて選ぶ（`cmd.createEventFromTemplate`。1 回の Undo で消える）。「作成して編集…」はそのままイベントの編集画面を開く。「やめる」・Esc では何も置かない。イベントのあるセルのクリックは、これまでどおり選ぶだけ。一覧は `useEventTemplates()`（組み込み + `EditorEnv.pluginEventTemplates`）。
- **入力フォーム**：ひな形の `input`（zod）から `SchemaForm` で作る。初期値は `defaultValue` に `template.initial(project)` を重ねたもの（話しかける人・商人の見た目は、歩行グラフィックらしい画像が最初から入る）。下書きは文書に入れず、zod を通らない間は「作成」を押せない（問題は `IssueList` でひな形の見出しを使って出す）。開いている間にセルがふさがったら、作成せずにメッセージを出す。
- **フォームのメタデータを追加**：`.meta({ title })`（見出し。無ければ `labels.ts` の共通の表示名）、`.meta({ description })`（欄の近くの補足。ひとかたまりの欄は見出しの直下、1 行の欄は欄の下）。どちらも皮（optional / default）の外と中のどちらに付けてもよい。入力の問題の場所（`issuePlace(path, spec)`）も `title` を使う。
- **場所をマップのクリックで選ぶ**：オブジェクトに `.meta({ location: true })`（`mapId` / `x` / `y`）か `.meta({ location: { map, x, y } })` を付けると、位置の欄の後ろにマップのプレビュー（`MapPicker`。`FormContext.renderLocation`）が付く。下にゲームと同じ描画（MapCanvas と共通の `useMapRenderer`）、上にグリッド・イベント・選んでいる位置の枠。クリックで x / y が決まり、矢印キーでも動かせる。大きなマップは 420×300 に収まるよう縮めて見せる。範囲の外の位置はそう表示する。付けたのは、扉のひな形の移動先、**場所移動（`TransferPlayer`）の params**、**システム設定の開始位置**（`startMap` / `startX` / `startY`）。
- **選択肢が無い ID 欄**（新しいプロジェクトのアイテム・敵グループなど）には、「まだアイテムがありません（メニューの「データベース」で追加できます）」のように、どこで作れるかを出す（その場で作れるスイッチ・変数には出さない）。
- **その他**：ページのグラフィックの向きの初期値を「下」に（`.meta({ initial: "down" })`）。`useFormContext` は `form-context.tsx` に移した（`MapPicker` がフックを使うので、`hooks.tsx` との循環を避ける）。
- **テスト**：`EventTemplateDialog.test.tsx`（「置くイベント」の一覧と切り替え・置き方・プレビューのクリックと矢印キー・やめる/Esc・入力の問題と案内・初期値・「作成して編集…」・Enter・ふさがったセル・プラグインのひな形）、`schema-form.test.tsx`（title / description / location のメタデータと表示・選択肢が無いときの案内）、`EventDialog.test.tsx`（場所移動の移動先をプレビューで選ぶ）、`dialogs.test.tsx`（開始位置をプレビューで選ぶ）、E2E `e2e/editor.spec.ts`（宝箱（お金）と扉（移動先をプレビューのクリックで選ぶ）を置き、テストプレイで手に入って扉で移動する）。
- **未対応**：ひな形の見た目の画像のプレビュー（番号は数字で選ぶ）、宿屋（全回復のコマンドが無い）、置いたあとのイベントをひな形の入力に戻して編集し直すこと（作られるのは普通のコマンド列）。

## 実装メモ（コマンドの並べ替え・コピー・複数選択）
コマンドリスト（`CommandList`。イベントのページ・コモンイベント・敵グループのページで共通）に、並べ替え・コピー・切り取り・貼り付け・範囲選択を足した。分岐・ループの構造は `meta.block`（03）にまとめ、構造を扱う関数は editor-core（12 の「実装メモ（コマンド列の構造の操作）」）に移した（以前の `command-templates.ts` は無くなった。追加の一覧は `isPart` で区切り・終端・内部用を除く）。
- **選択**：クリックか矢印で 1 行。**Shift+クリック / Shift+↑↓** で、選んでいた行からの範囲（連続した行だけ。離れた行を Ctrl+クリックで足すことはできない）。範囲が分岐の開始・区切り・終端にかかると、ブロックを切らないよう分岐全体まで広がる。**1 行だけ選んでいるとき**は、開始の行ならブロック全体が操作の対象になり、ブロックの行が薄く示される（`in-block`。選択そのものは開始の行だけなので、ここに追加・貼り付けするとブロックの中に入る、という従来の動きは変わらない）。区切り・終端の行だけを選んでいるときは、削除・並べ替え・コピー・切り取りはできない（貼り付けはできる）。範囲選択中は設定フォームは開かず、Enter も効かない。リストは `aria-multiselectable`、行数と「クリップボード：N 行」は `role="status"` で読み上げる。
- **並べ替え**：「↑ 上へ」「↓ 下へ」か **Alt+↑ / Alt+↓**。同じ本体の中の 1 つ前・後と入れ替わり（相手が分岐ならブロックを丸ごと飛び越える）、選択も追従する。本体の先頭・末尾や区切り・終端は越えず、ボタンは無効になる（別の分岐へは切り取り→貼り付け）。1 回の操作が 1 回の Undo（見出し「コマンドの移動」）。ドラッグ＆ドロップは無い。
- **コピー・切り取り・貼り付け**：「コピー」「切り取り」「貼り付け」か **Ctrl/⌘+C・X・V**。選んでいる行（範囲・ブロック）を `EditorUiState.commandClipboard`（12）に入れる。字下げは 0 始まりで、貼るときに場所の字下げに合わせる。**貼り付け**は選んでいる行の直後（開始の行・区切りの行ならブロックの中、終端の行ならその後ろ。範囲選択なら範囲の後ろ。何も選んでいなければ末尾）で、貼った行が選ばれる。イベントのページ・別のイベント・コモンイベントにも貼れる（セッションの中だけ。OS のクリップボードは使わない）。Undo の見出しは「コマンドの切り取り」「コマンドの貼り付け」。入力欄（設定フォーム・文章をすぐ追加）の中のキーは行の操作にしない。Shift / Alt を伴う C・X・V は何もしない。
- **`onEdit(ops, label?)`**：`CommandList` の編集は操作（挿入・削除・差し替え）の並びで親に渡す。`label` があれば（移動・貼り付け・切り取り）複数の操作を 1 回の Undo にまとめて、その見出しにする（`EventDialog`）。コモンイベントなどは `applyOps` で適用する（`DatabaseDialog`）。
- **分岐の見出しと区切りの数**：`branchHeading` は `divider` 役のコマンドの行すべてに効く（`params.index` があれば開始の行の `branchLabel` を使う）。設定フォームの確定で、開始の行の区切りの数が変わったら（選択肢の数など）`syncDividers` で合わせる（以前は `ShowChoices` だけ）。
- **テスト**：`CommandList.test.tsx`（並べ替え・端・Alt+矢印・範囲選択・分岐への広がり・コピー / 切り取り / 貼り付け・ページをまたぐ・区切りの行・入力欄のキー）、`plugins.test.tsx`（プラグインの分岐コマンド）、`dialogs.test.tsx`（コモンイベントの並べ替え・コピー）、E2E `e2e/editor.spec.ts`（並べ替え → Shift+↓ で範囲 → コピー → 貼り付け → Alt+↑ → Undo → テストプレイで並べ替えた順）。
- **未対応**：ドラッグ＆ドロップでの並べ替え、離れた行の複数選択（Ctrl+クリック）、すべて選択（Ctrl+A）、ブロックをまたぐ移動（別の分岐の中へ動かす）、別のブラウザ・プロジェクトへのコピー（OS のクリップボード）、貼り付けたブロックの構造の検証（クリップボードに入るのはブロックを切らない範囲だけなので、いつも閉じている）。

## 実装メモ（サンプルと、編集データの ZIP）
デモのゲームを、エディタで中身を見て作り変えられるサンプルにした。編集データの ZIP は project-store の `exportZip` / `importZip`（10）をそのまま使う。
- **サンプルの同梱**：エディタのビルド（`scripts/build-web.mjs`）が、`tools/build-demos.mjs` の `DEMOS`（はじまりの村・地下迷宮・バトルタワー・謎解きの館・おばけ屋敷の追いかけっこ。デモを選ぶページと同じ一覧・タイトル・説明・タグ・画面写真）の編集データを `samples/<id>/`（`fixtures/projects/v1/<name>` の project.json + maps/ + assets/ をそのまま）に、画面写真を `samples/<id>.png` に置き、一覧 `samples/index.json`（id・タイトル・説明・タグ・画面写真・ファイルの一覧）を書く。サイト（`tools/build-site.mjs`）では `editor/samples/` になる。
- **`EditorEnv`**：`listSamples(): Promise<ProjectSample[]>`（一覧。無ければ空）と `loadSample(id)`（編集データを `importZip` で読める ZIP のバイト列にして返す）を足した。ブラウザでは `createSampleSource("samples/")`（`browser-env.ts`）が、`index.json` を取り（404 ならサンプルは無い。失敗したら次に呼んだときに取り直す）、サンプルのファイルを取って `writeZip` でまとめる。取り込みは UI が `repo.importZip` で行うので、保存先（IndexedDB / OPFS / 選んだフォルダ）を選ばない。
- **プロジェクト一覧**（`ProjectList`）：「サンプルから作る」（画面写真・タイトル・説明・タグのカード。「このサンプルから作る」で取り込んで、そのまま開く。サンプルが無ければ節ごと出さない）、「ZIP から読み込む…」（ファイルを選ぶと `importZip` で新しいプロジェクトにして開く）、プロジェクトごとの「ZIP」（`exportZip` の結果を `<タイトル>.zip` で `saveFile`）。取り込みは新しい ID になるので、同じサンプルを何度取り込んでもよい。取り込み中はほかの取り込みを押せない。失敗は理由（ZIP の中身の問題なら最初の 1 つ）を出し、一覧に留まる。
- **テスト**：`samples.test.tsx`（すべてのデモの fixture を ZIP にして取り込むと、マップ・アセットごと同じ内容の新しいプロジェクトとして開く。サンプルが無いとき・読めないとき。ZIP の書き出し → 読み込み、壊れた ZIP、書き出しの失敗。`createSampleSource` の一覧・ZIP・404・欠けたファイル・取り直し）、`tools/build-site.test.ts`（`editor/samples/` に全デモの編集データがある）、E2E `e2e/samples.spec.ts`（画面写真つきで並ぶ → 地下迷宮から作ってテストプレイで第 1 の間に立つ。はじまりの村から作って ZIP に書き出し、別実装の unzip で中身を確かめて、読み込み直す）。ヘッドレスの Chromium は ASCII 以外のダウンロードのファイル名を "download" にするので、E2E ではファイル名を確かめない。
