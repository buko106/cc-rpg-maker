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
