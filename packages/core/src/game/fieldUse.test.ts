import type { ActorId, ItemId } from "@rpg/schema";
import { battleKit, press } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import type { GameState } from "../state.js";
import { menuItems, step } from "./index.js";
import { fieldItemUsable, fieldSkills, fieldSkillUsable, useOnField } from "./fieldUse.js";

/** 勇者（HP 100）・魔法使い（HP 60 / MP 20。ヒール = 一人に約 60 回復・MP 2、ファイア = 敵への攻撃）。全体回復「いやしの風」と、蘇生薬を足してある。 */
const kit = battleKit({
  mutate: (p) => {
    p.system.menuSkill = true;
    Object.assign(p.database.skills, {
      sk_wind: { id: "sk_wind", name: "いやしの風", mpCost: 4, scope: "all-allies", formula: "", effects: [{ kind: "recoverHp", value: 25 }] },
    });
    p.database.classes["class_mage" as never]!.skills.push({ level: 1, skill: "sk_wind" as never });
  },
});
const { ctx } = kit;
const hero = "actor_hero" as ActorId;
const mage = "actor_mage" as ActorId;

/** 勇者の HP を 20、魔法使いの HP を 10 にした状態。 */
function hurt(state: GameState = kit.state): GameState {
  return { ...state, actors: { ...state.actors, [hero]: { ...state.actors[hero]!, hp: 20 }, [mage]: { ...state.actors[mage]!, hp: 10 } } };
}
const hp = (s: GameState, id: ActorId): number => s.actors[id]!.hp;
const potions = (s: GameState): number => s.party.items["potion" as ItemId] ?? 0;

describe("メニューでのアイテム・スキルの使用（useOnField）", () => {
  it("アイテムは、傷ついた味方に使うと回復して 1 個減る", () => {
    const used = useOnField(hurt(), ctx, { kind: "item", id: "potion" as ItemId }, hero)!;
    expect(hp(used, hero)).toBe(70);
    expect(hp(used, mage)).toBe(10);
    expect(potions(used)).toBe(1);
  });

  it("最大 HP を超えて回復しない。満タンの相手には使えず、アイテムは減らない", () => {
    const almost = { ...hurt(), actors: { ...hurt().actors, [hero]: { ...hurt().actors[hero]!, hp: 90 } } };
    expect(hp(useOnField(almost, ctx, { kind: "item", id: "potion" as ItemId }, hero)!, hero)).toBe(100);
    expect(useOnField(kit.state, ctx, { kind: "item", id: "potion" as ItemId }, hero)).toBeUndefined();
  });

  it("持っていないアイテム・対象がいない・戦闘不能の味方には使えない", () => {
    const none = { ...hurt(), party: { ...hurt().party, items: {} } };
    expect(useOnField(none, ctx, { kind: "item", id: "potion" as ItemId }, hero)).toBeUndefined();
    expect(useOnField(hurt(), ctx, { kind: "item", id: "potion" as ItemId })).toBeUndefined();
    const dead = { ...hurt(), actors: { ...hurt().actors, [hero]: { ...hurt().actors[hero]!, hp: 0 } } };
    expect(useOnField(dead, ctx, { kind: "item", id: "potion" as ItemId }, hero)).toBeUndefined();
  });

  it("武器・効果のないものは、メニューから使えるものではない", () => {
    expect(fieldItemUsable(ctx.project.item("potion" as ItemId))).toBe(true);
    expect(fieldItemUsable(ctx.project.item("sword" as ItemId))).toBe(false);
    expect(fieldItemUsable(undefined)).toBe(false);
  });

  it("スキルは MP を使って味方を回復する（式のばらつきは戦闘と同じ）", () => {
    const used = useOnField(hurt(), ctx, { kind: "skill", id: "sk_heal" as never, user: mage }, hero)!;
    expect(hp(used, hero)).toBeGreaterThanOrEqual(74);
    expect(hp(used, hero)).toBeLessThanOrEqual(86); // 20 + 60（魔力 30 × 2）の ±10%
    expect(used.actors[mage]!.mp).toBe(kit.state.actors[mage]!.mp - 2);
    expect(potions(used)).toBe(2);
  });

  it("MP が足りないスキル・敵に向けたスキルは使えない", () => {
    const empty = { ...hurt(), actors: { ...hurt().actors, [mage]: { ...hurt().actors[mage]!, mp: 1 } } };
    expect(useOnField(empty, ctx, { kind: "skill", id: "sk_heal" as never, user: mage }, hero)).toBeUndefined();
    expect(fieldSkillUsable(ctx.project.skill("sk_fire" as never))).toBe(false);
    expect(useOnField(hurt(), ctx, { kind: "skill", id: "sk_fire" as never, user: mage }, hero)).toBeUndefined();
  });

  it("全体のスキルは対象を選ばずに全員を回復する（満タンの人は変わらない）", () => {
    const used = useOnField(hurt(), ctx, { kind: "skill", id: "sk_wind" as never, user: mage })!;
    expect(hp(used, hero)).toBe(45);
    expect(hp(used, mage)).toBe(35);
    expect(used.actors[mage]!.mp).toBe(kit.state.actors[mage]!.mp - 4);
  });

  it("マップの乱数（rng）には触れず、同じ入力なら同じ結果になる", () => {
    const a = useOnField(hurt(), ctx, { kind: "skill", id: "sk_heal" as never, user: mage }, hero)!;
    const b = useOnField(hurt(), ctx, { kind: "skill", id: "sk_heal" as never, user: mage }, hero)!;
    expect(a).toEqual(b);
    expect(a.rng).toEqual(hurt().rng);
  });

  it("使えるスキルの一覧はクラスの習得順（fieldSkills）", () => {
    expect(fieldSkills(kit.state, ctx, mage).map((s) => s.id)).toEqual(["sk_fire", "sk_heal", "sk_wind"]);
    expect(fieldSkills(kit.state, ctx, "nobody" as ActorId)).toEqual([]);
  });
});

describe("メニューの操作", () => {
  const frames = (state: GameState, ...buttons: Parameters<typeof press>[0][]): GameState => buttons.reduce((s, b) => step(s, press(b), ctx).state, state);
  const open = (s: GameState, screen: "item" | "skill"): GameState => frames(s, "menu", ...Array(menuItems(ctx.project).indexOf(screen)).fill("down"), "ok");
  const menu = (s: GameState) => (s.scene.kind === "menu" ? s.scene : undefined);

  it("system.menuSkill が true のときだけ、メインメニューに「スキル」が並ぶ", () => {
    expect(menuItems(ctx.project)).toEqual(["item", "skill", "status", "save", "load"]);
    const off = { ...ctx.project, project: { ...ctx.project.project, system: { ...ctx.project.project.system, menuSkill: undefined } } };
    expect(menuItems(off as never)).toEqual(["item", "status", "save", "load"]);
  });

  it("アイテム：決定で対象の選択に進み、上下で味方を選び、決定で使う。使い切ると一覧から消えてカーソルが収まる", () => {
    let s = open(hurt(), "item");
    expect(menu(s)).toMatchObject({ screen: "item", cursor: 0 });
    s = frames(s, "ok");
    expect(menu(s)?.pick).toEqual({ kind: "item", id: "potion", cursor: 0 });
    s = frames(s, "down");
    expect(menu(s)?.pick?.cursor).toBe(1);
    s = frames(s, "ok"); // 魔法使いに使う
    expect(menu(s)).toMatchObject({ screen: "item" });
    expect(menu(s)?.pick).toBeUndefined();
    expect(hp(s, mage)).toBe(60);
    expect(potions(s)).toBe(1);
    s = frames(s, "ok", "ok"); // 勇者に使う（最後の 1 個）
    expect(hp(s, hero)).toBe(70);
    expect(potions(s)).toBe(0);
    expect(menu(s)).toMatchObject({ screen: "item", cursor: 0 });
  });

  it("アイテム：キャンセルで対象の選択をやめ、もう一度キャンセルでメインメニューに戻る。使えないアイテムは決定しても何も起きない", () => {
    let s = frames(open(hurt(), "item"), "ok", "cancel");
    expect(menu(s)).toMatchObject({ screen: "item" });
    expect(menu(s)?.pick).toBeUndefined();
    s = frames(s, "cancel");
    expect(menu(s)).toMatchObject({ screen: "main", cursor: 0 });
    const sword = { ...hurt(), party: { ...hurt().party, items: { sword: 1 } as never } };
    expect(menu(frames(open(sword, "item"), "ok"))?.pick).toBeUndefined();
  });

  it("アイテム：満タンの相手を選んで決定しても、アイテムは減らない（対象の選択は終わる）", () => {
    const s = frames(open(kit.state, "item"), "ok", "ok");
    expect(potions(s)).toBe(2);
    expect(menu(s)?.pick).toBeUndefined();
  });

  it("スキル：使う人を選び、スキルを選び、対象を選んで使う。キャンセルで一つずつ戻る", () => {
    let s = open(hurt(), "skill");
    expect(menu(s)).toMatchObject({ screen: "skill", cursor: 0 });
    s = frames(s, "down", "ok"); // 魔法使い
    expect(menu(s)).toMatchObject({ screen: "skill", actor: 1, cursor: 0 });
    s = frames(s, "down"); // ヒール（ファイアは使えない：決定しても何も起きない）
    expect(menu(frames(s, "up", "ok"))?.pick).toBeUndefined();
    s = frames(s, "ok");
    expect(menu(s)?.pick).toMatchObject({ kind: "skill", id: "sk_heal", user: "actor_mage", cursor: 0 });
    s = frames(s, "cancel");
    expect(menu(s)).toMatchObject({ screen: "skill", actor: 1, cursor: 1 });
    expect(menu(s)?.pick).toBeUndefined();
    s = frames(s, "ok", "ok"); // 勇者に使う
    expect(hp(s, hero)).toBeGreaterThan(70);
    expect(s.actors[mage]!.mp).toBe(18);
    s = frames(s, "cancel");
    expect(menu(s)).toMatchObject({ screen: "skill", cursor: 1 });
    expect(menu(s)?.actor).toBeUndefined();
    s = frames(s, "cancel");
    expect(menu(s)).toMatchObject({ screen: "main", cursor: 1 });
  });

  it("スキル：全体のスキルは、スキルを決定した時点で全員に使う（対象は選ばない）。MP が足りないと何も起きない", () => {
    let s = frames(open(hurt(), "skill"), "down", "ok", "down", "down", "ok");
    expect(hp(s, hero)).toBe(45);
    expect(hp(s, mage)).toBe(35);
    expect(s.actors[mage]!.mp).toBe(16);
    const low = { ...hurt(), actors: { ...hurt().actors, [mage]: { ...hurt().actors[mage]!, mp: 3 } } };
    s = frames(open(low, "skill"), "down", "ok", "down", "down", "ok");
    expect(hp(s, hero)).toBe(20);
    expect(menu(s)?.pick).toBeUndefined();
  });
});
