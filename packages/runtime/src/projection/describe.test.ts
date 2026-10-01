import { describe, expect, it } from "vitest";
import { createProjectView, initialState } from "@rpg/core";
import type { GameState, ProjectView } from "@rpg/core";
import type { Item, Project, Skill } from "@rpg/schema";
import { deepFreeze, loadFixtureProject } from "@rpg/test-utils";
import type { UiNode } from "../frame-spec.js";
import { describeDef, wrapLines } from "./describe.js";
import { projectFrame } from "./index.js";

const { ctx, view } = loadFixtureProject("commands-smoke");
const flatten = (nodes: readonly UiNode[]): UiNode[] => nodes.flatMap((n) => (n.kind === "window" ? [n, ...flatten(n.children)] : [n]));
const textsOf = (nodes: readonly UiNode[]): string[] => flatten(nodes).flatMap((n) => (n.kind === "text" ? [n.text] : []));

const item = (over: Partial<Item>): Item => ({ id: "i" as Item["id"], name: "x", kind: "consumable", price: 0, effects: [], ...over });
const skill = (over: Partial<Skill>): Skill => ({ id: "s" as Skill["id"], name: "x", mpCost: 0, scope: "one-enemy", formula: "", effects: [], ...over });

describe("describeDef（自動の説明）", () => {
  it("アイテム：回復量と対象", () => {
    expect(describeDef(view, item({ effects: [{ kind: "recoverHp", value: 50 }] }))).toBe("味方1人：HPを50回復");
    expect(describeDef(view, item({ effects: [{ kind: "recoverMp", value: 30 }, { kind: "recoverHp", value: 5 }] }))).toBe("味方1人：MPを30回復、HPを5回復");
  });

  it("スキル：式のあるものは敵ならダメージ、負の式は回復。対象の範囲が付く", () => {
    expect(describeDef(view, skill({ formula: "a.mat * 4 - b.mdf * 2" }))).toBe("敵1体：ダメージを与える");
    expect(describeDef(view, skill({ scope: "all-enemies", formula: "a.atk" }))).toBe("敵全体：ダメージを与える");
    expect(describeDef(view, skill({ scope: "one-ally", formula: "-(a.mat * 2 + 30)" }))).toBe("味方1人：HPを回復");
    expect(describeDef(view, skill({ scope: "self", effects: [{ kind: "buff", param: "atk", level: 1 }] }))).toBe("自分：攻撃力を上げる");
    expect(describeDef(view, skill({ scope: "all-allies", effects: [{ kind: "buff", param: "def", level: -1 }] }))).toBe("味方全体：防御力を下げる");
    expect(describeDef(view, skill({ scope: "one-dead-ally", effects: [{ kind: "recoverHp", value: 10 }] }))).toBe("戦闘不能の味方1人：HPを10回復");
  });

  it("状態：付与（確率つき）と治療。名前は状態の定義から引く", () => {
    const withStates = createProjectView(
      { ...view.project, database: { ...view.project.database, states: { st_poison: { id: "st_poison", name: "毒", restriction: "none", turns: 3, paramRates: {}, hpRegen: -0.1 } } } } as unknown as Project,
      {},
    );
    expect(describeDef(withStates, skill({ effects: [{ kind: "addState", state: "st_poison" as never, chance: 0.5 }] }))).toBe("敵1体：50%で毒にする");
    expect(describeDef(withStates, skill({ effects: [{ kind: "addState", state: "st_poison" as never, chance: 1 }] }))).toBe("敵1体：毒にする");
    expect(describeDef(withStates, item({ effects: [{ kind: "removeState", state: "st_poison" as never }] }))).toBe("味方1人：毒を治す");
    expect(describeDef(view, skill({ effects: [{ kind: "removeState", state: "st_nothing" as never }] }))).toBe("敵1体：st_nothingを治す");
  });

  it("装備：能力値の増減だけ（対象は付かない）", () => {
    expect(describeDef(view, item({ kind: "weapon", params: { atk: 5, def: -1 } }))).toBe("攻撃力+5、防御力-1");
    expect(describeDef(view, item({ kind: "armor", params: { def: 0 } }))).toBe("");
  });

  it("効果の中身が分からないもの（コモンイベント）・大事なものは何も出さない", () => {
    expect(describeDef(view, item({ effects: [{ kind: "commonEvent", id: "ce_x" as never }] }))).toBe("");
    expect(describeDef(view, item({ kind: "key" }))).toBe("");
    expect(describeDef(view, undefined)).toBe("");
  });

  it("description があれば自動の説明より優先してそのまま使う。空文字なら何も出さない（秘密・ランダム）", () => {
    const effects = [{ kind: "recoverHp", value: 50 }] as Item["effects"];
    expect(describeDef(view, item({ effects, description: "何が起こるかは使ってのお楽しみ。" }))).toBe("何が起こるかは使ってのお楽しみ。");
    expect(describeDef(view, item({ effects, description: "" }))).toBe("");
    expect(describeDef(view, skill({ formula: "a.atk", description: "ふしぎな力" }))).toBe("ふしぎな力");
  });
});

describe("wrapLines", () => {
  it("全角は 1em・半角は約 0.55em で幅に収まるよう折り返す", () => {
    expect(wrapLines("あいうえおかきくけこ", 50, 10)).toEqual(["あいうえお", "かきくけこ"]);
    expect(wrapLines("abcdefghij", 30, 10)).toEqual(["abcde", "fghij"]);
  });

  it("改行は段落の区切りとして効く。空文字は 1 行の空", () => {
    expect(wrapLines("あ\nい", 100, 10)).toEqual(["あ", "い"]);
    expect(wrapLines("", 100, 10)).toEqual([""]);
  });
});

describe("説明の窓", () => {
  const stateWith = (v: ProjectView, patch: Partial<GameState>): GameState => deepFreeze({ ...initialState({ ...ctx, project: v }, "help"), ...patch } as GameState);
  const patched = (items: Record<string, Item>): ProjectView =>
    createProjectView({ ...view.project, database: { ...view.project.database, items: { ...view.project.database.items, ...items } } } as unknown as Project, {});

  it("アイテム画面：選んでいるアイテムの説明が下に出る", () => {
    const v = patched({ item_potion: { ...view.item("item_potion" as never)! } });
    const base = stateWith(v, {});
    const state = { ...base, party: { ...base.party, items: { item_potion: 1, item_key: 1 } }, scene: { kind: "menu", screen: "item", cursor: 0 } } as unknown as GameState;
    // ids は昇順：item_key（説明なし）→ item_potion
    expect(textsOf(projectFrame(state, v).ui)).not.toContain("味方1人：HPを30回復");
    const second = { ...state, scene: { kind: "menu", screen: "item", cursor: 1 } } as GameState;
    expect(textsOf(projectFrame(second, v).ui)).toContain("味方1人：HPを30回復");
  });

  it("アイテム画面：description で秘密にできる（自動の説明は出ない）", () => {
    const secret = { ...view.item("item_potion" as never)!, description: "？？？" };
    const v = patched({ item_potion: secret });
    const base = stateWith(v, {});
    const state = { ...base, party: { ...base.party, items: { item_potion: 1 } }, scene: { kind: "menu", screen: "item", cursor: 0 } } as unknown as GameState;
    const texts = textsOf(projectFrame(state, v).ui);
    expect(texts).toContain("？？？");
    expect(texts).not.toContain("味方1人：HPを30回復");
  });

  it("長い説明は 2 行までに収める", () => {
    const long = { ...view.item("item_potion" as never)!, description: "あ".repeat(80) };
    const v = patched({ item_potion: long });
    const base = stateWith(v, {});
    const state = { ...base, party: { ...base.party, items: { item_potion: 1 } }, scene: { kind: "menu", screen: "item", cursor: 0 } } as unknown as GameState;
    const lines = textsOf(projectFrame(state, v).ui).filter((t) => t.startsWith("ああ"));
    expect(lines).toHaveLength(2);
  });
});
