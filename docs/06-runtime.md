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
