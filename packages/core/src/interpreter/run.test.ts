import fc from "fast-check";
import type { EventCommand } from "@rpg/schema";
import { cmd, deepFreeze, loadFixtureProject, runCommands } from "@rpg/test-utils";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { createCtx } from "../ctx.js";
import { initialState } from "../game/index.js";
import { emptyInput, inputFrame } from "../input.js";
import type { GameState } from "../state.js";
import { defineCommand } from "./handler.js";
import type { CommandHandler } from "./handler.js";
import { MAX_COMMANDS_PER_FRAME, runInterpreters, startInterpreter } from "./run.js";

const empty = z.strictObject({});
const noMeta = { label: "t", category: "test", describe: () => "t", refs: () => [] } as const;
const count = (s: GameState, id = "n"): number => (s.variables as Record<string, number>)[id] ?? 0;
const warnings = (effects: { kind: string; level?: string }[]) => effects.filter((e) => e.kind === "log" && e.level === "warn");

/** テスト用の追加コマンドを登録した Ctx を作る。 */
function ctxWith(...handlers: CommandHandler<any>[]) {
  const { view } = loadFixtureProject("minimal");
  const ctx = createCtx(view);
  for (const h of handlers) ctx.commands.register(h);
  return ctx;
}

/** 変数 n を 1 増やす。 */
const inc = defineCommand({
  code: "Inc", params: empty, meta: noMeta,
  run: (_p, c) => ({ state: { ...c.state, variables: { ...c.state.variables, n: count(c.state) + 1 } } }),
});
/** 変数 n を 1 増やして先頭に戻る（無限ループ）。 */
const spin = defineCommand({
  code: "Spin", params: empty, meta: noMeta,
  run: (_p, c) => ({ state: { ...c.state, variables: { ...c.state.variables, n: count(c.state) + 1 } }, control: { kind: "jump", pc: 0 } }),
});
const exit = defineCommand({ code: "Exit", params: empty, meta: noMeta, run: () => ({ control: { kind: "exit" } }) });
/** params.commands を呼び出す（コモンイベント呼び出し相当）。 */
const call = defineCommand({
  code: "Call", params: z.strictObject({ commands: z.array(z.any()) }), meta: noMeta,
  run: (p) => ({ control: { kind: "call", commands: p.commands as EventCommand[] } }),
});

describe("registry", () => {
  it("registers every builtin command in docs/03 (M1 + M4 + M6)", () => {
    const codes = loadFixtureProject("minimal").ctx.commands.list().map((h) => h.code).sort();
    // docs/03-interpreter.md の組み込みコマンド一覧（内部用の ChoiceBranch / MoveStep を含む）
    const documented = [
      "ShowText", "ShowChoices", "ChoiceBranch", "InputNumber", "SelectItem", "ControlSwitches", "ControlVariables", "ControlSelfSwitch", "ControlTimer",
      "ConditionalBranch", "Else", "EndBranch", "Loop", "BreakLoop", "EndLoop", "ExitEventProcessing", "CallCommonEvent", "Label", "JumpToLabel", "Wait",
      "TransferPlayer", "SetMoveRoute", "SetEventLocation", "ChangeMapTile", "MoveStep", "WaitPlayerStep", "ChangeGold", "ChangeItems", "ChangeParty", "ChangeEquipment", "ChangeHp", "ChangeMp", "ChangeExp", "ChangeLevel",
      "ChangeBgm", "PlaySe", "FadeoutBgm", "ShakeScreen", "FlashScreen", "TintScreen", "Fadein", "Fadeout", "BattleProcessing", "ShopProcessing",
      "EnemyAppear", "EnemyTransform", "AbortBattle",
      "SaveGame", "LoadGame", "GameOver", "ReturnToTitle", "Script", "Comment",
    ].sort();
    expect(codes).toEqual(documented);
  });

  it("rejects duplicate registration", () => {
    const ctx = ctxWith();
    expect(() => ctx.commands.register(inc)).not.toThrow();
    expect(() => ctx.commands.register(inc)).toThrow(/二重登録/);
  });

  it("validate() reports unknown commands and invalid params with paths", () => {
    const { commands } = loadFixtureProject("minimal").ctx;
    expect(commands.validate(cmd("ControlSwitches", { ids: ["a"], value: true }))).toEqual({ ok: true, value: undefined });
    expect(commands.validate(cmd("Nope"))).toEqual({ ok: false, error: { kind: "unknownCommand", code: "Nope" } });
    const bad = commands.validate(cmd("ControlSwitches", { ids: "a", value: true }));
    expect(bad).toMatchObject({ ok: false, error: { kind: "invalidParams", code: "ControlSwitches" } });
    if (!bad.ok && bad.error.kind === "invalidParams") expect(bad.error.issues.map((i) => i.path)).toContain("ids");
  });

  it("exposes editor metadata: describe() and refs()", () => {
    const { commands, project } = loadFixtureProject("transfer-demo").ctx;
    const transfer = commands.get("TransferPlayer")!;
    const params = transfer.params.parse({ mapId: "map_b", x: 2, y: 3 });
    expect(transfer.meta.describe(params, project)).toBe("場所移動：map_b (2, 3)");
    expect(transfer.meta.refs(params)).toEqual([{ kind: "map", id: "map_b" }]);
    const vars = commands.get("ControlVariables")!;
    const p = vars.params.parse({ ids: ["a"], op: "add", operand: { kind: "variable", id: "b" } });
    expect(vars.meta.refs(p)).toEqual([{ kind: "variable", id: "a" }, { kind: "variable", id: "b" }]);
  });
});

describe("startInterpreter", () => {
  const ctx = ctxWith(inc);
  const base = initialState(ctx, "s");
  const origin = { kind: "plugin", name: "t" } as const;
  const cmds = [cmd("Inc")];

  it("starts at pc 0 with no wait and unique ids", () => {
    const s1 = startInterpreter(base, origin, cmds, "normal");
    const s2 = startInterpreter(s1, origin, cmds, "parallel");
    const s3 = startInterpreter(s2, origin, cmds, "parallel");
    expect(s1.interpreters[0]).toMatchObject({ pc: 0, wait: { kind: "none" }, branch: {}, callStack: [], mode: "normal" });
    expect(new Set(s3.interpreters.map((i) => i.id)).size).toBe(3);
  });

  it("allows only one normal interpreter at a time, but any number of parallel ones", () => {
    const s1 = startInterpreter(base, origin, cmds, "normal");
    expect(startInterpreter(s1, origin, cmds, "normal")).toBe(s1);
    expect(startInterpreter(s1, origin, cmds, "parallel").interpreters).toHaveLength(2);
  });

  it("does not mutate the given state", () => {
    const frozen = deepFreeze(structuredClone(base));
    expect(() => startInterpreter(frozen, origin, cmds, "normal")).not.toThrow();
  });
});

describe("runInterpreters: execution", () => {
  it("runs consecutive commands within one frame until something blocks", () => {
    const ctx = ctxWith(inc);
    const s = startInterpreter(initialState(ctx, "s"), { kind: "plugin", name: "t" }, [cmd("Inc"), cmd("Inc"), cmd("Inc")], "normal");
    const r = runInterpreters(s, emptyInput(), ctx);
    expect(count(r.state)).toBe(3);
    expect(r.state.interpreters).toHaveLength(0);
  });

  it("[inv-1] runs at most MAX_COMMANDS_PER_FRAME commands per interpreter per call (infinite loops cannot hang a frame)", () => {
    const ctx = ctxWith(spin);
    let s = startInterpreter(initialState(ctx, "s"), { kind: "plugin", name: "t" }, [cmd("Spin")], "normal");
    const r1 = runInterpreters(s, emptyInput(), ctx);
    expect(count(r1.state)).toBe(MAX_COMMANDS_PER_FRAME);
    expect(warnings(r1.effects)).toHaveLength(1);
    expect(r1.state.interpreters).toHaveLength(1); // 打ち切っても終了はしない
    s = r1.state;
    expect(count(runInterpreters(s, emptyInput(), ctx).state)).toBe(2 * MAX_COMMANDS_PER_FRAME);
  });

  it("[inv-1] the limit applies per interpreter, not to the whole frame", () => {
    const ctx = ctxWith(spin);
    let s = initialState(ctx, "s");
    s = startInterpreter(s, { kind: "plugin", name: "a" }, [cmd("Spin")], "parallel");
    s = startInterpreter(s, { kind: "plugin", name: "b" }, [cmd("Spin")], "parallel");
    expect(count(runInterpreters(s, emptyInput(), ctx).state)).toBe(2 * MAX_COMMANDS_PER_FRAME);
  });

  it("[inv-5] skips unregistered commands with a warning and keeps going", () => {
    const r = runCommands([cmd("NoSuchCommand"), cmd("plugin:x/Y", { a: 1 }), cmd("ControlSwitches", { ids: ["ok"], value: true })]);
    expect(r.finished).toBe(true);
    expect(r.state.switches).toEqual({ ok: true });
    expect(warnings(r.effects)).toHaveLength(2);
  });

  it("[inv-4] is deterministic: the same inputs give the same result", () => {
    const program = [
      cmd("ControlVariables", { ids: ["r"], op: "set", operand: { kind: "random", min: 0, max: 1000 } }),
      cmd("ConditionalBranch", { condition: 'v("r") > 500' }),
      cmd("ControlSwitches", { ids: ["big"], value: true }, 1),
      cmd("EndBranch"),
    ];
    const a = runCommands(program);
    const b = runCommands(program);
    expect(a.state).toEqual(b.state);
    expect(a.effects).toEqual(b.effects);
  });

  it("does not mutate the given state (deep-frozen input)", () => {
    const ctx = ctxWith(inc);
    const s = deepFreeze(startInterpreter(initialState(ctx, "s"), { kind: "plugin", name: "t" }, [cmd("Inc"), cmd("Wait", { frames: 2 }), cmd("Inc")], "normal"));
    let cur: GameState = s;
    for (let i = 0; i < 5; i++) cur = deepFreeze(runInterpreters(cur, emptyInput(), ctx).state);
    expect(count(cur)).toBe(2);
  });
});

describe("runInterpreters: control flow", () => {
  it("exit terminates the interpreter immediately", () => {
    const ctx = ctxWith(inc, exit);
    const r = runCommands([cmd("Inc"), cmd("Exit"), cmd("Inc")], { ctx });
    expect(count(r.state)).toBe(1);
    expect(r.finished).toBe(true);
  });

  it("call runs the callee and then resumes after the call site, restoring the caller's branch state", () => {
    const ctx = ctxWith(inc, call);
    const callee = [cmd("Inc"), cmd("Inc")];
    const r = runCommands([cmd("ConditionalBranch", { condition: "true" }), cmd("Call", { commands: callee }, 1), cmd("Inc", {}, 1), cmd("Else"), cmd("Inc", {}, 1), cmd("EndBranch"), cmd("Inc")], { ctx });
    expect(count(r.state)).toBe(2 + 1 + 1);
    expect(r.state.interpreters).toHaveLength(0);
  });

  it("nested calls unwind in order", () => {
    const ctx = ctxWith(inc, call);
    const inner = [cmd("Inc")];
    const outer = [cmd("Call", { commands: inner }), cmd("Inc")];
    const r = runCommands([cmd("Call", { commands: outer }), cmd("Inc")], { ctx });
    expect(count(r.state)).toBe(3);
  });

  it("jump to the end of the list finishes the interpreter", () => {
    const jumpOut = defineCommand({ code: "JumpOut", params: empty, meta: noMeta, run: () => ({ control: { kind: "jump", pc: 999 } }) });
    const r = runCommands([cmd("JumpOut"), cmd("ControlSwitches", { ids: ["skipped"], value: true })], { ctx: ctxWith(jumpOut) });
    expect(r.finished).toBe(true);
    expect(r.state.switches).toEqual({});
  });

  it("supports a custom resume(): the wait is released when its own condition holds", () => {
    const gate = defineCommand({
      code: "Gate", params: empty, meta: noMeta,
      run: () => ({ control: { kind: "wait", wait: { kind: "frames", left: 999 } } }),
      resume: (_p, c) => ((c.state.variables as Record<string, number>)["open"] === 1 ? { control: { kind: "next" } } : { control: { kind: "wait", wait: c.interp.wait } }),
    });
    const ctx = ctxWith(gate, inc);
    const base = startInterpreter(initialState(ctx, "s"), { kind: "plugin", name: "t" }, [cmd("Gate"), cmd("Inc")], "normal");
    let s = base;
    for (let i = 0; i < 5; i++) s = runInterpreters(s, emptyInput(), ctx).state;
    expect(count(s)).toBe(0);
    s = { ...s, variables: { open: 1 } as never };
    expect(count(runInterpreters(s, emptyInput(), ctx).state)).toBe(1);
  });
});

describe("runInterpreters: waiting", () => {
  it("[inv-2] pc does not change while a wait is not released", () => {
    // 解除されない待機（入力なしのメッセージ、永遠のウェイト）の間は、何フレーム経っても同じ pc に留まる
    const forever = defineCommand({ code: "Forever", params: empty, meta: noMeta, run: () => ({ control: { kind: "wait", wait: { kind: "message" } } }), resume: (_p, c) => ({ control: { kind: "wait", wait: c.interp.wait } }) });
    const ctx = ctxWith(inc, forever);
    const scenarios: [string, EventCommand[], number][] = [
      ["message without input", [cmd("Inc"), cmd("ShowText", { text: "a" }), cmd("Inc")], 1],
      ["custom wait", [cmd("Inc"), cmd("Inc"), cmd("Forever"), cmd("Inc")], 2],
      ["long Wait", [cmd("Inc"), cmd("Wait", { frames: 500 }), cmd("Inc")], 1],
    ];
    for (const [name, commands, blockedAt] of scenarios) {
      const r = runCommands(commands, { ctx, maxFrames: 60, input: () => emptyInput() });
      expect(r.finished, name).toBe(false);
      for (const state of r.history) {
        expect(state.interpreters[0]!.pc, name).toBe(blockedAt);
        expect(state.interpreters[0]!.wait.kind, name).not.toBe("none");
      }
    }
  });

  it("[inv-2] a released wait moves pc by exactly one", () => {
    const r = runCommands([cmd("Wait", { frames: 2 }), cmd("Wait", { frames: 2 }), cmd("Wait", { frames: 2 })]);
    const pcs = r.history.map((s) => s.interpreters[0]?.pc);
    expect(pcs).toEqual([0, 0, 1, 1, 2, 2, undefined]);
  });

  it("a parallel interpreter waiting does not block the normal one, and vice versa", () => {
    const ctx = ctxWith(inc);
    let s = initialState(ctx, "s");
    s = startInterpreter(s, { kind: "plugin", name: "p" }, [cmd("Wait", { frames: 1000 }), cmd("ControlSwitches", { ids: ["parallel_done"], value: true })], "parallel");
    s = startInterpreter(s, { kind: "plugin", name: "n" }, [cmd("Wait", { frames: 3 }), cmd("ControlSwitches", { ids: ["normal_done"], value: true })], "normal");
    for (let i = 0; i < 4; i++) s = runInterpreters(s, emptyInput(), ctx).state;
    expect(s.switches).toEqual({ normal_done: true });
    expect(s.interpreters).toHaveLength(1);
    expect(s.interpreters[0]!.mode).toBe("parallel");
  });

  it("a second interpreter that wants to show text waits for the first message to close, then shows its own", () => {
    const ctx = ctxWith();
    let s = initialState(ctx, "s");
    s = startInterpreter(s, { kind: "plugin", name: "a" }, [cmd("ShowText", { text: "A" })], "normal");
    s = startInterpreter(s, { kind: "plugin", name: "b" }, [cmd("ShowText", { text: "B" })], "parallel");
    const ok = { pressed: new Set(["ok" as const]), triggered: new Set(["ok" as const]) };
    const shown: string[] = [];
    const step1 = (input: typeof ok | ReturnType<typeof emptyInput>): void => {
      s = runInterpreters(s, input, ctx).state;
    };
    step1(emptyInput());
    shown.push(s.message.text);
    expect(s.message.owner).toBe(s.interpreters[0]!.id);
    // 入力フェーズ相当：メッセージを閉じる
    s = { ...s, message: { ...s.message, open: false, owner: "", text: "" } };
    step1(emptyInput());
    step1(emptyInput());
    shown.push(s.message.text);
    expect(shown).toEqual(["A", "B"]);
  });

  it("releases a 'child' wait when the awaited interpreter has finished", () => {
    const ctx = ctxWith(inc);
    let s = initialState(ctx, "s");
    s = startInterpreter(s, { kind: "plugin", name: "child" }, [cmd("Wait", { frames: 3 })], "parallel");
    const childId = s.interpreters[0]!.id;
    const waiter = defineCommand({ code: "AwaitChild", params: empty, meta: noMeta, run: () => ({ control: { kind: "wait", wait: { kind: "child", id: childId } } }) });
    ctx.commands.register(waiter);
    s = startInterpreter(s, { kind: "plugin", name: "parent" }, [cmd("AwaitChild"), cmd("Inc")], "normal");
    const done: number[] = [];
    for (let i = 0; i < 8; i++) {
      s = runInterpreters(s, emptyInput(), ctx).state;
      if (count(s) === 1 && done.length === 0) done.push(i);
    }
    expect(done).toEqual([3]);
  });
});

describe("runInterpreters: default wait resolution", () => {
  /** 指定した種類の待機に入るだけのコマンド（既定の解除処理を検査する）。 */
  const waitFor = defineCommand({
    code: "WaitFor", params: z.strictObject({ wait: z.any() }), meta: noMeta,
    run: (p) => ({ control: { kind: "wait", wait: p.wait } }),
  });
  const start = (wait: unknown) => {
    const ctx = ctxWith(waitFor, inc);
    const s = startInterpreter(initialState(ctx, "s"), { kind: "plugin", name: "t" }, [cmd("WaitFor", { wait }), cmd("Inc")], "normal");
    return { ctx, s };
  };
  const tick = (s: GameState, ctx: ReturnType<typeof ctxWith>) => runInterpreters(s, emptyInput(), ctx);

  it("choice: stays while this interpreter's choices are pending, then continues", () => {
    const { ctx, s } = start({ kind: "choice" });
    const waiting = tick(s, ctx).state; // WaitFor 実行 → choice 待ち
    const id = waiting.interpreters[0]!.id;
    const pending = { ...waiting, message: { ...waiting.message, open: true, owner: id, choices: ["はい", "いいえ"] } };
    expect(count(tick(pending, ctx).state)).toBe(0); // 選択待ち
    const answered = { ...pending, message: { ...pending.message, choices: null } };
    expect(count(tick(answered, ctx).state)).toBe(1);
  });

  it("choice: someone else's pending choices do not hold this interpreter", () => {
    const { ctx, s } = start({ kind: "choice" });
    const waiting = tick(s, ctx).state;
    const foreign = { ...waiting, message: { ...waiting.message, owner: "someone-else", choices: ["a"] } };
    expect(count(tick(foreign, ctx).state)).toBe(1);
  });

  it.each(["move", "battle"] as const)("%s: no source exists in M1, so it is released with a warning instead of hanging", (kind) => {
    const { ctx, s } = start(kind === "move" ? { kind, who: "player" } : { kind });
    const waiting = tick(s, ctx).state;
    const released = tick(waiting, ctx);
    expect(count(released.state)).toBe(1);
    expect(warnings(released.effects)).toHaveLength(1);
  });

  it("plugin: resume() で毎フレーム入力を読み、決定ボタンが押されたら解除する（ミニゲーム・独自の画面）", () => {
    const minigame = defineCommand({
      code: "Minigame", params: empty, meta: noMeta,
      run: () => ({ control: { kind: "wait", wait: { kind: "plugin", name: "t" } } }),
      resume: (_p, c) => (c.input.triggered.has("ok") ? { control: { kind: "next" } } : { control: { kind: "wait", wait: c.interp.wait } }),
    });
    const ctx = ctxWith(minigame, inc);
    let s = startInterpreter(initialState(ctx, "s"), { kind: "plugin", name: "t" }, [cmd("Minigame"), cmd("Inc")], "normal");
    s = runInterpreters(s, emptyInput(), ctx).state; // Minigame 実行 → plugin 待ち
    expect(s.interpreters[0]!.wait).toEqual({ kind: "plugin", name: "t" });
    for (let i = 0; i < 5; i++) s = runInterpreters(s, emptyInput(), ctx).state;
    expect(count(s)).toBe(0); // 押すまで進まない
    expect(count(runInterpreters(s, inputFrame([], ["ok"]), ctx).state)).toBe(1);
  });

  it("plugin: resume を持たないコマンドが発行した待機は、警告して解除する（プラグインを外したセーブで詰まらない）", () => {
    const { ctx, s } = start({ kind: "plugin", name: "gone" });
    const waiting = tick(s, ctx).state;
    const released = tick(waiting, ctx);
    expect(count(released.state)).toBe(1);
    expect(warnings(released.effects)).toHaveLength(1);
  });

  it("transfer: holds while a transfer is reserved and releases once it is gone", () => {
    const { ctx, s } = start({ kind: "transfer" });
    const waiting = tick(s, ctx).state;
    const reserved = { ...waiting, map: { ...waiting.map, transfer: { to: "map_start" as never, x: 0, y: 0, dir: "down" as const, fade: "none" as const, requested: true } } };
    expect(count(tick(reserved, ctx).state)).toBe(0);
    expect(count(tick(waiting, ctx).state)).toBe(1);
  });
});

describe("runInterpreters: structured programs", () => {
  type Node = { kind: "set"; id: string } | { kind: "if"; cond: string; then: Node[]; otherwise: Node[] | null };
  const nodeArb = (depth: number): fc.Arbitrary<Node> => {
    const leaf = fc.constantFrom("a", "b", "c").map((id): Node => ({ kind: "set", id }));
    if (depth <= 0) return leaf;
    const sub = fc.array(nodeArb(depth - 1), { maxLength: 3 });
    return fc.oneof(
      leaf,
      fc.tuple(fc.constantFrom("true", "false", 's("a")', 'v("x") >= 1'), sub, fc.option(sub, { nil: null })).map(([cond, then, otherwise]): Node => ({ kind: "if", cond, then, otherwise })),
    );
  };
  const flatten = (nodes: Node[], indent = 0): EventCommand[] =>
    nodes.flatMap((n): EventCommand[] =>
      n.kind === "set"
        ? [cmd("ControlSwitches", { ids: [n.id], value: true }, indent)]
        : [
            cmd("ConditionalBranch", { condition: n.cond }, indent),
            ...flatten(n.then, indent + 1),
            ...(n.otherwise ? [cmd("Else", {}, indent), ...flatten(n.otherwise, indent + 1)] : []),
            cmd("EndBranch", {}, indent),
          ],
    );

  it("[inv-3] arbitrarily nested branches always terminate without warnings", () => {
    fc.assert(
      fc.property(fc.array(nodeArb(3), { maxLength: 5 }), (nodes) => {
        const r = runCommands(flatten(nodes), { maxFrames: 5 });
        expect(r.finished).toBe(true);
        expect(warnings(r.effects)).toHaveLength(0);
      }),
      { numRuns: 200 },
    );
  });

  it("evaluates nested branches like a reference interpreter", () => {
    const evalNodes = (nodes: Node[], on: Set<string>): void => {
      for (const n of nodes) {
        if (n.kind === "set") on.add(n.id);
        else {
          const cond = n.cond === "true" ? true : n.cond === "false" ? false : n.cond === 's("a")' ? on.has("a") : false; // v("x") は未設定 = 0
          if (cond) evalNodes(n.then, on);
          else if (n.otherwise) evalNodes(n.otherwise, on);
        }
      }
    };
    fc.assert(
      fc.property(fc.array(nodeArb(3), { maxLength: 5 }), (nodes) => {
        const expected = new Set<string>();
        evalNodes(nodes, expected);
        const r = runCommands(flatten(nodes), { maxFrames: 5 });
        const actual = new Set(Object.entries(r.state.switches).filter(([, v]) => v).map(([k]) => k));
        expect(actual).toEqual(expected);
      }),
      { numRuns: 200 },
    );
  });

  it("[inv-3] still terminates on malformed indentation (random indents, missing terminators)", () => {
    const codes = ["ConditionalBranch", "Else", "EndBranch", "ControlSwitches", "Wait"] as const;
    const commandArb = fc.tuple(fc.constantFrom(...codes), fc.integer({ min: 0, max: 3 })).map(([code, indent]) =>
      cmd(code, code === "ConditionalBranch" ? { condition: "false" } : code === "ControlSwitches" ? { ids: ["x"], value: true } : code === "Wait" ? { frames: 1 } : {}, indent),
    );
    fc.assert(
      fc.property(fc.array(commandArb, { maxLength: 12 }), (commands) => {
        const r = runCommands(commands, { maxFrames: 100 });
        expect(r.finished).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});
