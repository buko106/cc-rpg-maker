import type { GameState, ProjectView } from "@rpg/core";
import { TITLE_ITEMS } from "@rpg/core";
import type { UiNode } from "../frame-spec.js";
import { projectSlotList } from "./slot-list.js";
import { term } from "./terms.js";
import { TITLE_FONT, UI_PADDING, UI_ROW_HEIGHT } from "./theme.js";
import { commandRows, textNode, windowNode } from "./ui.js";
import type { UiContext } from "./ui.js";

/** タイトル画面：ゲームタイトルとコマンド（ニューゲーム/コンティニュー）、または続きからのスロット一覧。 */
export function projectTitle(state: GameState, view: ProjectView, screen: { width: number; height: number }, ui: UiContext): UiNode[] {
  const scene = state.scene;
  if (scene.kind !== "title") return [];
  if (scene.screen === "continue") return projectSlotList(view, screen, "continue", scene.cursor, ui);

  const labels = TITLE_ITEMS.map((key) => term(view, key));
  const w = 168;
  const h = labels.length * UI_ROW_HEIGHT + UI_PADDING * 2;
  const x = Math.round((screen.width - w) / 2);
  const y = Math.round(screen.height * 0.62);
  return [
    textNode(screen.width / 2, Math.round(screen.height * 0.24), view.project.meta.title, { r: 255, g: 255, b: 255, a: 1 }, { font: TITLE_FONT, align: "center", maxWidth: screen.width - 16 }),
    windowNode(x, y, w, h, commandRows(x, y, w, labels, scene.cursor)),
  ];
}
