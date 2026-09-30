import type { GameState } from "@rpg/core";
import type { SystemSettings } from "@rpg/schema";
import type { UiNode } from "../frame-spec.js";
import { UI_MARGIN, UI_PADDING, UI_ROW_HEIGHT } from "./theme.js";
import { textNode, windowNode } from "./ui.js";

const WIDTH = 64;

/** タイマー（`ControlTimer`）の残り時間 `m:ss` を右上に出す。動いていなければ空。 */
export function projectTimer(state: GameState, screen: SystemSettings["screen"]): UiNode[] {
  if (!state.timers.active) return [];
  const seconds = Math.ceil(state.timers.ticks / 60);
  const text = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const h = UI_ROW_HEIGHT + UI_PADDING * 2;
  const x = screen.width - UI_MARGIN - WIDTH;
  return [windowNode(x, UI_MARGIN, WIDTH, h, [textNode(x + WIDTH / 2, UI_MARGIN + UI_PADDING + 2, text, undefined, { align: "center" })])];
}
