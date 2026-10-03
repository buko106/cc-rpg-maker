// @vitest-environment jsdom
import { createNullAudioOut } from "@rpg/audio-null";
import { cmd } from "@rpg/editor-core";
import { createScriptInput } from "@rpg/input-script";
import { createNullRenderer } from "@rpg/render-null";
import type { AssetSource, ImageHandle } from "@rpg/runtime";
import type { ItemId, MapId, SwitchId, VariableId } from "@rpg/schema";
import { createManualScheduler } from "@rpg/test-utils";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DebugPanel } from "./components/DebugPanel.js";
import { debugCommands, runDebug } from "./debug-commands.js";
import { startPlaytest } from "./playtest.js";
import { createTestEnv, fakePlaytestRuntime } from "./test-env.js";
import type { TestEnv } from "./test-env.js";

const M1 = "map_001" as MapId;
const CAVE = "map_cave" as MapId;
const SW = "sw_door" as SwitchId;
const VAR = "var_day" as VariableId;
const ITEM = "item_potion" as ItemId;
let t: TestEnv;
beforeEach(async () => {
  t = await createTestEnv();
  act(() => void t.session.execute(cmd.createMap({ name: "洞窟", order: 1 }, { width: 8, height: 8 }, CAVE)));
  act(() => void t.session.execute(cmd.setSwitchName(SW, "扉が開いた")));
  act(() => void t.session.execute(cmd.setVariableName(VAR, "日数")));
  act(() => void t.session.execute(cmd.upsertEntity("items", { id: ITEM, name: "薬草", kind: "consumable", price: 10, effects: [] } as never)));
});
afterEach(cleanup);

const assets: AssetSource = {
  loadImage: () => Promise.resolve({} as ImageHandle),
  loadAudio: () => Promise.reject(new Error("音声なし")),
  loadJson: () => Promise.reject(new Error("JSON なし")),
  has: () => Promise.resolve(true),
};

describe("runDebug（本物の Runtime）", () => {
  it("スイッチ・変数・所持金・アイテム・場所の移動が、イベントコマンドとして効く", async () => {
    const scheduler = createManualScheduler();
    const pt = await startPlaytest(t.session, { scheduler, renderer: createNullRenderer(), audio: createNullAudioOut(), input: createScriptInput([]), assets, seed: "s" }, { mapId: M1, x: 1, y: 1 });
    runDebug(pt.runtime, [debugCommands.setSwitch(SW, true), debugCommands.setVariable(VAR, 7), debugCommands.addGold(300), debugCommands.addItem(ITEM, 3), debugCommands.warp(CAVE, 2, 5)]);
    scheduler.advance(500);
    await pt.runtime.settled();
    scheduler.advance(500);
    const s = pt.runtime.getState();
    expect(s.switches[SW]).toBe(true);
    expect(s.variables[VAR]).toBe(7);
    expect(s.party.gold).toBe(300);
    expect(s.party.items[ITEM]).toBe(3);
    expect(s.map.mapId).toBe(CAVE);
    expect(s.map.player).toMatchObject({ x: 2, y: 5 });
    // 減らす（0 未満にはならない）
    runDebug(pt.runtime, [debugCommands.addGold(-1000), debugCommands.addItem(ITEM, -1)]);
    scheduler.advance(200);
    expect(pt.runtime.getState().party.gold).toBe(0);
    expect(pt.runtime.getState().party.items[ITEM]).toBe(2);
    pt.stop();
  });
});

describe("DebugPanel", () => {
  const setup = (): unknown[] => {
    const dispatched: unknown[] = [];
    render(t.wrap(<DebugPanel runtime={fakePlaytestRuntime(dispatched)} />));
    return dispatched;
  };
  const commandsOf = (a: unknown): unknown => (a as { commands: unknown }).commands;

  it("スイッチを切り替えると ControlSwitches が走る", () => {
    const d = setup();
    fireEvent.click(screen.getByLabelText("扉が開いた（sw_door）"));
    expect(d).toEqual([{ type: "interpreter", op: "start", origin: { kind: "plugin", name: "debug" }, mode: "normal", commands: [debugCommands.setSwitch(SW, true)] }]);
  });

  it("変数は Enter（またはフォーカスが外れたとき）で設定する", () => {
    const d = setup();
    const input = screen.getByLabelText("日数（var_day）");
    fireEvent.change(input, { target: { value: "12" } });
    expect(d).toHaveLength(0);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(commandsOf(d[0])).toEqual([debugCommands.setVariable(VAR, 12)]);
    fireEvent.change(input, { target: { value: "3" } });
    fireEvent.blur(input);
    expect(commandsOf(d[1])).toEqual([debugCommands.setVariable(VAR, 3)]);
  });

  it("所持金・アイテム・場所の移動のボタン", () => {
    const d = setup();
    fireEvent.click(screen.getByRole("button", { name: "所持金を増やす" }));
    fireEvent.change(screen.getByLabelText("アイテムの数"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "アイテムを増やす" }));
    fireEvent.change(screen.getByLabelText("移動先のマップ"), { target: { value: CAVE } });
    fireEvent.change(screen.getByLabelText("移動先の X"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("移動先の Y"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "移動" }));
    expect(d.map(commandsOf)).toEqual([[debugCommands.addGold(100)], [debugCommands.addItem(ITEM, 4)], [debugCommands.warp(CAVE, 2, 3)]]);
  });

  it("ここでのキー入力はゲームに届かない（Esc だけは閉じるために通す）", () => {
    setup();
    const seen: string[] = [];
    const onKey = (e: KeyboardEvent): void => void seen.push(e.key);
    window.addEventListener("keydown", onKey);
    try {
      fireEvent.keyDown(screen.getByLabelText("日数（var_day）"), { key: "z" });
      fireEvent.keyDown(screen.getByLabelText("日数（var_day）"), { key: "Escape" });
    } finally {
      window.removeEventListener("keydown", onKey);
    }
    expect(seen).toEqual(["Escape"]);
  });
});
