import { loadFixtureProject } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { fromSnapshot, toSnapshot } from "../snapshot.js";
import { emptyInput, inputFrame } from "../input.js";
import type { Button } from "../input.js";
import type { GameState } from "../state.js";
import { dispatch, initialState, menuItemIds, menuItems, SAVE_SLOT_COUNT, step, TITLE_ITEMS, titleState } from "./index.js";
import type { StepResult } from "./index.js";

const { ctx } = loadFixtureProject("minimal");

const press = (state: GameState, ...buttons: Button[]): StepResult => step(state, inputFrame(buttons, buttons), ctx);
const pressAll = (state: GameState, ...buttons: Button[]): GameState => buttons.reduce((s, b) => press(s, b).state, state);
const inMenu = (state: GameState, screen: "item" | "status" | "save" | "load"): GameState =>
  pressAll(state, "menu", ...Array<Button>(menuItems(ctx.project).indexOf(screen)).fill("down"), "ok");

describe("title", () => {
  const title = titleState(ctx, "seed");

  it("starts on the main screen with the cursor on newGame", () => {
    expect(title.scene).toEqual({ kind: "title", screen: "main", cursor: 0 });
    expect(TITLE_ITEMS).toEqual(["newGame", "continue"]);
  });

  it("the world is frozen: only the tick advances, the player cannot walk", () => {
    const s = step(title, inputFrame(["right"], ["right"]), ctx).state;
    expect(s.tick).toBe(1);
    expect(s.playtimeTicks).toBe(0);
    expect(s.map.player).toEqual(title.map.player);
  });

  it("the cursor wraps with up/down", () => {
    expect(press(title, "down").state.scene).toEqual({ kind: "title", screen: "main", cursor: 1 });
    expect(pressAll(title, "down", "down").scene).toEqual({ kind: "title", screen: "main", cursor: 0 });
    expect(press(title, "up").state.scene).toEqual({ kind: "title", screen: "main", cursor: 1 });
  });

  it("newGame starts a fresh game on the map but keeps counting ticks; stops the BGM", () => {
    const waited = Array.from({ length: 5 }).reduce<GameState>((s) => step(s, emptyInput(), ctx).state, title);
    const r = press(waited, "ok");
    expect(r.state.scene).toEqual({ kind: "map" });
    expect(r.state.tick).toBe(waited.tick + 1);
    expect(r.state.playtimeTicks).toBe(1);
    expect(r.state.rng).toEqual(initialState(ctx, "seed").rng);
    expect(r.effects).toEqual([{ kind: "stopBgm", fadeMs: 500 }]);
  });

  it("continue opens the slot list; ok requests a load of the slot under the cursor; cancel goes back", () => {
    const list = pressAll(title, "down", "ok");
    expect(list.scene).toEqual({ kind: "title", screen: "continue", cursor: 0 });
    const moved = pressAll(list, "down", "down");
    expect(press(moved, "ok").effects).toEqual([{ kind: "requestLoad", slot: 3 }]);
    expect(press(moved, "ok").state.scene).toEqual(moved.scene);
    expect(press(list, "up").state.scene).toEqual({ kind: "title", screen: "continue", cursor: SAVE_SLOT_COUNT - 1 });
    expect(press(moved, "cancel").state.scene).toEqual({ kind: "title", screen: "main", cursor: 1 });
  });

  it("ignores buttons that do nothing", () => {
    expect(press(title, "shift").state.scene).toEqual(title.scene);
    expect(press(pressAll(title, "down", "ok"), "shift").effects).toEqual([]);
  });
});

describe("menu", () => {
  const map = initialState(ctx, "seed");
  const withItems: GameState = { ...map, party: { ...map.party, items: { potion: 3, ether: 0, antidote: 1 } as never } };

  it("opens with menu or cancel when the player is idle, and closes again", () => {
    expect(press(map, "menu").state.scene).toEqual({ kind: "menu", screen: "main", cursor: 0 });
    expect(press(map, "cancel").state.scene).toEqual({ kind: "menu", screen: "main", cursor: 0 });
    expect(press(press(map, "menu").state, "menu").state.scene).toEqual({ kind: "map" });
    expect(press(press(map, "menu").state, "cancel").state.scene).toEqual({ kind: "map" });
  });

  it("does not open while the player is moving", () => {
    const walking = step(map, inputFrame(["right"], ["right"]), ctx).state;
    expect(walking.map.player.moving).toBe(true);
    expect(press(walking, "menu").state.scene).toEqual({ kind: "map" });
  });

  it("freezes the world but counts playtime", () => {
    const opened = press(map, "menu").state;
    const s = step(opened, inputFrame(["right"], ["right"]), ctx).state;
    expect(s.map.player).toEqual(opened.map.player);
    expect(s.tick).toBe(opened.tick + 1);
    expect(s.playtimeTicks).toBe(opened.playtimeTicks + 1);
  });

  it("main: the cursor moves and ok enters the chosen screen; cancel returns with the cursor on that entry", () => {
    const opened = press(map, "menu").state;
    expect(press(opened, "up").state.scene).toEqual({ kind: "menu", screen: "main", cursor: menuItems(ctx.project).length - 1 });
    const status = pressAll(opened, "down", "ok");
    expect(status.scene).toEqual({ kind: "menu", screen: "status", cursor: 0 });
    expect(press(status, "cancel").state.scene).toEqual({ kind: "menu", screen: "main", cursor: 1 });
    expect(press(status, "menu").state.scene).toEqual({ kind: "map" });
  });

  it("item screen lists owned items only, in id order (within the same category)", () => {
    expect(menuItemIds(withItems, ctx)).toEqual(["antidote", "potion"]);
    const item = inMenu(withItems, "item");
    expect(item.scene).toEqual({ kind: "menu", screen: "item", cursor: 0 });
    expect(pressAll(item, "down", "down").scene).toEqual({ kind: "menu", screen: "item", cursor: 0 });
    expect(press(item, "up").state.scene).toEqual({ kind: "menu", screen: "item", cursor: 1 });
    expect(press(item, "ok").effects).toEqual([]);
    // 所持品が空でもカーソルは 0 のまま
    expect(press(inMenu(map, "item"), "down").state.scene).toEqual({ kind: "menu", screen: "item", cursor: 0 });
  });

  it("status screen switches the member with up/down and pageup/pagedown", () => {
    const two: GameState = { ...map, party: { ...map.party, members: ["actor_hero", "actor_hero"] as never } };
    const status = inMenu(two, "status");
    expect(press(status, "down").state.scene).toEqual({ kind: "menu", screen: "status", cursor: 1 });
    expect(press(status, "pagedown").state.scene).toEqual({ kind: "menu", screen: "status", cursor: 1 });
    expect(press(status, "pageup").state.scene).toEqual({ kind: "menu", screen: "status", cursor: 1 });
    expect(press(status, "ok").effects).toEqual([]);
  });

  it("save / load screens request the slot under the cursor and stay open", () => {
    const save = inMenu(map, "save");
    expect(save.scene).toEqual({ kind: "menu", screen: "save", cursor: 0 });
    const r = press(pressAll(save, "down"), "ok");
    expect(r.effects).toEqual([{ kind: "requestSave", slot: 2 }]);
    expect(r.state.scene).toEqual({ kind: "menu", screen: "save", cursor: 1 });
    const load = inMenu(map, "load");
    expect(press(pressAll(load, "up"), "ok").effects).toEqual([{ kind: "requestLoad", slot: SAVE_SLOT_COUNT }]);
  });
});

describe("menu confirm dialog", () => {
  const map = initialState(ctx, "seed");
  const asked = (kind: "save" | "load", slot = 2): GameState => dispatch(inMenu(map, kind), { type: "askConfirm", kind, slot }, ctx).state;

  it("askConfirm opens the dialog on the menu with the cursor on いいえ; elsewhere it does nothing", () => {
    expect(asked("save").scene).toEqual({ kind: "menu", screen: "save", cursor: 0, confirm: { kind: "save", slot: 2, cursor: 1 } });
    const r = dispatch(map, { type: "askConfirm", kind: "save", slot: 2 }, ctx);
    expect(r.state).toBe(map);
    expect(r.effects).toEqual([]);
  });

  it("up/down/left/right toggle はい/いいえ; other buttons do nothing (the slot list stays put)", () => {
    const s = asked("save");
    expect(press(s, "up").state.scene).toMatchObject({ confirm: { cursor: 0 } });
    expect(press(s, "down").state.scene).toMatchObject({ confirm: { cursor: 0 } });
    expect(pressAll(s, "left", "right").scene).toMatchObject({ confirm: { cursor: 1 } });
    expect(press(s, "pageup").state.scene).toBe(s.scene);
    expect(press(s, "up").state.scene).toMatchObject({ cursor: 0 }); // 一覧のカーソルは動かない
  });

  it("いいえ / cancel closes the dialog without a request; the screen stays open", () => {
    const s = asked("save");
    const no = press(s, "ok");
    expect(no.effects).toEqual([]);
    expect(no.state.scene).toEqual({ kind: "menu", screen: "save", cursor: 0 });
    const cancelled = press(s, "cancel");
    expect(cancelled.effects).toEqual([]);
    expect(cancelled.state.scene).toEqual({ kind: "menu", screen: "save", cursor: 0 });
  });

  it("はい re-issues the request with confirmed: true for the asked slot", () => {
    const save = press(pressAll(asked("save", 5), "up"), "ok");
    expect(save.effects).toEqual([{ kind: "requestSave", slot: 5, confirmed: true }]);
    expect(save.state.scene).toEqual({ kind: "menu", screen: "save", cursor: 0 });
    const load = press(pressAll(asked("load", 3), "up"), "ok");
    expect(load.effects).toEqual([{ kind: "requestLoad", slot: 3, confirmed: true }]);
  });

  it("the menu button closes everything at once", () => {
    expect(press(asked("load"), "menu").state.scene).toEqual({ kind: "map" });
  });
});

describe("snapshot of UI scenes", () => {
  const map = initialState(ctx, "seed");
  const meta = { projectId: "p", projectHash: "h", savedAt: "2026-01-01T00:00:00.000Z" };

  it("saving from the menu stores the map scene, and loading it resumes on the map", () => {
    const save = inMenu(map, "save");
    const snap = toSnapshot(save, meta);
    expect(snap.state.scene).toEqual({ kind: "map" });
    const loaded = fromSnapshot(snap, ctx);
    expect(loaded.ok && loaded.value.scene).toEqual({ kind: "map" });
  });

  it("dispatch(loadSnapshot) replaces the state and re-arms a pending transfer request", () => {
    const pending: GameState = { ...map, map: { ...map.map, transfer: { to: map.map.mapId, x: 1, y: 1, dir: "down", fade: "none", requested: true } } };
    const r = dispatch(title(), { type: "loadSnapshot", snapshot: toSnapshot(pending, meta) }, ctx);
    expect(r.state.scene).toEqual({ kind: "map" });
    expect(r.state.map.transfer?.requested).toBe(false);
    const bad = dispatch(title(), { type: "loadSnapshot", snapshot: { ...toSnapshot(map, meta), version: 99 } }, ctx);
    expect(bad.state.scene.kind).toBe("title");
    expect(bad.effects[0]).toMatchObject({ kind: "log", level: "warn" });
  });
});

function title(): GameState {
  return titleState(ctx, "seed");
}
