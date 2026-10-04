import type { GameState, MenuPick, ProjectView } from "@rpg/core";
import { actorParamsOf, equipCandidates, equipsOf, fieldItemUsable, fieldSkills, fieldSkillUsable, menuItemIds, menuItems, paramsIfEquipped } from "@rpg/core";
import { EQUIP_SLOTS } from "@rpg/schema";
import type { ActorId, EquipSlot, Param } from "@rpg/schema";
import type { UiNode } from "../frame-spec.js";
import { projectConfirm } from "./confirm.js";
import { HELP_HEIGHT, helpWindow } from "./describe.js";
import { projectSlotList } from "./slot-list.js";
import { term } from "./terms.js";
import type { TermKey } from "./terms.js";
import { EXP_COLOR, HP_COLOR, MP_COLOR, textColor, UI_MARGIN, UI_PADDING, UI_ROW_HEIGHT } from "./theme.js";
import { commandRows, cursorNode, firstVisible, formatPlaytime, textNode, windowNode } from "./ui.js";
import type { UiContext } from "./ui.js";

type Screen = { width: number; height: number };

const COMMAND_WIDTH = 120;
const PARAMS: readonly Param[] = ["mhp", "mmp", "atk", "def", "mat", "mdf", "agi", "luk"];

const actorOf = (state: GameState, id: string) => (Object.hasOwn(state.actors, id) ? state.actors[id as keyof typeof state.actors] : undefined);

/** いまのレベルと装備での能力値（最大 HP は 1 以上）。 */
function paramsOf(state: GameState, view: ProjectView, id: string): Record<Param, number> {
  const params = actorParamsOf(state, { project: view }, id as ActorId);
  return { ...params, mhp: Math.max(1, params.mhp) };
}

/** 名前・レベル・HP/MP ゲージを縦に並べたパーティ一覧の 1 人分（`y` から `ROW` の高さ）。 */
function memberSummary(state: GameState, view: ProjectView, id: string, x: number, y: number, w: number): UiNode[] {
  const actor = actorOf(state, id);
  if (actor === undefined) return [];
  const { mhp, mmp } = paramsOf(state, view, actor.id);
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

/** 人を選ぶ一覧（スキル・装備の画面の最初）：名前・Lv と、右に HP・MP。 */
function memberList(state: GameState, view: ProjectView, screen: Screen, title: TermKey, cursor: number): UiNode {
  const x = UI_MARGIN;
  const y = UI_MARGIN;
  const w = listWidth(screen, false);
  const h = screen.height - UI_MARGIN * 2;
  const children: UiNode[] = [textNode(x + UI_PADDING, y + UI_PADDING, term(view, title), textColor(6))];
  state.party.members.forEach((id, i) => {
    const actor = actorOf(state, id);
    if (actor === undefined) return;
    const ty = y + 28 + i * UI_ROW_HEIGHT + 2;
    children.push(textNode(x + UI_PADDING, ty, `${actor.name}  ${term(view, "level")}${actor.level}`));
    children.push(textNode(x + w - UI_PADDING, ty, `${term(view, "hp")} ${actor.hp}   ${term(view, "mp")} ${actor.mp}`, textColor(0), { align: "right" }));
  });
  if (state.party.members.length > 0) children.push(cursorNode(x + 4, y + 28 + cursor * UI_ROW_HEIGHT, w - 8));
  return windowNode(x, y, w, h, children);
}

/** スキル画面：使う人を選ぶ（パーティ一覧）→ その人のスキルの一覧 →（一人を選ぶ範囲なら）対象の味方。 */
function projectSkills(state: GameState, view: ProjectView, screen: Screen, scene: Extract<GameState["scene"], { kind: "menu" }>): UiNode[] {
  const x = UI_MARGIN;
  const y = UI_MARGIN;
  const userId = scene.actor === undefined ? undefined : state.party.members[scene.actor];
  const user = userId === undefined ? undefined : actorOf(state, userId);
  if (userId === undefined || user === undefined) return [memberList(state, view, screen, "skill", scene.cursor)];

  const w = listWidth(screen, scene.pick !== undefined);
  const upper = aboveHelp(screen);
  const { mmp } = paramsOf(state, view, user.id);
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
  const params = paramsOf(state, view, actor.id);
  const { mhp, mmp } = params;
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
    children.push(textNode(px, py, `${term(view, param)} ${params[param]}`, textColor(0), { font: { family: "sans-serif", size: 14 } }));
  });
  if (def?.face !== undefined) children.push({ kind: "image", x: x + w - UI_PADDING - 72, y: y + UI_PADDING, asset: def.face.asset, sx: 0, sy: 0, sw: 72, sh: 72 });
  return [windowNode(x, y, w, h, children)];
}

const SLOT_TERM: Record<EquipSlot, TermKey> = { weapon: "equipWeapon", armor: "equipArmor", accessory: "equipAccessory" };
const SMALL_FONT = { family: "sans-serif", size: 14 } as const;

/**
 * 装備画面：替える人を選ぶ（パーティ一覧）→ 左上に装備欄、左下に付けられる持ち物（末尾は「外す」）、右に能力値。
 * 付けるものを選んでいる間は、能力値の右に付け替えたあとの値を出す（上がれば緑、下がれば赤）。下端は選んでいるものの説明。
 */
function projectEquip(state: GameState, view: ProjectView, screen: Screen, scene: Extract<GameState["scene"], { kind: "menu" }>): UiNode[] {
  const actorId = scene.actor === undefined ? undefined : state.party.members[scene.actor];
  const actor = actorId === undefined ? undefined : actorOf(state, actorId);
  if (actorId === undefined || actor === undefined) return [memberList(state, view, screen, "equip", scene.cursor)];

  const ctx = { project: view };
  const upper = aboveHelp(screen);
  const leftW = Math.floor(screen.width * 0.55) - UI_MARGIN;
  const x = UI_MARGIN;
  const y = UI_MARGIN;
  const equips = equipsOf(state, ctx, actorId);
  const slot = scene.slot === undefined ? undefined : EQUIP_SLOTS[scene.slot];

  // 装備欄
  const slotH = 28 + EQUIP_SLOTS.length * UI_ROW_HEIGHT + UI_PADDING;
  const labelW = 64;
  const slotChildren: UiNode[] = [textNode(x + UI_PADDING, y + UI_PADDING, `${term(view, "equip")}  ${actor.name}`, textColor(6))];
  EQUIP_SLOTS.forEach((s, i) => {
    const ty = y + 28 + i * UI_ROW_HEIGHT + 2;
    const id = equips[s];
    slotChildren.push(textNode(x + UI_PADDING, ty, term(view, SLOT_TERM[s]), textColor(4)));
    slotChildren.push(textNode(x + UI_PADDING + labelW, ty, id === undefined ? term(view, "noItems") : (view.item(id)?.name ?? id), id === undefined ? textColor(7) : textColor(0)));
  });
  slotChildren.push(cursorNode(x + 4, y + 28 + (scene.slot ?? scene.cursor) * UI_ROW_HEIGHT, leftW - 8));

  // 付けられる持ち物（欄を選んだあとだけ中身が出る）
  const listY = y + slotH + UI_MARGIN;
  const listH = upper.height - UI_MARGIN - listY;
  const candidates = slot === undefined ? [] : equipCandidates(state, ctx, slot);
  const listChildren: UiNode[] = [];
  if (slot !== undefined) {
    const rows = Math.max(1, Math.floor((listH - UI_PADDING * 2) / UI_ROW_HEIGHT));
    const labels = [...candidates.map((id) => view.item(id)?.name ?? id), term(view, "unequip")];
    const first = firstVisible(scene.cursor, labels.length, rows);
    labels.slice(first, first + rows).forEach((label, i) => {
      const ty = listY + UI_PADDING + i * UI_ROW_HEIGHT + 2;
      const id = candidates[first + i];
      listChildren.push(textNode(x + UI_PADDING, ty, label, id === undefined ? textColor(7) : textColor(0)));
      if (id !== undefined) listChildren.push(textNode(x + leftW - UI_PADDING, ty, `× ${state.party.items[id] ?? 0}`, textColor(0), { align: "right" }));
    });
    listChildren.push(cursorNode(x + 4, listY + UI_PADDING + (scene.cursor - first) * UI_ROW_HEIGHT, leftW - 8));
  }

  // 能力値（いま → 付け替えたあと）
  const paramX = x + leftW + UI_MARGIN;
  const paramW = screen.width - paramX - UI_MARGIN;
  const now = paramsOf(state, view, actorId);
  const preview = slot === undefined ? undefined : paramsIfEquipped(state, ctx, actorId, slot, candidates[scene.cursor]);
  const paramChildren: UiNode[] = [textNode(paramX + UI_PADDING, y + UI_PADDING, `${actor.name}  ${term(view, "level")}${actor.level}`, textColor(6))];
  PARAMS.forEach((param, i) => {
    const py = y + 30 + i * 20;
    paramChildren.push(textNode(paramX + UI_PADDING, py, term(view, param), textColor(4), { font: SMALL_FONT }));
    const valueX = preview === undefined ? paramX + paramW - UI_PADDING : paramX + paramW - UI_PADDING - 44;
    paramChildren.push(textNode(valueX, py, String(now[param]), textColor(0), { font: SMALL_FONT, align: "right" }));
    if (preview === undefined) return;
    const after = param === "mhp" ? Math.max(1, preview[param]) : preview[param];
    const color = after > now[param] ? textColor(3) : after < now[param] ? textColor(2) : textColor(0);
    paramChildren.push(textNode(paramX + paramW - UI_PADDING, py, `→ ${after}`, color, { font: SMALL_FONT, align: "right" }));
  });

  // 説明：付けるものを選んでいる間はその候補、欄を選んでいる間はその欄のいまの装備
  const helpId = slot === undefined ? equips[EQUIP_SLOTS[scene.cursor] ?? "weapon"] : candidates[scene.cursor];
  return [
    windowNode(x, y, leftW, slotH, slotChildren),
    windowNode(x, listY, leftW, listH, listChildren),
    windowNode(paramX, y, paramW, upper.height - UI_MARGIN * 2, paramChildren),
    projectHelp(view, screen, helpId === undefined ? undefined : view.item(helpId)),
  ];
}

/** メニューの投影。画面（メイン/アイテム/スキル/装備/ステータス/セーブ/ロード）ごとに 1 つのウィンドウ構成。 */
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
    case "equip":
      return projectEquip(state, view, screen, scene);
    case "status":
      return projectStatus(state, view, screen, scene.cursor);
    case "save":
    case "load": {
      const list = projectSlotList(view, screen, scene.screen, scene.cursor, ui);
      return scene.confirm === undefined ? list : [...list, ...projectConfirm(view, screen, scene.confirm)];
    }
  }
}
