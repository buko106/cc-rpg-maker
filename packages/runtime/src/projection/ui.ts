import type { RGBA } from "@rpg/core";
import type { SlotMeta } from "../ports/saves.js";
import type { UiNode } from "../frame-spec.js";
import type { NoticeKey } from "./terms.js";
import { UI_FONT, UI_PADDING, UI_ROW_HEIGHT, textColor } from "./theme.js";

/** 画面の見た目に必要な、GameState の外にある情報（runtime が持つ）。 */
export interface UiContext {
  /** 保存済みスロットの一覧（`listSlots` のキャッシュ）。 */
  readonly slots: readonly SlotMeta[];
  /** 表示中のお知らせ（用語のキー）。 */
  readonly notice?: NoticeKey;
}

export const NO_UI: UiContext = { slots: [] };

export const windowNode = (x: number, y: number, w: number, h: number, children: UiNode[]): UiNode => ({ kind: "window", x, y, w, h, variant: "normal", children });

export const textNode = (x: number, y: number, text: string, color: RGBA = textColor(0), extra: Partial<Extract<UiNode, { kind: "text" }>> = {}): UiNode => ({
  kind: "text",
  x,
  y,
  text,
  font: UI_FONT,
  color,
  ...extra,
});

export const cursorNode = (x: number, y: number, w: number): UiNode => ({ kind: "cursor", x, y, w, h: UI_ROW_HEIGHT, blink: false });

/** 縦に並べるコマンドの行。 */
export function commandRows(x: number, y: number, w: number, labels: readonly string[], cursor: number): UiNode[] {
  const nodes: UiNode[] = labels.map((label, i) => textNode(x + UI_PADDING, y + UI_PADDING + i * UI_ROW_HEIGHT + 2, label));
  if (cursor >= 0 && cursor < labels.length) nodes.push(cursorNode(x + 4, y + UI_PADDING + cursor * UI_ROW_HEIGHT, w - 8));
  return nodes;
}

/** `total` 個の行のうち、カーソルが見えるように `rows` 行だけ切り出したときの先頭の番号。 */
export function firstVisible(cursor: number, total: number, rows: number): number {
  if (total <= rows) return 0;
  return Math.min(Math.max(0, cursor - Math.floor(rows / 2)), total - rows);
}

/** ティック数 → `h:mm:ss`。 */
export function formatPlaytime(ticks: number): string {
  const seconds = Math.floor(ticks / 60);
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${Math.floor(seconds / 3600)}:${two(Math.floor(seconds / 60) % 60)}:${two(seconds % 60)}`;
}
