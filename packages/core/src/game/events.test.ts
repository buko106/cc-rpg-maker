import type { EventCommand, EventPage, MapEvent, PageCondition } from "@rpg/schema";
import { cmd, loadFixtureProject } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { emptyInput, inputFrame } from "../input.js";
import type { Button } from "../input.js";
import type { GameState } from "../state.js";
import { initialState, step } from "./index.js";

type Loaded = ReturnType<typeof loadFixtureProject>;

/** minimal の NPC を取り除き、テスト用のイベントだけを置いたプロジェクトを作る。 */
function setup(...events: MapEvent[]): Loaded {
  const loaded = loadFixtureProject("minimal");
  const map = loaded.maps["map_start" as never]!;
  (map as { events: unknown }).events = Object.fromEntries(events.map((e) => [e.id, e]));
  return loaded;
}
const page = (o: Partial<EventPage> & { commands: EventCommand[] }): EventPage => ({
  conditions: [], trigger: "action", through: false, priority: "same", ...o,
});
const event = (id: string, x: number, y: number, ...pages: EventPage[]): MapEvent => ({ id: id as never, name: id, x, y, pages });
const off = (id: string): PageCondition => ({ kind: "switch", id: id as never, value: false });
const on = (id: string): PageCondition => ({ kind: "switch", id: id as never, value: true });
const setSwitch = (id: string, value = true): EventCommand => cmd("ControlSwitches", { ids: [id], value });
const addVar = (id: string, n = 1): EventCommand => cmd("ControlVariables", { ids: [id], op: "add", operand: { kind: "constant", value: n } });

const v = (s: GameState, id: string): number => (s.variables as Record<string, number>)[id] ?? 0;
const sw = (s: GameState, id: string): boolean => (s.switches as Record<string, boolean>)[id] === true;

function frames(state: GameState, n: number, ctx: Loaded["ctx"], button?: Button, everyFrame = false): GameState {
  let s = state;
  for (let i = 0; i < n; i++) s = step(s, button ? inputFrame([button], i === 0 || everyFrame ? [button] : []) : emptyInput(), ctx).state;
  return s;
}

describe("autorun events", () => {
  it("start by themselves, run once, and stop when their page condition no longer holds", () => {
    const { ctx } = setup(event("auto", 8, 6, page({ trigger: "autorun", conditions: [off("done")], commands: [addVar("n"), setSwitch("done")] })));
    const s = frames(initialState(ctx, "s"), 10, ctx);
    expect(v(s, "n")).toBe(1);
    expect(sw(s, "done")).toBe(true);
    expect(s.interpreters).toHaveLength(0);
    expect(s.map.events["auto" as never]).toMatchObject({ pageIndex: null });
  });

  it("repeats every frame while the page stays active (RPG Maker behaviour)", () => {
    const { ctx } = setup(event("auto", 8, 6, page({ trigger: "autorun", commands: [addVar("n")] })));
    expect(v(frames(initialState(ctx, "s"), 10, ctx), "n")).toBe(10);
  });

  it("takes over the player's control while running", () => {
    const { ctx } = setup(event("auto", 8, 6, page({ trigger: "autorun", conditions: [off("done")], commands: [cmd("Wait", { frames: 30 }), setSwitch("done")] })));
    const s = frames(initialState(ctx, "s"), 20, ctx, "right", true);
    // 自動実行イベントは tick で起動するので、最初のフレームの入力（1 歩目）だけは受理される。以後は動けない。
    expect(s.map.player).toMatchObject({ x: 3, moving: false });
    const after = frames(s, 40, ctx, "right", true);
    expect(after.map.player.x).toBeGreaterThan(3); // 終わったら動ける
  });

  it("does not start while a message is open or another normal event is running", () => {
    const { ctx } = setup(
      event("talk", 3, 2, page({ commands: [cmd("ShowText", { text: "hi" })] })),
      event("auto", 8, 6, page({ trigger: "autorun", conditions: [on("go"), off("done")], commands: [addVar("n"), setSwitch("done")] })),
    );
    let s = frames(initialState(ctx, "s"), 20, ctx, "right", true); // (2,2) → 隣の talk に突き当たる
    s = frames(s, 1, ctx, "ok");
    expect(s.message.open).toBe(true);
    s = { ...s, switches: { ...s.switches, ["go" as never]: true } };
    s = frames(s, 10, ctx);
    expect(v(s, "n")).toBe(0);
    s = frames(s, 1, ctx, "ok");
    s = frames(s, 5, ctx);
    expect(v(s, "n")).toBe(1);
  });
});

describe("parallel events", () => {
  it("run alongside player movement and loop while their page is active", () => {
    const { ctx } = setup(event("par", 8, 6, page({ trigger: "parallel", commands: [addVar("n"), cmd("Wait", { frames: 9 })] })));
    let s = initialState(ctx, "s");
    s = frames(s, 40, ctx, "right", true);
    expect(s.map.player.x).toBeGreaterThan(2); // 並列イベントは操作を妨げない
    expect(v(s, "n")).toBeGreaterThanOrEqual(4); // 10 フレームごとに 1 回
    expect(v(s, "n")).toBeLessThanOrEqual(5);
    expect(s.interpreters.every((i) => i.mode === "parallel")).toBe(true);
  });

  it("start only once per active page (no duplicates)", () => {
    const { ctx } = setup(event("par", 8, 6, page({ trigger: "parallel", commands: [cmd("Wait", { frames: 1000 })] })));
    const s = frames(initialState(ctx, "s"), 30, ctx);
    expect(s.interpreters).toHaveLength(1);
  });

  it("stop as soon as the event's page is no longer active", () => {
    const { ctx } = setup(
      event("par", 8, 6, page({ trigger: "parallel", conditions: [off("stop")], commands: [addVar("n"), cmd("Wait", { frames: 1000 })] })),
      event("stopper", 8, 5, page({ trigger: "parallel", conditions: [on("go"), off("stop")], commands: [setSwitch("stop")] })),
    );
    let s = frames(initialState(ctx, "s"), 10, ctx);
    expect(s.interpreters).toHaveLength(2 - 1); // stopper はまだ無効
    s = { ...s, switches: { ...s.switches, ["go" as never]: true } };
    s = frames(s, 5, ctx);
    expect(sw(s, "stop")).toBe(true);
    expect(s.interpreters).toHaveLength(0);
    expect(v(s, "n")).toBe(1);
  });

  it("do not block a normal event started by the player", () => {
    const { ctx } = setup(
      event("par", 8, 6, page({ trigger: "parallel", commands: [addVar("n"), cmd("Wait", { frames: 3 })] })),
      event("talk", 3, 2, page({ commands: [cmd("ShowText", { text: "hi" })] })),
    );
    let s = frames(initialState(ctx, "s"), 20, ctx, "right", true);
    s = frames(s, 1, ctx, "ok");
    expect(s.message.open).toBe(true);
    const before = v(s, "n");
    s = frames(s, 20, ctx);
    expect(v(s, "n")).toBeGreaterThan(before); // メッセージ表示中も並列イベントは進む
    expect(s.message.open).toBe(true);
  });
});

describe("touch and action triggers by priority", () => {
  it("a below-priority touch event fires when the player steps onto its tile, and does not block", () => {
    const { ctx } = setup(event("mat", 3, 2, page({ trigger: "touch", priority: "below", commands: [setSwitch("stepped")] })));
    let s = frames(initialState(ctx, "s"), 10, ctx, "right", true);
    expect(sw(s, "stepped")).toBe(false); // まだ到着していない
    s = frames(s, 10, ctx, "right", true);
    expect(sw(s, "stepped")).toBe(true);
    expect(s.map.player.x).toBeGreaterThanOrEqual(3);
  });

  it("a touch event fires once per arrival, not while standing on it", () => {
    const { ctx } = setup(event("mat", 3, 2, page({ trigger: "touch", priority: "below", commands: [addVar("n")] })));
    let s = frames(initialState(ctx, "s"), 20, ctx, "right", true);
    s = { ...s, map: { ...s.map, player: { ...s.map.player, moving: false } } };
    s = frames(s, 30, ctx);
    expect(v(s, "n")).toBe(1);
  });

  it("an 'above'-priority action event triggers from the tile the player stands on", () => {
    const { ctx } = setup(event("here", 2, 2, page({ priority: "above", commands: [setSwitch("acted")] })));
    const s = frames(initialState(ctx, "s"), 3, ctx, "ok");
    expect(sw(s, "acted")).toBe(true);
  });

  it("a same-priority action event on the player's own tile is not triggered from there", () => {
    const { ctx } = setup(event("here", 2, 2, page({ priority: "same", commands: [setSwitch("acted")] })));
    expect(sw(frames(initialState(ctx, "s"), 3, ctx, "ok"), "acted")).toBe(false);
  });

  it("a below-priority action event in front is not triggered by 'ok' (only same-priority ones are)", () => {
    const { ctx } = setup(event("front", 2, 3, page({ priority: "below", commands: [setSwitch("acted")] })));
    expect(sw(frames(initialState(ctx, "s"), 3, ctx, "ok"), "acted")).toBe(false);
  });

  it("events without an active page neither block nor trigger", () => {
    const { ctx } = setup(event("ghost", 3, 2, page({ conditions: [on("never")], commands: [setSwitch("acted")] })));
    const s = frames(initialState(ctx, "s"), 40, ctx, "right", true);
    expect(s.map.player.x).toBeGreaterThan(3);
    expect(sw(s, "acted")).toBe(false);
  });

  it("a through event does not block", () => {
    const { ctx } = setup(event("cloud", 3, 2, page({ through: true, commands: [] })));
    expect(frames(initialState(ctx, "s"), 40, ctx, "right", true).map.player.x).toBeGreaterThan(3);
  });

  it("the event's graphic direction and image are taken from the active page", () => {
    const { ctx } = setup(event("npc", 5, 5, page({ commands: [] }), { ...page({ conditions: [on("second")], commands: [] }), graphic: { asset: "0123456789abcdef" as never, index: 3, direction: "left" } }));
    let s = initialState(ctx, "s");
    expect(s.map.events["npc" as never]!.graphic).toBeUndefined();
    s = frames({ ...s, switches: { second: true } as never }, 1, ctx);
    expect(s.map.events["npc" as never]).toMatchObject({ pageIndex: 1, direction: "left", graphic: { asset: "0123456789abcdef", index: 3 } });
    s = frames({ ...s, switches: { second: false } as never }, 1, ctx);
    expect(s.map.events["npc" as never]!.graphic).toBeUndefined();
  });
});

describe("transfer side effects", () => {
  it("transferring drops the old map's parallel events and re-evaluates the new map's events", () => {
    const loaded = loadFixtureProject("transfer-demo");
    const mapA = loaded.maps["map_a" as never]!;
    const mapB = loaded.maps["map_b" as never]!;
    (mapA as { events: unknown }).events = { par: event("par", 8, 6, page({ trigger: "parallel", commands: [cmd("Wait", { frames: 1000 })] })) };
    (mapB as { events: unknown }).events = { par_b: event("par_b", 8, 6, page({ trigger: "parallel", commands: [cmd("Wait", { frames: 1000 })] })) };
    let s = frames(initialState(loaded.ctx, "s"), 5, loaded.ctx);
    expect(s.interpreters.map((i) => i.origin)).toEqual([{ kind: "mapEvent", mapId: "map_a", eventId: "par", page: 0 }]);

    s = step(
      { ...s, map: { ...s.map, transfer: { to: "map_b" as never, x: 1, y: 1, dir: "down", fade: "none", requested: false } } },
      emptyInput(),
      loaded.ctx,
    ).state;
    s = frames(s, 2, loaded.ctx);
    expect(s.map.mapId).toBe("map_b");
    expect(s.interpreters.map((i) => i.origin)).toEqual([{ kind: "mapEvent", mapId: "map_b", eventId: "par_b", page: 0 }]);
  });

  it("self switches persist across transfers while event positions are reset", () => {
    const loaded = setup(event("e", 4, 4, page({ commands: [] })));
    let s = initialState(loaded.ctx, "s");
    s = { ...s, selfSwitches: { "map_start:e:A": true } as never, map: { ...s.map, events: { ...s.map.events, e: { ...s.map.events["e" as never]!, x: 9, y: 9 } } as never } };
    s = step({ ...s, map: { ...s.map, transfer: { to: "map_start" as never, x: 1, y: 1, dir: "down", fade: "none", requested: false } } }, emptyInput(), loaded.ctx).state;
    expect(s.map.events["e" as never]).toMatchObject({ x: 4, y: 4 });
    expect(s.selfSwitches).toEqual({ "map_start:e:A": true });
  });
});
