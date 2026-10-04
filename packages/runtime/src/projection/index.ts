import type { GameState, ProjectView } from "@rpg/core";
import type { FrameSpec } from "../frame-spec.js";
import { fxOverlay, NO_FX } from "../visual-fx.js";
import type { VisualFx } from "../visual-fx.js";
import { projectBattle, projectGameOver } from "./battle.js";
import { projectMapLayers } from "./map-scene.js";
import { projectMenu } from "./menu.js";
import { projectMessage } from "./message.js";
import { projectShop } from "./shop.js";
import { projectTitle } from "./title.js";
import { term } from "./terms.js";
import { NO_UI, textNode, windowNode } from "./ui.js";
import { projectTimer } from "./timer.js";
import type { UiContext } from "./ui.js";
import type { UiNode } from "../frame-spec.js";

/**
 * お知らせ（セーブ完了など）。タイトル・メニューでは下端、マップ上では上端（イベントのセーブ・オートセーブの後に出る。下端はメッセージウィンドウと重なる）。
 */
function projectNotice(view: ProjectView, ui: UiContext, screen: { width: number; height: number }, at: "top" | "bottom" = "bottom"): UiNode[] {
  if (ui.notice === undefined) return [];
  const w = 220;
  const h = 32;
  const x = Math.round((screen.width - w) / 2);
  const y = at === "top" ? 8 : screen.height - 8 - h - 4;
  return [windowNode(x, y, w, h, [textNode(screen.width / 2, y + 7, term(view, ui.notice), { r: 255, g: 255, b: 255, a: 1 }, { align: "center" })])];
}

/**
 * `GameState` → `FrameSpec`。純粋関数（同じ入力なら deep-equal な出力）。
 * マップシーン（とメッセージ）、タイトル、メニュー、ショップ、戦闘、ゲームオーバーを投影する。
 * `ui` は GameState の外にある情報（保存済みスロット一覧・お知らせ）。
 */
export function projectFrame(state: GameState, view: ProjectView, fx: VisualFx = NO_FX, ui: UiContext = NO_UI): FrameSpec {
  const { screen } = view.project.system;
  const overlay = fxOverlay(fx);
  const size = { width: screen.width, height: screen.height };
  if (state.scene.kind === "title") return { size, camera: { x: 0, y: 0 }, layers: [], overlay, ui: [...projectTitle(state, view, size, ui), ...projectNotice(view, ui, size)] };
  if (state.scene.kind === "menu") {
    // メニューはマップの上に重ねる（背景にマップが見える）
    const under = projectFrame({ ...state, scene: { kind: "map" } }, view, fx);
    return { ...under, ui: [{ kind: "window", x: 0, y: 0, w: size.width, h: size.height, variant: "dim", children: [] }, ...projectMenu(state, view, size, ui), ...projectNotice(view, ui, size)] };
  }
  if (state.scene.kind === "shop") {
    // ショップもマップの上に重ねる（メニューと同じ）
    const under = projectFrame({ ...state, scene: { kind: "map" } }, view, fx);
    return { ...under, ui: [{ kind: "window", x: 0, y: 0, w: size.width, h: size.height, variant: "dim", children: [] }, ...projectShop(state, view, size)] };
  }
  if (state.scene.kind === "battle") {
    // 戦闘はマップの地形を背景にして（キャラクターは描かず、暗くして）重ねる
    const under = projectFrame({ ...state, scene: { kind: "map" } }, view, fx);
    // 敵グループのバトルイベントのメッセージは、戦闘の画面の上に重ねる
    const message = state.message.open ? projectMessage(state, (id) => (Object.hasOwn(state.actors, id) ? state.actors[id as keyof typeof state.actors]?.name : undefined), screen) : [];
    return { ...under, layers: under.layers.filter((l) => l.kind === "tiles"), ui: [...projectBattle(state, view, size), ...message] };
  }
  if (state.scene.kind === "gameover") return { size, camera: { x: 0, y: 0 }, layers: [], overlay, ui: projectGameOver(view, size) };

  const { tileSize, layers } = projectMapLayers(state, view);
  return {
    size: { width: screen.width, height: screen.height },
    camera: { x: Math.round(state.map.camera.x * tileSize), y: Math.round(state.map.camera.y * tileSize) },
    layers,
    overlay,
    ui: [
      ...projectTimer(state, screen),
      ...projectMessage(state, (id) => (Object.hasOwn(state.actors, id) ? state.actors[id as keyof typeof state.actors]?.name : undefined), screen),
      ...projectNotice(view, ui, screen, "top"),
    ],
  };
}

export { projectMapLayers } from "./map-scene.js";
export { projectMessage } from "./message.js";
export { projectMenu } from "./menu.js";
export { projectShop } from "./shop.js";
export { BATTLE_LOG_LINES, projectBattle, projectGameOver } from "./battle.js";
export { formatLogEntry } from "./battle-log.js";
export { projectTitle } from "./title.js";
export { NO_UI } from "./ui.js";
export type { UiContext } from "./ui.js";
export { term } from "./terms.js";
export type { NoticeKey, TermKey } from "./terms.js";
