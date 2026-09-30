import { loadFixtureProject } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { emptyInput, inputFrame } from "../input.js";
import type { Button } from "../input.js";
import { startInterpreter } from "../interpreter/index.js";
import { fromSnapshot, toSnapshot } from "../snapshot.js";
import type { GameState, ShopScene } from "../state.js";
import { initialState, isSellable, maxBuyQuantity, openShop, sellableItemIds, sellPrice, shopCommands, shopListIds, step } from "./index.js";

// commands-smoke：ポーション（10G・消耗品）と古い鍵（0G・大事なもの）
const { ctx } = loadFixtureProject("commands-smoke");
const potion = ctx.project.item("item_potion" as never)!;
const key = ctx.project.item("item_key" as never)!;

const press = (state: GameState, ...buttons: Button[]): GameState => buttons.reduce((s, b) => step(s, inputFrame([b], [b]), ctx).state, state);
const scene = (s: GameState): ShopScene => {
  if (s.scene.kind !== "shop") throw new Error(`shop ではない: ${s.scene.kind}`);
  return s.scene;
};
const shopOf = (over: Partial<Pick<GameState["party"], "gold" | "items">> = {}, canSell = true, goods = ["item_potion"]): GameState => {
  const base = initialState(ctx, "shop");
  return openShop({ ...base, party: { ...base.party, gold: 25, items: {}, ...over } }, goods as never, canSell, "i1");
};

describe("ショップの計算", () => {
  it("売値は買値の半分（切り捨て）。大事なものと値段のないものは売れない", () => {
    expect(sellPrice(potion)).toBe(5);
    expect(sellPrice({ ...potion, price: 25 })).toBe(12);
    expect(isSellable(potion)).toBe(true);
    expect(isSellable(key)).toBe(false);
    expect(isSellable({ ...potion, price: 0 })).toBe(false);
    expect(isSellable(undefined)).toBe(false);
  });

  it("買える数は所持金と、持てる上限（99）の残りの小さい方", () => {
    const s = shopOf({ gold: 25 });
    expect(maxBuyQuantity(s, potion)).toBe(2);
    expect(maxBuyQuantity({ ...s, party: { ...s.party, gold: 5 } }, potion)).toBe(0);
    expect(maxBuyQuantity({ ...s, party: { ...s.party, gold: 9999 } }, potion)).toBe(99);
    expect(maxBuyQuantity({ ...s, party: { ...s.party, gold: 9999, items: { item_potion: 95 } as never } }, potion)).toBe(4);
    expect(maxBuyQuantity({ ...s, party: { ...s.party, gold: 0 } }, { ...potion, price: 0 })).toBe(99); // 0G の商品でも 0/0 にならない
  });

  it("売却の一覧は、持っていて売れるものだけ", () => {
    const s = shopOf({ items: { item_potion: 2, item_key: 1 } as never });
    expect(sellableItemIds(s, ctx)).toEqual(["item_potion"]);
    expect(sellableItemIds(shopOf({ items: { item_key: 1 } as never }), ctx)).toEqual([]);
    expect(shopCommands({ canSell: true })).toEqual(["buy", "sell", "quit"]);
    expect(shopCommands({ canSell: false })).toEqual(["buy", "quit"]);
  });
});

describe("ショップの入力", () => {
  it("開いた直後はコマンド画面で、世界は止まり、時間だけ進む", () => {
    const s = shopOf();
    expect(s.scene).toEqual({ kind: "shop", goods: ["item_potion"], canSell: true, owner: "i1", screen: "command", cursor: 0 });
    const t = step(s, inputFrame(["right"], ["right"]), ctx).state;
    expect(t.tick).toBe(s.tick + 1);
    expect(t.playtimeTicks).toBe(s.playtimeTicks + 1);
    expect(t.map.player).toEqual(s.map.player);
    expect(scene(step(shopOf(), emptyInput(), ctx).state).screen).toBe("command");
  });

  it("コマンドは左右（上下）で循環し、キャンセル・やめるでマップに戻る", () => {
    expect(scene(press(shopOf(), "right")).cursor).toBe(1);
    expect(scene(press(shopOf(), "left")).cursor).toBe(2);
    expect(scene(press(shopOf(), "down", "down", "down")).cursor).toBe(0);
    expect(scene(press(shopOf({}, false), "right")).cursor).toBe(1); // 売らない店は購入とやめるだけ
    expect(press(shopOf(), "cancel").scene).toEqual({ kind: "map" });
    expect(press(shopOf(), "right", "right", "ok").scene).toEqual({ kind: "map" });
    expect(press(shopOf({}, false), "right", "ok").scene).toEqual({ kind: "map" });
  });

  it("購入：一覧で品物を選び、数量を決めて確定すると所持金と所持数が変わり、一覧に戻る", () => {
    let s = press(shopOf({ gold: 25 }), "ok");
    expect(scene(s)).toMatchObject({ screen: "buy", cursor: 0 });
    s = press(s, "ok");
    expect(scene(s)).toMatchObject({ screen: "buy", quantity: 1 });
    s = press(s, "up"); // 上で増える
    expect(scene(s).quantity).toBe(2);
    s = press(s, "up", "up", "up"); // 買える数（2）で止まる
    expect(scene(s).quantity).toBe(2);
    s = press(s, "down", "down", "down"); // 1 で止まる
    expect(scene(s).quantity).toBe(1);
    s = press(s, "right"); // +10 でも上限まで
    expect(scene(s).quantity).toBe(2);
    s = press(s, "ok");
    expect(s.party.gold).toBe(5);
    expect(s.party.items).toEqual({ item_potion: 2 });
    expect(scene(s)).toMatchObject({ screen: "buy", cursor: 0 });
    expect(scene(s).quantity).toBeUndefined();
  });

  it("買えないもの（所持金が足りない・持てる上限）は数量の選択に進めない", () => {
    expect(scene(press(shopOf({ gold: 9 }), "ok", "ok")).quantity).toBeUndefined();
    expect(scene(press(shopOf({ gold: 9999, items: { item_potion: 99 } as never }), "ok", "ok")).quantity).toBeUndefined();
  });

  it("数量の選択のキャンセルは一覧へ、一覧のキャンセルはコマンドへ（そのコマンドの上に戻る）", () => {
    const listed = press(shopOf(), "right", "ok");
    expect(scene(listed)).toMatchObject({ screen: "sell", cursor: 0 });
    let s = press(shopOf({ gold: 25 }), "ok", "ok", "cancel");
    expect(scene(s)).toMatchObject({ screen: "buy" });
    expect(scene(s).quantity).toBeUndefined();
    s = press(s, "cancel");
    expect(scene(s)).toMatchObject({ screen: "command", cursor: 0 });
    expect(scene(press(listed, "cancel"))).toMatchObject({ screen: "command", cursor: 1 });
    expect(shopListIds(shopOf(), scene(shopOf()), ctx)).toEqual(["item_potion"]);
  });

  it("売却：売値 × 数で所持金が増え、所持数が減る。全部売ると一覧から消え、空になればコマンドに戻る", () => {
    const start = shopOf({ gold: 0, items: { item_potion: 3, item_key: 1 } as never });
    let s = press(start, "right", "ok", "ok"); // 売却 → 一覧 → 数量
    expect(scene(s)).toMatchObject({ screen: "sell", quantity: 1 });
    s = press(s, "up", "up", "up"); // 持っている数（3）まで
    expect(scene(s).quantity).toBe(3);
    s = press(s, "down", "ok"); // 2 個売る
    expect(s.party.gold).toBe(10);
    expect(s.party.items).toEqual({ item_potion: 1, item_key: 1 });
    expect(scene(s)).toMatchObject({ screen: "sell", cursor: 0 });
    s = press(s, "ok", "ok"); // 最後の 1 個
    expect(s.party.gold).toBe(15);
    expect(s.party.items).toEqual({ item_key: 1 });
    expect(scene(s)).toMatchObject({ screen: "command", cursor: 1 }); // 売れるものがもう無い
    expect(scene(press(s, "ok")).cursor).toBe(0);
    expect(scene(press(s, "ok")).screen).toBe("sell");
  });

  it("売るものが無いときの決定は何も起きない。カーソルは一覧の長さの範囲に収まる", () => {
    expect(scene(press(shopOf(), "right", "ok", "ok")).quantity).toBeUndefined();
    const two = shopOf({ gold: 100 }, true, ["item_potion", "item_key"]);
    expect(scene(press(two, "ok", "down")).cursor).toBe(1);
    expect(scene(press(two, "ok", "down", "down")).cursor).toBe(0);
    expect(scene(press(two, "ok", "down", "ok")).quantity).toBe(1); // 古い鍵は 0G なので、所持金が足りないことはない
  });

  it("セーブされるのはマップだけ：ショップ中の状態はマップに戻り、待機は復元できる", () => {
    const started = startInterpreter(initialState(ctx, "shop"), { kind: "plugin", name: "t" }, [{ code: "ShopProcessing", params: { goods: ["item_potion"] }, indent: 0 }], "normal");
    const waiting = step(started, emptyInput(), ctx).state;
    expect(scene(waiting).owner).toBe(waiting.interpreters[0]?.id);
    const snap = toSnapshot(waiting, { projectId: "p", projectHash: "h", savedAt: "2026-01-01T00:00:00Z" });
    expect(snap.state.scene).toEqual({ kind: "map" });
    const restored = fromSnapshot(snap, ctx);
    expect(restored.ok).toBe(true);
    if (restored.ok) expect(restored.value.interpreters[0]?.wait).toEqual({ kind: "shop" });
  });
});
