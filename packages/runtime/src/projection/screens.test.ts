import { describe, expect, it } from "vitest";
import { inputFrame, SAVE_SLOT_COUNT } from "@rpg/core";
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

