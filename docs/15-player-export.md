# 15. `@rpg/player`（apps/player） — 配布用シェルとエクスポータ

## 責務
- プレイヤー向けの最小 HTML シェル。`runtime` に本番アダプタを結線して起動する。
- エクスポータ：エディタのプロジェクトから配布物を生成する。
  - **フォルダ形式**：`index.html` + `player.js` + `project/`（JSON）+ `assets/`。静的ホスティング用。
  - **単一 HTML 形式**：すべてを base64 埋め込み（`createEmbeddedBytesSource`）。メール等で配れる。
- ローディング画面、エラー画面、音声解禁のためのタップ待ち画面。
- オプション：Service Worker によるオフライン化（フォルダ形式のみ）。

## 非責務
- ゲームの実行ロジック。→ `runtime`
- プロジェクトの保存。→ `project-store`（`exportZip` を利用）

## 依存が許されるパッケージ
`@rpg/runtime`, `@rpg/plugin-api`, `@rpg/schema`, 任意のアダプタ。エクスポータは `@rpg/project-store`（ポート型）。

## 公開インターフェース
```ts
// シェル
export interface PlayerConfig {
  projectUrl?: string;                           // フォルダ形式：project/project.json
  embedded?: { project: unknown; maps: Record<MapId, unknown>; assets: Record<AssetId, string> };
  renderer?: "canvas2d" | "webgl" | "auto";
  plugins?: PluginModule[];
  saveScope?: string;                            // 同一オリジンで複数ゲームを配るときの分離キー
}
export async function bootPlayer(root: HTMLElement, config: PlayerConfig): Promise<Runtime>;

// エクスポータ（エディタ内で実行）
export interface ExportOptions { format: "folder" | "singleHtml"; renderer: PlayerConfig["renderer"]; offline?: boolean; minifyJson?: boolean }
export async function exportGame(repo: ProjectRepository, projectId: string, opts: ExportOptions): Promise<Blob>;   // ZIP または HTML
```

## 実装指針
- `bootPlayer` の結線：
  - `renderer: "auto"` は WebGL 対応かつ `render-webgl` がバンドルされていれば webgl、それ以外 canvas2d。
  - `saves: createSaveRepository({ projectId, projectHash, ... })`。`projectHash` は `project.json` のハッシュ。
  - `input: createBrowserInput(window, { touch: { canvas } })`。
  - `audio`: `AudioContext` は初回ユーザー操作で生成。
- ローディング：`assets.preload` にシステム・タイトル画面・開始マップのアセットを渡し進捗表示。
- エラー：`Runtime` の未捕捉例外はエラー画面へ。開発ビルドではスタックを表示。
- 単一 HTML：16 MB を超える場合は警告し、フォルダ形式を推奨する。
- ハッシュ付きファイル名でキャッシュ制御（`assets/<id>.<ext>` は不変なので `Cache-Control: immutable` 推奨、README に記載）。

## 不変条件
1. エクスポートした配布物は `apps/editor-ui` で動いたテストプレイと同じリプレイ結果を生む（プロジェクトハッシュが一致する）。
2. 単一 HTML 形式は外部リクエストを一切行わない。
3. `saveScope` が異なれば同一オリジンでもセーブが混ざらない。

## テスト要件
- エクスポータ：`fixtures/projects/v1/minimal` を両形式でエクスポートし、生成物の構造を検証（ZIP エントリ一覧、HTML 内の埋め込み JSON がパースできる）。
- Playwright：フォルダ形式を静的サーバで配信し、タイトル → 開始 → 歩行 → セーブ → リロード → ロード。単一 HTML を `file://` で開き同じシナリオ（ネットワークリクエスト 0 件を検証）。
- `renderer: "auto"` のフォールバック（WebGL を無効化した Playwright コンテキスト）。

## 完了条件
- 両形式のエクスポートが E2E を通る。
- ローディング/エラー/タップ待ち画面が実装されている。

## 実装メモ（M2 で確定した点）
- **実装範囲**：フォルダ形式の起動（`bootPlayer`）のみ。エクスポータ（`exportGame`）、単一 HTML、`renderer: "webgl" | "auto"`、`plugins`、`saveScope`、Service Worker、タップ待ち画面は後続。`PlayerConfig` は `{ projectUrl, assetsUrl?, debug? }`。
- **配布物の形**：`index.html` + `player.js` + `project/project.json` + `project/maps/<MapId>.json` + `assets/<AssetId>.<ext>`。アセットは `projectUrl` の隣の `../assets/`（`assetsUrl` で変更可）。
- **結線**：`createHttpProjectSource` → `createAssetSource(createHttpBytesSource)` → 開始前に `collectStartAssets`（タイルセット画像・アクターの歩行/顔・開始マップのイベントの絵）を `preload`（進捗表示）→ `createCanvas2dRenderer`（2 倍表示、`image-rendering: pixelated`）+ `createBrowserInput(window, { gamepad: true })` + `createNullAudioOut()`（音は M4）+ `createRafScheduler()`。`seed` は `Date.now()`。
- `createHttpProjectSource(projectUrl)`：`project.json` は一度だけ取得して検証し、`projectHash` はそのバイト列の sha256（hex）。マップはプロジェクトに登録された ID だけを `maps/<id>.json` から取得し、取得済みは覚えておく（失敗は覚えない）。
- **画面**：読み込み中（`role="status"`）と、失敗時のエラー画面（`role="alert"`、`debug` のときスタックも）。`Runtime` の `onError` もエラー画面へ。
- **ビルド**：`node apps/player/scripts/build-web.mjs [--project <dir>] [--out <dir>]` が esbuild で `player.js` を作り、`static/index.html` と（指定があれば）プロジェクトのフォルダをコピーする。出力の既定は `apps/player/dist-web/`（git 管理外）。`pnpm demo` でデモを配信（http://127.0.0.1:4173/）。エントリ（`main.ts`）は `?project=<url>` と `?debug` を受け、起動した Runtime を `window.__rpg` に置く（E2E とデバッグ用）。
- **M3 の変更**：`PlayerConfig` に `saveScope?`（同じオリジンで複数のゲームを配るとき、IndexedDB の DB 名 `rpg-saves-<scope>` と localStorage の接頭辞 `rpg-save-<scope>` に反映して保存先自体を分ける）を追加。`saves = createSaveRepository({ projectId: project.meta.id, projectHash })`（`projectHash` は `project.json` のバイト列の sha256）、`clock: Date.now` を Runtime に渡す。**タイトル画面から始まる**（`title` の既定が `true`）。キー操作は既定の割り当て（決定 = Z/Enter/Space、キャンセル = X/Esc、メニュー = M）。
- **E2E**（`e2e/player.spec.ts`）：Playwright の `webServer` が demo プロジェクト付きでビルドして `tools/serve-static.mjs` で配信する。起動と描画のピクセル確認、歩行と壁での停止、会話（ウィンドウと文字の描画、2 ページ目）、扉でのマップ遅延ロード（リクエストの発行タイミング）、読み込み失敗のエラー画面。

## 実装メモ（M4 で確定した点）
- **音**：`bootPlayer` は `audio-webaudio` を結線した（08）。`AssetSource` に `decodeAudio` を渡し、開始前の事前読み込み（`collectStartAssets`）に**敵の絵とタイトル/戦闘の BGM** を加えた（戦闘の初回に読み込みで止まらないように）。`AudioContext` が無い環境では音声は読み込まない。
- **demo プロジェクト**：マップ `map_town` の (11,8) にスライム（話しかけると戦闘。勝てば `sw_slime_defeated` を立てて消え、逃げれば残る）、戦闘 BGM（8bit の短いループ WAV）、スキル「ファイア」、アイテム「ポーション」（スライムが確実にドロップ）を追加。アセットは `node tools/make-demo-assets.mjs`（PNG と WAV。ID は内容のハッシュ）で生成する。
- **E2E**（`e2e/player.spec.ts`）：話しかけて戦闘 → 攻撃で勝利 → マップに戻って続きのイベント（画面のピクセル・報酬・Effect を確認）、逃走してもう一度戦う、戦闘中はメニューが開かずスキルで戦える。

## 実装メモ（M6 で確定した点）
- **エクスポータは新しいパッケージ `@rpg/exporter`**（`schema` と `project-store` にだけ依存。`editor-ui` が import できる。`apps/player` に置くと、エディタから読めない — アプリ同士は import できない — ため）。`exportGame(repo, projectId, { format, minifyJson?, warnAboveBytes? }, { js })` は `Result<{ bytes, mime, fileName, warnings }, ProjectStoreError>` を返す（`Blob` ではなくバイト列）。プレイヤー本体（`player.js` のソース）は呼び出し側が渡す。ストアに保存されている内容から作る（`load` を通るので検証・マイグレーション済み）。
- **フォルダ形式（ZIP）**：`index.html` / `player.js` / `project/project.json` / `project/maps/<MapId>.json` / `assets/<AssetId>.<ext>` / `README.txt`（置き方とキャッシュ：`assets/` は `Cache-Control: public, max-age=31536000, immutable` をすすめる）。`assets/` の拡張子はプレイヤーの `createHttpBytesSource` と同じ規則（名前の拡張子 → MIME → `bin`）。バイト列が無いアセットは警告して含めない。
- **単一 HTML**：`<script type="application/json" id="rpg-embedded">`（`{ project, maps, assets(base64), projectHash }`。`<` と行区切り文字は `\u` 形式にエスケープ）と、インラインの `<script type="module">`（`player.js`。`</script` と `<!--` はエスケープ）。favicon は `data:,` で、外部のファイルは一切読まない。16 MB（`warnAboveBytes`）を超えたら警告してフォルダ形式をすすめる。`projectHash` はフォルダ形式の `project.json` のバイト列の sha256 と同じ値（[inv-1] のテストがある）。`minifyJson: false` は `project.json` / マップの整形だけに効く。
- **`bootPlayer`**：`PlayerConfig` は `{ projectUrl?, embedded?, assetsUrl?, debug?, saveScope? }`（`projectUrl` か `embedded` のどちらか）。`embedded` があれば `createEmbeddedProjectSource`（検証は HTTP 版と同じ）と `createEmbeddedBytesSource`（09）を使い、通信しない。エントリ `main.ts` は `#rpg-embedded` があればそれで起動する（JSON が壊れていればエラーを表示）。
- **E2E**（`e2e/export.spec.ts`）：エディタで新規作成 → イベントを置く → 「配布物を書き出す…」でフォルダ形式と単一 HTML をダウンロード。ZIP は別実装（テスト内の最小の unzip）で構造を確かめ、**別のオリジン（ランダムなポートの静的サーバ）**で配信して、タイトル → 開始 → 話しかける → セーブ → リロード → コンティニュー → 歩く。単一 HTML は `file://` で同じシナリオを遊び、**リクエストがすべて `file://` / `data:` / `blob:` であること**を確かめる。
- **未対応**：`renderer`（`webgl` / `auto`）と `plugins`（M7）、Service Worker によるオフライン化（M7）、ローディングのタップ待ち画面（音声の解禁。`AudioContext` は最初の入力で生成する現状の作りのまま）、`saveScope` を書き出しの設定にすること（`project.meta.id` ごとにセーブが分かれるので、既定では混ざらない）。

## 実装メモ（M7 で確定した点）
- **`renderer`**：`PlayerConfig.renderer?: "canvas2d" | "webgl" | "auto"`（既定 `auto`）。`auto` は `isWebglAvailable()` が真なら WebGL、偽なら Canvas2D。`main.ts` は `?renderer=` か `#app` の `data-renderer`（書き出しが埋める）から決める。選ばれた方式は `<canvas data-renderer>` に出る。`webgl` を明示して使えなければエラー画面。WebGL のときの `preserveDrawingBuffer` は `?debug` のときだけ（ピクセルを読むため）。
- **エクスポータ**：`ExportOptions` に `renderer`（既定 `auto`。`data-renderer` になる）と `offline`（フォルダ形式のみ。単一 HTML では無効にして警告）を追加。エディタの書き出しダイアログに描画方式とオフラインの選択がある。
- **オフライン（Service Worker）**：`offline: true` で `sw.js` を同梱し、`index.html` に登録のスクリプトを入れる。`sw.js` は install で全ファイル（と `./`）をキャッシュへ入れ、activate で古い `rpg-` キャッシュを消し、GET・同一オリジンの取得をキャッシュ優先（無ければネットワーク）で返す。**キャッシュ名は配布物の全ファイルの内容ハッシュ**から決めるので、ゲームを置き直せば別のキャッシュになる。E2E `e2e/offline.spec.ts`：別オリジンで一度開いて有効にし、**サーバを止めてネットワークも切った**状態でリロードしても、タイトル → ニューゲームまで動く。
- **プラグイン**：`PlayerConfig.plugins`（09 ではなく 14）。単一 HTML でも同じ（プレイヤーに同梱したカタログから、`system.plugins` のものを読み込む）。
- **E2E**：`e2e/webgl.spec.ts`（demo を WebGL と Canvas2D で動かしてタイトル・マップの見た目を比べる。`--disable-3d-apis` のブラウザで `auto` が Canvas2D になり、`webgl` の明示はエラー画面）。ピクセルを 2D コンテキストから読む既存のプレイヤーの E2E は `?renderer=canvas2d` を指定するようにした。
- **未対応**：ローディングのタップ待ち画面（音声の解禁）、`saveScope` を書き出しの設定にすること。

## 実装メモ（GitHub Pages への公開）
- **公開先**：https://www.buko106.tokyo/cc-rpg-maker/ 。`/` がランディングページ（`site/index.html`。画像は `site/img/`）、`/editor/` がエディタ、`/demo/` が demo プロジェクト付きのプレイヤー。
- **ビルド**：`pnpm build:site`（`tools/build-site.mjs`）が `site-dist/`（git 管理外）に、エディタ（`apps/editor-ui/scripts/build-web.mjs`）・プレイヤー（`apps/player/scripts/build-web.mjs --project fixtures/projects/v1/demo`）・`site/` をまとめて出力し、`.nojekyll` を置く。`pnpm site` はビルドして http://127.0.0.1:4175/ で配信する。
- **サブパスで動く条件**：どの HTML も `editor.js` / `project/project.json` / `player/player.js` のように**相対パス**だけで参照する（`/` 始まりを使わない）。`tools/build-site.test.ts` が、出力の HTML に絶対パスが無いことと、ランディングのリンク先が実在することを確かめる。
- **デプロイ**：`.github/workflows/pages.yml`。`main` への push と手動実行（`workflow_dispatch`）で、ビルド → `actions/upload-pages-artifact` → `actions/deploy-pages`。**初回だけ**、リポジトリの Settings → Pages → Source を「GitHub Actions」にする。独自ドメイン（`www.buko106.tokyo`）はアカウント側の設定で、このリポジトリに `CNAME` は置かない。
- **保存先の注意**：エディタのプロジェクト（IndexedDB `rpg-projects`）とデモのセーブ（`rpg-saves-*`）は**オリジン単位**で、パスでは分かれない。同じドメインの別サイトが同じ名前を使うと混ざる。

### 実装メモ（スマホ用の操作パッド）
- 主入力が指の端末（`matchMedia("(pointer: coarse)")`）では、ゲーム画面の下に操作パッド（十字キー・決定・キャンセル・メニュー）を出す。`bootPlayer` の `touchPad`（`auto` / `on` / `off`）、`?touch=on|off` で上書きできる。仕組みは docs/08 を参照。
- iOS 対策：矢印・☰ は記号文字だと絵文字に化けるので SVG で描く。ダブルタップ/ピンチでページが拡大されないよう、パッド上の `touchstart` / `touchmove` と `gesturestart` の既定動作を止め、viewport に `maximum-scale=1, user-scalable=no` も付ける（iOS の Safari は touch-action だけでは止めきれない）。実機での確認はまだ。
- 画面の幅だけでなく高さにも収まるように拡大率を決める（横向きのスマホでも、ゲーム画面が切れない）。`index.html` は `viewport-fit=cover` と `overscroll-behavior: none`（引っ張って更新を防ぐ）。書き出しのテンプレートも同じ。
