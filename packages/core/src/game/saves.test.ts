import { loadFixtureProject } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { createCtx } from "../ctx.js";
import { emptyInput, inputFrame } from "../input.js";
import type { Button } from "../input.js";
import { startInterpreter } from "../interpreter/index.js";
import { createProjectView } from "../project-view.js";
import type { GameState } from "../state.js";
import { AUTOSAVE_SLOT, dispatch, initialState, loadSlotNumbers, menuItems, SAVE_SLOT_COUNT, saveSlotNumbers, step, titleState } from "./index.js";
import type { StepResult } from "./index.js";

/** プロジェクトに `system.autosave` を足した ctx。 */
function withAutosave(name: string, onTransfer: boolean) {
  const loaded = loadFixtureProject(name);
  const project = { ...loaded.project, system: { ...loaded.project.system, autosave: { onTransfer } } };
  return { ...loaded, view: createProjectView(project, loaded.maps), ctx: createCtx(createProjectView(project, loaded.maps)) };
}
const plain = loadFixtureProject("minimal");
const auto = withAutosave("minimal", true);

const press = (ctx: typeof plain.ctx, state: GameState, ...buttons: Button[]): StepResult => step(state, inputFrame(buttons, buttons), ctx);
const pressAll = (ctx: typeof plain.ctx, state: GameState, ...buttons: Button[]): GameState => buttons.reduce((s, b) => press(ctx, s, b).state, state);
const loadScreen = (ctx: typeof plain.ctx): GameState => pressAll(ctx, initialState(ctx, "seed"), "menu", ...Array<Button>(menuItems(ctx.project).indexOf("load")).fill("down"), "ok");

describe("スロット番号", () => {
  it("手動セーブは 1〜10。ロードはオートセーブが有効なときだけ先頭にスロット 0 が付く", () => {
    expect(saveSlotNumbers()).toEqual(Array.from({ length: SAVE_SLOT_COUNT }, (_, i) => i + 1));
    expect(loadSlotNumbers(plain.view)).toEqual(saveSlotNumbers());
    expect(loadSlotNumbers(auto.view)).toEqual([AUTOSAVE_SLOT, ...saveSlotNumbers()]);
    expect(loadSlotNumbers(withAutosave("minimal", false).view)).toEqual(saveSlotNumbers());
  });

  it("ロード画面：オートセーブが有効なら先頭の行がスロット 0、末尾は 10。上から戻ると 10 に回る", () => {
    const load = loadScreen(auto.ctx);
    expect(press(auto.ctx, load, "ok").effects).toEqual([{ kind: "requestLoad", slot: 0 }]);
    expect(press(auto.ctx, pressAll(auto.ctx, load, "down"), "ok").effects).toEqual([{ kind: "requestLoad", slot: 1 }]);
    expect(press(auto.ctx, pressAll(auto.ctx, load, "up"), "ok").effects).toEqual([{ kind: "requestLoad", slot: SAVE_SLOT_COUNT }]);
    // 無効なら従来どおり先頭がスロット 1
    expect(press(plain.ctx, loadScreen(plain.ctx), "ok").effects).toEqual([{ kind: "requestLoad", slot: 1 }]);
  });

  it("コンティニュー：同じくオートセーブが有効なら先頭がスロット 0", () => {
    const list = pressAll(auto.ctx, titleState(auto.ctx, "seed"), "down", "ok");
    expect(press(auto.ctx, list, "ok").effects).toEqual([{ kind: "requestLoad", slot: 0 }]);
    expect(press(auto.ctx, pressAll(auto.ctx, list, "up"), "ok").effects).toEqual([{ kind: "requestLoad", slot: SAVE_SLOT_COUNT }]);
  });

  it("セーブ画面にはオートセーブは並ばない（手動では書けない）", () => {
    const save = pressAll(auto.ctx, initialState(auto.ctx, "seed"), "menu", ...Array<Button>(menuItems(auto.ctx.project).indexOf("save")).fill("down"), "ok");
    expect(press(auto.ctx, save, "ok").effects).toEqual([{ kind: "requestSave", slot: 1 }]);
    expect(press(auto.ctx, pressAll(auto.ctx, save, "up"), "ok").effects).toEqual([{ kind: "requestSave", slot: SAVE_SLOT_COUNT }]);
  });
});

describe("オートセーブの発火（場所移動）", () => {
  const run = (name: string, onTransfer: boolean | undefined): { effects: StepResult["effects"]; state: GameState } => {
    const { ctx } = onTransfer === undefined ? loadFixtureProject(name) : withAutosave(name, onTransfer);
    let s = startInterpreter(initialState(ctx, "seed"), { kind: "plugin", name: "t" }, [{ code: "TransferPlayer", params: { mapId: "map_b", x: 2, y: 3, fade: "none" }, indent: 0 }], "normal");
    const effects: StepResult["effects"][number][] = [];
    for (let i = 0; i < 10; i++) {
      const r = step(s, emptyInput(), ctx);
      s = r.state;
      effects.push(...r.effects);
    }
    return { effects, state: s };
  };

  it("system.autosave.onTransfer が有効なら、移動先に着いたときに 1 回だけ slot 0 の保存を要求する", () => {
    const r = run("transfer-demo", true);
    expect(r.state.map.mapId).toBe("map_b");
    expect(r.effects.filter((e) => e.kind === "requestSave")).toEqual([{ kind: "requestSave", slot: AUTOSAVE_SLOT }]);
  });

  it("無効（false）・設定なしなら要求しない", () => {
    expect(run("transfer-demo", false).effects.filter((e) => e.kind === "requestSave")).toEqual([]);
    const none = run("transfer-demo", undefined);
    expect(none.state.map.mapId).toBe("map_b");
    expect(none.effects.filter((e) => e.kind === "requestSave")).toEqual([]);
  });
});

/** プロジェクトの `system.menuSave` を差し替えた ctx。 */
function withMenuSave(menuSave: boolean | undefined) {
  const project = { ...plain.project, system: { ...plain.project.system, ...(menuSave === undefined ? {} : { menuSave }) } };
  return createCtx(createProjectView(project, plain.maps));
}

describe("セーブポータル（イベントから開くセーブ画面）", () => {
  const open = (code: "SaveGame" | "LoadGame", ctx = plain.ctx): GameState => {
    let s = startInterpreter(initialState(ctx, "seed"), { kind: "plugin", name: "t" }, [{ code, params: {}, indent: 0 }], "normal");
    for (let i = 0; i < 3; i++) s = step(s, emptyInput(), ctx).state;
    return s;
  };

  it("SaveGame は画面を開くだけで、保存は要求しない。決定でそのスロットを要求する", () => {
    const portal = open("SaveGame");
    expect(portal.scene).toEqual({ kind: "menu", screen: "save", cursor: 0, portal: true });
    expect(press(plain.ctx, pressAll(plain.ctx, portal, "down"), "ok").effects).toEqual([{ kind: "requestSave", slot: 2 }]);
  });

  it("キャンセルでメインメニューを経由せずマップに戻り、イベントが続きから動く", () => {
    const back = press(plain.ctx, open("SaveGame"), "cancel").state;
    expect(back.scene).toEqual({ kind: "map" });
    expect(back.interpreters).toHaveLength(0);
    expect(press(plain.ctx, open("LoadGame"), "cancel").state.scene).toEqual({ kind: "map" });
  });

  it("確認ダイアログの間のキャンセルは、まずダイアログだけを閉じる", () => {
    const asked = dispatch(open("SaveGame"), { type: "askConfirm", kind: "save", slot: 1 }, plain.ctx).state;
    const closed = press(plain.ctx, asked, "cancel").state;
    expect(closed.scene).toEqual({ kind: "menu", screen: "save", cursor: 0, portal: true });
    expect(press(plain.ctx, closed, "cancel").state.scene).toEqual({ kind: "map" });
  });

  it("メニューから開いたセーブ画面は従来どおり、キャンセルでメインメニューに戻る", () => {
    const fromMenu = pressAll(plain.ctx, initialState(plain.ctx, "seed"), "menu", "down", "down", "ok");
    expect(press(plain.ctx, fromMenu, "cancel").state.scene).toEqual({ kind: "menu", screen: "main", cursor: 2 });
  });
});

describe("system.menuSave（メニューからのセーブ可否）", () => {
  const mainItems = (ctx: typeof plain.ctx): string[] => {
    const items: string[] = [];
    let s = pressAll(ctx, initialState(ctx, "seed"), "menu");
    for (let i = 0; i < 6; i++) {
      const next = press(ctx, s, "ok").state;
      items.push(next.scene.kind === "menu" ? next.scene.screen : "?");
      s = press(ctx, press(ctx, next, "cancel").state, "down").state;
    }
    return items;
  };

  it("省略・true ならメインメニューに「セーブ」が並ぶ。false なら並ばない（アイテム/ステータス/ロード）", () => {
    expect(mainItems(withMenuSave(undefined)).slice(0, 4)).toEqual(["item", "status", "save", "load"]);
    expect(mainItems(withMenuSave(true)).slice(0, 4)).toEqual(["item", "status", "save", "load"]);
    expect(mainItems(withMenuSave(false)).slice(0, 3)).toEqual(["item", "status", "load"]);
  });

  it("false のとき、ロードから戻るカーソル位置は詰めた並びに合う。メインメニューのカーソルは 3 つで循環する", () => {
    const ctx = withMenuSave(false);
    const main = pressAll(ctx, initialState(ctx, "seed"), "menu");
    expect(press(ctx, main, "up").state.scene).toEqual({ kind: "menu", screen: "main", cursor: 2 });
    const load = pressAll(ctx, main, "down", "down", "ok");
    expect(load.scene).toMatchObject({ screen: "load" });
    expect(press(ctx, load, "cancel").state.scene).toEqual({ kind: "menu", screen: "main", cursor: 2 });
  });

  it("false でもイベントのセーブポータルからはセーブできる", () => {
    const ctx = withMenuSave(false);
    let s = startInterpreter(initialState(ctx, "seed"), { kind: "plugin", name: "t" }, [{ code: "SaveGame", params: {}, indent: 0 }], "normal");
    for (let i = 0; i < 3; i++) s = step(s, emptyInput(), ctx).state;
    expect(press(ctx, s, "ok").effects).toEqual([{ kind: "requestSave", slot: 1 }]);
  });
});
