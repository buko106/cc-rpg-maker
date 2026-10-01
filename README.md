# cc-rpg-maker

ブラウザで動く RPGツクール風のゲーム制作ツールです。
マップやイベントを作る **エディタ** と、作ったゲームを遊ぶ **プレイヤー（ランタイム）** で構成します。

> **ステータス：M7（プラグイン・WebGL・仕上げ）完了。設計したマイルストーンはすべて完了**
> `@rpg/schema`・`@rpg/core`（戦闘を含む）に加えて `@rpg/runtime`（ゲームループ、FrameSpec 投影、遅延ロード、セーブ/ロードの仲介）と、
> Canvas2D 描画・キーボード入力・HTTP アセット読み込み・`@rpg/save-store`（IndexedDB / localStorage / メモリ）・`@rpg/audio-webaudio` のアダプタ、
> プレイヤー（`apps/player`）が動きます。タイトル画面から始めて、マップを歩き、イベントに話しかけ、メニュー（アイテム・ステータス・セーブ・ロード）から
> セーブしてリロード後に続きから再開でき、イベントから始まる戦闘（攻撃・スキル・アイテム・防御・逃走、状態異常、敵AI、経験値とドロップ）を BGM 付きで遊べます（`pnpm demo`）。
> エディタ（`apps/editor-ui`）で新しいゲームを作り、マップにタイルを描き、イベントやデータベースを編集し、保存して、そのままテストプレイできます（`pnpm editor`）。
> 全ての組み込みコマンド（選択肢・移動ルート・画面効果・購入と売却ができるショップ画面など）が使え、エディタの「配布物を書き出す…」から、フォルダ形式（ZIP）と単一 HTML の配布物を作れます（別のオリジンの静的サーバでも `file://` でも遊べます）。
> プラグイン（`@rpg/plugin-api`。独自コマンド・式関数・戦闘ルール・HUD など。サンプルは `@rpg/plugin-samples`）がプレイヤーとエディタの両方で動き、
> 描画は WebGL（`@rpg/render-webgl`）と Canvas2D を選べ（`auto` は WebGL が使えなければ Canvas2D）、フォルダ形式の配布物は Service Worker でオフラインでも遊べます。
> プロジェクトの保存先は IndexedDB のほか、OPFS / 利用者が選んだフォルダ（File System Access API。一覧の「フォルダを選ぶ…」）も使えます。
> エディタのプロジェクト一覧の「サンプルから作る」で、デモ（はじまりの村・地下迷宮・バトルタワー）の編集データを新しいプロジェクトとして取り込んで、中身を見たり作り変えたりできます。
> 編集データは一覧の「ZIP」で書き出し、「ZIP から読み込む…」で取り込めます（バックアップや、別のブラウザへの持ち運び）。
> 設計は [`docs/`](./docs/) にあります。

**公開中**： [ランディング](https://www.buko106.tokyo/cc-rpg-maker/) / [エディタ](https://www.buko106.tokyo/cc-rpg-maker/editor/) / [デモ](https://www.buko106.tokyo/cc-rpg-maker/demo/)（村のデモと迷宮のデモから選べます。`main` に入るたびに GitHub Pages へ自動で公開します）

## 作るもの

### エディタ（`apps/editor-ui`）
- マップ編集：タイル描画、塗りつぶし、レイヤ、イベント配置（Ctrl/⌘ + C・X・V でイベントのコピー・切り取り・貼り付け。別のマップにも貼れる）
- イベント編集：ページ条件、コマンドリスト。コマンドの入力フォームはスキーマから自動生成
- データベース編集：アクター、職業、スキル、アイテム、敵、敵グループ、コモンイベント
- システム設定、アセット管理（ドラッグ＆ドロップでインポート）
- Undo/Redo、自動保存、参照切れなどの診断
- テストプレイ（本番のセーブデータには書き込まない）

### プレイヤー（`apps/player`）
- マップ歩行、メッセージ表示、選択肢、ターン制戦闘、メニュー、セーブ/ロード（別のデータの上書きや、セーブしていない進行を捨てるロードの前には確認ダイアログが出る）
- キーボード、ゲームパッド、タッチ（スマホでは操作パッドが自動で出る）で操作
- 配布形式は2種類
  - **フォルダ形式**：静的ホスティング用。Service Worker でオフライン化もできる
  - **単一 HTML 形式**：アセットをすべて埋め込み、外部リクエストなしで動く

### プラグイン
コマンド、式の関数、戦闘ルール、描画の後処理（HUD など）、エディタのフォームを追加できます。

## 設計の柱

1. **ヘキサゴナル（ポート＆アダプタ）**：依存の向きは `schema → core → runtime → adapters/apps` です。`core` と `schema` はブラウザ API を import しません。
2. **決定論**：乱数、時刻、入力はすべて外から注入します。シードと入力列が同じなら、ゲーム状態も同じになります。この性質を使って、リプレイをゴールデンテストにします。
3. **永続化を2つに分ける**：ゲーム定義（`ProjectRepository`）とプレイ状態（`SaveRepository`）は、別パッケージ・別契約です。
4. **描画は FrameSpec 経由**：エンジンは「何を描くか」を純データ（`FrameSpec`）として出力します。「どう描くか」は Renderer アダプタ（Canvas2D / WebGL）が担当します。

## アーキテクチャ

```
┌───────────────────────────────────────────────────────────────────┐
│  apps      : editor-ui (React)            player (配布シェル)        │
├───────────────────────────────────────────────────────────────────┤
│  editor-core   exporter   runtime (ループ / シーン / FrameSpec 投影)│
├───────────────────────────────────────────────────────────────────┤
│  adapters  : render-canvas2d / render-webgl / render-null           │
│              audio-webaudio / audio-null                            │
│              input-browser / input-script                           │
│              project-store (idb, opfs, fsa, memory)                 │
│              save-store (idb, localStorage, memory)                 │
│              assets (http, opfs, zip, embedded, memory)             │
├───────────────────────────────────────────────────────────────────┤
│  core      : GameState / Interpreter / Battle / Expression          │
├───────────────────────────────────────────────────────────────────┤
│  schema    : Project 型 / zod / migrations                          │
└───────────────────────────────────────────────────────────────────┘
      依存は常に下向き。adapters は上位パッケージのポート型だけに依存する。
```

依存ルールは lint で検査し、違反はビルドエラーにします。詳細は [`00-principles.md`](./docs/00-principles.md) にあります。

## リポジトリ構成（予定）

```
/
├── docs/           設計ドキュメント
├── packages/       schema, core, runtime, 各アダプタ, editor-core, plugin-api, test-utils
├── apps/           editor-ui, player
└── fixtures/       サンプルプロジェクト、リプレイ、マイグレーション用データ
```

## 技術スタック

| 用途 | 採用するもの |
|---|---|
| 言語 / モノレポ | TypeScript（strict）、pnpm workspace |
| スキーマ | zod |
| テスト | Vitest、fast-check、Playwright |
| エディタ UI | React 18、Zustand、CSS Modules |
| 描画 | Canvas2D、WebGL（PixiJS v8） |
| 音声 | Web Audio API |
| 保存先 | IndexedDB、OPFS、File System Access API、localStorage |

## 設計ドキュメント

各ドキュメントは「1パッケージ分の実装に、そのドキュメント1本を読むだけで着手できる」粒度で書いています。

1. 最初に [`00-principles.md`](./docs/00-principles.md)（全体ルール）を読む
2. 次に担当パッケージのドキュメントを読む
3. テストの書き方は [`16-testing.md`](./docs/16-testing.md) を読む

一覧は [`docs/README.md`](./docs/README.md) にあります。

| 分類 | ドキュメント |
|---|---|
| 全体 | [00 原則](./docs/00-principles.md) · [16 テスト戦略](./docs/16-testing.md) · [17 マイルストーン](./docs/17-milestones.md) |
| データ・ゲームロジック | [01 schema](./docs/01-schema.md) · [02 core 状態](./docs/02-core-state.md) · [03 インタプリタ](./docs/03-interpreter.md) · [04 戦闘](./docs/04-battle.md) · [05 式言語](./docs/05-expression.md) |
| 実行環境 | [06 runtime](./docs/06-runtime.md) · [07 描画](./docs/07-render.md) · [08 音声・入力](./docs/08-audio-input.md) · [09 アセット](./docs/09-assets.md) |
| 永続化 | [10 project-store](./docs/10-project-store.md) · [11 save-store](./docs/11-save-store.md) |
| エディタ・配布 | [12 editor-core](./docs/12-editor-core.md) · [13 editor-ui](./docs/13-editor-ui.md) · [14 プラグイン](./docs/14-plugin-api.md) · [15 プレイヤー・エクスポート](./docs/15-player-export.md) |

## ロードマップ

| # | 内容 | 目安 | 完了条件 |
|---|---|---|---|
| M0 ✅ | 基盤（モノレポ、CI、依存ルール lint） | 1〜2週 | 依存ルール違反を検出できる |
| M1 ✅ | schema + core の骨格、式言語、基本コマンド | 2〜3週 | リプレイフィクスチャ 3 本が通る |
| M2 ✅ | runtime + 最小プレイヤー | 2〜3週 | ブラウザでマップを歩き、メッセージが出る |
| M3 ✅ | セーブ + メニュー | 1〜2週 | セーブ → リロード → ロードで同じ位置から再開できる |
| M4 ✅ | 戦闘 | 2〜3週 | ブラウザで戦闘できる |
| M5 ✅ | エディタ | 3〜4週 | 新規作成 → 描画 → イベント作成 → 保存 → テストプレイ |
| M6 ✅ | 全コマンド、エクスポート | 2〜3週 | 作ったゲームを配布物にして遊べる |
| M7 ✅ | プラグイン、WebGL、仕上げ | 2〜3週 | プラグインが両アプリで動く |

詳細は [`17-milestones.md`](./docs/17-milestones.md) にあります。

## 開発

必要なもの：Node.js 22 以上、pnpm 10（`corepack enable` で `packageManager` の版が使えます）。

```sh
pnpm install
pnpm build          # 全パッケージを tsc -b でビルド（パッケージごとの lib / 参照制約つき）
pnpm typecheck      # テストを含む全体の型検査
pnpm test           # 単体・プロパティ・契約・リプレイ・スナップショット（Node）
pnpm test:coverage  # 上記 + カバレッジ閾値（schema / core 90%、他の実装済みパッケージ 70%）
pnpm test:browser   # Playwright（Chromium。E2E）。プレイヤー（demo 付き）とエディタをビルドして配信する
pnpm demo           # デモ（はじまりの村・地下迷宮・バトルタワー）と選ぶページをビルドして http://127.0.0.1:4173/ で配信（矢印/WASD で移動、Z/Enter/Space で決定）
pnpm editor         # エディタをビルドして http://127.0.0.1:4174/ で配信（プロジェクトはブラウザの IndexedDB に保存）
pnpm site           # 公開するサイト（ランディング + editor/ + demo/）をビルドして http://127.0.0.1:4175/ で配信
pnpm lint:deps      # 依存ルール検査（dependency-cruiser + package.json 検査）
```

依存ルールの許可関係は [`tools/dependency-rules.cjs`](./tools/dependency-rules.cjs) が単一情報源です。
[`00-principles.md`](./docs/00-principles.md) の依存ルールを変えるときは、このファイルも同時に更新してください。

## ライセンス

[Apache License 2.0](./LICENSE)
