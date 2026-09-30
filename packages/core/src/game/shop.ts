import type { Item, ItemId } from "@rpg/schema";
import type { Ctx } from "../ctx-types.js";
import type { InputFrame } from "../input.js";
import type { GameState, ShopScene } from "../state.js";
import type { StepResult } from "./actions.js";

/** 1 種類のアイテムを持てる上限（買うときの数量の上限になる）。 */
export const SHOP_ITEM_LIMIT = 99;

/** ショップのコマンド（`ShopScene.cursor` の意味。表示文言は runtime が `system.terms[key]` から引く）。売却しない店は `sell` が無い。 */
export const shopCommands = (scene: Pick<ShopScene, "canSell">): readonly ("buy" | "sell" | "quit")[] => (scene.canSell ? ["buy", "sell", "quit"] : ["buy", "quit"]);

/** 売値（買値の半分、端数は切り捨て）。 */
export const sellPrice = (item: Item): number => Math.floor(item.price / 2);

const owned = (state: GameState, id: ItemId): number => state.party.items[id] ?? 0;

/** 売れるアイテムか（大事なものと、値段のないものは売れない）。 */
export const isSellable = (item: Item | undefined): item is Item => item !== undefined && item.kind !== "key" && item.price > 0;

/** 売却の一覧に並ぶアイテム ID（持っていて売れるもの。ID の昇順）。 */
export function sellableItemIds(state: GameState, ctx: Pick<Ctx, "project">): ItemId[] {
  return (Object.keys(state.party.items) as ItemId[]).filter((id) => owned(state, id) > 0 && isSellable(ctx.project.item(id))).sort();
}

/** 一度に買える最大数：所持金で買える数と、持てる上限の残りの小さい方（0 なら買えない）。 */
export function maxBuyQuantity(state: GameState, item: Item): number {
  const room = Math.max(0, SHOP_ITEM_LIMIT - owned(state, item.id));
  return item.price === 0 ? room : Math.min(room, Math.floor(state.party.gold / item.price));
}

/** 今の画面に並ぶアイテム ID（コマンド画面では商品を見せるだけ）。 */
export const shopListIds = (state: GameState, scene: ShopScene, ctx: Pick<Ctx, "project">): readonly ItemId[] =>
  scene.screen === "sell" ? sellableItemIds(state, ctx) : scene.goods;

/** ショップを開く。`owner` は呼び出したインタプリタの id。 */
export const openShop = (state: GameState, goods: readonly ItemId[], canSell: boolean, owner: string): GameState => ({
  ...state,
  scene: { kind: "shop", goods, canSell, owner, screen: "command", cursor: 0 },
});

const wrap = (n: number, delta: number, count: number): number => (count <= 0 ? 0 : (((n + delta) % count) + count) % count);
const vertical = (input: InputFrame): number => (input.triggered.has("down") ? 1 : 0) - (input.triggered.has("up") ? 1 : 0);
const horizontal = (input: InputFrame): number => (input.triggered.has("right") ? 1 : 0) - (input.triggered.has("left") ? 1 : 0);

/** 一覧（購入/売却）から見たコマンド画面のカーソル位置（戻ったとき、そのコマンドの上に重なる）。 */
const commandCursor = (scene: ShopScene): number => Math.max(0, shopCommands(scene).indexOf(scene.screen as "buy" | "sell"));
const withoutQuantity = (scene: ShopScene): ShopScene => {
  const { quantity: _quantity, ...rest } = scene;
  return rest;
};

const at = (state: GameState, scene: ShopScene): StepResult => ({ state: { ...state, scene }, effects: [] });
const closed = (state: GameState): StepResult => ({ state: { ...state, scene: { kind: "map" } }, effects: [] });

/** 数量を選ぶ画面で選べる最大数。 */
function quantityMax(state: GameState, scene: ShopScene, item: Item): number {
  return scene.screen === "buy" ? maxBuyQuantity(state, item) : owned(state, item.id);
}

/** 数量を確定して売り買いする。売却で一覧が空になったらコマンドに戻る。 */
function settle(state: GameState, scene: ShopScene, item: Item, quantity: number, ctx: Ctx): StepResult {
  const buying = scene.screen === "buy";
  const count = owned(state, item.id) + (buying ? quantity : -quantity);
  const items = { ...state.party.items };
  if (count <= 0) delete items[item.id];
  else items[item.id] = count;
  const gold = state.party.gold + (buying ? -item.price : sellPrice(item)) * quantity;
  const next: GameState = { ...state, party: { ...state.party, gold, items } };
  const list = withoutQuantity(scene);
  const rows = shopListIds(next, list, ctx).length;
  if (rows === 0) return at(next, { ...list, screen: "command", cursor: commandCursor(scene) });
  return at(next, { ...list, cursor: Math.min(list.cursor, rows - 1) });
}

/**
 * ショップ画面の入力。
 * - コマンド：左右（上下）で選び、決定で購入/売却の一覧へ（やめる・キャンセルでマップに戻る）。
 * - 一覧：上下でカーソル、決定で数量の選択へ（買えない・売れるものが無いときは何も起きない）、キャンセルでコマンドへ。
 * - 数量：上下で ±1、左右で ±10（1 〜 最大の範囲で止まる）、決定で売り買い、キャンセルで一覧へ。
 * 売り買いの結果（所持金・所持数）は `GameState` に直接書く。
 */
export function handleShopInput(state: GameState, input: InputFrame, ctx: Ctx): StepResult {
  const scene = state.scene;
  if (scene.kind !== "shop") return { state, effects: [] };
  const ok = input.triggered.has("ok");
  const cancel = input.triggered.has("cancel");

  if (scene.screen === "command") {
    const commands = shopCommands(scene);
    if (cancel) return closed(state);
    const dx = horizontal(input) || vertical(input);
    if (dx !== 0) return at(state, { ...scene, cursor: wrap(scene.cursor, dx, commands.length) });
    if (!ok) return { state, effects: [] };
    const chosen = commands[scene.cursor];
    if (chosen === "quit" || chosen === undefined) return closed(state);
    return at(state, { ...scene, screen: chosen, cursor: 0 });
  }

  const ids = shopListIds(state, scene, ctx);
  const id = ids[scene.cursor];
  const item = id === undefined ? undefined : ctx.project.item(id);

  if (scene.quantity !== undefined) {
    if (item === undefined || cancel) return at(state, withoutQuantity(scene));
    const max = quantityMax(state, scene, item);
    const delta = -vertical(input) + horizontal(input) * 10; // 上で増える（数値入力と同じ）
    if (delta !== 0) return at(state, { ...scene, quantity: Math.min(Math.max(scene.quantity + delta, 1), Math.max(max, 1)) });
    return ok && max >= 1 ? settle(state, scene, item, Math.min(scene.quantity, max), ctx) : { state, effects: [] };
  }

  if (cancel) return at(state, { ...scene, screen: "command", cursor: commandCursor(scene) });
  const dy = vertical(input);
  if (dy !== 0) return at(state, { ...scene, cursor: wrap(scene.cursor, dy, ids.length) });
  if (!ok || item === undefined || quantityMax(state, scene, item) < 1) return { state, effects: [] };
  return at(state, { ...scene, quantity: 1 });
}
