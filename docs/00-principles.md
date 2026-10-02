# 00. 設計原則・依存ルール・規約

すべてのパッケージに適用される。個別ドキュメントの記述と矛盾する場合は本ドキュメントが優先する。

## 1. 設計原則

### 1.1 ヘキサゴナル（ポート＆アダプタ）
- 外界との接点はすべて **ポート（TypeScript interface）** として `core` または `runtime` が定義する。
- ポートの実装（アダプタ）は独立パッケージ。**必ず in-memory / null 実装を1つ以上持つ**。
- アプリ（`editor-ui`, `player`）が結線（composition root）を担う。それ以外の場所で具象アダプタを `new` してはならない。

### 1.2 決定論
- `Math.random`, `Date.now`, `performance.now`, `setTimeout` を `core` と `runtime` で直接使ってはならない。`Random` / `Clock` ポートを経由する。
- ゲーム状態の更新は `tick(state, inputs, ctx) → state` の純粋関数で表現する。
- 結果として「入力列 + 初期シード」からゲーム状態を完全再現できる。これをリプレイテストの基盤とする。

### 1.3 不変データ
- `GameState`, `Project` は不変（immutable）として扱う。更新は新オブジェクトを返す。`immer` の使用を許可する。
- 状態オブジェクトに関数・クラスインスタンス・`Map`/`Set` を入れない（直列化可能であること）。

### 1.4 「意味」と「表現」の分離
- `core` は「ゲームとして何が起きたか」のみを扱う。ピクセル・音・DOMを知らない。
- 表示は `runtime` が `FrameSpec`（純データ）へ投影し、`Renderer` アダプタが描く。
- 待機（メッセージ送り待ち等）は状態で表現し、`Promise` や callback で表現しない。

### 1.5 拡張点は登録制
- イベントコマンド、戦闘式、シーン、エディタのパラメータフォームはすべて**レジストリへの登録**で追加する。`switch` 文の肥大化を禁止する。

## 2. 依存ルール（違反はビルドエラーにする）

```
schema        → (なし)
core          → schema
runtime       → core, schema
render-*      → runtime（ポート型のみ）
audio-*       → runtime（ポート型のみ）
input-*       → runtime（ポート型のみ）
assets        → runtime（ポート型のみ）
project-store → schema
exporter      → schema, project-store（ポート型・ZIP）
save-store    → core（Snapshot 型・マイグレーション）, runtime（ポート型のみ）
editor-core   → schema, core（CommandRegistry のメタデータ参照のみ）, project-store（ポート型のみ）
plugin-api    → core, runtime, editor-core（公開型のみ）
plugin-samples → plugin-api（サンプルプラグイン。第三者のプラグインと同じ立場）
plugin-dungeon → plugin-api（不思議のダンジョン。同じく第三者のプラグインと同じ立場。docs/18）
plugin-fishing → plugin-api（釣り大会。同じく第三者のプラグインと同じ立場。docs/19）
editor-ui     → editor-core, runtime, plugin-api, plugin-samples, plugin-dungeon, plugin-fishing, schema, core（CommandRegistry のメタデータ参照のみ）, exporter, 任意のアダプタ
player        → runtime, plugin-api, plugin-samples, plugin-dungeon, plugin-fishing, schema（project.json の検証用）, 任意のアダプタ
test-utils    → 任意（テスト専用）
```

- 各パッケージの**テストファイル（`*.test.ts`）と、テスト専用のヘルパ（`*.testkit.ts`。パッケージのビルドからは除く）だけは、上記に加えて `test-utils` を import できる**（契約テスト・ハーネスを使うため）。`package.json` では `devDependencies` にのみ宣言する。プロダクションコードは `test-utils` を import してはならない。

- 逆方向・横方向の import は `eslint-plugin-boundaries`（または `dependency-cruiser`）で禁止する。
- `schema`, `core` の `tsconfig` は `lib: ["ES2022"]` のみ（`DOM` を含めない）。これにより DOM API への依存が型レベルで不可能になる。
- ポート型は `packages/<name>/src/ports/*.ts` に置き、`index.ts` から re-export する。アダプタはこれのみを import する。

## 3. コーディング規約

- TypeScript `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`。
- ID はすべて **ブランド型の文字列**（`type MapId = string & { __brand: "MapId" }`）。数値インデックスをIDにしない。
- エラーは `Result<T, E>` 型（`{ ok: true, value } | { ok: false, error }`）で返す。例外は「プログラミングエラー（バグ）」にのみ使う。
- 公開APIには JSDoc を付ける。特に不変条件と前提条件。
- 1ファイル 300 行を目安に分割する。

## 4. テスト規約（詳細は 16-testing.md）

- 各パッケージは `vitest` の単体テストを持つ。カバレッジ目標は `core`/`schema` で 90%、その他 70%。
- ポートには **契約テスト**（`test-utils/contracts/*`）があり、すべてのアダプタはそれを通さなければならない。
- 決定論に関わる関数は fast-check によるプロパティテストを最低1本持つ。
- テストは実装ファイルと同じディレクトリに `*.test.ts` として置く。

## 5. 用語集

| 用語 | 意味 |
|---|---|
| Project | ゲーム定義全体。エディタで編集し、`ProjectRepository` に保存する |
| GameState | プレイ中の状態。`core` が管理し、`SaveSnapshot` に変換して保存する |
| Action | GameState を変化させる入力単位（プレイヤー入力、時間経過、インタプリタ命令） |
| Effect | core が外界へ要求する副作用の記述（音を鳴らす、画面を揺らす等）。純データ |
| EventCommand | マップイベント/コモンイベントを構成する命令1行 |
| CommandHandler | EventCommand を解釈する純関数。レジストリに登録される |
| FrameSpec | 1フレーム分の描画内容を表す純データ。Renderer への入力 |
| Port | core/runtime が定義するインターフェース |
| Adapter | Port の具象実装 |
| Snapshot | GameState の直列化可能な表現。フォーマットバージョンを持つ |
| Migration | 旧フォーマットの Project / Snapshot を新フォーマットへ変換する関数 |
| Plugin | `PluginHost` を通じてコマンド・式・シーンを追加する ES モジュール |

## 6. 変更の手順

- ポート型の変更は**契約テストの更新を伴う**。契約テストを変えずにポートを変えてはならない。
- `schema` の変更は**フォーマットバージョンのインクリメントとマイグレーション追加**を伴う（01-schema.md）。
- `SaveSnapshot` の変更も同様（11-save-store.md）。
