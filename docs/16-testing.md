# 16. テスト戦略と共通テストユーティリティ（`packages/test-utils`）

## 目的
- 「すべての仕様がテスト可能」を実現するための共通基盤を定義する。
- 各パッケージのドキュメントが参照する契約テスト・arbitrary・ハーネスの所在を定める。

## テストの層

| 層 | 対象 | ツール | 実行環境 |
|---|---|---|---|
| 単体 | 純粋関数（schema, core, runtime の投影, editor-core） | Vitest | Node |
| プロパティ | 不変条件 | fast-check | Node |
| 契約 | ポートの全アダプタ | Vitest + 契約スイート | Node（`fake-indexeddb`, jsdom）／ Playwright（OPFS, FSA, WebGL, WebAudio） |
| リプレイ | 決定論的な end-to-end（UI なし） | Vitest + `fixtures/replays` | Node |
| スナップショット | FrameSpec、CommandForm、マイグレーション結果 | Vitest snapshot | Node |
| ピクセル | Renderer 出力 | Playwright `toHaveScreenshot` | ブラウザ |
| E2E | エディタ・プレイヤーのユーザーシナリオ | Playwright | ブラウザ |

## `packages/test-utils` の内容

```
test-utils/src/
  arbitraries/
    schema.ts          ← Project, MapData, EventCommand, Database エンティティの fast-check arbitrary
    state.ts           ← GameState, InputFrame
    editorCommands.ts  ← 合法な EditorCommand 列（現在の doc に依存する生成）
  contracts/
    renderer.contract.ts
    audioOut.contract.ts
    inputSource.contract.ts
    assetBytesSource.contract.ts
    projectRepository.contract.ts
    saveRepository.contract.ts
  harness/
    manualScheduler.ts       ← advance(ms) で frame を駆動
    runtimeHarness.ts        ← null/script/memory アダプタで Runtime を組み立てる
    interpreterHarness.ts    ← コマンド列を与えて完了まで step する
    replay.ts                ← fixtures/replays/*.json の実行と最終状態ハッシュ比較
  fixtures.ts                ← fixtures/ 配下の読み込みヘルパ
```

### 契約テストの書き方
```ts
// contracts/saveRepository.contract.ts
export function saveRepositoryContract(name: string, make: () => Promise<SaveRepository>, opts: { supportsExport: boolean }) {
  describe(`SaveRepository contract: ${name}`, () => {
    it("write → read round-trips", async () => { ... });
    it("rejects corrupted payload", ...);
    ...
  });
}
// packages/save-store/src/idb.test.ts
saveRepositoryContract("idb", () => createIdbSaveRepository({ ... }), { supportsExport: true });
```
- 契約は**ポートを定義するパッケージ側のドキュメントの不変条件**を 1:1 で写す。契約に無い不変条件は存在しないものとみなす。

### リプレイフィクスチャ
```json
{
  "project": "fixtures/projects/v1/minimal",
  "seed": "abc",
  "inputs": [{ "hold": "right", "frames": 30 }, { "press": "ok" }, { "wait": 10 }],
  "expect": { "finalStateHash": "…", "effects": { "playSe": 2 } },
  "assertions": [{ "atTick": 30, "path": "map.player.x", "equals": 3 }]
}
```
- `replay.ts` が `inputs` を `InputFrame[]` に展開し、`runtimeHarness` で実行する。
- `finalStateHash` は `GameState` を安定ソート JSON 化した sha256。変更時は `UPDATE_REPLAYS=1` で更新し、差分をレビューする。

## テスト作成の規約
- **不変条件にはすべてテストがある**：各ドキュメントの「不変条件」節の番号をテスト名に含める（例：`it("[inv-3] step increments tick by exactly 1")`）。
- **null/memory アダプタを先に作る**：どのポートも、本番アダプタより先に null/memory 実装と契約テストを完成させる。
- **時間・乱数を固定する**：`Clock`/`Random`/`Scheduler` を注入し、`vi.useFakeTimers()` はアダプタ層のみで使う。
- **スナップショットは小さく**：FrameSpec のスナップショットは対象シーンの関連ノードのみを抽出して保存する。

## CI
- `pnpm test`：Node 層（単体・プロパティ・契約(Node)・リプレイ・スナップショット）。PR 必須。
- `pnpm test:browser`：Playwright 層。PR 必須（並列、Chromium のみ。Firefox/WebKit は nightly）。
- `pnpm lint:deps`：依存ルール検査。PR 必須。
- カバレッジ閾値：`schema`/`core` 90%、その他 70%。

## 実装メモ（M2 で確定した点）
- 契約スイートは Renderer / AudioOut / InputSource / AssetBytesSource が実装済み（ProjectRepository / SaveRepository は骨格のまま）。契約テストの `make` の形はポートごとに異なる（InputSource は操作口 `InputDriver`、AssetBytesSource は登録内容つきの `BytesSourceFixture`）。`test-utils` はアダプタ型に依存しないよう、必要な形を構造的に定義している。
- `runtimeHarness`（`createRuntimeHarness`）と、FrameSpec の要約 `summarizeFrame` を追加。
- カバレッジ閾値：`schema` / `core` は 90%（branches 85%）、実装済みのその他のパッケージ（runtime・assets・render-null・render-canvas2d・audio-null・input-script・input-browser）は 70%。
- ブラウザ層：`pnpm test:browser` は demo プロジェクトをビルドして静的サーバで配信する（`playwright.config.ts` の `webServer`）。

## 実装メモ（M4 で確定した点）
- **リプレイ**：`fixtures/replays/*.json` に任意の `"title": true` を追加した（`titleState` から始め、先頭の入力でニューゲームを選ぶ）。`battle-win.json`（歩いてスライムに話しかけ、攻撃とファイアで勝利、マップに戻って続きのイベント）と `battle-escape.json`。demo プロジェクトを使うので、demo の敵・トループの座標を変えたら `UPDATE_REPLAYS=1` で更新する。`runtime.test.ts` はリプレイを Runtime 経由でも実行して同じハッシュになることを確かめる。
- **戦闘のテストデータ**：`test-utils` の `battleProject()`（`minimal` に、勇者と魔法使い・スキル・アイテム・状態・敵・トループを足した、手計算しやすい固定値のプロジェクト。`mutate` で書き換えられる）と `battleKit()`（Ctx と初期状態）、`beginBattle` / `drive` / `driveUntil` / `press` / `idleFrames`。`autoBattle(state, ctx, policy)` は、作戦（味方ごとに行動と対象を選ぶ関数）の選んだ行動をメニューの十字キーと決定で入力して、戦闘が終わるまで進める（デモの通しプレイに使う。中身は `@rpg/bot` の `runBattle`）。敵の強さの見積もりは `@rpg/bot` の `simulateBattles` / `levelSweep`（試行は決定的なので、目安をそのままテストに書ける。20）。
- **プロパティテスト**：任意の入力列で HP/MP が範囲内・状態を変更しない（`deepFreeze`）・毎フレーム何かが進む・同じ入力で同じ結果。
- **カバレッジ閾値**：実装済みのパッケージに `audio-webaudio` を追加（70%）。
- **依存ルール（テスト）**：パッケージ自身を `@rpg/<自分>` の名前で import できない（解決できない依存として検出される）ので、同じパッケージのテストは相対パスで import する。

## 実装メモ（M5 で確定した点）
- **契約スイート**：ProjectRepository の契約（`projectRepositoryContract`）を実装した（骨格は無くなり、`registerContractSkeleton` は削除）。`memory` と `idb`（`fake-indexeddb`）が通る。`opfs` / `fsa` は M6 以降。
- **コンポーネントテスト**：`apps/editor-ui` の `*.test.tsx` は `// @vitest-environment jsdom`（ファイル単位）。依存ルールの「テストは test-utils を import できる」は `*.test.ts` と `*.test.tsx` の両方に適用する。Testing Library の `fireEvent` で操作し、外部ストアの更新（`session.execute` など）は `act()` で包む。
- **性質テスト**：`editorCommandArb(doc)`（test-utils）。生成器は `fc.filter` を使わず、先に候補を絞る（フィルタの述語が満たされないと無限に再試行して固まる）。
- **カバレッジ閾値**：`project-store` と `editor-core` を 70% の対象に追加（apps は対象外）。
- **E2E**：`pnpm test:browser` はプレイヤー（:4173、demo 付き）とエディタ（:4174）の 2 つの静的サーバを起動する。エディタの E2E は各テストの前に IndexedDB を消す。

## 実装メモ（M6 で確定した点）
- **`commands-smoke`**：`fixtures/projects/v1/commands-smoke/` の全イベントが、レジストリの全コマンドを使い、`ev_smoke` は警告なしに完走する（03）。ネストした `Loop` × `ConditionalBranch` の終了性は fast-check。
- **ZIP**：`projectRepositoryContract` に、書き出しのレイアウト・ラウンドトリップ（ID だけが新しい）・入れ子フォルダ・壊れた ZIP/JSON/マップ欠落・`newer-format`・アセットの改ざん・マニフェスト外のファイル・バイト列の無いアセットを追加した。
- **エクスポータ**：`packages/exporter` を 70% のカバレッジ対象に追加。フォルダ形式の構造・単一 HTML の外部参照なし・`</script>` のエスケープ・警告をテストする。プレイヤーの取り決め（アセットの拡張子）は `apps/player` のテストで突き合わせる。
- **E2E**：`e2e/export.spec.ts` を追加（別オリジン + `file://` + リクエスト 0 件）。`Window` の型宣言は E2E の各ファイルで衝突する（型チェックは 1 つのプログラム）ので、新しい E2E ではページ内の式を文字列で評価する。

## 実装メモ（M7 で確定した点）
- **カバレッジ**：`plugin-api` / `plugin-samples` / `render-webgl` を 70% の対象に追加。
- **ピクセル差分**：`e2e/render.spec.ts` は、ブラウザ側のハーネス（`e2e/support/render-harness.ts`）をテストの中で esbuild でバンドルしてページに流し込み、同じ `FrameSpec` を両レンダラで描いて比べる（差の画像は Playwright の添付に付く）。SwiftShader の WebGL で Chromium（PR 必須のブラウザ）だけを対象にしている。
- **`e2e/support/*.ts` と `e2e/helpers.ts`** はテストではない（`*.spec.ts` だけがテストとして実行される）。`Window` の型宣言は E2E の各ファイルで衝突するので、ページ内の式は文字列で評価する。
- **フェイクのディレクトリ**：`createFakeDirectory()`（test-utils）で OPFS / File System Access の契約テストを Node で回し、実物の OPFS は `e2e/opfs.spec.ts`。
- **E2E の数**：プレイヤー 11、エディタ 3、書き出し 1、プラグイン 1、描画 9、WebGL のプレイヤー 3、オフライン 1、OPFS 1。
