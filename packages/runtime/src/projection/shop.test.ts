import { describe, expect, it } from "vitest";
import { initialState, openShop } from "@rpg/core";
import type { GameState, ShopScene } from "@rpg/core";
import { deepFreeze, loadFixtureProject } from "@rpg/test-utils";
import type { UiNode } from "../frame-spec.js";
import { projectFrame } from "./index.js";
import { projectShop } from "./shop.js";

// commands-smoke：ポーション（10G）と古い鍵（0G・大事なもの）
const { ctx, view } = loadFixtureProject("commands-smoke");
const size = { width: 320, height: 256 };

const flatten = (nodes: readonly UiNode[]): UiNode[] => nodes.flatMap((n) => (n.kind === "window" ? [n, ...flatten(n.children)] : [n]));
const textsOf = (nodes: readonly UiNode[]): string[] => flatten(nodes).flatMap((n) => (n.kind === "text" ? [n.text] : []));
const cursors = (nodes: readonly UiNode[]) => flatten(nodes).filter((n) => n.kind === "cursor");

const shopState = (patch: Partial<ShopScene> = {}, party: Partial<GameState["party"]> = {}, canSell = true): GameState => {
  const base = initialState(ctx, "shop-ui");
  const opened = openShop({ ...base, party: { ...base.party, gold: 25, items: { item_potion: 3 } as never, ...party } }, ["item_potion", "item_key"] as never, canSell, "i1");
  return deepFreeze({ ...opened, scene: { ...(opened.scene as ShopScene), ...patch } });
};

describe("projectFrame（ショップ）", () => {
  it("[snapshot] コマンド画面：購入・売却・やめると所持金、商品の一覧（値段と所持数）", () => {
    const f = projectFrame(shopState(), view);
    expect({ size: f.size, ui: f.ui }).toMatchSnapshot();
  });

  it("マップを暗くして重ねる。ショップでなければ何も出さない", () => {
    const f = projectFrame(shopState(), view);
    expect(f.layers.length).toBeGreaterThan(0);
    expect(f.ui[0]).toMatchObject({ kind: "window", variant: "dim" });
    expect(projectShop(initialState(ctx, "x"), view, size)).toEqual([]);
  });

  it("コマンド画面：カーソルはコマンドの上。売らない店は「売却する」が無い", () => {
    const s = shopState({ cursor: 1 });
    const texts = textsOf(projectShop(s, view, size));
    expect(texts).toEqual(expect.arrayContaining(["購入する", "売却する", "やめる", "所持金", "25G", "ポーション", "10G", "所持 3"]));
    expect(cursors(projectShop(s, view, size))).toHaveLength(1);
    expect(textsOf(projectShop(shopState({}, {}, false), view, size))).not.toContain("売却する");
  });

  it("一覧では選んでいる品物の説明が出る。コマンド画面と、説明のない品物では出ない", () => {
    expect(textsOf(projectShop(shopState({ screen: "buy", cursor: 0 }), view, size))).toContain("味方1人：HPを30回復");
    expect(textsOf(projectShop(shopState({ screen: "buy", cursor: 1 }), view, size))).not.toContain("味方1人：HPを30回復"); // 古い鍵は説明なし
    expect(textsOf(projectShop(shopState({ screen: "command" }), view, size))).not.toContain("味方1人：HPを30回復");
    expect(textsOf(projectShop(shopState({ screen: "sell", cursor: 0 }), view, size))).toContain("味方1人：HPを30回復");
  });

  it("購入の一覧：カーソルは品物の行。買えないものは灰色", () => {
    const s = shopState({ screen: "buy", cursor: 0 }, { gold: 5 });
    const nodes = flatten(projectShop(s, view, size));
    const grey = nodes.filter((n) => n.kind === "text" && n.text === "ポーション");
    expect(grey[0]).toMatchObject({ color: { r: 128, g: 128, b: 128 } });
    const at = (cursor: number): number => (cursors(projectShop(shopState({ screen: "buy", cursor }), view, size))[0] as { y: number }).y;
    expect(at(1) - at(0)).toBe(24);
    expect(cursors(projectShop(shopState(), view, size))).toHaveLength(1); // コマンド画面では一覧にカーソルは無い
  });

  it("売却の一覧：売値（買値の半分）と持っているものだけ。大事なものは並ばない。空なら「（なし）」", () => {
    const sell = projectShop(shopState({ screen: "sell" }, { items: { item_potion: 3, item_key: 1 } as never }), view, size);
    expect(textsOf(sell)).toEqual(expect.arrayContaining(["ポーション", "5G", "所持 3"]));
    expect(textsOf(sell)).not.toContain("古い鍵");
    expect(textsOf(projectShop(shopState({ screen: "sell" }, { items: {} as never }), view, size))).toContain("（なし）");
  });

  it("数量の選択：品名・個数・単価・合計が中央のウィンドウに出る", () => {
    const buy = textsOf(projectShop(shopState({ screen: "buy", cursor: 0, quantity: 2 }), view, size));
    expect(buy).toEqual(expect.arrayContaining(["× 2", "10G", "合計", "20G"]));
    const sell = textsOf(projectShop(shopState({ screen: "sell", cursor: 0, quantity: 3 }), view, size));
    expect(sell).toEqual(expect.arrayContaining(["× 3", "5G", "合計", "15G"]));
    expect(textsOf(projectShop(shopState({ screen: "buy", cursor: 0 }), view, size))).not.toContain("合計");
  });

  it("文言は system.terms が優先", () => {
    const custom = { ...view, project: { ...view.project, system: { ...view.project.system, terms: { buy: "かう", gold: "おかね" } } } };
    expect(textsOf(projectShop(shopState(), custom as typeof view, size))).toEqual(expect.arrayContaining(["かう", "おかね"]));
  });
});
