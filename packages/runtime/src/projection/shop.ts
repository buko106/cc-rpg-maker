import type { GameState, ProjectView, ShopScene } from "@rpg/core";
import { maxBuyQuantity, sellPrice, shopCommands, shopListIds } from "@rpg/core";
import type { UiNode } from "../frame-spec.js";
import { term } from "./terms.js";
import { textColor, UI_MARGIN, UI_PADDING, UI_ROW_HEIGHT } from "./theme.js";
import { cursorNode, firstVisible, textNode, windowNode } from "./ui.js";

type Screen = { width: number; height: number };

const OWNED_COLUMN = 76;
const DIALOG_WIDTH = 240;

const rowY = (top: number, i: number): number => top + UI_PADDING + i * UI_ROW_HEIGHT + 2;

/** 上段の左：購入/売却/やめるを横に並べる。一覧を見ている間は選んだコマンドを黄色にして、カーソルはコマンド画面のときだけ。 */
function projectCommands(view: ProjectView, scene: ShopScene, x: number, w: number): UiNode[] {
  const commands = shopCommands(scene);
  const cell = (w - UI_PADDING * 2) / commands.length;
  const nodes: UiNode[] = commands.map((key, i) => textNode(x + UI_PADDING + i * cell, rowY(UI_MARGIN, 0), term(view, key), scene.screen === key ? textColor(6) : textColor(0)));
  if (scene.screen === "command") nodes.push(cursorNode(x + UI_PADDING - 4 + scene.cursor * cell, UI_MARGIN + UI_PADDING, cell));
  return nodes;
}

/** 品物の一覧。買うときは値段、売るときは売値。所持数を添える。買えないものは灰色。 */
function projectList(state: GameState, view: ProjectView, scene: ShopScene, box: { x: number; y: number; w: number; h: number }): UiNode[] {
  const { x, y, w, h } = box;
  const ids = shopListIds(state, scene, { project: view });
  if (ids.length === 0) return [textNode(x + UI_PADDING, rowY(y, 0), term(view, "noItems"), textColor(7))];
  const rows = Math.max(1, Math.floor((h - UI_PADDING * 2) / UI_ROW_HEIGHT));
  const first = firstVisible(scene.cursor, ids.length, rows);
  const nodes: UiNode[] = [];
  ids.slice(first, first + rows).forEach((id, i) => {
    const item = view.item(id);
    const ty = rowY(y, i);
    const price = item === undefined ? 0 : scene.screen === "sell" ? sellPrice(item) : item.price;
    const color = scene.screen !== "sell" && item !== undefined && maxBuyQuantity(state, item) < 1 ? textColor(7) : textColor(0);
    nodes.push(
      textNode(x + UI_PADDING, ty, item?.name ?? id, color),
      textNode(x + w - UI_PADDING - OWNED_COLUMN, ty, `${term(view, "owned")} ${state.party.items[id] ?? 0}`, color, { align: "right" }),
      textNode(x + w - UI_PADDING, ty, `${price}G`, color, { align: "right" }),
    );
  });
  if (scene.screen !== "command") nodes.push(cursorNode(x + 4, y + UI_PADDING + (scene.cursor - first) * UI_ROW_HEIGHT, w - 8));
  return nodes;
}

/** 数量の選択（画面中央に重ねる）：品名・個数・合計金額。 */
function projectQuantity(state: GameState, view: ProjectView, scene: ShopScene, screen: Screen): UiNode[] {
  const id = shopListIds(state, scene, { project: view })[scene.cursor];
  const item = id === undefined ? undefined : view.item(id);
  if (scene.quantity === undefined || item === undefined) return [];
  const w = Math.min(DIALOG_WIDTH, screen.width - 32);
  const h = UI_ROW_HEIGHT * 3 + UI_PADDING * 2;
  const x = Math.round((screen.width - w) / 2);
  const y = Math.round((screen.height - h) / 2);
  const unit = scene.screen === "sell" ? sellPrice(item) : item.price;
  return [
    windowNode(x, y, w, h, [
      textNode(x + UI_PADDING, rowY(y, 0), item.name, textColor(6)),
      textNode(x + UI_PADDING, rowY(y, 1), `× ${scene.quantity}`),
      textNode(x + w - UI_PADDING, rowY(y, 1), `${unit}G`, textColor(0), { align: "right" }),
      textNode(x + UI_PADDING, rowY(y, 2), term(view, "total")),
      textNode(x + w - UI_PADDING, rowY(y, 2), `${unit * scene.quantity}G`, textColor(0), { align: "right" }),
    ]),
  ];
}

/**
 * ショップの投影。上段に「購入する / 売却する / やめる」、その下に品物の一覧（値段と所持数）、下段に所持金、数量の選択中は中央に小さなウィンドウ。
 */
export function projectShop(state: GameState, view: ProjectView, screen: Screen): UiNode[] {
  const scene = state.scene;
  if (scene.kind !== "shop") return [];
  const barH = UI_ROW_HEIGHT + UI_PADDING * 2;
  const w = screen.width - UI_MARGIN * 2;
  const goldY = screen.height - UI_MARGIN - barH;
  const list = { x: UI_MARGIN, y: UI_MARGIN * 2 + barH, w, h: goldY - UI_MARGIN - (UI_MARGIN * 2 + barH) };
  return [
    windowNode(UI_MARGIN, UI_MARGIN, w, barH, projectCommands(view, scene, UI_MARGIN, w)),
    windowNode(list.x, list.y, list.w, list.h, projectList(state, view, scene, list)),
    windowNode(UI_MARGIN, goldY, w, barH, [
      textNode(UI_MARGIN + UI_PADDING, rowY(goldY, 0), term(view, "gold"), textColor(6)),
      textNode(UI_MARGIN + w - UI_PADDING, rowY(goldY, 0), `${state.party.gold}G`, textColor(0), { align: "right" }),
    ]),
    ...projectQuantity(state, view, scene, screen),
  ];
}
