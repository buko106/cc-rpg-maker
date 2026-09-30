import type { ProjectView } from "@rpg/core";
import { SAVE_SLOT_COUNT, SAVE_SLOT_FIRST } from "@rpg/core";
import type { UiNode } from "../frame-spec.js";
import { term } from "./terms.js";
import type { TermKey } from "./terms.js";
import { textColor, UI_MARGIN, UI_PADDING, UI_ROW_HEIGHT } from "./theme.js";
import { cursorNode, firstVisible, formatPlaytime, textNode, windowNode } from "./ui.js";
import type { UiContext } from "./ui.js";

const HEADER_HEIGHT = 28;

/**
 * セーブ/ロード/コンティニューのスロット一覧（画面いっぱいのウィンドウ）。
 * 1 行 = スロット番号・マップ名・先頭のキャラクターのレベルと、右端にプレイ時間。
 */
export function projectSlotList(view: ProjectView, screen: { width: number; height: number }, titleKey: TermKey, cursor: number, ui: UiContext): UiNode[] {
  const x = UI_MARGIN;
  const y = UI_MARGIN;
  const w = screen.width - UI_MARGIN * 2;
  const h = screen.height - UI_MARGIN * 2;
  const rows = Math.max(1, Math.floor((h - HEADER_HEIGHT - UI_PADDING) / UI_ROW_HEIGHT));
  const first = firstVisible(cursor, SAVE_SLOT_COUNT, rows);
  const top = y + HEADER_HEIGHT;

  const children: UiNode[] = [textNode(x + UI_PADDING, y + UI_PADDING, term(view, titleKey), textColor(6))];
  for (let i = 0; i < Math.min(rows, SAVE_SLOT_COUNT - first); i++) {
    const index = first + i;
    const slot = SAVE_SLOT_FIRST + index;
    const meta = ui.slots.find((m) => m.slot === slot);
    const ty = top + i * UI_ROW_HEIGHT + 2;
    const label = `${String(slot).padStart(2, " ")}  `;
    if (meta === undefined) {
      children.push(textNode(x + UI_PADDING, ty, `${label}${term(view, "emptySlot")}`, textColor(7)));
    } else {
      const lead = meta.preview.partyNames[0] ?? "";
      const info = `${label}${meta.preview.mapName}  ${term(view, "level")}${meta.preview.level}  ${lead}`;
      children.push(textNode(x + UI_PADDING, ty, info, meta.compatible === "no" ? textColor(2) : textColor(0)));
      children.push(
        meta.compatible === "no"
          ? textNode(x + w - UI_PADDING, ty, term(view, "incompatible"), textColor(2), { align: "right" })
          : textNode(x + w - UI_PADDING, ty, formatPlaytime(meta.playtimeTicks), textColor(0), { align: "right" }),
      );
    }
  }
  children.push(cursorNode(x + 4, top + (cursor - first) * UI_ROW_HEIGHT, w - 8));
  return [windowNode(x, y, w, h, children)];
}
