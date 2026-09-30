# 07. `@rpg/render-canvas2d` / `@rpg/render-webgl` / `@rpg/render-null` — Renderer アダプタ

## 責務
- `runtime` が定義する `Renderer` ポートの実装。`FrameSpec` を受け取って描画する。
- テクスチャ/フォントのキャッシュ管理（`AssetSource` から取得）。
- `render-null`：何も描かず、受け取った `FrameSpec` を記録する（テスト用）。

## 非責務
- 何を描くかの決定。→ `runtime` の投影。
- 入力処理。→ `input-*`

## 依存が許されるパッケージ
`@rpg/runtime`（`Renderer`, `FrameSpec`, `AssetSource` の型のみ）。`DOM` 型を使用可。

## 公開インターフェース
```ts
// render-canvas2d
export function createCanvas2dRenderer(canvas: HTMLCanvasElement, opts?: { pixelated?: boolean; dpr?: number }): Renderer;
// render-webgl（PixiJS v8 を使用可）
export function createWebglRenderer(canvas: HTMLCanvasElement, opts?: {...}): Renderer;
// render-null
export interface NullRenderer extends Renderer { frames: FrameSpec[]; last(): FrameSpec | undefined; clear(): void }
export function createNullRenderer(): NullRenderer;
```

## 実装指針（canvas2d）
- `ImageHandle` は `ImageBitmap` とする。`AssetSource.loadImage` の結果を `Map<AssetId, ImageBitmap>` にキャッシュ。未ロードのアセットが FrameSpec に現れたら**そのフレームはスキップして非同期ロードを開始**し、次回以降描く（例外にしない）。
- `tiles` レイヤは可視範囲のみ描画（カメラ矩形でクリップ）。
- `sprites` は FrameSpec 内で既にソート済み。並べ替えない。
- `ui.text` は `maxWidth` で折り返す。フォント計測は `measureText`。
- `overlay` の順序：tint → flash → fade。shake はカメラオフセットとして全レイヤに適用。
- `pixelated: true` で `imageSmoothingEnabled = false`。

## 実装指針（webgl）
- canvas2d と**ピクセル単位で同一の出力**を目標にする（差分許容 1%）。
- スプライトバッチ化。タイルレイヤはチャンク単位でキャッシュ。

## 不変条件
1. `render` は例外を投げない（アセット未ロード、不正な座標はスキップ）。
2. `render` は `FrameSpec` を変更しない。
3. `dispose` 後の `render` は no-op。
4. canvas2d と webgl は同じ `FrameSpec` に対して視覚的に同等の出力（Playwright ピクセル差分テストで検証）。

## テスト要件
- 契約テスト `test-utils/contracts/renderer.contract.ts`：`init → render → resize → render → dispose → render` の順で呼んで例外が出ないこと、`render-null` は `frames` に蓄積されること。
- canvas2d：jsdom + `canvas` パッケージ（node-canvas）でスモーク。ピクセル検証は Playwright（`fixtures/frames/*.json` → PNG スナップショット）。
- webgl：Playwright のみ。canvas2d の PNG との差分比較。
- 未ロードアセットのスキップ→次フレーム描画の挙動。

## 完了条件
- `render-null` と契約テストが先に完成し、06 のテストで使える状態になる。
- canvas2d が `apps/player` で動作し、`fixtures/frames/` に対するスナップショットが揃う。
- webgl は後続マイルストーン（17）。

## 実装メモ（M2 で確定した点）
- **実装済み**：`render-null`、`render-canvas2d`。`render-webgl` は M7。
- `createNullRenderer()` は `frames` / `last()` / `clear()` に加えて `initOpts` / `size` / `disposed` を持つ。`dispose` 後は `render` / `resize` / `init` が何も記録しない。
- `createCanvas2dRenderer(canvas, { pixelated = true, dpr = 1 })`：`init` で canvas の実サイズを `width * dpr` × `height * dpr` にする（画面への拡大は CSS で行う）。`ImageHandle` は `ImageBitmap`（描画可能な `width` / `height` を持つもの）として扱う。
- 未ロードの画像は、そのフレームでは描かずに `AssetSource.loadImage` を一度だけ呼ぶ。失敗した画像は再試行しない。`tiles` は見えている範囲だけ描き、空タイルと画像範囲外のセルは飛ばす。`ui.text` は `maxWidth` で 1 文字ずつ折り返す（`measureText`）。`runs` のある行は折り返さない。`cursor` の `blink` は M2 では点滅しない。
- **M3 の変更（canvas2d）**：`cursor` は半透明の白い塗り + 枠で描く（選択行のハイライト。`blink` は引き続き無視）。`gauge` / `text` の `align`（`center` / `right` は `x` が基準点）はタイトル・メニューで使い始めた。`FrameSpec` の型は変わっていない。
- **契約テスト**：`rendererContract(name, make)` は不変条件 1〜3（例外を出さない・`FrameSpec` を変更しない・`dispose` 後は no-op）を検証する。壊れた値（NaN、負のタイルサイズ、短すぎるタイル配列）と未ロードアセットも投げる。不変条件 4 は WebGL が入る M7 で。
- **canvas2d のテスト**：Node では呼び出しを記録するモックコンテキストで、描画順・カリング・スキップ→次フレーム描画・overlay の順序を検証する。ピクセルの確認は `e2e/player.spec.ts`（demo プロジェクトのタイル・スプライト・ウィンドウの色）で行う。`fixtures/frames/*.json` → PNG スナップショットは、`FrameSpec` の見た目が安定した後（M3〜）。
