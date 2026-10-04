import type { Item, ItemId } from "@rpg/schema";
import type { ProjectCtx } from "../battle/battlers.js";
import { equipSlotOf } from "./equip.js";

/** 一覧での分類（並ぶ順）：消耗品 → 武器 → 防具 → 装飾品 → 大事なもの。 */
export const ITEM_CATEGORIES = ["item", "weapon", "armor", "accessory", "key"] as const;
export type ItemCategory = (typeof ITEM_CATEGORIES)[number];

/** アイテムの分類。装備は付ける欄（`equipSlotOf`）、大事なものは `key`、それ以外（消耗品・DB に無い ID）は `item`。 */
export function itemCategory(item: Item | undefined): ItemCategory {
  if (item?.kind === "key") return "key";
  return equipSlotOf(item) ?? "item";
}

/** `ids` を分類の順に並べ替える（同じ分類の中では元の順のまま）。 */
export function sortByCategory<T extends string>(ids: readonly T[], ctx: ProjectCtx): T[] {
  const rank = (id: T): number => ITEM_CATEGORIES.indexOf(itemCategory(ctx.project.item(id as string as ItemId)));
  return ids
    .map((id, i) => ({ id, i, r: rank(id) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((e) => e.id);
}
