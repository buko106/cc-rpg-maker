import type { EventPage, MapEvent, MapData, PageCondition } from "@rpg/schema";
import { describe, expect, it } from "vitest";
import { createCtx } from "../ctx.js";
import { createProjectView } from "../project-view.js";
import type { GameState } from "../state.js";
import { IDLE_MESSAGE } from "../state.js";
import { activePage, activePageIndex, eventsToTrigger, initialEventRuntimes, refreshEventPages } from "./pages.js";

const M = "m1" as never;
const base: GameState = {
  tick: 0, rng: { seed: "s", s: [1, 2, 3, 4] }, scene: { kind: "map" },
  map: { mapId: M, name: "", player: { x: 0, y: 0, realX: 0, realY: 0, direction: "down", moving: false, speed: 4, through: false }, events: {}, followers: [], camera: { x: 0, y: 0 }, encounterSteps: 0 },
  party: { gold: 0, members: [], items: {} }, actors: {}, switches: {}, variables: {}, selfSwitches: {},
  interpreters: [], nextInterpreterId: 0, message: IDLE_MESSAGE, timers: { active: false, ticks: 0 }, playtimeTicks: 0,
};
const withState = (o: Partial<GameState>): GameState => ({ ...base, ...o });

const page = (conditions: PageCondition[] = [], o: Partial<EventPage> = {}): EventPage => ({
  conditions, trigger: "action", through: false, priority: "same", commands: [], ...o,
});
const ev = (...pages: EventPage[]): MapEvent => ({ id: "ev" as never, name: "ev", x: 0, y: 0, pages });

const sw = (id: string, value: boolean): PageCondition => ({ kind: "switch", id: id as never, value });

describe("activePage", () => {
  it("returns undefined when the event has no pages or no page matches", () => {
    expect(activePage(ev(), base, M)).toBeUndefined();
    expect(activePage(ev(page([sw("a", true)])), base, M)).toBeUndefined();
  });

  it("a page without conditions is always active", () => {
    expect(activePageIndex(ev(page()), base, M)).toBe(0);
  });

  it("later pages take priority over earlier ones", () => {
    const e = ev(page(), page([sw("a", true)]), page([sw("b", true)]));
    expect(activePageIndex(e, base, M)).toBe(0);
    expect(activePageIndex(e, withState({ switches: { a: true } as never }), M)).toBe(1);
    expect(activePageIndex(e, withState({ switches: { a: true, b: true } as never }), M)).toBe(2);
    expect(activePageIndex(e, withState({ switches: { b: true } as never }), M)).toBe(2);
  });

  it("falls back to an earlier page when the later one's condition fails", () => {
    const e = ev(page(), page([sw("a", true)]));
    expect(activePageIndex(e, withState({ switches: { a: false } as never }), M)).toBe(0);
  });

  it("requires ALL conditions of a page", () => {
    const e = ev(page([sw("a", true), sw("b", true)]));
    expect(activePageIndex(e, withState({ switches: { a: true } as never }), M)).toBeUndefined();
    expect(activePageIndex(e, withState({ switches: { a: true, b: true } as never }), M)).toBe(0);
  });

  it.each<[string, PageCondition, Partial<GameState>, boolean]>([
    ["switch on / on", sw("a", true), { switches: { a: true } as never }, true],
    ["switch on / unset", sw("a", true), {}, false],
    ["switch off / unset", sw("a", false), {}, true],
    ["switch off / on", sw("a", false), { switches: { a: true } as never }, false],
    ["variable >= (equal)", { kind: "variable", id: "v" as never, op: ">=", value: 3 }, { variables: { v: 3 } as never }, true],
    ["variable >= (less)", { kind: "variable", id: "v" as never, op: ">=", value: 3 }, { variables: { v: 2 } as never }, false],
    ["variable == ", { kind: "variable", id: "v" as never, op: "==", value: 3 }, { variables: { v: 3 } as never }, true],
    ["variable == (other)", { kind: "variable", id: "v" as never, op: "==", value: 3 }, { variables: { v: 4 } as never }, false],
    ["variable <= (equal)", { kind: "variable", id: "v" as never, op: "<=", value: 3 }, { variables: { v: 3 } as never }, true],
    ["variable <= (greater)", { kind: "variable", id: "v" as never, op: "<=", value: 3 }, { variables: { v: 4 } as never }, false],
    ["unset variable counts as 0 (<= 0)", { kind: "variable", id: "v" as never, op: "<=", value: 0 }, {}, true],
    ["selfSwitch on", { kind: "selfSwitch", key: "A", value: true }, { selfSwitches: { "m1:ev:A": true } as never }, true],
    ["selfSwitch of another key", { kind: "selfSwitch", key: "B", value: true }, { selfSwitches: { "m1:ev:A": true } as never }, false],
    ["selfSwitch of another map", { kind: "selfSwitch", key: "A", value: true }, { selfSwitches: { "m2:ev:A": true } as never }, false],
    ["selfSwitch off / unset", { kind: "selfSwitch", key: "A", value: false }, {}, true],
    ["item held", { kind: "item", id: "potion" as never }, { party: { gold: 0, members: [], items: { potion: 2 } as never } }, true],
    ["item count 0", { kind: "item", id: "potion" as never }, { party: { gold: 0, members: [], items: { potion: 0 } as never } }, false],
    ["actor in party", { kind: "actor", id: "hero" as never }, { party: { gold: 0, members: ["hero" as never], items: {} } }, true],
    ["actor not in party", { kind: "actor", id: "hero" as never }, {}, false],
    ["prototype-named switch is not set", sw("constructor", true), {}, false],
  ])("condition: %s", (_name, cond, state, expected) => {
    expect(activePage(ev(page([cond])), withState(state), M) !== undefined).toBe(expected);
  });
});

describe("eventsToTrigger / refreshEventPages", () => {
  const map: MapData = {
    id: M, width: 3, height: 3, tileset: "ts" as never, layers: [{ name: "l", tiles: new Array(9).fill(0) }],
    events: {
      a: { id: "a" as never, name: "a", x: 0, y: 0, pages: [page([], { trigger: "action" })] },
      b: { id: "b" as never, name: "b", x: 1, y: 0, pages: [page([], { trigger: "autorun" }), page([sw("off", true)], { trigger: "parallel" })] },
      c: { id: "c" as never, name: "c", x: 2, y: 0, pages: [page([sw("never", true)], { trigger: "touch" })] },
    } as never,
  };
  const project = createProjectView({} as never, { [M]: map });
  const ctx = createCtx(project);
  const state = { ...base, map: { ...base.map, events: initialEventRuntimes(map) } };

  it("lists events whose active page has the trigger, in map order", () => {
    expect(eventsToTrigger(state, ctx, "action")).toEqual(["a"]);
    expect(eventsToTrigger(state, ctx, "autorun")).toEqual(["b"]);
    expect(eventsToTrigger(state, ctx, "parallel")).toEqual([]);
    expect(eventsToTrigger(state, ctx, "touch")).toEqual([]); // 条件を満たさないページ
  });

  it("returns an empty list when the map is not loaded", () => {
    expect(eventsToTrigger(state, createCtx(createProjectView({} as never, {})), "action")).toEqual([]);
  });

  it("refreshEventPages copies the active page onto the runtime and reuses unchanged objects", () => {
    const s1 = refreshEventPages(state, map);
    expect(s1.map.events["b" as never]).toMatchObject({ pageIndex: 0, trigger: "autorun" });
    expect(s1.map.events["c" as never]).toMatchObject({ pageIndex: null, trigger: null });
    expect(refreshEventPages(s1, map)).toBe(s1); // 変化なし → 同一オブジェクト

    const s2 = refreshEventPages({ ...s1, switches: { off: true } as never }, map);
    expect(s2.map.events["b" as never]).toMatchObject({ pageIndex: 1, trigger: "parallel" });
    expect(s2.map.events["a" as never]).toBe(s1.map.events["a" as never]);
  });
});
