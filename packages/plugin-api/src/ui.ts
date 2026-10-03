import type { RGBA, UiNode } from "@rpg/runtime";

type Align = "left" | "center" | "right";
type Variant = "normal" | "dim";

/**
 * `projection.after` で `FrameSpec.ui` に足す `UiNode` の組み立て部品。座標はすべて画面のピクセル。
 * どれも `UiNode` を返すだけの純関数で、描画の仕方（アダプタ）は知らない。
 */
export const ui = {
  /** フォント指定。ファミリは `sans-serif` 固定。`bold` が偽のときは項目ごと省く（`exactOptionalPropertyTypes` のため）。 */
  font: (size: number, bold = false): { family: string; size: number; bold?: boolean } => ({ family: "sans-serif", size, ...(bold ? { bold: true } : {}) }),
  /** 1 行の文字。`x` は `align` の基準（左端・中心・右端）。 */
  text: (x: number, y: number, text: string, color: RGBA, size = 13, align: Align = "left", bold = false): UiNode => ({ kind: "text", x, y, text, font: ui.font(size, bold), color, align }),
  /** ゲージ。`ratio`（0〜1）の分だけ左から塗る。 */
  gauge: (x: number, y: number, w: number, h: number, ratio: number, color: RGBA): UiNode => ({ kind: "gauge", x, y, w, h, ratio, color }),
  /** ベタ塗りの四角（`ratio` が 1 のゲージ）。座標と大きさは整数に丸める。 */
  rect: (x: number, y: number, w: number, h: number, color: RGBA): UiNode => ({ kind: "gauge", x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), ratio: 1, color }),
  /** ウィンドウ。`children` の座標は画面の座標のまま（ウィンドウの左上からの相対ではない）。 */
  panel: (x: number, y: number, w: number, h: number, children: readonly UiNode[], variant: Variant = "normal"): UiNode => ({ kind: "window", x, y, w, h, variant, children }),
} as const;
