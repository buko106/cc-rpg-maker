import type { MenuConfirm, ProjectView } from "@rpg/core";
import type { UiNode } from "../frame-spec.js";
import { fill, term } from "./terms.js";
import { UI_PADDING, UI_ROW_HEIGHT } from "./theme.js";
import { cursorNode, textNode, windowNode } from "./ui.js";

const MAX_WIDTH = 360;

/**
 * セーブ/ロード画面に重ねる確認ダイアログ：問いかけの 1 行と「はい/いいえ」。
 * 上書き（`save`）と未セーブの進行の破棄（`load`）で問いかけが違う。
 */
export function projectConfirm(view: ProjectView, screen: { width: number; height: number }, confirm: MenuConfirm): UiNode[] {
  const w = Math.min(MAX_WIDTH, screen.width - 32);
  const h = UI_ROW_HEIGHT * 3 + UI_PADDING * 2;
  const x = Math.round((screen.width - w) / 2);
  const y = Math.round((screen.height - h) / 2);
  const question = fill(term(view, confirm.kind === "save" ? "confirmOverwrite" : "confirmLoad"), { slot: confirm.slot });
  const rowY = (i: number): number => y + UI_PADDING + i * UI_ROW_HEIGHT;
  return [
    windowNode(x, y, w, h, [
      textNode(x + UI_PADDING, rowY(0) + 2, question, undefined, { maxWidth: w - UI_PADDING * 2 }),
      textNode(x + UI_PADDING, rowY(1) + 2, term(view, "yes")),
      textNode(x + UI_PADDING, rowY(2) + 2, term(view, "no")),
      cursorNode(x + 4, rowY(1 + confirm.cursor), w - 8),
    ]),
  ];
}
