import type { ItemId } from "@rpg/schema";
import { battleKit } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import type { GameState } from "../state.js";
import { itemCategory, sortByCategory } from "./item-order.js";
import { menuItemIds } from "./scenes.js";
import { sellableItemIds, shopListIds } from "./shop.js";

/** 消耗品（potion・elixir）・武器（sword・axe）・防具（mail）・装飾品（ring）・大事なもの（map）。 */
const kit = battleKit({
  mutate: (p) => {
    Object.assign(p.database.items, {
      axe: { id: "axe", name: "斧", kind: "weapon", price: 30, effects: [] },
      elixir: { id: "elixir", name: "エリクサー", kind: "consumable", price: 90, effects: [{ kind: "recoverHp", value: 999 }] },
      mail: { id: "mail", name: "鎧", kind: "armor", price: 40, effects: [] },
      ring: { id: "ring", name: "指輪", kind: "armor", price: 30, effects: [], equipSlot: "accessory" },
      map: { id: "map", name: "地図", kind: "key", price: 0, effects: [] },
    });
  },
});
const { ctx } = kit;
const all = { potion: 1, elixir: 1, sword: 1, axe: 1, mail: 1, ring: 1, map: 1 } as GameState["party"]["items"];
const state: GameState = { ...kit.state, party: { ...kit.state.party, items: all } };

describe("アイテムの分類と並び（item-order.ts）", () => {
  it("分類：消耗品は item、装備は付ける欄、大事なものは key。DB に無いものは item", () => {
    const of = (id: string) => itemCategory(ctx.project.item(id as ItemId));
    expect(["potion", "sword", "mail", "ring", "map", "nope"].map(of)).toEqual(["item", "weapon", "armor", "accessory", "key", "item"]);
  });

  it("並べ替え：消耗品 → 武器 → 防具 → 装飾品 → 大事なもの。同じ分類の中は元の順のまま", () => {
    expect(sortByCategory(["map", "ring", "sword", "potion", "mail", "axe", "elixir"], ctx)).toEqual(["potion", "elixir", "sword", "axe", "mail", "ring", "map"]);
  });

  it("メニューのアイテム画面・売却の一覧は分類の順（同じ分類の中は ID 順）。商品は分類の順で、同じ分類の中は店の並びのまま", () => {
    expect(menuItemIds(state, ctx)).toEqual(["elixir", "potion", "axe", "sword", "mail", "ring", "map"]);
    expect(sellableItemIds(state, ctx)).toEqual(["elixir", "potion", "axe", "sword", "mail", "ring"]);
    const scene = { kind: "shop", goods: ["ring", "sword", "potion", "axe"], canSell: true, owner: "i", screen: "buy", cursor: 0 } as const;
    expect(shopListIds(state, scene as never, ctx)).toEqual(["potion", "sword", "axe", "ring"]);
  });
});
