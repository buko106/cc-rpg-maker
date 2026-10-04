import type { AssetId } from "@rpg/schema";
import type { RGBA } from "@rpg/core";

/**
 * 1 フレームの描画内容を表す純データ（docs/06-runtime.md）。`runtime` が `GameState` から投影し、
 * `Renderer` アダプタが描く。JSON に直せるので、スナップショットテストとピクセルテストの入力になる。
 */
export interface FrameSpec {
  readonly size: { readonly width: number; readonly height: number };
  /** 画面左上のワールド座標（ピクセル） */
  readonly camera: { readonly x: number; readonly y: number };
  /** 描画順 */
  readonly layers: readonly FrameLayer[];
  readonly overlay: Overlay;
  readonly ui: readonly UiNode[];
}

export interface Overlay {
  /** 0 = 通常、1 = 完全に暗転 */
  readonly fade: number;
  /** 暗転の色（`a` は使わない）。省略は黒。 */
  readonly fadeColor?: RGBA;
  readonly tint: RGBA;
  readonly flash?: { readonly color: RGBA; readonly alpha: number };
  /** 全レイヤに適用するカメラオフセット（ピクセル） */
  readonly shake: { readonly dx: number; readonly dy: number };
}

export type FrameLayer =
  | {
      readonly kind: "tiles";
      /** タイルセット画像。画像が無いタイルセットは `null`（描かれない）。 */
      readonly tileset: AssetId | null;
      readonly tileSize: number;
      readonly width: number;
      readonly height: number;
      /** `width * height` 個。0 = 空。タイル ID `t` はタイルセット画像の `t` 番目のセル（左→右、上→下）を使う。 */
      readonly tiles: readonly number[];
      readonly z: number;
    }
  | {
      readonly kind: "sprites";
      /** 描く順（y ソート済み）。レンダラは並べ替えない。 */
      readonly sprites: readonly Sprite[];
      readonly z: number;
    };

export interface Sprite {
  readonly asset: AssetId;
  readonly sx: number;
  readonly sy: number;
  readonly sw: number;
  readonly sh: number;
  /** ワールド座標（ピクセル） */
  readonly x: number;
  readonly y: number;
  readonly alpha?: number;
  readonly flipX?: boolean;
}

export interface FontSpec {
  readonly family: string;
  readonly size: number;
  readonly bold?: boolean;
}

export interface TextRun {
  readonly text: string;
  readonly color: RGBA;
}

/** 画面座標（ピクセル）で置く UI 部品。 */
export type UiNode =
  | {
      readonly kind: "window";
      readonly x: number;
      readonly y: number;
      readonly w: number;
      readonly h: number;
      readonly skin?: AssetId;
      /** `dim` は半透明の暗い背景（枠なし） */
      readonly variant?: "normal" | "dim";
      readonly children: readonly UiNode[];
    }
  | {
      readonly kind: "text";
      readonly x: number;
      readonly y: number;
      readonly text: string;
      readonly font: FontSpec;
      readonly color: RGBA;
      /** 色替えのある行。指定されたときは `text` / `color` の代わりに `runs` を左から順に描く（折り返しなし）。 */
      readonly runs?: readonly TextRun[];
      readonly align?: "left" | "center" | "right";
      readonly maxWidth?: number;
    }
  | { readonly kind: "gauge"; readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly ratio: number; readonly color: RGBA }
  | { readonly kind: "cursor"; readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly blink: boolean }
  | {
      readonly kind: "image";
      readonly x: number;
      readonly y: number;
      readonly asset: AssetId;
      readonly sx?: number;
      readonly sy?: number;
      readonly sw?: number;
      readonly sh?: number;
      /** 不透明度（0〜1）。省略は 1。 */
      readonly alpha?: number;
      /** 倍率（1 = 原寸）。省略は 1。 */
      readonly scale?: number;
      /** `center` なら `x` `y` は画像の中心。省略は左上。 */
      readonly origin?: "topLeft" | "center";
    };
