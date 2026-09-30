# 17. 実装順序とマイルストーン

各マイルストーンは「動くもの」を基準に区切る。先行マイルストーンの完了条件を満たしてから着手する。

## M0: 基盤（1〜2週）
- モノレポ、TypeScript strict、Vitest、Playwright、依存ルール lint、CI。
- `test-utils` の骨格（`manualScheduler`, 空の契約スイート）。
- **完了条件**：空パッケージが全部ビルドされ、依存違反が検出できる。

## M1: Schema + Core の骨格（2〜3週）
- 01：`Project`/`MapData` 型、zod、`fixtures/projects/v1/minimal`。
- 02：`Random`, `GameState`, `step`, 移動・衝突、Snapshot。
- 05：式言語（04 の前提）。
- 03：インタプリタ骨格 + `ShowText`, `ControlSwitches`, `ControlVariables`, `ConditionalBranch`, `Wait`, `TransferPlayer`。
- **完了条件**：`interpreterHarness` で上記コマンドが動く。リプレイフィクスチャ 3 本。

## M2: Runtime + 最小プレイヤー（2〜3週）
- 06：ループ、マップシーン投影、メッセージ投影、Effect 分配。
- 07：`render-null`, `render-canvas2d`。08：`input-script`, `input-browser`, `audio-null`。09：`memory`, `http`。
- 15：`bootPlayer` の最小形（フォルダ形式、手作り `project/`）。
- **完了条件**：ブラウザでマップを歩き、イベントに話しかけてメッセージが出る。FrameSpec スナップショットあり。

## M3: セーブ + メニュー（1〜2週）
- 11：`memory`, `idb`, `localStorage` + 契約テスト。
- 06/02：タイトル・メニュー（アイテム/ステータス/セーブ/ロード）を GameState 内 UI として実装。
- **完了条件**：セーブ → リロード → ロードで同じ位置から再開。

## M4: 戦闘（2〜3週）
- 04：`BattleState`, 解決, 敵AI, 報酬。03：`BattleProcessing`。06：戦闘シーン投影。08：`audio-webaudio`。
- **完了条件**：`fixtures/replays/battle-*.json` が通り、ブラウザで戦闘できる。
- **状況**：完了。ランダムエンカウント・トループのイベントページ・戦闘アニメーション・メニューからのアイテム使用・オートセーブは後続（04・11 の実装メモ）。

## M5: エディタ（3〜4週）
- 10：`memory`, `idb` + 契約テスト。09：`opfs`, `zip`。
- 12：全コマンドファクトリ、Undo/Redo、validate、自動保存。
- 13：マップキャンバス、イベントエディタ（CommandForm 自動生成）、データベース、テストプレイ。
- **完了条件**：13 の E2E（新規作成 → 描画 → イベント → 保存 → テストプレイ）。
- **状況**：完了（`e2e/editor.spec.ts`）。`exportZip` / `importZip`・`opfs` / `fsa` のリポジトリ・移動ルートの編集・テストプレイの音は後続（10・13 の実装メモ）。

## M6: 残りのコマンド・DB・エクスポート（2〜3週）
- 03：組み込みコマンド全実装（`commands-smoke.json`）。
- 15：エクスポータ（フォルダ・単一 HTML）。10：`exportZip`/`importZip`。
- **完了条件**：エディタで作ったゲームを配布物にして別オリジンで遊べる。
- **状況**：完了（`e2e/export.spec.ts`）。エクスポータは `@rpg/exporter`（15）。ページの `moveRoute`（自律移動）・専用のショップ画面・`opfs` / `fsa`・`renderer: "webgl"` / Service Worker は後続（M7 以降。03・15 の実装メモ）。

## M7: プラグイン・WebGL・仕上げ（2〜3週）
- 14：`PluginHost`、サンプルプラグイン 2 本。
- 07：`render-webgl` + ピクセル差分テスト。
- 10：`fsa` アダプタ。15：Service Worker オフライン化。
- **完了条件**：プラグインが両アプリで動き、WebGL/Canvas2D が同等出力。
- **状況**：完了。`e2e/plugins.spec.ts`（プラグインがエディタのテストプレイと書き出したゲームの両方で動く）、`e2e/render.spec.ts`（WebGL と Canvas2D の差が 1% 以内）。`formatVersion` は 2（`system.plugins`）に上がり、最初の実マイグレーションが入った。プラグインの実行時ロード・ページの `moveRoute`・専用のショップ画面は後続（14・10・03 の実装メモ）。

## 後続候補（スコープ外）
- ランタイムの Web Worker 化（決定論設計により後付け可能）。
- 共同編集（`revision` 楽観ロックの上に CRDT を検討）。
- タイルの自動タイル（オートタイル）・アニメーションタイル。
- プラグインの iframe サンドボックス化。

## 各マイルストーンでのコーディングエージェント向け指示テンプレート
```
対象パッケージ: @rpg/<name>
読むべきドキュメント: docs/00-principles.md, docs/<nn>-<name>.md, docs/16-testing.md
依存先の公開インターフェース: docs/<mm>-<dep>.md の「公開インターフェース」節のみ
やること:
  1. 公開インターフェースをそのまま src/index.ts にエクスポートする（シグネチャを変えない）
  2. null/memory 実装（あれば）と契約テストを先に書く
  3. 不変条件ごとに [inv-n] テストを書き、実装する
  4. 完了条件を満たしたら pnpm test && pnpm lint:deps を通す
やらないこと: 依存ルール外の import、ポート型の変更（必要なら docs の変更を先に提案する）
```
