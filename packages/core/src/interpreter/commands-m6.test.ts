import type { EventCommand } from "@rpg/schema";
import { cmd, loadFixtureProject, runCommands } from "@rpg/test-utils";
import type { RunCommandsOptions } from "@rpg/test-utils";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { emptyInput, inputFrame } from "../input.js";
import type { Button, InputFrame } from "../input.js";
import { initialState } from "../game/index.js";
import { BUILTIN_COMMANDS } from "./builtins.js";
import { runInterpreters, startInterpreter } from "./run.js";
import { step } from "../game/index.js";
import type { GameState } from "../state.js";
import type { Effect } from "../effects.js";
import { startBattle } from "../battle/index.js";

const loaded = loadFixtureProject("commands-smoke");
const { ctx } = loaded;
const fresh = (): GameState => initialState(ctx, "m6");
const c = (n: number) => ({ kind: "constant", value: n });
const v = (s: GameState, id: string): unknown => (s.variables as Record<string, number>)[id];
const sw = (s: GameState, id: string): unknown => (s.switches as Record<string, boolean>)[id];
const warnings = (effects: { kind: string; level?: string; message?: string }[]) => effects.filter((e) => e.kind === "log" && e.level === "warn").map((e) => e.message);
const run = (commands: EventCommand[], options: RunCommandsOptions = {}) => runCommands(commands, { ctx, ...options });
const press = (...buttons: Button[]): InputFrame => inputFrame(buttons, buttons);

describe("フロー制御", () => {
  it("Loop / BreakLoop / EndLoop: ネストしたループの内側だけを抜ける", () => {
    const r = run([
      cmd("Loop"),
      cmd("ControlVariables", { ids: ["outer"], op: "add", operand: c(1) }, 1),
      cmd("ControlVariables", { ids: ["inner"], op: "set", operand: c(0) }, 1),
      cmd("Loop", {}, 1),
      cmd("ControlVariables", { ids: ["inner"], op: "add", operand: c(1) }, 2),
      cmd("ControlVariables", { ids: ["total"], op: "add", operand: c(1) }, 2),
      cmd("ConditionalBranch", { condition: { kind: "variable", id: "inner", op: ">=", value: 2 } }, 2),
      cmd("BreakLoop", {}, 3),
      cmd("EndBranch", {}, 2),
      cmd("EndLoop", {}, 1),
      cmd("ConditionalBranch", { condition: { kind: "variable", id: "outer", op: ">=", value: 3 } }, 1),
      cmd("BreakLoop", {}, 2),
      cmd("EndBranch", {}, 1),
      cmd("EndLoop"),
      cmd("ControlSwitches", { ids: ["after"], value: true }),
    ]);
    expect(r.finished).toBe(true);
    expect(v(r.state, "outer")).toBe(3);
    expect(v(r.state, "total")).toBe(6); // 内側は 2 回ずつ × 外側 3 回
    expect(sw(r.state, "after")).toBe(true);
  });

  it("BreakLoop outside a loop warns and continues", () => {
    const r = run([cmd("BreakLoop"), cmd("ControlSwitches", { ids: ["a"], value: true })]);
    expect(warnings(r.effects)).toHaveLength(1);
    expect(sw(r.state, "a")).toBe(true);
  });

  it("EndLoop without a Loop does nothing; an unterminated Loop ends the event when broken", () => {
    expect(run([cmd("EndLoop"), cmd("ControlSwitches", { ids: ["a"], value: true })]).finished).toBe(true);
    const r = run([cmd("Loop"), cmd("BreakLoop", {}, 1)]); // EndLoop が無い
    expect(r.finished).toBe(true);
  });

  it("an infinite loop is cut off each frame with a warning and never blocks the engine", () => {
    const r = run([cmd("Loop"), cmd("Comment", {}, 1), cmd("EndLoop")], { maxFrames: 3 });
    expect(r.finished).toBe(false);
    expect(warnings(r.effects).length).toBeGreaterThanOrEqual(3);
  });

  it("ExitEventProcessing stops the whole event, even inside a common event call", () => {
    const r = run([cmd("CallCommonEvent", { id: "ce_hello" }), cmd("ExitEventProcessing"), cmd("ControlSwitches", { ids: ["never"], value: true })]);
    expect(r.finished).toBe(true);
    expect(sw(r.state, "sw_common")).toBe(true);
    expect(sw(r.state, "never")).toBeUndefined();
  });

  it("CallCommonEvent runs the common event then continues; unknown ids warn", () => {
    const r = run([cmd("CallCommonEvent", { id: "ce_hello" }), cmd("ControlSwitches", { ids: ["next"], value: true }), cmd("CallCommonEvent", { id: "ce_nope" })]);
    expect(sw(r.state, "sw_common")).toBe(true);
    expect(sw(r.state, "next")).toBe(true);
    expect(warnings(r.effects)).toHaveLength(1);
  });

  it("a common event that calls itself is stopped by the depth limit (no runaway)", () => {
    const base = fresh();
    const project = { ...loaded.project, database: { ...loaded.project.database, commonEvents: { ce_self: { id: "ce_self", name: "自己呼び出し", trigger: "none", commands: [cmd("CallCommonEvent", { id: "ce_self" })] } } } };
    const view = { ...loaded.view, project, commonEvent: (id: string) => (id === "ce_self" ? project.database.commonEvents.ce_self : undefined) } as typeof loaded.view;
    const r = runCommands([cmd("CallCommonEvent", { id: "ce_self" })], { ctx: { ...ctx, project: view }, state: base, maxFrames: 20 });
    expect(r.finished).toBe(true);
    expect(warnings(r.effects).some((m) => m?.includes("深すぎる"))).toBe(true);
  });

  it("Label / JumpToLabel jump within the same list; a missing label warns", () => {
    const r = run([
      cmd("JumpToLabel", { name: "skip" }),
      cmd("ControlSwitches", { ids: ["skipped"], value: true }),
      cmd("Label", { name: "skip" }),
      cmd("ControlSwitches", { ids: ["reached"], value: true }),
      cmd("JumpToLabel", { name: "nowhere" }),
    ]);
    expect(sw(r.state, "skipped")).toBeUndefined();
    expect(sw(r.state, "reached")).toBe(true);
    expect(warnings(r.effects)).toHaveLength(1);
  });

  it("Comment does nothing", () => {
    const r = run([cmd("Comment", { text: "メモ" })]);
    expect(r.finished).toBe(true);
    expect(r.effects).toEqual([]);
  });
});

describe("ゲーム進行", () => {
  it("ControlSelfSwitch writes the running event's self switch; outside a map event it warns", () => {
    const map = loaded.maps["map_start" as never]!;
    const started = startInterpreter(fresh(), { kind: "mapEvent", mapId: map.id, eventId: "ev_smoke" as never, page: 0 }, [cmd("ControlSelfSwitch", { key: "B", value: true })], "normal");
    let s = started;
    for (let i = 0; i < 3; i++) s = step(s, emptyInput(), ctx).state;
    expect(s.selfSwitches).toEqual({ "map_start:ev_smoke:B": true });
    expect(warnings(run([cmd("ControlSelfSwitch", { key: "A", value: true })]).effects)).toHaveLength(1);
  });

  it("ControlTimer starts a countdown that stops at 0", () => {
    const r = run([cmd("ControlTimer", { op: "start", seconds: 1 }), cmd("Wait", { frames: 90 })]);
    expect(r.state.timers).toEqual({ active: false, ticks: 0 });
    expect(r.history[1]!.timers).toEqual({ active: true, ticks: 59 - 0 });
    const stopped = run([cmd("ControlTimer", { op: "start", seconds: 5 }), cmd("ControlTimer", { op: "stop" })]);
    expect(stopped.state.timers.active).toBe(false);
    expect(run([cmd("ControlTimer", { op: "start", seconds: 0 })]).state.timers.active).toBe(false);
  });

  it("ChangeGold gains and loses (never below 0), with a variable amount", () => {
    const base = { ...fresh(), variables: { amt: 30 } as never };
    const r = run([cmd("ChangeGold", { op: "gain", amount: c(100) }), cmd("ChangeGold", { op: "lose", amount: { kind: "variable", id: "amt" } })], { state: base });
    expect(r.state.party.gold).toBe(70);
    expect(run([cmd("ChangeGold", { op: "lose", amount: c(5) })]).state.party.gold).toBe(0);
  });

  it("ChangeItems adds, removes down to 0 (entry dropped); unknown items warn", () => {
    const r = run([cmd("ChangeItems", { item: "item_potion", op: "gain", amount: c(3) }), cmd("ChangeItems", { item: "item_potion", op: "lose", amount: c(1) })]);
    expect(r.state.party.items).toEqual({ item_potion: 2 });
    const gone = run([cmd("ChangeItems", { item: "item_potion", op: "gain", amount: c(1) }), cmd("ChangeItems", { item: "item_potion", op: "lose", amount: c(9) })]);
    expect(gone.state.party.items).toEqual({});
    expect(warnings(run([cmd("ChangeItems", { item: "item_nope", op: "gain", amount: c(1) })]).effects)).toHaveLength(1);
  });

  it("ChangeParty adds to the end / removes; duplicates and unknown actors are handled", () => {
    const r = run([cmd("ChangeParty", { actor: "actor_mage", op: "add" }), cmd("ChangeParty", { actor: "actor_mage", op: "add" })]);
    expect(r.state.party.members).toEqual(["actor_hero", "actor_mage"]);
    expect(run([cmd("ChangeParty", { actor: "actor_hero", op: "remove" })]).state.party.members).toEqual([]);
    expect(warnings(run([cmd("ChangeParty", { actor: "actor_nope", op: "add" })]).effects)).toHaveLength(1);
  });

  it("ChangeEquipment equips an owned item (taking it from the party's items) and unequips back into the items", () => {
    const gain = cmd("ChangeItems", { item: "item_sword", op: "gain", amount: c(1) });
    const r = run([gain, cmd("ChangeEquipment", { actor: "actor_hero", slot: "weapon", item: "item_sword" })]);
    expect(warnings(r.effects)).toEqual([]);
    expect(r.state.actors["actor_hero" as never]!.equips).toEqual({ weapon: "item_sword" });
    expect(r.state.party.items).toEqual({});
    const off = run([cmd("ChangeEquipment", { actor: "actor_hero", slot: "weapon" })], { state: r.state });
    expect(off.state.actors["actor_hero" as never]!.equips).toEqual({});
    expect(off.state.party.items).toEqual({ item_sword: 1 });
  });

  it("ChangeEquipment warns and skips: not owned, wrong slot, non-equipment, unknown actor", () => {
    const owned = run([cmd("ChangeItems", { item: "item_sword", op: "gain", amount: c(1) })]).state;
    const cases = [
      { actor: "actor_hero", slot: "weapon", item: "item_sword" }, // 持っていない（fresh の状態）
      { actor: "actor_hero", slot: "armor", item: "item_sword" },
      { actor: "actor_hero", slot: "weapon", item: "item_potion" },
      { actor: "actor_nope", slot: "weapon", item: "item_sword" },
    ];
    for (const [i, params] of cases.entries()) {
      const r = run([cmd("ChangeEquipment", params)], i === 0 ? {} : { state: owned });
      expect(warnings(r.effects), JSON.stringify(params)).toHaveLength(1);
      expect(r.state.actors["actor_hero" as never]!.equips).toBeUndefined();
    }
  });

  describe("HP / MP / 経験値 / レベル", () => {
    const hero = (s: GameState) => s.actors["actor_hero" as never]!;
    it("ChangeHp clamps to [1, max] (or [0, max] when death is allowed); the dead stay dead when damaged", () => {
      const start = hero(fresh());
      expect(start.hp).toBe(100);
      expect(hero(run([cmd("ChangeHp", { op: "lose", amount: c(30) })]).state).hp).toBe(70);
      expect(hero(run([cmd("ChangeHp", { op: "lose", amount: c(999) })]).state).hp).toBe(1);
      expect(hero(run([cmd("ChangeHp", { op: "lose", amount: c(999), allowDeath: true })]).state).hp).toBe(0);
      expect(hero(run([cmd("ChangeHp", { op: "gain", amount: c(999) })]).state).hp).toBe(100);
      const dead = { ...fresh(), actors: { actor_hero: { ...start, hp: 0 } } as never };
      expect(hero(run([cmd("ChangeHp", { op: "lose", amount: c(5) })], { state: dead }).state).hp).toBe(0);
    });
    it("ChangeMp clamps to [0, max] and can target one actor", () => {
      expect(hero(run([cmd("ChangeMp", { target: "actor_hero", op: "lose", amount: c(5) })]).state).mp).toBe(15);
      expect(hero(run([cmd("ChangeMp", { op: "lose", amount: c(99) })]).state).mp).toBe(0);
      expect(hero(run([cmd("ChangeMp", { op: "gain", amount: c(99) })]).state).mp).toBe(20);
    });
    it("ChangeExp levels up the whole party", () => {
      const r = run([cmd("ChangeExp", { amount: c(100) })]);
      expect(hero(r.state).level).toBeGreaterThan(1);
      expect(hero(r.state).exp).toBe(100);
    });
    it("ChangeLevel moves the level within 1..99, sets exp to the threshold, and raises max HP/MP with the level", () => {
      const up = hero(run([cmd("ChangeLevel", { op: "gain", amount: c(2) })]).state);
      expect(up.level).toBe(3);
      expect(up.hp).toBe(120); // 最大 HP が 20 増えた分だけ増える
      const down = hero(run([cmd("ChangeLevel", { op: "gain", amount: c(2) }), cmd("ChangeLevel", { op: "lose", amount: c(5) })]).state);
      expect(down.level).toBe(1);
      expect(down.hp).toBe(100);
      expect(down.exp).toBe(0);
      expect(hero(run([cmd("ChangeLevel", { op: "gain", amount: c(500) })]).state).level).toBe(99);
    });
  });
});

describe("選択肢と入力", () => {
  const choice = (_pick?: number) => [
    cmd("ShowChoices", { choices: ["A", "B", "C"], cancel: 2 }),
    cmd("ChoiceBranch", { index: 0 }),
    cmd("ControlVariables", { ids: ["r"], op: "set", operand: c(100) }, 1),
    cmd("ChoiceBranch", { index: 1 }),
    cmd("ControlVariables", { ids: ["r"], op: "set", operand: c(200) }, 1),
    cmd("ChoiceBranch", { index: 2 }),
    cmd("ControlVariables", { ids: ["r"], op: "set", operand: c(300) }, 1),
    cmd("EndBranch"),
  ];
  /** メッセージが開いているフレームに、順に 1 回ずつボタンを押す。 */
  const script = (buttons: Button[][]) => {
    let i = 0;
    return (_frame: number, s: GameState): InputFrame => ((s.message.open || s.scene.kind === "shop") && i < buttons.length ? press(...buttons[i++]!) : emptyInput());
  };

  it("ShowChoices: the cursor selects the branch (down, ok → second)", () => {
    const r = run(choice(1), { input: script([["down"], ["ok"]]) });
    expect(r.finished).toBe(true);
    expect(v(r.state, "r")).toBe(200);
  });

  it("ShowChoices: the cursor wraps around (up from the top → last)", () => {
    expect(v(run(choice(2), { input: script([["up"], ["ok"]]) }).state, "r")).toBe(300);
  });

  it("ShowChoices: cancel picks the configured branch; with cancel disallowed it does nothing", () => {
    expect(v(run(choice(2), { input: script([["cancel"]]) }).state, "r")).toBe(300);
    const noCancel = run([cmd("ShowChoices", { choices: ["A", "B"] }), cmd("ChoiceBranch", { index: 0 }), cmd("ChoiceBranch", { index: 1 }), cmd("EndBranch")], {
      input: script([["cancel"], ["cancel"]]),
      maxFrames: 20,
    });
    expect(noCancel.finished).toBe(false);
  });

  it("ShowChoices waits for the message window while another message is open", () => {
    const r = run([cmd("ShowText", { text: "先" }), cmd("ShowChoices", { choices: ["A"] }), cmd("ChoiceBranch", { index: 0 }), cmd("EndBranch")]);
    expect(r.finished).toBe(true);
  });

  it("ShowChoices is resumable even if the window was closed without an answer (falls back to the cancel/first branch)", () => {
    const opened = run(choice(0), { maxFrames: 2, input: () => emptyInput() });
    const closed: GameState = { ...opened.state, message: { ...opened.state.message, open: false, choices: null } };
    const done = (() => { let s = closed; for (let i = 0; i < 10; i++) s = step(s, emptyInput(), ctx).state; return s; })();
    expect(done.interpreters).toHaveLength(0);
    expect(v(done, "r")).toBe(300); // cancel: 2
  });

  it("InputNumber: ↑ raises the digit, ← / → move the digit, ok confirms", () => {
    // 2 桁。→ で 1 の位へ、↑ ×3 → 03、← で 10 の位、↑ → 13
    const r = run([cmd("InputNumber", { variable: "n", digits: 2 })], {
      input: script([["right"], ["up"], ["up"], ["up"], ["left"], ["up"], ["ok"]]),
    });
    expect(r.finished).toBe(true);
    expect(v(r.state, "n")).toBe(13);
  });

  it("InputNumber: ↓ from 0 wraps to 9; the initial value is the variable's current value (clamped to the digit count)", () => {
    expect(v(run([cmd("InputNumber", { variable: "n", digits: 1 })], { input: script([["down"], ["ok"]]) }).state, "n")).toBe(9);
    const base = { ...fresh(), variables: { n: 5000 } as never };
    expect(v(run([cmd("InputNumber", { variable: "n", digits: 2 })], { state: base, input: script([["ok"]]) }).state, "n")).toBe(99);
  });

  it("SelectItem: lists key items, stores the item's 1-based number (consumables before key items, then by id); 0 when none held or cancelled", () => {
    expect(v(run([cmd("SelectItem", { variable: "it" })]).state, "it")).toBe(0);
    const held = { ...fresh(), party: { ...fresh().party, items: { item_key: 1, item_potion: 2 } as never } };
    // 既定の kind は key：候補は「古い鍵」だけ。item_key は id の昇順で 1 番目。
    expect(v(run([cmd("SelectItem", { variable: "it" })], { state: held, input: script([["ok"]]) }).state, "it")).toBe(1);
    // all: 消耗品 → 大事なもの の順（メニューのアイテム画面と同じ）で item_potion, item_key。2 番目 = item_key = 1
    expect(v(run([cmd("SelectItem", { variable: "it", kind: "all" })], { state: held, input: script([["down"], ["ok"]]) }).state, "it")).toBe(1);
    expect(v(run([cmd("SelectItem", { variable: "it", kind: "all" })], { state: held, input: script([["ok"]]) }).state, "it")).toBe(2);
    expect(v(run([cmd("SelectItem", { variable: "it" })], { state: held, input: script([["cancel"]]) }).state, "it")).toBe(0);
  });

  it("ShopProcessing: opens the shop scene, waits while it is open, and continues once it is closed", () => {
    const base = { ...fresh(), party: { ...fresh().party, gold: 25 } };
    const cmds = [cmd("ShopProcessing", { goods: ["item_potion", "item_nope"] }), cmd("ControlSwitches", { ids: ["after"], value: true })];
    // 開いている間は先に進まない
    const open = run(cmds, { state: base, maxFrames: 5 });
    expect(open.finished).toBe(false);
    expect(open.state.scene).toMatchObject({ kind: "shop", goods: ["item_potion"], canSell: true, screen: "command", owner: open.state.interpreters[0]?.id });
    expect(sw(open.state, "after")).toBeUndefined();
    // 購入 → 一覧 → 数量を 2 に → 確定（ポーション 10G × 2）→ 一覧に戻る → コマンドに戻る → やめる
    const bought = run(cmds, { state: base, input: script([["ok"], ["ok"], ["up"], ["ok"], ["cancel"], ["cancel"]]) });
    expect(bought.finished).toBe(true);
    expect(sw(bought.state, "after")).toBe(true);
    expect(bought.state.scene).toEqual({ kind: "map" });
    expect(bought.state.party.gold).toBe(5);
    expect(bought.state.party.items).toEqual({ item_potion: 2 });
    // 「やめる」を選んでも終わる
    const leave = run([cmd("ShopProcessing", { goods: ["item_potion"], canSell: false })], { state: base, input: script([["down"], ["ok"]]) });
    expect(leave.finished).toBe(true);
    expect(leave.state.party.gold).toBe(25);
    expect(warnings(run([cmd("ShopProcessing", { goods: ["item_nope"] })]).effects)).toHaveLength(1);
  });

  it("ShopProcessing: only opens from the map scene, and waits for a message window that is still open", () => {
    const title = startInterpreter({ ...fresh(), scene: { kind: "title", screen: "main", cursor: 0 } }, { kind: "plugin", name: "t" }, [cmd("ShopProcessing", { goods: ["item_potion"] })], "normal");
    const refused = runInterpreters(title, emptyInput(), ctx); // 通常の step ではタイトル中にインタプリタは動かないので、直接回す
    expect(warnings(refused.effects)).toHaveLength(1);
    expect(refused.state.scene.kind).toBe("title");
    const busy = { ...fresh(), message: { ...fresh().message, open: true, owner: "other", text: "…" } };
    const waiting = run([cmd("ShopProcessing", { goods: ["item_potion"] })], { state: busy, maxFrames: 3, input: () => emptyInput() });
    expect(waiting.state.scene.kind).toBe("map");
    expect(waiting.finished).toBe(false);
  });
});

describe("移動ルート", () => {
  const player = (s: GameState) => s.map.player;
  it("SetMoveRoute (wait) moves step by step and finishes when the last step is done", () => {
    const r = run([cmd("SetMoveRoute", { target: "player", wait: true, route: { repeat: false, skippable: false, steps: [{ kind: "move", dir: "right" }, { kind: "turn", dir: "up" }, { kind: "move", dir: "down" }] } })]);
    expect(r.finished).toBe(true);
    expect(player(r.state)).toMatchObject({ x: 3, y: 3, direction: "down", moving: false });
  });

  it("wait:false hands the route to a parallel interpreter and continues immediately", () => {
    const r = run([
      cmd("SetMoveRoute", { target: "player", wait: false, route: { repeat: false, skippable: false, steps: [{ kind: "move", dir: "right" }, { kind: "move", dir: "right" }] } }),
      cmd("ControlSwitches", { ids: ["after"], value: true }),
    ]);
    expect(sw(r.history[0]!, "after")).toBe(true);
    expect(r.history[0]!.interpreters.map((i) => i.origin.kind)).toEqual(["plugin"]); // 元のイベントは終わり、ルートだけが残る
    // ルートが終わるまでフレームを進める
    let s = r.state;
    for (let i = 0; i < 80 && s.interpreters.length > 0; i++) s = step(s, emptyInput(), ctx).state;
    expect(s.interpreters).toHaveLength(0);
    expect(player(s).x).toBe(4);
  });

  it("a repeating route keeps going; starting another route for the same target replaces it", () => {
    const route = (dir: "left" | "right") => cmd("SetMoveRoute", { target: "player", wait: false, route: { repeat: true, skippable: true, steps: [{ kind: "move", dir }, { kind: "wait", frames: 4 }] } });
    let s = run([route("right")], { maxFrames: 1 }).state;
    for (let i = 0; i < 60; i++) s = step(s, emptyInput(), ctx).state;
    expect(s.interpreters.filter((i) => i.origin.kind === "plugin")).toHaveLength(1);
    const x = player(s).x;
    expect(x).toBeGreaterThan(2);
    const replaced = startInterpreter(s, { kind: "plugin", name: "t" }, [route("left")], "normal");
    let t = replaced;
    for (let i = 0; i < 4; i++) t = step(t, emptyInput(), ctx).state;
    expect(t.interpreters.filter((i) => i.origin.kind === "plugin" && i.origin.name.startsWith("moveRoute"))).toHaveLength(1);
  });

  it("a blocked step is given up right away when skippable, otherwise after a while with a warning", () => {
    const wall = { kind: "move", dir: "up" } as const; // 開始位置 (2,2) の上はマップの壁 (y=1 は空だが、y=0 は壁)
    const steps = [wall, wall, wall];
    const skip = run([cmd("SetMoveRoute", { target: "player", wait: true, route: { repeat: false, skippable: true, steps } })]);
    expect(skip.finished).toBe(true);
    expect(warnings(skip.effects)).toHaveLength(0);
    const stuck = run([cmd("SetMoveRoute", { target: "player", wait: true, route: { repeat: false, skippable: false, steps } })], { maxFrames: 400 });
    expect(stuck.finished).toBe(true);
    expect(warnings(stuck.effects).length).toBeGreaterThanOrEqual(1);
  });

  it("toward / away / random directions", () => {
    const at = (x: number, y: number) => ({ ...fresh(), map: { ...fresh().map, events: { ev_smoke: { ...fresh().map.events["ev_smoke" as never]!, x, y } } } }) as unknown as GameState;
    const base = at(5, 2); // プレイヤーは (2,2)。右に居る
    const fromMapEvent = (steps: unknown[]) => {
      let s = startInterpreter(base, { kind: "mapEvent", mapId: "map_start" as never, eventId: "ev_smoke" as never, page: 0 }, [cmd("SetMoveRoute", { target: "this", wait: true, route: { repeat: false, skippable: true, steps } })], "normal");
      for (let i = 0; i < 40; i++) s = step(s, emptyInput(), ctx).state;
      return s.map.events["ev_smoke" as never]!;
    };
    expect(fromMapEvent([{ kind: "move", dir: "toward" }]).x).toBe(4);
    expect(fromMapEvent([{ kind: "move", dir: "away" }]).x).toBe(6);
    const random = fromMapEvent([{ kind: "move", dir: "random" }, { kind: "move", dir: "random" }, { kind: "move", dir: "random" }]);
    expect(Math.abs(random.x - 5) + Math.abs(random.y - 2)).toBeLessThanOrEqual(3);
  });

  it("speed changes the movement speed; unresolvable targets warn; a vanished target ends the route", () => {
    const fast = run([cmd("SetMoveRoute", { target: "player", wait: true, route: { repeat: false, skippable: true, steps: [{ kind: "speed", value: 6 }] } })]);
    expect(player(fast.state).speed).toBe(6);
    expect(warnings(run([cmd("SetMoveRoute", { target: "this", wait: true, route: { repeat: false, skippable: true, steps: [] } })]).effects)).toHaveLength(1);
    expect(warnings(run([cmd("SetMoveRoute", { target: "ev_nope", wait: true, route: { repeat: false, skippable: true, steps: [] } })]).effects)).toHaveLength(1);
    const gone = run([cmd("MoveStep", { who: "ev_nope", step: { kind: "wait", frames: 1 } }), cmd("ControlSwitches", { ids: ["x"], value: true })]);
    expect(gone.finished).toBe(true);
    expect(sw(gone.state, "x")).toBeUndefined();
  });
});

describe("音と画面", () => {
  it("emits the matching Effects", () => {
    const audio = { asset: "fedcba9876543210", volume: 1, pitch: 1, loop: false };
    const r = run([
      cmd("ChangeBgm", { audio, fadeMs: 200 }),
      cmd("PlaySe", { audio }),
      cmd("FadeoutBgm", { fadeMs: 300 }),
      cmd("ShakeScreen", { power: 3, duration: 4 }),
      cmd("FlashScreen", { duration: 5 }),
      cmd("TintScreen", { color: { r: 0, g: 0, b: 1, a: 0.5 }, duration: 6 }),
      cmd("Fadeout", { duration: 7, wait: false }),
      cmd("Fadein", { duration: 8, wait: false }),
    ]);
    expect(r.effects.map((e) => e.kind)).toEqual(["playBgm", "playSe", "stopBgm", "screenShake", "screenFlash", "screenTint", "screenFade", "screenFade"]);
    expect(r.effects[0]).toMatchObject({ kind: "playBgm", fadeMs: 200 });
    expect(r.effects[6]).toEqual({ kind: "screenFade", to: 1, durationTicks: 7 });
    expect(r.effects[7]).toEqual({ kind: "screenFade", to: 0, durationTicks: 8 });
  });

  it("SetWeather は setWeather の Effect を 1 つ出し、待たない", () => {
    const r = run([cmd("SetWeather", { weather: "snow", intensity: 7 })]);
    expect(r.effects).toEqual([{ kind: "setWeather", weather: "snow", intensity: 7 }]);
  });

  it("ShowPicture / MovePicture / ErasePicture emit picture Effects", () => {
    const image = { asset: "fedcba9876543210" };
    const r = run([
      cmd("ShowPicture", { id: 2, image, x: 10, y: 20, origin: "center", opacity: 0.5, scale: 2, duration: 4 }),
      cmd("MovePicture", { id: 2, x: 30, y: 40, duration: 6 }),
      cmd("ErasePicture", { id: 2 }),
    ]);
    expect(r.effects).toEqual([
      { kind: "showPicture", id: 2, asset: "fedcba9876543210", x: 10, y: 20, origin: "center", opacity: 0.5, scale: 2, durationTicks: 4 },
      { kind: "movePicture", id: 2, x: 30, y: 40, opacity: 1, scale: 1, durationTicks: 6 },
      { kind: "erasePicture", id: 2 },
    ]);
  });

  it("MovePicture with wait: true holds the event for its duration", () => {
    expect(run([cmd("MovePicture", { id: 1, duration: 10, wait: true })]).frames).toBeGreaterThanOrEqual(10);
    expect(run([cmd("MovePicture", { id: 1, duration: 10 })]).frames).toBe(1);
  });

  it("wait: true holds the event for the effect's duration; zero duration never waits", () => {
    expect(run([cmd("Fadeout", { duration: 10 })]).frames).toBeGreaterThanOrEqual(10);
    expect(run([cmd("Fadeout", { duration: 0 })]).frames).toBe(1);
    expect(run([cmd("ShakeScreen", { duration: 30, wait: false })]).frames).toBe(1);
  });
});

describe("システム", () => {
  const frames = (commands: EventCommand[], n = 3) => {
    let s = startInterpreter(fresh(), { kind: "plugin", name: "t" }, commands, "normal");
    for (let i = 0; i < n; i++) s = step(s, emptyInput(), ctx).state;
    return s;
  };
  it("SaveGame / LoadGame open the menu on the save / load screen as a portal", () => {
    expect(frames([cmd("SaveGame")]).scene).toEqual({ kind: "menu", screen: "save", cursor: 0, portal: true });
    expect(frames([cmd("LoadGame")]).scene).toEqual({ kind: "menu", screen: "load", cursor: 0, portal: true });
  });
  it("GameOver goes to the game over scene and drops the event", () => {
    const s = frames([cmd("GameOver"), cmd("ControlSwitches", { ids: ["never"], value: true })]);
    expect(s.scene.kind).toBe("gameover");
    expect(s.interpreters).toHaveLength(0);
    expect(sw(s, "never")).toBeUndefined();
  });
  it("ReturnToTitle rebuilds the state at the title screen but keeps counting ticks", () => {
    const start = { ...fresh(), switches: { a: true } as never, party: { ...fresh().party, gold: 500 } };
    let s = startInterpreter(start, { kind: "plugin", name: "t" }, [cmd("ReturnToTitle")], "normal");
    for (let i = 0; i < 3; i++) s = step(s, emptyInput(), ctx).state;
    expect(s.scene).toMatchObject({ kind: "title", screen: "main" });
    expect(s.switches).toEqual({});
    expect(s.party.gold).toBe(0);
    expect(s.tick).toBe(3);
  });
  it("Script applies setVar / setSwitch / gainItem mutations, and warns on errors", () => {
    const r = run([
      cmd("Script", { expr: 'setVar("n", 3) + setVar("m", 4)' }),
      cmd("Script", { expr: 'setSwitch("s", true)' }),
      cmd("Script", { expr: 'gainItem("item_potion", 2)' }),
      cmd("Script", { expr: 'gainItem("item_potion", -5)' }),
      cmd("Script", { expr: "1 +" }),
      cmd("Script", { expr: "unknownFn()" }),
    ]);
    expect(r.state.variables).toEqual({ n: 3, m: 4 });
    expect(sw(r.state, "s")).toBe(true);
    expect(r.state.party.items).toEqual({});
    expect(warnings(r.effects)).toHaveLength(2);
  });
  it("式の中の `gold` は所持金（ConditionalBranch / ControlVariables の式で使える）", () => {
    const rich = { ...fresh(), party: { ...fresh().party, gold: 40 } };
    const branch = (cond: string) =>
      run(
        [cmd("ConditionalBranch", { condition: cond }), cmd("ControlVariables", { ids: ["hit"], op: "set", operand: c(1) }, 1), cmd("EndBranch")],
        { state: rich },
      );
    expect(v(branch("gold >= 40").state, "hit")).toBe(1);
    expect(v(branch("gold >= 41").state, "hit")).toBeUndefined();
    const copied = run([cmd("ControlVariables", { ids: ["g"], op: "set", operand: { kind: "expr", expr: "gold / 2" } })], { state: rich });
    expect(v(copied.state, "g")).toBe(20);
  });
  it("side-effect functions are rejected in ConditionalBranch (condition mode)", () => {
    const r = run([cmd("ConditionalBranch", { condition: 'setVar("n", 1) > 0' }), cmd("Comment", {}, 1), cmd("EndBranch")]);
    expect(warnings(r.effects)).toHaveLength(1);
    expect(v(r.state, "n")).toBeUndefined();
  });
});

describe("commands-smoke（全コマンドを 1 回ずつ使うイベント）", () => {
  const map = loaded.maps["map_start" as never]!;
  const eventCommands = (id: string) => map.events[id as never]!.pages[0]!.commands as EventCommand[];

  it("every builtin command (except the internal MoveStep / WaitPlayerStep) appears in the smoke map's events (battle commands: in the troop's battle events)", () => {
    const troopCommands = Object.values(loaded.project.database.troops).flatMap((t) => t.pages.flatMap((p) => p.commands));
    const used = new Set([...Object.values(map.events).flatMap((e) => e.pages.flatMap((p) => p.commands)), ...troopCommands].map((c2) => c2.code));
    const missing = BUILTIN_COMMANDS.map((h) => h.code).filter((code) => code !== "MoveStep" && code !== "WaitPlayerStep" && !used.has(code));
    expect(missing).toEqual([]);
  });

  it("the smoke troop's battle events (EnemyAppear / EnemyTransform / AbortBattle) run without any warning", () => {
    const started = startBattle(fresh(), "tr_events" as never, { canEscape: false, canLose: true }, ctx);
    let s = started;
    const effects: Effect[] = [];
    for (let i = 0; i < 600 && s.scene.kind === "battle"; i++) {
      // メッセージを送り、コマンドは防御だけ選ぶ
      const b = s.battle;
      const input = s.message.open ? press("ok") : b?.phase === "input" ? press(b.inputCursor.index === 3 ? "ok" : "down") : emptyInput();
      const r = step(s, input, ctx);
      s = r.state;
      effects.push(...r.effects);
    }
    expect(s.scene.kind).toBe("map");
    expect(warnings(effects)).toEqual([]);
  });

  it("every command in the smoke events validates against its params schema", () => {
    for (const e of Object.values(map.events)) {
      for (const command of e.pages.flatMap((p) => p.commands)) expect(ctx.commands.validate(command), `${e.id}: ${command.code}`).toEqual({ ok: true, value: undefined });
    }
  });

  it("the main smoke event runs to completion without any warning", () => {
    const shopKeys: Button[] = ["ok", "ok", "ok", "cancel", "cancel"]; // 購入 → ポーション → 1 個 → 確定 → 一覧から戻る → やめる
    let shop = 0;
    const input = (_frame: number, s: GameState): InputFrame => {
      if (s.scene.kind === "shop") return press(shopKeys[shop++] ?? "cancel");
      return s.message.open ? press("ok") : emptyInput();
    };
    const state = startInterpreter(fresh(), { kind: "mapEvent", mapId: map.id, eventId: "ev_smoke" as never, page: 0 }, eventCommands("ev_smoke"), "normal");
    const r = runCommands([], { ctx, state, input, maxFrames: 2000 });
    expect(r.finished).toBe(true);
    expect(warnings(r.effects)).toEqual([]);
    expect(sw(r.state, "sw_done")).toBe(true);
    expect(sw(r.state, "sw_common")).toBe(true);
    expect(v(r.state, "var_choice")).toBe(10);
    expect(v(r.state, "var_loop")).toBe(3);
    expect(v(r.state, "var_number")).toBe(7);
    expect(r.state.selfSwitches).toEqual({ "map_start:ev_smoke:A": true });
    expect(r.state.party.gold).toBe(90); // +100、ポーションを 1 個買って -10
    expect(r.state.party.items).toEqual({ item_potion: 4 });
    expect(r.state.party.members).toEqual(["actor_hero"]);
    expect(r.state.actors["actor_hero" as never]!.equips).toEqual({ weapon: "item_sword" });
  });

  it("the scene events (transfer / battle / save / load / game over / title) each do their job", () => {
    const at = (id: string, frames: number) => {
      let s = startInterpreter(fresh(), { kind: "mapEvent", mapId: map.id, eventId: id as never, page: 0 }, eventCommands(id), "normal");
      for (let i = 0; i < frames; i++) s = step(s, emptyInput(), ctx).state;
      return s;
    };
    expect(at("ev_transfer", 5).map.player).toMatchObject({ x: 3, y: 3 });
    expect(at("ev_battle", 3).scene.kind).toBe("battle");
    expect(at("ev_save", 3).scene).toMatchObject({ kind: "menu", screen: "save" });
    expect(at("ev_load", 3).scene).toMatchObject({ kind: "menu", screen: "load" });
    expect(at("ev_gameover", 3).scene.kind).toBe("gameover");
    expect(at("ev_title", 3).scene.kind).toBe("title");
  });
});

describe("[property] ネストした Loop × ConditionalBranch は必ず終了する", () => {
  type Node = { kind: "leaf" } | { kind: "if"; body: Node[]; other: Node[] } | { kind: "loop"; limit: number; body: Node[] };
  const nodes = (depth: number): fc.Arbitrary<Node[]> => {
    const leaf: fc.Arbitrary<Node> = fc.constant({ kind: "leaf" });
    if (depth <= 0) return fc.array(leaf, { maxLength: 2 });
    return fc.array(
      fc.oneof(
        leaf,
        fc.record({ kind: fc.constant("if" as const), body: nodes(depth - 1), other: nodes(depth - 1) }),
        fc.record({ kind: fc.constant("loop" as const), limit: fc.integer({ min: 1, max: 3 }), body: nodes(depth - 1) }),
      ),
      { maxLength: 3 },
    );
  };

  /** 各 Loop に専用のカウンタを持たせ、`limit` 回で必ず BreakLoop する。 */
  function emit(list: Node[], indent: number, counter: { n: number }, out: EventCommand[]): void {
    for (const node of list) {
      if (node.kind === "leaf") out.push(cmd("ControlVariables", { ids: ["work"], op: "add", operand: c(1) }, indent));
      else if (node.kind === "if") {
        out.push(cmd("ConditionalBranch", { condition: { kind: "variable", id: "work", op: ">=", value: 3 } }, indent));
        emit(node.body, indent + 1, counter, out);
        out.push(cmd("Else", {}, indent));
        emit(node.other, indent + 1, counter, out);
        out.push(cmd("EndBranch", {}, indent));
      } else {
        const id = `cnt${counter.n++}`;
        out.push(cmd("ControlVariables", { ids: [id], op: "set", operand: c(0) }, indent));
        out.push(cmd("Loop", {}, indent));
        out.push(cmd("ControlVariables", { ids: [id], op: "add", operand: c(1) }, indent + 1));
        out.push(cmd("ConditionalBranch", { condition: { kind: "variable", id, op: ">=", value: node.limit } }, indent + 1));
        out.push(cmd("BreakLoop", {}, indent + 2));
        out.push(cmd("EndBranch", {}, indent + 1));
        emit(node.body, indent + 1, counter, out);
        out.push(cmd("EndLoop", {}, indent));
      }
    }
  }

  it("terminates, and never warns", () => {
    fc.assert(
      fc.property(nodes(3), (tree) => {
        const commands: EventCommand[] = [];
        emit(tree, 0, { n: 0 }, commands);
        const r = run(commands, { maxFrames: 200 });
        expect(r.finished).toBe(true);
        expect(warnings(r.effects)).toEqual([]);
      }),
      { numRuns: 150 },
    );
  });
});
