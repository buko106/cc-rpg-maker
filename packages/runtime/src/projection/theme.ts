import type { RGBA } from "@rpg/core";
import type { FontSpec } from "../frame-spec.js";

const rgb = (r: number, g: number, b: number, a = 1): RGBA => ({ r, g, b, a });

/** `\C[n]` の色番号 → 色（範囲外は 0 番）。 */
const TEXT_COLORS: readonly RGBA[] = [
  rgb(255, 255, 255),
  rgb(32, 160, 214),
  rgb(255, 120, 76),
  rgb(102, 204, 64),
  rgb(153, 204, 255),
  rgb(204, 192, 255),
  rgb(255, 255, 160),
  rgb(128, 128, 128),
];

export const textColor = (index: number): RGBA => TEXT_COLORS[index] ?? TEXT_COLORS[0]!;

export const NO_TINT: RGBA = rgb(0, 0, 0, 0);

export const MESSAGE_FONT: FontSpec = { family: "sans-serif", size: 16 };
export const MESSAGE_LINES = 4;
export const MESSAGE_LINE_HEIGHT = 22;
export const MESSAGE_PADDING = 10;
export const MESSAGE_MARGIN = 4;
export const FACE_SIZE = 72;

// ---- タイトル・メニュー ----
export const UI_FONT: FontSpec = { family: "sans-serif", size: 16 };
export const TITLE_FONT: FontSpec = { family: "sans-serif", size: 28, bold: true };
export const UI_ROW_HEIGHT = 24;
export const UI_PADDING = 8;
export const UI_MARGIN = 8;
export const HP_COLOR: RGBA = rgb(102, 204, 64);
export const MP_COLOR: RGBA = rgb(32, 160, 214);
export const EXP_COLOR: RGBA = rgb(255, 255, 160);
