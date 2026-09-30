import type { BattleCommand, BattleState, Battler, EnemyBattler, GameState, ProjectView } from "@rpg/core";
import { battleCommands, isAlive, learnedSkills, targetCandidates, usableItems } from "@rpg/core";
import type { ActorId, Skill } from "@rpg/schema";
import type { FontSpec, UiNode } from "../frame-spec.js";
import { formatLogEntry } from "./battle-log.js";
import { term } from "./terms.js";
import { EXP_COLOR, HP_COLOR, MP_COLOR, textColor, UI_MARGIN, UI_PADDING, UI_ROW_HEIGHT } from "./theme.js";
import { commandRows, cursorNode, firstVisible, textNode, windowNode } from "./ui.js";

type Screen = { width: number; height: number };

const SMALL_FONT: FontSpec = { family: "sans-serif", size: 12 };
const MID_FONT: FontSpec = { family: "sans-serif", size: 14 };
const POPUP_FONT: FontSpec = { family: "sans-serif", size: 20, bold: true };

/** 画面上部のログに出す行数。 */
export const BATTLE_LOG_LINES = 3;
const LOG_LINE_HEIGHT = 20;
const STATUS_ROW = 44;
const COMMAND_WIDTH = 112;
/** スキル/アイテムの一覧に出す行数（超えたらカーソル中心にスクロール）。 */
const LIST_ROWS = 5;
/** 名前だけで敵を表示するときの大きさ。 */
const PLACEHOLDER = { w: 72, h: 40 };
const DEFAULT_ENEMY_SIZE = { w: 64, h: 64 };
const POPUP_RISE_DIVISOR = 3;
const POPUP_TTL_FULL = 45;

const WHITE = { r: 255, g: 255, b: 255, a: 1 } as const;

/** 敵の表示範囲（左上と大きさ）。中心が `x, y` に来る。 */
function enemyRect(view: ProjectView, enemy: EnemyBattler): { x: number; y: number; w: number; h: number; image?: { asset: string; w: number; h: number } } {
  const graphic = view.enemy(enemy.enemyId)?.graphic;
  if (graphic === undefined) return { x: Math.round(enemy.x - PLACEHOLDER.w / 2), y: Math.round(enemy.y - PLACEHOLDER.h / 2), ...PLACEHOLDER };
  const entry = Object.hasOwn(view.project.assets.entries, graphic.asset) ? view.project.assets.entries[graphic.asset] : undefined;
  const w = entry?.width ?? DEFAULT_ENEMY_SIZE.w;
  const h = entry?.height ?? DEFAULT_ENEMY_SIZE.h;
  return { x: Math.round(enemy.x - w / 2), y: Math.round(enemy.y - h / 2), w, h, image: { asset: graphic.asset, w, h } };
}

function projectEnemies(b: BattleState, view: ProjectView, targeted: string | undefined): UiNode[] {
  const nodes: UiNode[] = [];
  for (const id of b.enemyOrder) {
    const enemy = b.enemies[id];
    if (enemy === undefined || !isAlive(enemy) || enemy.hidden) continue;
    const r = enemyRect(view, enemy);
    if (r.image !== undefined) {
      nodes.push({ kind: "image", x: r.x, y: r.y, asset: r.image.asset as never, sx: 0, sy: 0, sw: r.image.w, sh: r.image.h });
      nodes.push(textNode(Math.round(enemy.x), r.y + r.h + 2, enemy.name, WHITE, { font: SMALL_FONT, align: "center" }));
    } else {
      nodes.push(windowNode(r.x, r.y, r.w, r.h, [textNode(Math.round(enemy.x), r.y + Math.round((r.h - 16) / 2), enemy.name, WHITE, { align: "center", maxWidth: r.w - 8 })]));
    }
    if (id === targeted) nodes.push({ kind: "cursor", x: r.x - 2, y: r.y - 2, w: r.w + 4, h: r.h + 4, blink: false });
  }
  return nodes;
}

/** 上部のログ：最後の数行。 */
function projectLog(state: GameState, view: ProjectView, screen: Screen): UiNode[] {
  const b = state.battle!;
  const lines = b.log.flatMap((entry) => formatLogEntry(entry, state, view)).slice(-BATTLE_LOG_LINES);
  if (lines.length === 0) return [];
  const h = BATTLE_LOG_LINES * LOG_LINE_HEIGHT + UI_PADDING * 2;
  return [
    windowNode(UI_MARGIN, UI_MARGIN, screen.width - UI_MARGIN * 2, h, lines.map((line, i) => textNode(UI_MARGIN + UI_PADDING, UI_MARGIN + UI_PADDING + i * LOG_LINE_HEIGHT, line, WHITE, { font: MID_FONT }))),
  ];
}

function stateLabel(view: ProjectView, battler: Battler): string {
  return battler.states.map((s) => view.state(s.id)?.name ?? s.id).join(" ");
}

/** 味方のステータス（名前・HP/MP・状態）。`highlight` の行にはカーソルを重ねる。 */
function projectStatus(b: BattleState, view: ProjectView, x: number, w: number, bottom: number, highlight: string | undefined): UiNode[] {
  const party = b.party.flatMap((id) => (b.allies[id] === undefined ? [] : [b.allies[id]]));
  const h = party.length * STATUS_ROW + UI_PADDING * 2;
  const y = bottom - h;
  const children: UiNode[] = [];
  party.forEach((m, i) => {
    const ry = y + UI_PADDING + i * STATUS_ROW;
    const dim = !isAlive(m);
    const color = dim ? textColor(2) : WHITE;
    children.push(textNode(x + UI_PADDING, ry, m.name, color, { maxWidth: Math.round(w / 2) - UI_PADDING }));
    children.push(textNode(x + w - UI_PADDING, ry + 2, `${term(view, "hp")} ${m.hp}/${m.params.mhp}`, color, { font: MID_FONT, align: "right" }));
    children.push({ kind: "gauge", x: x + UI_PADDING, y: ry + 20, w: w - UI_PADDING * 2, h: 4, ratio: m.params.mhp > 0 ? m.hp / m.params.mhp : 0, color: HP_COLOR });
    const label = stateLabel(view, m);
    if (label !== "") children.push(textNode(x + UI_PADDING, ry + 26, label, textColor(2), { font: SMALL_FONT }));
    children.push(textNode(x + w - UI_PADDING, ry + 26, `${term(view, "mp")} ${m.mp}/${m.params.mmp}`, color, { font: SMALL_FONT, align: "right" }));
    children.push({ kind: "gauge", x: x + UI_PADDING, y: ry + 39, w: w - UI_PADDING * 2, h: 3, ratio: m.params.mmp > 0 ? m.mp / m.params.mmp : 0, color: MP_COLOR });
    if (m.id === highlight) children.push({ kind: "cursor", x: x + 4, y: ry - 3, w: w - 8, h: STATUS_ROW - 2, blink: false });
  });
  return [windowNode(x, y, w, h, children)];
}

const COMMAND_KEY = { attack: "attack", skill: "skill", item: "item", guard: "guard", escape: "escape" } as const satisfies Record<BattleCommand, string>;

function projectCommands(b: BattleState, view: ProjectView, bottom: number): UiNode[] {
  const labels = battleCommands(b.canEscape).map((c) => term(view, COMMAND_KEY[c]));
  const h = labels.length * UI_ROW_HEIGHT + UI_PADDING * 2;
  const y = bottom - h;
  return [windowNode(UI_MARGIN, y, COMMAND_WIDTH, h, commandRows(UI_MARGIN, y, COMMAND_WIDTH, labels, b.inputCursor.menu === "command" ? b.inputCursor.index : -1))];
}

/** スキル/アイテムの一覧（画面下いっぱい）。 */
function projectList(state: GameState, view: ProjectView, screen: Screen, bottom: number): UiNode[] {
  const b = state.battle!;
  const cur = b.inputCursor;
  const actorId = b.party[cur.actorIndex];
  const ally = actorId === undefined ? undefined : b.allies[actorId];
  if (actorId === undefined || ally === undefined) return [];

  type Row = { name: string; right: string; enabled: boolean };
  const ctx = { project: view };
  let rows: Row[];
  if (cur.menu === "skill") {
    rows = learnedSkills(ctx, actorId as ActorId, ally.level).map((s: Skill) => ({ name: s.name, right: s.mpCost > 0 ? `${term(view, "mp")} ${s.mpCost}` : "", enabled: s.mpCost <= ally.mp }));
  } else {
    rows = usableItems(state, ctx).map((i) => ({ name: i.name, right: `× ${state.party.items[i.id] ?? 0}`, enabled: true }));
  }
  const w = screen.width - UI_MARGIN * 2;
  const shown = Math.min(LIST_ROWS, Math.max(1, rows.length));
  const h = shown * UI_ROW_HEIGHT + UI_PADDING * 2;
  const y = bottom - h;
  const first = firstVisible(cur.index, rows.length, LIST_ROWS);
  const children: UiNode[] = [];
  rows.slice(first, first + LIST_ROWS).forEach((row, i) => {
    const ty = y + UI_PADDING + i * UI_ROW_HEIGHT + 2;
    const color = row.enabled ? WHITE : textColor(7);
    children.push(textNode(UI_MARGIN + UI_PADDING, ty, row.name, color));
    if (row.right !== "") children.push(textNode(UI_MARGIN + w - UI_PADDING, ty, row.right, color, { align: "right" }));
  });
  if (rows.length > 0) children.push(cursorNode(UI_MARGIN + 4, y + UI_PADDING + (cur.index - first) * UI_ROW_HEIGHT, w - 8));
  return [windowNode(UI_MARGIN, y, w, h, children)];
}

/** ダメージなどの数字。対象の位置から少し浮かび上がる。 */
function projectPopups(b: BattleState, view: ProjectView, statusX: number, statusW: number, statusBottom: number): UiNode[] {
  const nodes: UiNode[] = [];
  const partyCount = b.party.length;
  const statusTop = statusBottom - (partyCount * STATUS_ROW + UI_PADDING * 2);
  for (const p of b.popups) {
    const rise = Math.round((POPUP_TTL_FULL - p.ttl) / POPUP_RISE_DIVISOR);
    const text = p.kind === "miss" ? "MISS" : String(p.amount);
    const color = p.kind === "heal" ? textColor(3) : p.kind === "critical" ? EXP_COLOR : p.kind === "miss" ? textColor(7) : WHITE;
    const enemy = b.enemies[p.target];
    if (enemy !== undefined) {
      const r = enemyRect(view, enemy);
      nodes.push(textNode(Math.round(enemy.x), r.y + Math.round(r.h / 3) - rise, text, color, { font: POPUP_FONT, align: "center" }));
      continue;
    }
    const index = b.party.indexOf(p.target);
    if (index >= 0) {
      const ry = statusTop + UI_PADDING + index * STATUS_ROW;
      nodes.push(textNode(statusX + Math.round(statusW / 2), ry - rise / 2, text, color, { font: POPUP_FONT, align: "center" }));
    }
  }
  return nodes;
}

/**
 * 戦闘画面の UI。マップは背景（暗くする）として `layers` 側に描かれる。
 * 上：ログ。中：敵（絵か名前の箱）とダメージの数字。下：コマンド/スキル/アイテムと味方のステータス。
 */
export function projectBattle(state: GameState, view: ProjectView, screen: Screen): UiNode[] {
  const b = state.battle;
  if (state.scene.kind !== "battle" || b === undefined) return [];
  const cur = b.inputCursor;
  const inInput = b.phase === "input";
  const bottom = screen.height - UI_MARGIN;

  const targeting = inInput && cur.menu === "target" && cur.pick !== null;
  let targetId: string | undefined;
  if (targeting) {
    const pick = cur.pick!;
    const scope = pick.kind === "attack" ? "one-enemy" : pick.kind === "item" ? "one-ally" : (pick.skillId === undefined ? undefined : view.skill(pick.skillId)?.scope) ?? "none";
    targetId = targetCandidates(b, scope)[cur.index];
  }
  const highlightAlly = inInput ? (targetId !== undefined && b.allies[targetId] !== undefined ? targetId : cur.menu === "command" ? b.party[cur.actorIndex] : undefined) : undefined;
  const targetEnemy = targetId !== undefined && b.enemies[targetId] !== undefined ? targetId : undefined;

  // 背景の地形を 2 枚重ねの暗幕で沈める
  const dim: UiNode = { kind: "window", x: 0, y: 0, w: screen.width, h: screen.height, variant: "dim", children: [] };
  const ui: UiNode[] = [dim, dim];
  ui.push(...projectEnemies(b, view, targetEnemy));

  const showList = inInput && (cur.menu === "skill" || cur.menu === "item");
  const showCommands = inInput && cur.menu === "command";
  const statusX = showCommands ? UI_MARGIN * 2 + COMMAND_WIDTH : UI_MARGIN;
  const statusW = screen.width - statusX - UI_MARGIN;
  if (showList) ui.push(...projectList(state, view, screen, bottom));
  else {
    if (showCommands) ui.push(...projectCommands(b, view, bottom));
    ui.push(...projectStatus(b, view, statusX, statusW, bottom, highlightAlly));
  }
  ui.push(...projectPopups(b, view, statusX, statusW, bottom));
  ui.push(...projectLog(state, view, screen));
  return ui;
}

/** ゲームオーバー画面。 */
export function projectGameOver(view: ProjectView, screen: Screen): UiNode[] {
  return [
    { kind: "window", x: 0, y: 0, w: screen.width, h: screen.height, variant: "dim", children: [] },
    textNode(screen.width / 2, Math.round(screen.height / 2) - 16, term(view, "gameOver"), textColor(2), { font: { family: "sans-serif", size: 32, bold: true }, align: "center" }),
  ];
}
