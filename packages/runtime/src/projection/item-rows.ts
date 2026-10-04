import type { ItemCategory, ProjectView } from "@rpg/core";
import { itemCategory } from "@rpg/core";
import type { RGBA } from "@rpg/core";
import type { UiNode } from "../frame-spec.js";
import { term } from "./terms.js";
import type { TermKey } from "./terms.js";
import { textColor } from "./theme.js";
import { textNode } from "./ui.js";

/** 品物の一覧の 1 行：分類の見出し、または品物（`index` は品物だけを数えた位置＝カーソルの位置）。 */
export type ItemRow<T extends string> = { readonly kind: "header"; readonly category: ItemCategory } | { readonly kind: "item"; readonly id: T; readonly index: number };

const CATEGORY_TERM: Record<ItemCategory, TermKey> = { item: "item", weapon: "equipWeapon", armor: "equipArmor", accessory: "equipAccessory", key: "keyItem" };
const HEADER_FONT = { family: "sans-serif", size: 12 } as const;

/**
 * 品物の一覧（分類の順に並んだ `ids`。core の `sortByCategory`）を、分類が変わるところに見出しを挟んだ行にする。
 * 分類が 1 つしかなければ見出しは付けない（これまでどおりの一覧）。
 */
export function itemRows<T extends string>(ids: readonly T[], view: ProjectView): ItemRow<T>[] {
  const categories = ids.map((id) => itemCategory(view.item(id as never)));
  const grouped = new Set(categories).size > 1;
  const rows: ItemRow<T>[] = [];
  ids.forEach((id, index) => {
    const category = categories[index]!;
    if (grouped && (index === 0 || categories[index - 1] !== category)) rows.push({ kind: "header", category });
    rows.push({ kind: "item", id, index });
  });
  return rows;
}

/** カーソル（品物の位置）が何行目にあるか。品物が無ければ 0。 */
export const rowOfItem = <T extends string>(rows: readonly ItemRow<T>[], index: number): number => Math.max(0, rows.findIndex((r) => r.kind === "item" && r.index === index));

/** 見出しの行（小さめの水色の文字）。 */
export const headerNode = (view: ProjectView, category: ItemCategory, x: number, y: number, color: RGBA = textColor(4)): UiNode =>
  textNode(x, y + 4, term(view, CATEGORY_TERM[category]), color, { font: HEADER_FONT });
