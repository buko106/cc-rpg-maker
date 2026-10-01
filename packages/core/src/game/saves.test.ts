import { loadFixtureProject } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { createCtx } from "../ctx.js";
import { emptyInput, inputFrame } from "../input.js";
import type { Button } from "../input.js";
import { startInterpreter } from "../interpreter/index.js";
import { createProjectView } from "../project-view.js";
import type { GameState } from "../state.js";
import { AUTOSAVE_SLOT, initialState, loadSlotNumbers, MENU_ITEMS, SAVE_SLOT_COUNT, saveSlotNumbers, step, titleState } from "./index.js";
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
const loadScreen = (ctx: typeof plain.ctx): GameState => pressAll(ctx, initialState(ctx, "seed"), "menu", ...Array<Button>(MENU_ITEMS.indexOf("load")).fill("down"), "ok");

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
    const save = pressAll(auto.ctx, initialState(auto.ctx, "seed"), "menu", ...Array<Button>(MENU_ITEMS.indexOf("save")).fill("down"), "ok");
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

describe("SaveGame コマンド", () => {
  const exec = (params: Record<string, unknown>, state = initialState(plain.ctx, "seed")): StepResult => {
    const s = startInterpreter(state, { kind: "plugin", name: "t" }, [{ code: "SaveGame", params, indent: 0 }, { code: "ControlSwitches", params: { ids: ["after"], value: true }, indent: 0 }], "normal");
    let cur = s;
    const effects: StepResult["effects"][number][] = [];
    for (let i = 0; i < 3; i++) {
      const r = step(cur, emptyInput(), plain.ctx);
      cur = r.state;
      effects.push(...r.effects);
    }
    return { state: cur, effects };
  };

  it("slot ありは、画面を開かずに確認なしの保存を要求して次のコマンドへ進む", () => {
    const r = exec({ slot: 3 });
    expect(r.effects.filter((e) => e.kind === "requestSave")).toEqual([{ kind: "requestSave", slot: 3, confirmed: true }]);
    expect(r.state.scene).toEqual({ kind: "map" });
    expect(r.state.switches["after" as never]).toBe(true);
  });

  it("slot なしは従来どおりセーブ画面を開く", () => {
    const r = exec({});
    expect(r.state.scene).toEqual({ kind: "menu", screen: "save", cursor: 0 });
    expect(r.effects.filter((e) => e.kind === "requestSave")).toEqual([]);
  });

  it("slot は 1〜10 だけ（0 はオートセーブ専用）", () => {
    const handler = plain.ctx.commands.get("SaveGame")!;
    expect(handler.params.safeParse({ slot: 1 }).success).toBe(true);
    expect(handler.params.safeParse({ slot: SAVE_SLOT_COUNT }).success).toBe(true);
    expect(handler.params.safeParse({ slot: 0 }).success).toBe(false);
    expect(handler.params.safeParse({ slot: SAVE_SLOT_COUNT + 1 }).success).toBe(false);
    expect(handler.params.safeParse({ slot: 1.5 }).success).toBe(false);
  });
});
