import { describe, expect, it } from "vitest";
import { createProjectView, inputFrame, SAVE_SLOT_COUNT } from "@rpg/core";
import type { Project } from "@rpg/schema";
import type { GameState } from "@rpg/core";
import { createRuntimeHarness, deepFreeze } from "@rpg/test-utils";
import type { RuntimeHarness } from "@rpg/test-utils";
import type { UiNode } from "../frame-spec.js";
import type { SlotMeta } from "../ports/saves.js";
import { NO_UI, projectFrame } from "./index.js";
import { firstVisible, formatPlaytime } from "./ui.js";

const boot = (): Promise<RuntimeHarness> => createRuntimeHarness({ project: "minimal", title: true });

/** ノードを深さ優先で平らにする。 */
const flatten = (nodes: readonly UiNode[]): UiNode[] => nodes.flatMap((n) => (n.kind === "window" ? [n, ...flatten(n.children)] : [n]));
const textsOf = (nodes: readonly UiNode[]): string[] => flatten(nodes).flatMap((n) => (n.kind === "text" ? [n.text] : []));

const meta = (slot: number, over: Partial<SlotMeta> = {}): SlotMeta => ({
  slot,
  savedAt: "2026-01-01T00:00:00.000Z",
  playtimeTicks: 60 * 3725,
  preview: { mapName: "はじまりの町", partyNames: ["勇者", "魔法使い"], level: 7 },
  version: 1,
  projectHash: "h",
  compatible: "yes",
  ...over,
});

describe("projectFrame（タイトル）", () => {
  it("[snapshot] メイン画面：ゲームタイトルとコマンド、カーソル", async () => {
    const h = await boot();
    const f = projectFrame(h.runtime.getState(), h.loaded.view);
    expect(f.layers).toEqual([]);
    expect({ size: f.size, ui: f.ui }).toMatchSnapshot();
  });

  it("コマンドの文言は system.terms が優先、無ければ既定", async () => {
    const h = await boot();
    const state = h.runtime.getState();
    const view = { ...h.loaded.view, project: { ...h.loaded.project, system: { ...h.loaded.project.system, terms: { newGame: "はじめから" } } } };
    expect(textsOf(projectFrame(state, view).ui)).toEqual([h.loaded.project.meta.title, "はじめから", "コンティニュー"]);
  });

  it("カーソルはコマンドの行に合う", async () => {
    const h = await boot();
    const s = h.runtime.getState();
    const cursorY = (cursor: number): number => {
      const c = flatten(projectFrame({ ...s, scene: { kind: "title", screen: "main", cursor } }, h.loaded.view).ui).find((n) => n.kind === "cursor");
      return c?.kind === "cursor" ? c.y : NaN;
    };
    expect(cursorY(1) - cursorY(0)).toBe(24);
  });

  it("[snapshot] コンティニュー：空き・保存済み・読み込めないスロットが並ぶ", async () => {
    const h = await boot();
    const s = { ...h.runtime.getState(), scene: { kind: "title", screen: "continue", cursor: 1 } } as GameState;
    const slots = [meta(2), meta(3, { compatible: "no" })];
    const ui = projectFrame(s, h.loaded.view, undefined, { slots }).ui;
    expect(ui).toMatchSnapshot();
    const texts = textsOf(ui);
    expect(texts).toContain("コンティニュー");
    expect(texts.some((t) => t.includes("（空き）"))).toBe(true);
    expect(texts).toContain("1:02:05"); // 3725 秒
    expect(texts).toContain("（読み込めません）");
    expect(texts.some((t) => t.includes("はじまりの町") && t.includes("Lv7") && t.includes("勇者"))).toBe(true);
  });

  it("お知らせは画面の下に出る", async () => {
    const h = await boot();
    const f = projectFrame(h.runtime.getState(), h.loaded.view, undefined, { slots: [], notice: "loadFailed" });
    expect(textsOf(f.ui).at(-1)).toBe("ロードに失敗しました");
  });
});

describe("projectFrame（メニュー）", () => {
  const menuState = async (screen: "main" | "item" | "status" | "save" | "load", cursor = 0, patch?: (s: GameState) => GameState) => {
    const h = await boot();
    const base = { ...h.runtime.getState(), scene: { kind: "menu", screen, cursor } } as GameState;
    return { h, state: patch ? patch(base) : base };
  };

  it("マップの上に重ねる（背景のレイヤが残り、暗くする）", async () => {
    const { h, state } = await menuState("main");
    const f = projectFrame(state, h.loaded.view);
    expect(f.layers.length).toBeGreaterThan(0);
    expect(f.ui[0]).toMatchObject({ kind: "window", variant: "dim", x: 0, y: 0, w: f.size.width, h: f.size.height });
  });

  it("[snapshot] メイン：コマンド・所持金/プレイ時間・パーティの HP/MP", async () => {
    const { h, state } = await menuState("main", 2, (s) => ({ ...s, playtimeTicks: 60 * 61, party: { ...s.party, gold: 250 } }));
    expect(projectFrame(state, h.loaded.view).ui).toMatchSnapshot();
  });

  it("[snapshot] アイテム：所持品を名前 × 個数で。空なら（なし）", async () => {
    const { h, state } = await menuState("item", 1, (s) => ({ ...s, party: { ...s.party, items: { potion: 3, herb: 12 } as never } }));
    const texts = textsOf(projectFrame(state, h.loaded.view).ui);
    expect(texts).toContain("アイテム");
    expect(texts).toContain("herb"); // DB に無い ID は ID のまま
    expect(texts).toContain("× 12");
    expect(projectFrame(state, h.loaded.view).ui).toMatchSnapshot();
    const empty = await menuState("item");
    expect(textsOf(projectFrame(empty.state, empty.h.loaded.view).ui)).toContain("（なし）");
  });

  describe("アイテム・スキルの使用", () => {
    /** minimal に、ポーション・ヒール（習得済み）を足し、メニューに「スキル」を出す。 */
    const fieldState = async (scene: unknown) => {
      const h = await boot();
      const p = h.loaded.project;
      const patched = {
        ...p,
        system: { ...p.system, menuSkill: true },
        database: {
          ...p.database,
          skills: { sk_heal: { id: "sk_heal", name: "ヒール", mpCost: 3, scope: "one-ally", formula: "", effects: [{ kind: "recoverHp", value: 30 }] } },
          items: {
            potion: { id: "potion", name: "ポーション", kind: "consumable", price: 10, effects: [{ kind: "recoverHp", value: 50 }] },
            sword: { id: "sword", name: "鉄の剣", kind: "weapon", price: 1, effects: [] },
          },
          classes: { class_hero: { ...p.database.classes["class_hero" as never]!, skills: [{ level: 1, skill: "sk_heal" }] } },
        },
      } as unknown as Project;
      const view = createProjectView(patched, h.loaded.maps);
      const base = h.runtime.getState();
      const state = { ...base, party: { ...base.party, items: { potion: 3, sword: 1 } }, scene } as GameState;
      return { h: { loaded: { view } }, state };
    };
    const cursors = (nodes: readonly UiNode[]) => flatten(nodes).filter((n) => n.kind === "cursor");

    it("メインメニューに「スキル」が並ぶ（system.menuSkill）", async () => {
      const { h, state } = await fieldState({ kind: "menu", screen: "main", cursor: 0 });
      expect(textsOf(projectFrame(state, h.loaded.view).ui)).toEqual(expect.arrayContaining(["アイテム", "スキル", "ステータス"]));
    });

    it("アイテム：使えない物（武器）は灰色。対象を選んでいる間は右にパーティが出て、選んでいる人にカーソルが付く", async () => {
      const { h, state } = await fieldState({ kind: "menu", screen: "item", cursor: 0 });
      const colorOf = (s: GameState, text: string) => flatten(projectFrame(s, h.loaded.view).ui).find((n) => n.kind === "text" && n.text === text);
      expect(colorOf(state, "ポーション")).toMatchObject({ color: { r: 255, g: 255, b: 255 } });
      expect(colorOf(state, "鉄の剣")).toMatchObject({ color: { r: 128, g: 128, b: 128 } });

      expect(textsOf(projectFrame(state, h.loaded.view).ui).some((t) => t.startsWith("HP"))).toBe(false);
      const picking = { ...state, scene: { kind: "menu", screen: "item", cursor: 0, pick: { kind: "item", id: "potion", cursor: 0 } } } as GameState;
      const ui = projectFrame(picking, h.loaded.view).ui;
      expect(textsOf(ui).some((t) => t.startsWith("勇者"))).toBe(true);
      expect(textsOf(ui).some((t) => t.startsWith("HP"))).toBe(true);
      expect(flatten(ui).filter((n) => n.kind === "window")).toHaveLength(4); // 暗幕・アイテム一覧・パーティ・説明
      expect(cursors(ui)).toHaveLength(2); // 一覧のカーソルと、対象のカーソル
    });

    it("スキル：使う人の一覧 → その人のスキル（MP の消費つき。MP が足りないと灰色）→ 対象のパーティ", async () => {
      const { h, state } = await fieldState({ kind: "menu", screen: "skill", cursor: 0 });
      const who = textsOf(projectFrame(state, h.loaded.view).ui);
      expect(who.some((t) => t.startsWith("勇者") && t.includes("Lv"))).toBe(true);

      const listed = { ...state, scene: { kind: "menu", screen: "skill", cursor: 0, actor: 0 } } as GameState;
      const ui = projectFrame(listed, h.loaded.view).ui;
      expect(textsOf(ui)).toEqual(expect.arrayContaining(["スキル  勇者", "ヒール", "MP 3"]));
      const heal = flatten(ui).find((n) => n.kind === "text" && n.text === "ヒール");
      expect(heal).toMatchObject({ color: { r: 255, g: 255, b: 255 } });

      const noMp = { ...listed, actors: { ...listed.actors, actor_hero: { ...listed.actors["actor_hero" as never]!, mp: 1 } } } as GameState;
      expect(flatten(projectFrame(noMp, h.loaded.view).ui).find((n) => n.kind === "text" && n.text === "ヒール")).toMatchObject({ color: { r: 128, g: 128, b: 128 } });

      const picking = { ...listed, scene: { kind: "menu", screen: "skill", cursor: 0, actor: 0, pick: { kind: "skill", id: "sk_heal", user: "actor_hero", cursor: 0 } } } as GameState;
      expect(flatten(projectFrame(picking, h.loaded.view).ui).filter((n) => n.kind === "window")).toHaveLength(4); // 暗幕・スキル一覧・パーティ・説明
    });
  });

  describe("装備", () => {
    /** minimal に、鉄の剣（atk +10。勇者の初期装備）・銅の剣（atk +4）・指輪（装飾品）を足し、メニューに「装備」を出す。 */
    const equipState = async (scene: unknown) => {
      const h = await boot();
      const p = h.loaded.project;
      const patched = {
        ...p,
        system: { ...p.system, menuEquip: true },
        database: {
          ...p.database,
          actors: { ...p.database.actors, actor_hero: { ...p.database.actors["actor_hero" as never]!, equips: { weapon: "sword" } } },
          items: {
            sword: { id: "sword", name: "鉄の剣", kind: "weapon", price: 1, effects: [], params: { atk: 10 } },
            copper: { id: "copper", name: "銅の剣", kind: "weapon", price: 1, effects: [], params: { atk: 4 } },
            ring: { id: "ring", name: "指輪", kind: "armor", price: 1, effects: [], params: { mdf: 3 }, equipSlot: "accessory" },
          },
        },
      } as unknown as Project;
      const view = createProjectView(patched, h.loaded.maps);
      const base = h.runtime.getState();
      const state = { ...base, party: { ...base.party, items: { copper: 1, ring: 1 } }, scene } as GameState;
      return { view, state };
    };
    const find = (nodes: readonly UiNode[], text: string) => flatten(nodes).find((n) => n.kind === "text" && n.text === text);

    it("メインメニューに「装備」が並ぶ（system.menuEquip）。最初は装備を替える人の一覧", async () => {
      const { view, state } = await equipState({ kind: "menu", screen: "main", cursor: 0 });
      expect(textsOf(projectFrame(state, view).ui)).toEqual(expect.arrayContaining(["アイテム", "装備", "ステータス"]));
      const who = textsOf(projectFrame({ ...state, scene: { kind: "menu", screen: "equip", cursor: 0 } } as GameState, view).ui);
      expect(who[0]).toBe("装備");
      expect(who.some((t) => t.startsWith("勇者") && t.includes("Lv"))).toBe(true);
    });

    it("人を選ぶと、装備欄（いまの装備。空きは「（なし）」）と能力値が出る。能力値は装備を含む", async () => {
      const { view, state } = await equipState({ kind: "menu", screen: "equip", cursor: 0, actor: 0 });
      const ui = projectFrame(state, view).ui;
      expect(textsOf(ui)).toEqual(expect.arrayContaining(["装備  勇者", "武器", "鉄の剣", "防具", "装飾品", "（なし）", "攻撃力"]));
      expect(textsOf(ui).some((t) => t.startsWith("→"))).toBe(false);
      const status = await equipState({ kind: "menu", screen: "status", cursor: 0 });
      const atkLine = textsOf(projectFrame(status.state, status.view).ui).find((t) => t.startsWith("攻撃力 "))!;
      const bareAtk = Number(atkLine.slice("攻撃力 ".length)) - 10;
      expect(find(ui, String(bareAtk + 10))).toBeDefined();
    });

    it("アイテム画面は 消耗品 → 武器 → 装飾品 の順に、分類の見出しを挟んで並ぶ。カーソルは見出しを飛ばす", async () => {
      const { view, state } = await equipState({ kind: "menu", screen: "item", cursor: 0 });
      const withPotion = { ...state, party: { ...state.party, items: { ring: 1, copper: 1, potion: 2 } } } as GameState;
      const patched = createProjectView(
        { ...view.project, database: { ...view.project.database, items: { ...view.project.database.items, potion: { id: "potion", name: "ポーション", kind: "consumable", price: 1, effects: [{ kind: "recoverHp", value: 10 }] } } } } as unknown as Project,
        {},
      );
      const ui = projectFrame(withPotion, patched).ui;
      const texts = textsOf(ui);
      const order = ["アイテム", "ポーション", "武器", "銅の剣", "装飾品", "指輪"].map((t) => texts.indexOf(t));
      expect(order.every((i) => i >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      const cursorY = (cursor: number) => flatten(projectFrame({ ...withPotion, scene: { kind: "menu", screen: "item", cursor } } as GameState, patched).ui).find((n) => n.kind === "cursor")!.y;
      expect(cursorY(1) - cursorY(0)).toBe(48); // ポーション → （武器の見出し）→ 銅の剣
      // 消耗品だけなら見出しは付けない（これまでどおり）
      const only = { ...withPotion, party: { ...withPotion.party, items: { potion: 2 } } } as GameState;
      expect(textsOf(projectFrame(only, patched).ui).filter((t) => t === "アイテム")).toHaveLength(1); // 窓の題だけ
    });

    it("欄を選ぶと、付けられる持ち物と末尾に「（外す）」が並び、付け替えたあとの能力値を色で示す（下がれば赤、上がれば緑）", async () => {
      const { view, state } = await equipState({ kind: "menu", screen: "equip", cursor: 0, actor: 0, slot: 0 });
      const ui = projectFrame(state, view).ui;
      expect(textsOf(ui)).toEqual(expect.arrayContaining(["銅の剣", "× 1", "（外す）"]));
      expect(textsOf(ui)).not.toContain("指輪");
      const down = flatten(ui).find((n) => n.kind === "text" && n.text.startsWith("→") && n.color.r === 255 && n.color.g === 120);
      expect(down).toBeDefined(); // 攻撃力 +10 → +4
      const ring = { ...state, scene: { kind: "menu", screen: "equip", cursor: 0, actor: 0, slot: 2 } } as GameState;
      const up = flatten(projectFrame(ring, view).ui).find((n) => n.kind === "text" && n.text.startsWith("→") && n.color.g === 204);
      expect(up).toBeDefined(); // 魔法防御 +3
      expect(flatten(ui).filter((n) => n.kind === "window")).toHaveLength(5); // 暗幕・装備欄・候補・能力値・説明
    });
  });

  it("[snapshot] ステータス：名前・クラス・レベル・HP/MP・能力値", async () => {
    const { h, state } = await menuState("status");
    expect(projectFrame(state, h.loaded.view).ui).toMatchSnapshot();
    const texts = textsOf(projectFrame(state, h.loaded.view).ui);
    expect(texts.some((t) => t.startsWith("ステータス  1/1"))).toBe(true);
    expect(texts.some((t) => t.startsWith("攻撃力 "))).toBe(true);
  });

  it("ステータス：パーティが空でも例外を出さない", async () => {
    const { h, state } = await menuState("status", 3);
    expect(() => projectFrame(state, h.loaded.view)).not.toThrow();
  });

  it("セーブ/ロード：スロット一覧（見出しだけが違う）", async () => {
    const slots = [meta(1)];
    const save = await menuState("save");
    const load = await menuState("load");
    expect(textsOf(projectFrame(save.state, save.h.loaded.view, undefined, { slots }).ui)).toContain("セーブ");
    expect(textsOf(projectFrame(load.state, load.h.loaded.view, undefined, { slots }).ui)).toContain("ロード");
  });

  it("確認ダイアログ：一覧の上に問いかけと はい/いいえ を重ね、カーソルが選択に従う", async () => {
    const at = (screen: "save" | "load", confirm: NonNullable<Extract<GameState["scene"], { kind: "menu" }>["confirm"]>) =>
      menuState(screen, 0, (s) => ({ ...s, scene: { kind: "menu", screen, cursor: 0, confirm } }));
    const save = await at("save", { kind: "save", slot: 4, cursor: 1 });
    const ui = projectFrame(save.state, save.h.loaded.view, undefined, { slots: [meta(4)] }).ui;
    const texts = textsOf(ui);
    expect(texts).toEqual(expect.arrayContaining(["セーブ", "スロット4 に上書きしますか？", "はい", "いいえ"]));
    const cursorY = (state: GameState, view: typeof save.h.loaded.view): number => {
      const dialog = projectFrame(state, view, undefined, { slots: [] }).ui.filter((n) => n.kind === "window").at(-1);
      const cursor = dialog?.kind === "window" ? dialog.children.find((c) => c.kind === "cursor") : undefined;
      return cursor?.kind === "cursor" ? cursor.y : NaN;
    };
    const yes = await at("save", { kind: "save", slot: 4, cursor: 0 });
    expect(cursorY(yes.state, yes.h.loaded.view)).toBeLessThan(cursorY(save.state, save.h.loaded.view)); // はい は いいえ の上

    const load = await at("load", { kind: "load", slot: 2, cursor: 1 });
    expect(textsOf(projectFrame(load.state, load.h.loaded.view, undefined, { slots: [] }).ui)).toContain("未セーブの進行は失われます。ロードしますか？");
  });

  it("確認ダイアログの文言は system.terms で差し替えられる", async () => {
    const h = await createRuntimeHarness({ project: "minimal", title: true, patchProject: (p) => ({ ...p, system: { ...p.system, terms: { ...p.system.terms, confirmOverwrite: "上書き{slot}？", yes: "OK" } } }) });
    const state = { ...h.runtime.getState(), scene: { kind: "menu", screen: "save", cursor: 0, confirm: { kind: "save", slot: 7, cursor: 0 } } } as GameState;
    expect(textsOf(h.runtime.project(state).ui)).toEqual(expect.arrayContaining(["上書き7？", "OK", "いいえ"]));
  });

  it("スロット一覧はカーソルが見える範囲にスクロールする", async () => {
    const { h, state } = await menuState("save", SAVE_SLOT_COUNT - 1);
    const ui = projectFrame(state, h.loaded.view, undefined, { slots: [] }).ui;
    const rows = textsOf(ui).filter((t) => t.includes("（空き）"));
    expect(rows.at(-1)).toContain(String(SAVE_SLOT_COUNT));
    expect(rows.length).toBeLessThan(SAVE_SLOT_COUNT); // 全部は出さない（画面に収まる分だけ）
  });

  it("[inv-3] 純粋：凍結した state・UiContext から deep-equal な結果を返し、JSON にできる", async () => {
    const { h, state } = await menuState("save", 2);
    const frozen = deepFreeze(state);
    const ui = deepFreeze({ slots: [meta(2)], notice: "saved" as const });
    const a = projectFrame(frozen, h.loaded.view, undefined, ui);
    expect(projectFrame(frozen, h.loaded.view, undefined, ui)).toEqual(a);
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
    expect(projectFrame(frozen, h.loaded.view, undefined, NO_UI).ui).not.toEqual(a.ui);
  });

  it("入力を通したメニューも投影できる（runtime 経由）", async () => {
    const h = await createRuntimeHarness({ project: "minimal" });
    h.play(inputFrame(["menu"], ["menu"]));
    expect(h.runtime.getState().scene).toEqual({ kind: "menu", screen: "main", cursor: 0 });
    expect(textsOf(h.renderer.last()?.ui ?? [])).toContain("アイテム");
  });
});

describe("ui helpers", () => {
  it("formatPlaytime は h:mm:ss", () => {
    expect(formatPlaytime(0)).toBe("0:00:00");
    expect(formatPlaytime(60 * 3725 + 59)).toBe("1:02:05");
  });

  it("firstVisible はカーソルを中央付近に保ち、端で止まる", () => {
    expect(firstVisible(0, 10, 4)).toBe(0);
    expect(firstVisible(5, 10, 4)).toBe(3);
    expect(firstVisible(9, 10, 4)).toBe(6);
    expect(firstVisible(3, 3, 8)).toBe(0);
  });
});

