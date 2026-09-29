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
