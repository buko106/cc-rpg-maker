import type { GameState, MenuPick, ProjectView } from "@rpg/core";
import { fieldItemUsable, fieldSkills, fieldSkillUsable, menuItemIds, menuItems, paramAt } from "@rpg/core";
import type { Param } from "@rpg/schema";
import type { UiNode } from "../frame-spec.js";
import { projectConfirm } from "./confirm.js";
import { HELP_HEIGHT, helpWindow } from "./describe.js";
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
  const labels = menuItems(view).map((key) => term(view, key));
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

/** 対象の味方を選ぶ画面の右側：パーティの一覧（HP/MP のゲージつき）。選んでいる人にカーソルが付く（一人を選ぶ範囲のときだけ、この画面が出る）。 */
function projectTargets(state: GameState, view: ProjectView, screen: Screen, x: number, pick: MenuPick): UiNode[] {
  const w = screen.width - x - UI_MARGIN;
  const rowH = 76;
  const children: UiNode[] = [];
  state.party.members.slice(0, 4).forEach((id, i) => {
    const y = UI_MARGIN + UI_PADDING + i * rowH;
    children.push(...memberSummary(state, view, id, x, y, w));
    if (i === pick.cursor) children.push({ kind: "cursor", x: x + 4, y: y - 4, w: w - 8, h: rowH - 4, blink: false });
  });
  return [windowNode(x, UI_MARGIN, w, screen.height - UI_MARGIN * 2, children)];
}

/** 説明の窓を下に置くぶん、上の窓に使える画面の高さ。 */
const aboveHelp = (screen: Screen): Screen => ({ width: screen.width, height: screen.height - HELP_HEIGHT - UI_MARGIN });

/** 画面の下端に置く説明の窓（選んでいるアイテム/スキルの説明）。 */
const projectHelp = (view: ProjectView, screen: Screen, def: Parameters<typeof helpWindow>[1]): UiNode =>
  helpWindow(view, def, UI_MARGIN, screen.height - UI_MARGIN - HELP_HEIGHT, screen.width - UI_MARGIN * 2);

/** 一覧の窓の幅（対象を選んでいる間は左に寄せて、右にパーティを出す）。 */
const listWidth = (screen: Screen, picking: boolean): number => (picking ? Math.floor(screen.width * 0.5) - UI_MARGIN : screen.width - UI_MARGIN * 2);

function projectItems(state: GameState, view: ProjectView, screen: Screen, cursor: number, pick: MenuPick | undefined): UiNode[] {
  const ids = menuItemIds(state);
  const x = UI_MARGIN;
  const y = UI_MARGIN;
  const w = listWidth(screen, pick !== undefined);
  const upper = aboveHelp(screen);
  const h = upper.height - UI_MARGIN * 2;
  const rows = Math.max(1, Math.floor((h - 28 - UI_PADDING) / UI_ROW_HEIGHT));
  const first = firstVisible(cursor, ids.length, rows);
  const children: UiNode[] = [textNode(x + UI_PADDING, y + UI_PADDING, term(view, "item"), textColor(6))];
  if (ids.length === 0) children.push(textNode(x + UI_PADDING, y + 30, term(view, "noItems"), textColor(7)));
  ids.slice(first, first + rows).forEach((id, i) => {
    const ty = y + 28 + i * UI_ROW_HEIGHT + 2;
    const item = view.item(id as never);
    const color = fieldItemUsable(item) ? textColor(0) : textColor(7);
    children.push(textNode(x + UI_PADDING, ty, item?.name ?? id, color));
    children.push(textNode(x + w - UI_PADDING, ty, `× ${state.party.items[id as keyof typeof state.party.items]}`, color, { align: "right" }));
  });
  if (ids.length > 0) children.push(cursorNode(x + 4, y + 28 + (cursor - first) * UI_ROW_HEIGHT, w - 8));
  const list = windowNode(x, y, w, h, children);
  const help = projectHelp(view, screen, view.item(ids[cursor] as never));
  return pick === undefined ? [list, help] : [list, ...projectTargets(state, view, upper, x + w + UI_MARGIN, pick), help];
}

/** スキル画面：使う人を選ぶ（パーティ一覧）→ その人のスキルの一覧 →（一人を選ぶ範囲なら）対象の味方。 */
function projectSkills(state: GameState, view: ProjectView, screen: Screen, scene: Extract<GameState["scene"], { kind: "menu" }>): UiNode[] {
  const x = UI_MARGIN;
  const y = UI_MARGIN;
  const h = screen.height - UI_MARGIN * 2;
  const userId = scene.actor === undefined ? undefined : state.party.members[scene.actor];
  const user = userId === undefined ? undefined : actorOf(state, userId);
  if (userId === undefined || user === undefined) {
    const w = listWidth(screen, false);
    const children: UiNode[] = [textNode(x + UI_PADDING, y + UI_PADDING, term(view, "skill"), textColor(6))];
    state.party.members.forEach((id, i) => {
      const actor = actorOf(state, id);
      if (actor === undefined) return;
      const ty = y + 28 + i * UI_ROW_HEIGHT + 2;
      children.push(textNode(x + UI_PADDING, ty, `${actor.name}  ${term(view, "level")}${actor.level}`));
      children.push(textNode(x + w - UI_PADDING, ty, `${term(view, "hp")} ${actor.hp}   ${term(view, "mp")} ${actor.mp}`, textColor(0), { align: "right" }));
    });
    if (state.party.members.length > 0) children.push(cursorNode(x + 4, y + 28 + scene.cursor * UI_ROW_HEIGHT, w - 8));
    return [windowNode(x, y, w, h, children)];
  }

  const w = listWidth(screen, scene.pick !== undefined);
  const upper = aboveHelp(screen);
  const cls = view.class(view.actor(user.id)?.classId ?? ("" as never));
  const mmp = paramAt(cls, "mmp", user.level);
  const skills = fieldSkills(state, { project: view }, user.id);
  const listH = upper.height - UI_MARGIN * 2;
  const rows = Math.max(1, Math.floor((listH - 28 - UI_PADDING) / UI_ROW_HEIGHT));
  const first = firstVisible(scene.cursor, skills.length, rows);
  const children: UiNode[] = [
    textNode(x + UI_PADDING, y + UI_PADDING, `${term(view, "skill")}  ${user.name}`, textColor(6)),
    textNode(x + w - UI_PADDING, y + UI_PADDING, `${term(view, "mp")} ${user.mp}/${mmp}`, MP_COLOR, { align: "right" }),
  ];
  if (skills.length === 0) children.push(textNode(x + UI_PADDING, y + 30, term(view, "noItems"), textColor(7)));
  skills.slice(first, first + rows).forEach((skill, i) => {
    const ty = y + 28 + i * UI_ROW_HEIGHT + 2;
    const color = fieldSkillUsable(skill) && skill.mpCost <= user.mp ? textColor(0) : textColor(7);
    children.push(textNode(x + UI_PADDING, ty, skill.name, color));
    children.push(textNode(x + w - UI_PADDING, ty, `${term(view, "mp")} ${skill.mpCost}`, color, { align: "right" }));
  });
  if (skills.length > 0) children.push(cursorNode(x + 4, y + 28 + (scene.cursor - first) * UI_ROW_HEIGHT, w - 8));
  const list = windowNode(x, y, w, listH, children);
  const help = projectHelp(view, screen, skills[scene.cursor]);
  return scene.pick === undefined ? [list, help] : [list, ...projectTargets(state, view, upper, x + w + UI_MARGIN, scene.pick), help];
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

/** メニューの投影。画面（メイン/アイテム/スキル/ステータス/セーブ/ロード）ごとに 1 つのウィンドウ構成。 */
export function projectMenu(state: GameState, view: ProjectView, screen: Screen, ui: UiContext): UiNode[] {
  const scene = state.scene;
  if (scene.kind !== "menu") return [];
  switch (scene.screen) {
    case "main":
      return projectMain(state, view, screen, scene.cursor);
    case "item":
      return projectItems(state, view, screen, scene.cursor, scene.pick);
    case "skill":
      return projectSkills(state, view, screen, scene);
    case "status":
      return projectStatus(state, view, screen, scene.cursor);
    case "save":
    case "load": {
      const list = projectSlotList(view, screen, scene.screen, scene.cursor, ui);
      return scene.confirm === undefined ? list : [...list, ...projectConfirm(view, screen, scene.confirm)];
    }
  }
}
