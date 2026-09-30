import type { GameState, ProjectView } from "@rpg/core";
import { MENU_ITEMS, menuItemIds, paramAt } from "@rpg/core";
import type { Param } from "@rpg/schema";
import type { UiNode } from "../frame-spec.js";
import { projectConfirm } from "./confirm.js";
import { projectSlotList } from "./slot-list.js";
import { term } from "./terms.js";
import { EXP_COLOR, HP_COLOR, MP_COLOR, textColor, UI_MARGIN, UI_PADDING, UI_ROW_HEIGHT } from "./theme.js";
import { commandRows, cursorNode, firstVisible, formatPlaytime, textNode, windowNode } from "./ui.js";
import type { UiContext } from "./ui.js";

type Screen = { width: number; height: number };

const COMMAND_WIDTH = 120;
const PARAMS: readonly Param[] = ["mhp", "mmp", "atk", "def", "mat", "mdf", "agi", "luk"];

const actorOf = (state: GameState, id: string) => (Object.hasOwn(state.actors, id) ? state.actors[id as keyof typeof state.actors] : undefined);

/** 名前・レベル・HP/MP ゲージを縦に並べたパーティ一覧の 1 人分（`y` から `ROW` の高さ）。 */
function memberSummary(state: GameState, view: ProjectView, id: string, x: number, y: number, w: number): UiNode[] {
  const actor = actorOf(state, id);
  if (actor === undefined) return [];
  const cls = view.class(view.actor(actor.id)?.classId ?? ("" as never));
  const mhp = Math.max(1, paramAt(cls, "mhp", actor.level));
  const mmp = paramAt(cls, "mmp", actor.level);
  const gaugeW = w - UI_PADDING * 2;
  return [
    textNode(x + UI_PADDING, y, `${actor.name}  ${term(view, "level")}${actor.level}`),
    textNode(x + UI_PADDING, y + 20, `${term(view, "hp")} ${actor.hp}/${mhp}`, textColor(0), { font: { family: "sans-serif", size: 12 } }),
    { kind: "gauge", x: x + UI_PADDING, y: y + 36, w: gaugeW, h: 6, ratio: actor.hp / mhp, color: HP_COLOR },
    textNode(x + UI_PADDING, y + 44, `${term(view, "mp")} ${actor.mp}/${mmp}`, textColor(0), { font: { family: "sans-serif", size: 12 } }),
    { kind: "gauge", x: x + UI_PADDING, y: y + 60, w: gaugeW, h: 6, ratio: mmp > 0 ? actor.mp / mmp : 0, color: MP_COLOR },
  ];
}

function projectMain(state: GameState, view: ProjectView, screen: Screen, cursor: number): UiNode[] {
  const labels = MENU_ITEMS.map((key) => term(view, key));
  const commandH = labels.length * UI_ROW_HEIGHT + UI_PADDING * 2;
  const infoH = 2 * UI_ROW_HEIGHT + UI_PADDING * 2;
  const partyX = UI_MARGIN * 2 + COMMAND_WIDTH;
  const partyW = screen.width - partyX - UI_MARGIN;

  const party: UiNode[] = [];
  state.party.members.slice(0, 3).forEach((id, i) => party.push(...memberSummary(state, view, id, partyX, UI_MARGIN + UI_PADDING + i * 76, partyW)));
  const infoY = screen.height - UI_MARGIN - infoH;
  return [
    windowNode(UI_MARGIN, UI_MARGIN, COMMAND_WIDTH, commandH, commandRows(UI_MARGIN, UI_MARGIN, COMMAND_WIDTH, labels, cursor)),
    windowNode(UI_MARGIN, infoY, COMMAND_WIDTH, infoH, [
      textNode(UI_MARGIN + UI_PADDING, infoY + UI_PADDING, `${term(view, "gold")} ${state.party.gold}`),
      textNode(UI_MARGIN + UI_PADDING, infoY + UI_PADDING + UI_ROW_HEIGHT, formatPlaytime(state.playtimeTicks)),
    ]),
    windowNode(partyX, UI_MARGIN, partyW, screen.height - UI_MARGIN * 2, party),
  ];
}

function projectItems(state: GameState, view: ProjectView, screen: Screen, cursor: number): UiNode[] {
  const ids = menuItemIds(state);
  const x = UI_MARGIN;
  const y = UI_MARGIN;
  const w = screen.width - UI_MARGIN * 2;
  const h = screen.height - UI_MARGIN * 2;
  const rows = Math.max(1, Math.floor((h - 28 - UI_PADDING) / UI_ROW_HEIGHT));
  const first = firstVisible(cursor, ids.length, rows);
  const children: UiNode[] = [textNode(x + UI_PADDING, y + UI_PADDING, term(view, "item"), textColor(6))];
  if (ids.length === 0) children.push(textNode(x + UI_PADDING, y + 30, term(view, "noItems"), textColor(7)));
  ids.slice(first, first + rows).forEach((id, i) => {
    const ty = y + 28 + i * UI_ROW_HEIGHT + 2;
    const name = view.item(id as never)?.name ?? id;
    children.push(textNode(x + UI_PADDING, ty, name));
    children.push(textNode(x + w - UI_PADDING, ty, `× ${state.party.items[id as keyof typeof state.party.items]}`, textColor(0), { align: "right" }));
  });
  if (ids.length > 0) children.push(cursorNode(x + 4, y + 28 + (cursor - first) * UI_ROW_HEIGHT, w - 8));
  return [windowNode(x, y, w, h, children)];
}

function projectStatus(state: GameState, view: ProjectView, screen: Screen, cursor: number): UiNode[] {
  const id = state.party.members[cursor];
  const actor = id === undefined ? undefined : actorOf(state, id);
  const x = UI_MARGIN;
  const y = UI_MARGIN;
  const w = screen.width - UI_MARGIN * 2;
  const h = screen.height - UI_MARGIN * 2;
  if (id === undefined || actor === undefined) return [windowNode(x, y, w, h, [textNode(x + UI_PADDING, y + UI_PADDING, term(view, "status"), textColor(6))])];

  const def = view.actor(actor.id);
  const cls = view.class(def?.classId ?? ("" as never));
  const children: UiNode[] = [
    textNode(x + UI_PADDING, y + UI_PADDING, `${term(view, "status")}  ${cursor + 1}/${state.party.members.length}`, textColor(6)),
    textNode(x + UI_PADDING, y + 36, `${actor.name}  ${cls?.name ?? ""}`),
    textNode(x + UI_PADDING, y + 60, `${term(view, "level")} ${actor.level}   ${term(view, "exp")} ${actor.exp}`, EXP_COLOR),
  ];
  const mhp = Math.max(1, paramAt(cls, "mhp", actor.level));
  const mmp = paramAt(cls, "mmp", actor.level);
  const gaugeW = Math.min(160, w - UI_PADDING * 2);
  children.push(
    textNode(x + UI_PADDING, y + 88, `${term(view, "hp")} ${actor.hp}/${mhp}`),
    { kind: "gauge", x: x + UI_PADDING, y: y + 108, w: gaugeW, h: 6, ratio: actor.hp / mhp, color: HP_COLOR },
    textNode(x + UI_PADDING, y + 118, `${term(view, "mp")} ${actor.mp}/${mmp}`),
    { kind: "gauge", x: x + UI_PADDING, y: y + 138, w: gaugeW, h: 6, ratio: mmp > 0 ? actor.mp / mmp : 0, color: MP_COLOR },
  );
  const colW = Math.floor((w - UI_PADDING * 2) / 2);
  PARAMS.slice(2).forEach((param, i) => {
    const px = x + UI_PADDING + (i % 2) * colW;
    const py = y + 156 + Math.floor(i / 2) * 20;
    children.push(textNode(px, py, `${term(view, param)} ${paramAt(cls, param, actor.level)}`, textColor(0), { font: { family: "sans-serif", size: 14 } }));
  });
  if (def?.face !== undefined) children.push({ kind: "image", x: x + w - UI_PADDING - 72, y: y + UI_PADDING, asset: def.face.asset, sx: 0, sy: 0, sw: 72, sh: 72 });
  return [windowNode(x, y, w, h, children)];
}

/** メニューの投影。画面（メイン/アイテム/ステータス/セーブ/ロード）ごとに 1 つのウィンドウ構成。 */
export function projectMenu(state: GameState, view: ProjectView, screen: Screen, ui: UiContext): UiNode[] {
  const scene = state.scene;
  if (scene.kind !== "menu") return [];
  switch (scene.screen) {
    case "main":
      return projectMain(state, view, screen, scene.cursor);
    case "item":
      return projectItems(state, view, screen, scene.cursor);
    case "status":
      return projectStatus(state, view, screen, scene.cursor);
    case "save":
    case "load": {
      const list = projectSlotList(view, screen, scene.screen, scene.cursor, ui);
      return scene.confirm === undefined ? list : [...list, ...projectConfirm(view, screen, scene.confirm)];
    }
  }
}
