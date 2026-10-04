import type { ActorId, ItemId } from "@rpg/schema";
import { battleKit, press } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { allyBattler } from "../battle/battlers.js";
import { fromSnapshot, toSnapshot } from "../snapshot.js";
import type { GameState } from "../state.js";
import { actorParamsOf, changeEquip, equipCandidates, equipsOf, equipSlotOf, paramsIfEquipped } from "./equip.js";
import { menuItems, step } from "./index.js";

/**
 * 勇者（atk 30 / def 10 / 最大 HP 100）は初期装備に鉄の剣（atk +10）を持つ。持ち物に、銅の剣（atk +4）・鎧（def +5・最大 HP +20）・
 * 指輪（装飾品。mdf +3）と、ポーションがある。
 */
const kit = battleKit({
  mutate: (p) => {
    p.system.menuEquip = true;
    p.database.actors["actor_hero" as never]!.equips = { weapon: "sword" as ItemId };
    Object.assign(p.database.items, {
      copper: { id: "copper", name: "銅の剣", kind: "weapon", price: 20, effects: [], params: { atk: 4 } },
      mail: { id: "mail", name: "鎧", kind: "armor", price: 40, effects: [], params: { def: 5, mhp: 20 } },
      ring: { id: "ring", name: "指輪", kind: "armor", price: 30, effects: [], params: { mdf: 3 }, equipSlot: "accessory" },
    });
  },
});
const { ctx } = kit;
const hero = "actor_hero" as ActorId;
const mage = "actor_mage" as ActorId;
const id = (s: string) => s as ItemId;
const start: GameState = { ...kit.state, party: { ...kit.state.party, items: { potion: 2, copper: 1, mail: 1, ring: 1 } as GameState["party"]["items"] } };

describe("装備（equip.ts）", () => {
  it("武器は weapon の欄、防具は equipSlot（省略 = armor）の欄に付く。消耗品は付けられない", () => {
    expect(equipSlotOf(ctx.project.item(id("copper")))).toBe("weapon");
    expect(equipSlotOf(ctx.project.item(id("mail")))).toBe("armor");
    expect(equipSlotOf(ctx.project.item(id("ring")))).toBe("accessory");
    expect(equipSlotOf(ctx.project.item(id("potion")))).toBeUndefined();
    expect(equipSlotOf(undefined)).toBeUndefined();
  });

  it("付け替えるまでは、データベースの初期装備のまま（能力値にも入る）", () => {
    expect(start.actors[hero]!.equips).toBeUndefined();
    expect(equipsOf(start, ctx, hero)).toEqual({ weapon: "sword" });
    expect(actorParamsOf(start, ctx, hero).atk).toBe(40);
    expect(equipsOf(start, ctx, mage)).toEqual({});
  });

  it("欄ごとの候補は、持ち物のうちその欄に付けられるもの（ID 順）", () => {
    expect(equipCandidates(start, ctx, "weapon")).toEqual(["copper"]);
    expect(equipCandidates(start, ctx, "armor")).toEqual(["mail"]);
    expect(equipCandidates(start, ctx, "accessory")).toEqual(["ring"]);
  });

  it("付け替えると、付けたものは持ち物から減り、外したものは持ち物に戻る。戦闘の能力値にも効く", () => {
    const s = changeEquip(start, ctx, hero, "weapon", id("copper"))!;
    expect(s.actors[hero]!.equips).toEqual({ weapon: "copper" });
    expect(s.party.items).toEqual({ potion: 2, sword: 1, mail: 1, ring: 1 });
    expect(actorParamsOf(s, ctx, hero).atk).toBe(34);
    expect(allyBattler(s, ctx, hero)!.params.atk).toBe(34);
    // 外す：空いた欄は無くなり、剣は持ち物に戻る
    const bare = changeEquip(s, ctx, hero, "weapon", undefined)!;
    expect(bare.actors[hero]!.equips).toEqual({});
    expect(bare.party.items).toEqual({ potion: 2, sword: 1, copper: 1, mail: 1, ring: 1 });
    expect(actorParamsOf(bare, ctx, hero).atk).toBe(30);
  });

  it("持っていない・欄が違う・いないアクターには付けられない（undefined）。同じものなら状態はそのまま", () => {
    expect(changeEquip(start, ctx, hero, "weapon", id("sword"))).toBe(start);
    const noCopper = { ...start, party: { ...start.party, items: { potion: 2 } as GameState["party"]["items"] } };
    expect(changeEquip(noCopper, ctx, hero, "weapon", id("copper"))).toBeUndefined();
    expect(changeEquip(start, ctx, hero, "armor", id("copper"))).toBeUndefined();
    expect(changeEquip(start, ctx, hero, "accessory", id("mail"))).toBeUndefined();
    expect(changeEquip(start, ctx, "nobody" as ActorId, "weapon", id("copper"))).toBeUndefined();
  });

  it("最大 HP が下がると、HP をその値までに切り詰める（戦闘不能の HP 0 はそのまま）", () => {
    const armored = changeEquip(start, ctx, hero, "armor", id("mail"))!;
    expect(actorParamsOf(armored, ctx, hero).mhp).toBe(120);
    const full = { ...armored, actors: { ...armored.actors, [hero]: { ...armored.actors[hero]!, hp: 120 } } };
    expect(changeEquip(full, ctx, hero, "armor", undefined)!.actors[hero]!.hp).toBe(100);
    const dead = { ...armored, actors: { ...armored.actors, [hero]: { ...armored.actors[hero]!, hp: 0 } } };
    expect(changeEquip(dead, ctx, hero, "armor", undefined)!.actors[hero]!.hp).toBe(0);
  });

  it("付け替えたあとの能力値の見込み（paramsIfEquipped）は、状態を変えずに計算する", () => {
    expect(paramsIfEquipped(start, ctx, hero, "weapon", id("copper")).atk).toBe(34);
    expect(paramsIfEquipped(start, ctx, hero, "weapon", undefined).atk).toBe(30);
    expect(paramsIfEquipped(start, ctx, hero, "accessory", id("ring")).mdf).toBe(13);
    expect(equipsOf(start, ctx, hero)).toEqual({ weapon: "sword" });
  });

  it("装備はセーブに含まれ、ロードで戻る", () => {
    const s = changeEquip(start, ctx, hero, "accessory", id("ring"))!;
    const loaded = fromSnapshot(toSnapshot(s, { projectId: "p", projectHash: "h", savedAt: "2026-01-01T00:00:00Z" }), ctx);
    expect(loaded.ok, JSON.stringify(loaded)).toBe(true);
    if (loaded.ok) expect(loaded.value.actors[hero]!.equips).toEqual({ weapon: "sword", accessory: "ring" });
  });
});

describe("メニューの装備画面", () => {
  const frames = (state: GameState, ...buttons: Parameters<typeof press>[0][]): GameState => buttons.reduce((s, b) => step(s, press(b), ctx).state, state);
  const menu = (s: GameState) => (s.scene.kind === "menu" ? s.scene : undefined);
  const openEquip = (s: GameState): GameState => frames(s, "menu", ...Array(menuItems(ctx.project).indexOf("equip")).fill("down"), "ok");

  it("system.menuEquip が true のときだけ、メインメニューの「スキル」の位置の次に「装備」が並ぶ", () => {
    expect(menuItems(ctx.project)).toEqual(["item", "equip", "status", "save", "load"]);
    const off = { ...ctx.project, project: { ...ctx.project.project, system: { ...ctx.project.project.system, menuEquip: undefined } } };
    expect(menuItems(off as never)).toEqual(["item", "status", "save", "load"]);
  });

  it("人 → 欄 → 付けるもの の順に選ぶ。付け替えると欄の一覧に戻る", () => {
    let s = openEquip(start);
    expect(menu(s)).toMatchObject({ screen: "equip", cursor: 0 });
    expect(menu(s)?.actor).toBeUndefined();
    s = frames(s, "ok"); // 勇者
    expect(menu(s)).toMatchObject({ actor: 0, cursor: 0 });
    s = frames(s, "down", "ok"); // 防具の欄
    expect(menu(s)).toMatchObject({ actor: 0, slot: 1, cursor: 0 });
    s = frames(s, "ok"); // 鎧
    expect(s.actors[hero]!.equips).toEqual({ weapon: "sword", armor: "mail" });
    expect(menu(s)).toMatchObject({ actor: 0, cursor: 1 });
    expect(menu(s)?.slot).toBeUndefined();
  });

  it("候補の末尾は「外す」。候補の数 + 1 で循環する", () => {
    let s = frames(openEquip(start), "ok", "ok"); // 勇者の武器の欄（候補は銅の剣だけ）
    s = frames(s, "down");
    expect(menu(s)?.cursor).toBe(1);
    s = frames(s, "down");
    expect(menu(s)?.cursor).toBe(0);
    s = frames(s, "up", "ok"); // 外す
    expect(s.actors[hero]!.equips).toEqual({});
    expect(s.party.items["sword" as never]).toBe(1);
  });

  it("キャンセルは一つ前へ（付けるもの → 欄 → 人 → メインメニュー）。カーソルは選んでいた位置に戻る", () => {
    let s = frames(openEquip(start), "down", "ok", "down", "down", "ok"); // 魔法使いの装飾品の欄
    expect(menu(s)).toMatchObject({ actor: 1, slot: 2 });
    s = frames(s, "cancel");
    expect(menu(s)).toMatchObject({ actor: 1, cursor: 2 });
    expect(menu(s)?.slot).toBeUndefined();
    s = frames(s, "cancel");
    expect(menu(s)).toMatchObject({ screen: "equip", cursor: 1 });
    expect(menu(s)?.actor).toBeUndefined();
    s = frames(s, "cancel");
    expect(menu(s)).toMatchObject({ screen: "main", cursor: menuItems(ctx.project).indexOf("equip") });
  });
});
