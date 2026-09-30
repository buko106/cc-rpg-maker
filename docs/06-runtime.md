# 06. `@rpg/runtime` — ゲームループ・シーン管理・FrameSpec 投影

## 責務
- 固定タイムステップのゲームループ。
- `core.step` の呼び出しと `Effect` の各アダプタへの分配。
- `GameState → FrameSpec`（描画内容の純データ）への投影。
- アセットの事前ロードとマップの遅延ロード（`requestMapData` への応答）。
- セーブ/ロード要求の仲介（`SaveRepository` 呼び出し）。
- すべてのポート型（`Renderer`, `AudioOut`, `InputSource`, `AssetSource`, `SaveRepository` の再エクスポート）の定義。

## 非責務
- 具象アダプタ。
- ゲームの意味論。→ `core`

## 依存が許されるパッケージ
`@rpg/core`, `@rpg/schema`。`DOM` 型は使わない（`requestAnimationFrame` も `Scheduler` ポート経由）。

## 公開インターフェース

### ポート（アダプタが実装する）
```ts
export interface Scheduler {                     // ブラウザでは rAF、テストでは手動
  requestFrame(cb: (nowMs: number) => void): () => void;   // cancel を返す
  now(): number;
}
export interface Renderer {                      // 07
  init(opts: { width: number; height: number; assets: AssetSource }): Promise<void>;
  render(frame: FrameSpec): void;
  resize(w: number, h: number): void;
  dispose(): void;
}
export interface AudioOut {                      // 08
  playBgm(ref: AudioRef, fadeMs?: number): void; stopBgm(fadeMs?: number): void;
  playSe(ref: AudioRef): void; setMasterVolume(v: number): void; dispose(): void;
}
export interface InputSource {                   // 08
  poll(): InputFrame;                            // 呼び出し時点の1フレーム分を返し、triggered をクリア
  dispose(): void;
}
export interface AssetSource {                   // 09
  loadImage(id: AssetId): Promise<ImageHandle>;
  loadAudio(id: AssetId): Promise<AudioHandle>;
  loadJson<T>(id: AssetId): Promise<T>;
  has(id: AssetId): Promise<boolean>;
}
export interface SaveRepository { /* 11 の定義を re-export */ }
export interface ProjectSource {                 // ランタイムがゲーム定義を得る口
  project(): Promise<Project>;
  mapData(id: MapId): Promise<MapData>;
  projectHash(): Promise<string>;
}
```

### Runtime
```ts
export interface RuntimeDeps {
  scheduler: Scheduler; renderer: Renderer; audio: AudioOut; input: InputSource;
  assets: AssetSource; saves: SaveRepository; projectSource: ProjectSource;
  plugins?: PluginModule[];                      // 14
  seed?: string; logger?: Logger;
}
export interface Runtime {
  start(): Promise<void>;                        // タイトルへ
  stop(): void;
  /** 1フレーム進める。通常は Scheduler から呼ばれるが、テストでは直接呼べる */
  frame(nowMs: number): Promise<void>;
  getState(): GameState;                         // 読み取り専用
  dispatch(action: Action): void;                // デバッグ・エディタ連携用
  onEffect(cb: (e: Effect) => void): () => void; // 観測用
  project(frame: GameState): FrameSpec;          // 投影の公開（テスト用）
}
export function createRuntime(deps: RuntimeDeps): Runtime;
```

### ループ仕様
```
STEP_MS = 1000 / 60
frame(now):
  acc += min(now - last, 250)           # 250ms 超はスパイラル防止で切り捨て
  while acc >= STEP_MS:
    input = deps.input.poll()
    { state, effects } = core.step(state, input, ctx)
    for e in effects: handleEffect(e)
    acc -= STEP_MS
  renderer.render(project(state, alpha = acc / STEP_MS))
```
- `requestMapData` Effect を受けたらループを `paused: "loading"` にし、`projectSource.mapData` が解決したら `ctx` を更新して再開する。
- `requestSave` / `requestLoad` も同様に `paused` にして非同期処理する。

### FrameSpec
```ts
export interface FrameSpec {
  readonly size: { width: number; height: number };
  readonly camera: { x: number; y: number };       // ピクセル
  readonly layers: readonly FrameLayer[];          // 描画順
  readonly overlay: { fade: number; tint: RGBA; flash?: { color: RGBA; alpha: number }; shake: { dx: number; dy: number } };
  readonly ui: readonly UiNode[];
}
export type FrameLayer =
  | { kind: "tiles"; tileset: AssetId; tileSize: number; width: number; height: number; tiles: readonly number[]; z: number }
  | { kind: "sprites"; sprites: readonly Sprite[]; z: number };   // y ソート済み
export interface Sprite { asset: AssetId; sx: number; sy: number; sw: number; sh: number; x: number; y: number; alpha?: number; flipX?: boolean }
export type UiNode =
  | { kind: "window"; x; y; w; h; skin?: AssetId; children: UiNode[] }
  | { kind: "text"; x; y; text: string; font: FontSpec; color: RGBA; align?: "left"|"center"|"right"; maxWidth?: number }
  | { kind: "gauge"; x; y; w; h; ratio: number; color: RGBA }
  | { kind: "cursor"; x; y; w; h; blink: boolean }
  | { kind: "image"; x; y; asset: AssetId; sx?; sy?; sw?; sh? };
```
- `FrameSpec` はシーンごとの投影関数 `projectMapScene`, `projectBattleScene`, `projectMenuScene`, `projectTitleScene`, `projectMessage` の合成。
- テキストの制御文字（`\V[n]`, `\N[n]`, `\C[n]`）は投影時に展開する（`textCodec.ts`）。改行・ページ送りの分割も投影時に行う。

### シーン管理
- シーンは `GameState.scene` で決まる（core が所有）。`runtime` はシーンごとの投影関数と Effect ハンドリングを持つだけで、独自のシーンスタックを持たない。
- メニュー/タイトル等の UI 入力処理も `core` の `dispatch` で行う（UI状態も GameState に含める）。これにより UI 操作もリプレイ可能になる。

## 不変条件
1. `frame` を呼ばない限り `getState()` は変化しない。
2. 同じ `nowMs` 列と同じ `InputSource` 出力で同じ最終状態（決定論）。
3. `project(state)` は純粋（同じ state → deep-equal な FrameSpec）。
4. 1回の `frame` 内で `core.step` は最大 15 回（250ms 分）。
5. すべての `Effect` は必ずどれかのハンドラに到達する（未処理 Effect は logger.warn）。

## テスト要件
- `test-utils/manualScheduler.ts`（手動で `advance(ms)` するスケジューラ）と `render-null`, `audio-null`, `input-script`, in-memory の各リポジトリで Runtime を組み立てるハーネスを用意する。
- ループ：`advance(16.67 * 3)` で `state.tick` が 3 増えること、250ms 切り捨て。
- FrameSpec のスナップショットテスト：`fixtures/projects/v1/*` の初期状態、メッセージ表示中、戦闘中。
- テキストコーデック：制御文字展開のテーブル駆動テスト。
- Effect 分配：`playSe` が `AudioOut.playSe` に届くことを null アダプタの記録で検証。
- 遅延ロード：`TransferPlayer` で未ロードマップへ移動 → `paused` → 解決 → 再開。

## 完了条件
- `apps/player` から起動してタイトル → マップ歩行 → メッセージ表示 → 戦闘 → セーブ → ロードが動く。
- 上記テストが通る。

## 実装メモ（M2 で確定した点）
- **実装範囲**：ループ、マップシーンとメッセージの投影、Effect 分配、`requestMapData` の遅延ロード。`plugins` / `saves`（`SaveRepository`）/ 戦闘・メニュー・タイトルの投影は後続（M3〜M4）。`start()` は M2 ではタイトルを経ずにマップシーンから始まる。
- **`RuntimeDeps`**：`plugins` と `saves` を除き、`onError(error)`（ループ中の未捕捉エラー。呼ばれるとループは止まる）を追加。`seed` 省略時は開始時の `scheduler.now()`。`Runtime` に `status`（`created | running | loading | stopped | failed`）を追加。
- **`project(state, view, fx)` ではなく `projectFrame(state, view, fx?)`**（純粋関数）。`Runtime.project(state?)` はその薄いラッパ。`alpha`（ステップ間補間）は使わない：補間は `Character.realX/realY` が持っている。
- **ループ**：`start()` が `lastNow = scheduler.now()` を置くので、最初のフレーム境界から 1 ステップ進む。ステップ数の上限は 15（`acc + 1e-6 >= STEP_MS` で浮動小数点誤差を許容）。ステップが無いフレームでは `input.poll()` を呼ばない（押下を失わない）。
- **遅延ロード**：`requestMapData` を受けると `status = "loading"`（ステップも `poll` も止まる。描画は続く）。`frame()` はロードの完了まで待つ。失敗したら `onError` を呼んで `failed`。同時に 2 つ以上の要求は出ない（core が `transfer.requested` で一度だけ発行し、ロード中は止まるため）。
- **Effect 分配**は `distributeEffect(effect, sinks)`（`effects.ts`）。未対応（`requestSave` / `requestLoad` / `plugin` / 未知の種類）は `logger.warn` に流れる（不変条件 5）。`screenShake` / `screenFlash` は `GameState` に入れない見た目だけの一時状態 `VisualFx`（`visual-fx.ts`）で、`step` ごとに 1 進む。
- **`FrameSpec` の追加点**：タイルレイヤの `tileset` は画像が無いタイルセットで `null`。`UiNode.window` に `variant: "normal" | "dim"`、`UiNode.text` に色替えのある行用の `runs`。
- **描画規約**（M2）：
  - タイルセット画像：タイル ID `t`（1 始まり、0 = 空）は画像の `t` 番目のセル（左→右、上→下）。セル 0 は未使用。
  - キャラクターシート：1 キャラ = 横 3 パターン × 縦 4 方向（下・左・右・上）、1 コマ = `tileSize` 四方。`index` 番目のキャラは（3 × tileSize）×（4 × tileSize）のブロックを左→右、上→下に数える（横のブロック数はマニフェストの `width` から）。歩行中は移動の前半・後半でパターン 0 / 2、止まっているときは 1。
  - 描画順：タイルレイヤ（`z` = レイヤ番号）→ スプライト（`below` 100 → `same` 200 → `above` 300。各レイヤ内は y ソート、同じ高さならプレイヤーが最後）。タイルレイヤはすべてキャラクターの下（キャラクターより手前のタイルレイヤは後続）。
- **メッセージ**：位置は `top` / `middle` / `bottom`（画面端から 4px の余白、高さは 4 行分 + 余白）、背景は `window`（枠付き）/ `dim` / `transparent`（文字だけ）。表示は先頭 4 行まで（ページ送り・選択肢は後続）。制御文字は `\V[変数ID]` `\N[アクターID]` `\C[色番号]` `\\`（`text-codec.ts`）。ID は文字列（`[A-Za-z0-9_-]`）で、数字ではない。
- **テスト**：`test-utils` の `createRuntimeHarness({ project, seed?, deferMaps?, failMaps? })` が null / script / memory アダプタと手動スケジューラで開始済みの Runtime を作る（`play(...frames)`、`advanceFrames(n)`、`projectSource.release(id)`）。FrameSpec スナップショットは `summarizeFrame` でタイル配列を畳んで保存する。

## 実装メモ（M3 で確定した点）
- **`RuntimeDeps` の追加**：`saves: SaveRepository`（必須）、`clock?: () => number`（壁時計のミリ秒。セーブの `savedAt` 用。core/runtime は `Date.now` を使わないので、プレイヤーが `Date.now` を渡す。省略時は 0）、`title?: boolean`（既定 `true` = タイトルから。`false` ならすぐニューゲーム。M2 までのテストと `createRuntimeHarness` は `false`）。`Runtime` に `settled()`（進行中のセーブ書き込み・ロードが終わるまで待つ。テストと E2E 用）を追加。`plugins` は未実装のまま。
- **`start()`**：`project.meta.id` と `projectSource.projectHash()` を控え、`titleState`（または `initialState`）を作り、`saves.listSlots()` でスロット一覧をキャッシュしてから開始する（一覧が取れなくても warn のみ）。`system.bgm.title` があればタイトルで流す（ニューゲームで core が `stopBgm`、コンティニュー成功時は runtime が止める）。
- **セーブ（`requestSave`）**：その場の状態から `toSnapshot`（同期。`projectId` = `project.meta.id`、`projectHash` = ProjectSource のもの）→ `saves.write` は非同期でループを止めない。成功でお知らせ `saved`＋一覧を取り直し、失敗（`Result` の Err も例外も）は warn＋お知らせ `saveFailed`。`slot` 省略時は 1。
- **ロード（`requestLoad`）**：ループを止めて（`status = "loading"`。マップの遅延ロードと同じ仕組みで、同時には 1 つだけ）`saves.read` → 保存されたマップがプロジェクトに無ければ失敗 → 未ロードなら `projectSource.mapData` で読む → `dispatch(loadSnapshot)` で状態を置き換える（`VisualFx` とお知らせは捨てる）。**読めない・マイグレーション/検証に失敗・マップが読めない、のどれも `onError`（致命）にはせず**、warn＋お知らせ `loadFailed` でゲーム（タイトルなら タイトル）に留まる。マップ読み込み自体の失敗は従来どおり致命。
- **確認（誤操作防止）**：`requestSave` / `requestLoad` は、メニューの中で `confirmed` でないとき、次の場合に**実行せず** `askConfirm` を `dispatch` して確認ダイアログを出す（判断は純粋関数 `save-guard.ts`）。runtime は「いまのプレイの元になっているセーブ」`origin = { slot, fingerprint }`（最後にロード/セーブに成功したスロットと、そのときの `progressFingerprint`）を持ち、タイトルに戻ると捨てる。
  - **セーブの上書き**（`saveNeedsConfirm`）：保存先にデータがあり、それが `origin.slot` でないとき。空きスロット、ロード/セーブしたばかりの同じスロットは確認しない（保存に失敗したら `origin` は変えない）。
  - **ロードでの進行の破棄**（`loadNeedsConfirm`）：読み込めるデータのあるスロットを選び、現在の進行が `origin.fingerprint` と違うとき（一度もセーブ/ロードしていなければ常に）。セーブした直後・ロードした直後は確認しない。空き・読み込めないスロットは失敗するだけなので確認しない。
  - **タイトルのコンティニュー**やプラグインなどメニュー外からの要求は確認せずそのまま実行する（失う進行が無い／ダイアログを出せない）。
  - 「はい」は core が `confirmed: true` つきで要求を出し直す（`EffectSinks.save/load` の第 2 引数）。文言は `terms` の `confirmOverwrite`（`{slot}`）・`confirmLoad`・`yes`・`no`。
- **ループを止める非同期処理は `runLoading(task)` に集約**：失敗は `fail`（`onError` → `failed`）。
- **`projectFrame(state, view, fx?, ui?)`**：`ui: UiContext = { slots: SlotMeta[]; notice?: NoticeKey }` は GameState の外にある表示用の情報（スロット一覧のキャッシュ、2 秒（120 ステップ）だけ出るお知らせ）。純粋関数のまま。タイトルは `projectTitle`、メニューは `projectMenu`（マップを背景に、全画面の `dim` ウィンドウの上へ重ねる）。戦闘・ゲームオーバーは M4 まで空の画面。
- **タイトル・メニューの見た目**：文言は `system.terms[key]`、無ければ既定（`newGame`「ニューゲーム」`continue` `item` `status` `save` `load` `gold` `playtime` `level` `hp` `mp` `exp` `emptySlot` `incompatible` `noItems` `saved` `saveFailed` `loadFailed` と能力値 `mhp`…`luk`。`projection/terms.ts`）。タイトル：ゲームタイトル（`meta.title`、28px 太字）＋ 168px 幅のコマンドウィンドウ（画面の 62% の高さ）。メニュー `main`：左にコマンド・所持金/プレイ時間、右にパーティ（最大 3 人の名前・Lv・HP/MP ゲージ）。`item`：名前と `× 個数`（DB に無い ID は ID のまま）。`status`：名前・クラス・Lv・経験値・HP/MP ゲージ・能力値・顔画像。`save` / `load` / `continue`：スロット一覧（1 行 = 番号・マップ名・Lv・先頭メンバー名、右端にプレイ時間。空きは灰色、互換性なしは赤で「読み込めません」）。行が画面に収まらなければカーソル中心にスクロールする。UI 部品は `window` / `text` / `cursor` / `gauge` / `image` だけで作る（`FrameSpec` の型は変えていない）。
- **`SaveRepository` ポートは runtime が定義**（`ports/saves.ts`。`SlotMeta` / `SaveStoreError` / `SaveRepositoryOpts` / `BlobLike`）。runtime は DOM の型を使わないので、`exportSlot` / `importSlot` の `Blob` は構造的に互換な最小の型 `BlobLike`（`size` / `type` / `text()`）にしてある。`Result` / `ok` / `err` も runtime から再エクスポートする（アダプタが schema に依存しなくて済む）。
- **テスト**：`createRuntimeHarness` に `title?` / `saves?` / `clock?` / `patchProject?` を追加し、`saves`（メモリ）を返す。`createMemorySaveRepository` は test-utils から再エクスポートしてある（runtime のテストはアダプタを直接 import できないため）。`save-load.test.ts`：タイトル → ニューゲーム、メニューからのセーブ（保存内容・お知らせ・失敗）、別セッションでのコンティニュー（位置・乱数の復元）、メニューのロード、空スロット・`projectHash` 不一致・壊れたスナップショット、別マップのセーブの遅延ロード。

## 実装メモ（M4 で確定した点）
- **戦闘・ゲームオーバーの投影**：`projectBattle`（`projection/battle.ts`）と `projectGameOver`。戦闘はマップの**地形のレイヤだけ**を背景に残し（キャラクターは描かない）、2 枚重ねの暗幕で沈めて UI を載せる。上：ログ（最後の 3 行。`BattleLogEntry` → 文章は `projection/battle-log.ts` の `formatLogEntry`）。中：敵（`Enemy.graphic` の絵を `Troop.members` の座標に中心合わせ。絵が無ければ名前の箱。名前を下に、倒れた敵は消える）とダメージの数字（`popups`。時間とともに浮かび上がる。通常 = 白、会心 = 黄、回復 = 緑、ミス = 灰）。下：コマンド（入力中だけ）とパーティのステータス（名前・HP/MP の数値とゲージ・状態。戦闘不能は赤）。スキル/アイテムの選択中は一覧が下いっぱいに広がる（最大 5 行でスクロール、MP 不足は灰色、アイテムは所持数）。対象選択では敵に枠のカーソル、味方にはステータスの行にカーソル。ゲームオーバーは暗幕と「ゲームオーバー」の文字。
- **文言**：`system.terms` が優先、無ければ既定（`projection/terms.ts`）。戦闘のコマンド（`attack skill guard escape`）とログの文言（`battleAppear`, `actionAttack`, `damage`, `defeated`, `rewards`, `levelUp` …）を追加。ログの文言は `{name}` `{amount}` のような穴を持つ（`fill`）。
- **Effect**：新しい種類は無い。`BattleProcessing` の `playBgm`、戦闘の終わりの `stopBgm`、味方がダメージを受けたときの `screenShake` は既存の分配で届く。runtime 自体のコードは変わらない（投影だけ）。
- **テスト**：`projection/battle.test.ts`（スナップショット 2 つ、レイアウト、ログの文言の表、ポップアップ、対象カーソル）、`battle-runtime.test.ts`（Runtime を通した BGM・描画・勝利・ゲームオーバー → タイトル）。`runtime.test.ts` のリプレイ一致テストは `title: true` のリプレイも通る。

## 実装メモ（M6 で確定した点）
- **`VisualFx` に色調と暗転を追加**：`screenTint`（`from` → `color` へ線形に変わり、終わってもそのまま保たれる。`a = 0` に戻ると消える）と `screenFade`（暗転は `to = 0`（明転）を指示するまで保たれる）。どちらも `fxOverlay` が `Overlay.tint` / `Overlay.fade` にする。セーブ・リプレイの対象外（ロードすると消える）。
- **投影**：選択肢（見出し `text` の下に縦に並べ、カーソルを重ねる。多いときはカーソルが見える範囲だけ）、数値入力（桁ごとの数字と、編集中の桁のカーソル。画面中央）、タイマー（右上に `m:ss`）。ショップも選択肢の窓を使う。

## 実装メモ（M7 で確定した点）
- **`RuntimeDeps.extensions?: RuntimeExtensions`**（`extensions.ts`）：`setup(ctx)`（`Ctx` を作った直後に呼ばれ、コマンド・式関数の登録や戦闘ルールの差し替えをして、使う `Ctx` を返す）、`onPluginEffect(effect, api)`（`plugin` Effect の受け口。`EffectApi` = `{ audio, dispatch, state }`）、`afterProject(scene, frame, state)`（`FrameSpec` の後処理）。どれも省略可能で、何も渡さなければ拡張なしと同じ挙動。`@rpg/plugin-api` の `toRuntimeExtensions` が、読み込んだプラグインの登録内容から作る（14）。
- `EffectSinks` に `plugin(effect)` を足した：受け口が無ければ `logger.warn`、受け口が例外を投げても警告して続ける。投影の後処理が例外を投げたら、拡張なしの `FrameSpec` を使う（ゲームを止めない）。
