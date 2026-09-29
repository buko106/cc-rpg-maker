import { cmd, runCommands } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { createRandom } from "../random.js";
import type { GameState } from "../state.js";

const v = (state: GameState, id: string): unknown => (state.variables as Record<string, number>)[id];
const sw = (state: GameState, id: string): unknown => (state.switches as Record<string, boolean>)[id];
const warnings = (effects: { kind: string; level?: string }[]) => effects.filter((e) => e.kind === "log" && e.level === "warn");

describe("ControlSwitches", () => {
  it("sets every listed switch on or off", () => {
    const r = runCommands([
      cmd("ControlSwitches", { ids: ["a", "b"], value: true }),
      cmd("ControlSwitches", { ids: ["b", "c"], value: false }),
    ]);
    expect(r.finished).toBe(true);
    expect(r.state.switches).toEqual({ a: true, b: false, c: false });
  });

  it.each([
    ["empty ids", { ids: [], value: true }],
    ["missing value", { ids: ["a"] }],
    ["value is not boolean", { ids: ["a"], value: "on" }],
    ["invalid switch id", { ids: ["bad id"], value: true }],
    ["unknown key", { ids: ["a"], value: true, extra: 1 }],
  ])("skips the command with a warning when params are invalid: %s", (_name, params) => {
    const r = runCommands([cmd("ControlSwitches", params), cmd("ControlSwitches", { ids: ["after"], value: true })]);
    expect(warnings(r.effects)).toHaveLength(1);
    expect(r.state.switches).toEqual({ after: true });
  });
});

describe("ControlVariables", () => {
  const run = (initial: Record<string, number>, params: Record<string, unknown>) => {
    const base = runCommands([]).state; // 何も起動しない状態を得る
    return runCommands([cmd("ControlVariables", params)], { state: { ...base, variables: initial as never } });
  };
  const constant = (value: number) => ({ kind: "constant", value });

  it.each<[string, number, string, number, number | undefined]>([
    // [name, 現在値, op, 被演算子, 期待値（undefined = 変化なし）]
    ["set", 5, "set", 9, 9],
    ["add", 5, "add", 3, 8],
    ["add negative", 5, "add", -8, -3],
    ["sub", 5, "sub", 3, 2],
    ["mul", 5, "mul", 3, 15],
    ["div (floor)", 7, "div", 2, 3],
    ["div negative floors toward -inf", -7, "div", 2, -4],
    ["div by zero leaves it unchanged", 7, "div", 0, undefined],
    ["mod", 7, "mod", 3, 1],
    ["mod negative keeps the JS sign", -7, "mod", 3, -1],
    ["mod by zero leaves it unchanged", 7, "mod", 0, undefined],
  ])("%s", (_name, current, op, operand, expected) => {
    const r = run({ x: current }, { ids: ["x"], op, operand: constant(operand) });
    expect(v(r.state, "x")).toBe(expected ?? current);
    expect(warnings(r.effects)).toHaveLength(0);
  });

  it("treats an unset variable as 0 and creates it", () => {
    expect(v(run({}, { ids: ["x"], op: "add", operand: constant(4) }).state, "x")).toBe(4);
  });

  it("applies the operand to every listed variable", () => {
    const r = run({ a: 1, b: 2 }, { ids: ["a", "b"], op: "mul", operand: constant(10) });
    expect(r.state.variables).toEqual({ a: 10, b: 20 });
  });

  it("reads a variable operand (evaluated once, before writing)", () => {
    const r = run({ a: 5, b: 1 }, { ids: ["a", "b"], op: "add", operand: { kind: "variable", id: "a" } });
    expect(r.state.variables).toEqual({ a: 10, b: 6 });
  });

  it("evaluates an expression operand with the 05 language", () => {
    const r = run({ a: 5 }, { ids: ["x"], op: "set", operand: { kind: "expr", expr: 'v("a") * 2 + 1' } });
    expect(v(r.state, "x")).toBe(11);
  });

  it.each([
    ["syntax error", "1 +"],
    ["type error", "1 + true"],
    ["unknown function", "nope(1)"],
    ["not a number", "true"],
    ["side effect function in condition mode", "setVar('x', 1)"],
  ])("warns and leaves variables alone for a bad expression: %s", (_name, expr) => {
    const r = run({ x: 3 }, { ids: ["x"], op: "set", operand: { kind: "expr", expr } });
    expect(v(r.state, "x")).toBe(3);
    expect(warnings(r.effects)).toHaveLength(1);
  });

  it("random operand is inclusive, deterministic per seed, and advances the shared rng", () => {
    const base = runCommands([]).state;
    const roll = (seed: string) =>
      runCommands([cmd("ControlVariables", { ids: ["r"], op: "set", operand: { kind: "random", min: 1, max: 6 } })], {
        state: { ...base, rng: createRandom(seed).serialize() },
      });
    const seen = new Set<number>();
    for (let i = 0; i < 60; i++) {
      const seed = `seed-${i}`;
      const r = roll(seed);
      const n = v(r.state, "r") as number;
      expect(Number.isInteger(n) && n >= 1 && n <= 6).toBe(true);
      seen.add(n);
      expect(roll(seed).state).toEqual(r.state);
      expect(r.state.rng).not.toEqual(createRandom(seed).serialize());
    }
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("random with min > max still yields a value in the range", () => {
    const n = v(run({}, { ids: ["r"], op: "set", operand: { kind: "random", min: 6, max: 1 } }).state, "r") as number;
    expect(n >= 1 && n <= 6).toBe(true);
  });

  it.each([
    ["unknown op", { ids: ["x"], op: "pow", operand: constant(1) }],
    ["unknown operand kind", { ids: ["x"], op: "set", operand: { kind: "magic" } }],
    ["empty ids", { ids: [], op: "set", operand: constant(1) }],
    ["random with non-integers", { ids: ["x"], op: "set", operand: { kind: "random", min: 0.5, max: 2 } }],
  ])("skips with a warning when params are invalid: %s", (_name, params) => {
    const r = run({ x: 3 }, params);
    expect(v(r.state, "x")).toBe(3);
    expect(warnings(r.effects)).toHaveLength(1);
  });
});

describe("ConditionalBranch", () => {
  /** 条件・真の側・偽の側を組み立てる。真なら T、偽なら F のスイッチが立つ。 */
  const program = (condition: unknown, withElse = true) => [
    cmd("ConditionalBranch", { condition }),
    cmd("ControlSwitches", { ids: ["T"], value: true }, 1),
    ...(withElse ? [cmd("Else"), cmd("ControlSwitches", { ids: ["F"], value: true }, 1)] : []),
    cmd("EndBranch"),
    cmd("ControlSwitches", { ids: ["after"], value: true }),
  ];
  const outcome = (r: ReturnType<typeof runCommands>) => ({ T: sw(r.state, "T"), F: sw(r.state, "F"), after: sw(r.state, "after") });
  const withState = (o: Partial<GameState>) => ({ state: { ...runCommands([]).state, ...o } });

  it.each<[string, unknown, Partial<GameState>, "T" | "F"]>([
    ["expr true", "true", {}, "T"],
    ["expr false", "false", {}, "F"],
    ["expr on variables", 'v("x") >= 3', { variables: { x: 3 } as never }, "T"],
    ["expr on variables (false)", 'v("x") >= 3', { variables: { x: 2 } as never }, "F"],
    ["expr on switches", 's("on") && !s("off")', { switches: { on: true } as never }, "T"],
    ["switch cond on/on", { kind: "switch", id: "s1", value: true }, { switches: { s1: true } as never }, "T"],
    ["switch cond on/unset", { kind: "switch", id: "s1", value: true }, {}, "F"],
    ["switch cond off/unset", { kind: "switch", id: "s1", value: false }, {}, "T"],
    ["variable >= ", { kind: "variable", id: "x", op: ">=", value: 2 }, { variables: { x: 2 } as never }, "T"],
    ["variable == ", { kind: "variable", id: "x", op: "==", value: 2 }, { variables: { x: 3 } as never }, "F"],
    ["variable <= (unset = 0)", { kind: "variable", id: "x", op: "<=", value: 0 }, {}, "T"],
  ])("%s", (_name, condition, state, taken) => {
    const r = runCommands(program(condition), withState(state));
    expect(r.finished).toBe(true);
    expect(outcome(r)).toEqual(taken === "T" ? { T: true, F: undefined, after: true } : { T: undefined, F: true, after: true });
    expect(warnings(r.effects)).toHaveLength(0);
  });

  it("without Else, a false condition skips the body and continues after EndBranch", () => {
    const r = runCommands(program("false", false));
    expect(outcome(r)).toEqual({ T: undefined, F: undefined, after: true });
  });

  it.each([
    ["syntax error", "1 +"],
    ["not a boolean", "1 + 1"],
    ["unknown identifier", "nope"],
  ])("treats an unusable condition as false and warns: %s", (_name, condition) => {
    const r = runCommands(program(condition));
    expect(outcome(r)).toEqual({ T: undefined, F: true, after: true });
    expect(warnings(r.effects)).toHaveLength(1);
  });

  it("supports nesting: inner branches at deeper indent do not confuse the outer Else/EndBranch", () => {
    const nested = [
      cmd("ConditionalBranch", { condition: "true" }),
      cmd("ConditionalBranch", { condition: "false" }, 1),
      cmd("ControlSwitches", { ids: ["in_t"], value: true }, 2),
      cmd("Else", {}, 1),
      cmd("ControlSwitches", { ids: ["in_f"], value: true }, 2),
      cmd("EndBranch", {}, 1),
      cmd("Else"),
      cmd("ControlSwitches", { ids: ["out_f"], value: true }, 1),
      cmd("EndBranch"),
      cmd("ControlSwitches", { ids: ["after"], value: true }),
    ];
    expect(runCommands(nested).state.switches).toEqual({ in_f: true, after: true });
  });

  it("a false outer branch skips a nested branch entirely", () => {
    const nested = [
      cmd("ConditionalBranch", { condition: "false" }),
      cmd("ConditionalBranch", { condition: "true" }, 1),
      cmd("ControlSwitches", { ids: ["inner"], value: true }, 2),
      cmd("EndBranch", {}, 1),
      cmd("Else"),
      cmd("ControlSwitches", { ids: ["else"], value: true }, 1),
      cmd("EndBranch"),
    ];
    expect(runCommands(nested).state.switches).toEqual({ else: true });
  });

  it("[inv-3] a false branch with no terminator ends the interpreter instead of running off the end", () => {
    const r = runCommands([cmd("ConditionalBranch", { condition: "false" }), cmd("ControlSwitches", { ids: ["body"], value: true }, 1)]);
    expect(r.finished).toBe(true);
    expect(r.state.switches).toEqual({});
  });

  it("a stray Else (no matching branch) does not crash", () => {
    const r = runCommands([cmd("Else"), cmd("ControlSwitches", { ids: ["x"], value: true })]);
    expect(r.finished).toBe(true);
  });
});

describe("Wait", () => {
  /** Wait の直後のスイッチが立つフレーム番号（`history` の添字）を返す。 */
  const frameOf = (frames: number): number => {
    const r = runCommands([cmd("Wait", { frames }), cmd("ControlSwitches", { ids: ["done"], value: true })]);
    expect(r.finished).toBe(true);
    return r.history.findIndex((s) => sw(s, "done") === true);
  };

  it.each([0, 1, 2, 3, 10, 60])("Wait %i continues exactly that many frames later", (frames) => {
    expect(frameOf(frames)).toBe(frames);
  });

  it("[inv-2] does not advance pc while waiting", () => {
    const r = runCommands([cmd("Wait", { frames: 5 }), cmd("ControlSwitches", { ids: ["x"], value: true })]);
    const pcs = r.history.slice(0, 5).map((s) => s.interpreters[0]?.pc);
    expect(pcs).toEqual([0, 0, 0, 0, 0]);
  });

  it.each([-1, 1.5, "3", undefined])("rejects frames = %j", (frames) => {
    const r = runCommands([cmd("Wait", { frames })]);
    expect(warnings(r.effects)).toHaveLength(1);
    expect(r.frames).toBe(1);
  });
});

describe("ShowText", () => {
  const talk = (extra: Record<string, unknown> = {}) => cmd("ShowText", { text: "こんにちは", ...extra });

  it("opens the message with defaults, waits for ok, then closes and continues", () => {
    const r = runCommands([talk(), cmd("ControlSwitches", { ids: ["after"], value: true })]);
    expect(r.finished).toBe(true);
    const opened = r.history[0]!;
    expect(opened.message).toEqual({
      open: true, owner: opened.interpreters[0]!.id, text: "こんにちは", face: null, position: "bottom", background: "window", choices: null,
    });
    expect(opened.interpreters[0]!.wait).toEqual({ kind: "message" });
    expect(sw(r.state, "after")).toBe(true);
    expect(r.state.message.open).toBe(false);
  });

  it("stays open until a confirm/cancel button is pressed", () => {
    const r = runCommands([talk()], { maxFrames: 20, input: () => ({ pressed: new Set(), triggered: new Set() }) });
    expect(r.finished).toBe(false);
    expect(r.state.message.open).toBe(true);
    expect(r.frames).toBe(20);
  });

  it("passes face / position / background through", () => {
    const r = runCommands([talk({ face: { asset: "0123456789abcdef" }, position: "top", background: "dim" })], { maxFrames: 1 });
    expect(r.state.message).toMatchObject({ face: { asset: "0123456789abcdef" }, position: "top", background: "dim" });
  });

  it("shows multiple messages in order", () => {
    const seen: string[] = [];
    runCommands([talk({ text: "1" }), talk({ text: "2" }), talk({ text: "3" })], {
      input: (_f, s) => {
        if (s.message.open) seen.push(s.message.text);
        return s.message.open ? { pressed: new Set(["ok"]), triggered: new Set(["ok"]) } : { pressed: new Set(), triggered: new Set() };
      },
    });
    expect(seen).toEqual(["1", "2", "3"]);
  });

  it("cancel also closes the message", () => {
    const r = runCommands([talk()], { input: (_f, s) => (s.message.open ? { pressed: new Set(["cancel"]), triggered: new Set(["cancel"]) } : { pressed: new Set(), triggered: new Set() }) });
    expect(r.finished).toBe(true);
  });

  it("rejects invalid position / background", () => {
    expect(warnings(runCommands([talk({ position: "left" })]).effects)).toHaveLength(1);
    expect(warnings(runCommands([talk({ background: "red" })]).effects)).toHaveLength(1);
  });
});

describe("TransferPlayer", () => {
  it("reserves a transfer and waits for it; the same-map transfer resets the player position", () => {
    const r = runCommands([
      cmd("TransferPlayer", { mapId: "map_start", x: 7, y: 5, dir: "up", fade: "none" }),
      cmd("ControlSwitches", { ids: ["after"], value: true }),
    ]);
    expect(r.finished).toBe(true);
    expect(r.history[0]!.interpreters[0]!.wait).toEqual({ kind: "transfer" });
    expect(r.state.map.player).toMatchObject({ x: 7, y: 5, realX: 7, realY: 5, direction: "up", moving: false });
    expect(sw(r.state, "after")).toBe(true);
  });

  it("keeps the current direction when dir is omitted or 'retain'", () => {
    for (const dir of [undefined, "retain"]) {
      const params = { mapId: "map_start", x: 1, y: 1, ...(dir ? { dir } : {}) };
      expect(runCommands([cmd("TransferPlayer", params)]).state.map.player.direction).toBe("down");
    }
  });

  it("skips with a warning when the map does not exist in the project", () => {
    const r = runCommands([cmd("TransferPlayer", { mapId: "nowhere", x: 0, y: 0 }), cmd("ControlSwitches", { ids: ["after"], value: true })]);
    expect(warnings(r.effects)).toHaveLength(1);
    expect(sw(r.state, "after")).toBe(true);
    expect(r.state.map.mapId).toBe("map_start");
  });

  it("clamps an out-of-range destination into the map and warns", () => {
    const r = runCommands([cmd("TransferPlayer", { mapId: "map_start", x: 99, y: 99 })]);
    expect(r.state.map.player).toMatchObject({ x: 9, y: 7 });
    expect(warnings(r.effects)).toHaveLength(1);
  });

  it.each([
    ["negative x", { mapId: "map_start", x: -1, y: 0 }],
    ["fractional y", { mapId: "map_start", x: 0, y: 0.5 }],
    ["bad dir", { mapId: "map_start", x: 0, y: 0, dir: "north" }],
    ["bad fade", { mapId: "map_start", x: 0, y: 0, fade: "red" }],
  ])("rejects invalid params: %s", (_name, params) => {
    const r = runCommands([cmd("TransferPlayer", params)]);
    expect(warnings(r.effects)).toHaveLength(1);
    expect(r.state.map.transfer).toBeUndefined();
  });
});
