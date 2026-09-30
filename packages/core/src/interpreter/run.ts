import type { EventCommand } from "@rpg/schema";
import { err, ok } from "@rpg/schema";
import type { Ctx } from "../ctx-types.js";
import { warn } from "../effects.js";
import type { Effect } from "../effects.js";
import { evaluate, parse } from "../expression/index.js";
import type { Scope, Value } from "../expression/index.js";
import type { InputFrame } from "../input.js";
import { restoreRandom } from "../random.js";
import type { Random } from "../random.js";
import type { GameState } from "../state.js";
import type { CommandCtx, CommandHandler, CommandResult } from "./handler.js";
import type { InterpreterOrigin, InterpreterState } from "./state.js";

/** 1 回の `runInterpreters` で、インタプリタ 1 つが実行できる命令数の上限（無限ループ耐性）。 */
export const MAX_COMMANDS_PER_FRAME = 1000;

/** 分岐の終端になるコマンド。`skipBlock` の飛び先。 */
const BLOCK_ENDS: ReadonlySet<string> = new Set(["Else", "EndBranch", "ChoiceBranch"]);

/**
 * インタプリタを開始する。
 * `normal` は同時に 1 つしか動かない：すでに `normal` が動いていれば何もせず、`state` をそのまま返す。
 */
export function startInterpreter(
  state: GameState,
  origin: InterpreterOrigin,
  commands: readonly EventCommand[],
  mode: "normal" | "parallel",
): GameState {
  if (mode === "normal" && state.interpreters.some((i) => i.mode === "normal")) return state;
  const interp: InterpreterState = {
    id: `i${state.nextInterpreterId}`,
    origin,
    mode,
    commands,
    pc: 0,
    wait: { kind: "none" },
    branch: {},
    callStack: [],
    locals: {},
  };
  return { ...state, nextInterpreterId: state.nextInterpreterId + 1, interpreters: [...state.interpreters, interp] };
}

const isWaiting = (i: InterpreterState): boolean => i.wait.kind !== "none";

function replace(state: GameState, id: string, f: (i: InterpreterState) => InterpreterState | null): GameState {
  const interpreters: InterpreterState[] = [];
  for (const i of state.interpreters) {
    if (i.id !== id) interpreters.push(i);
    else {
      const next = f(i);
      if (next !== null) interpreters.push(next);
    }
  }
  return { ...state, interpreters };
}

/** `pc` より後ろで、同じ indent の Else / EndBranch を探す。無ければ -1。 */
function findBlockEnd(commands: readonly EventCommand[], pc: number, indent: number): number {
  for (let i = pc + 1; i < commands.length; i++) {
    const c = commands[i]!;
    if (c.indent === indent && BLOCK_ENDS.has(c.code)) return i;
  }
  return -1;
}

/** ハンドラが `resume` を持たないときの、`wait.kind` に応じた既定の解除判定。 */
function defaultResume(c: CommandCtx): CommandResult {
  const { wait } = c.interp;
  const stay: CommandResult = { control: { kind: "wait", wait } };
  switch (wait.kind) {
    case "none":
      return {};
    case "frames":
      return wait.left <= 1 ? {} : { control: { kind: "wait", wait: { kind: "frames", left: wait.left - 1 } } };
    case "message":
      return c.state.message.open && c.state.message.owner === c.interp.id ? stay : {};
    case "choice":
      return c.state.message.choices !== null && c.state.message.owner === c.interp.id ? stay : {};
    case "transfer":
      return c.state.map.transfer !== undefined ? stay : {};
    case "child":
      return c.state.interpreters.some((i) => i.id === wait.id) ? stay : {};
    case "move":
    case "battle":
      // この待機の発行元は M1 には無い。詰まらないよう、警告して解除する。
      return { effects: [warn(`未対応の待機 "${wait.kind}" を解除した（${c.interp.id}）`)] };
  }
}

function makeEval(state: GameState, rng: Random, ctx: Ctx): CommandCtx["eval"] {
  return (expr, vars: Record<string, Value> = {}) => {
    const parsed = parse(expr);
    if (!parsed.ok) return err({ kind: "argument", message: `構文エラー: ${parsed.error.message}`, pos: parsed.error.pos });
    const scope: Scope = {
      vars,
      variable: (id) => (Object.hasOwn(state.variables, id) ? (state.variables[id] as number) : 0),
      switch: (id) => Object.hasOwn(state.switches, id) && state.switches[id] === true,
      rng,
      mode: "condition",
    };
    const r = evaluate(parsed.value, scope, ctx.formulas);
    return r.ok ? ok(r.value.value) : r;
  };
}

/** 1 フレーム分、全インタプリタを進める。`normal` も `parallel` も、配列の順に処理する。 */
export function runInterpreters(state: GameState, input: InputFrame, ctx: Ctx): { state: GameState; effects: Effect[] } {
  const rng = restoreRandom(state.rng);
  const effects: Effect[] = [];
  let s = state;

  // このフレームの開始時点で存在するインタプリタだけを動かす（途中で起動されたものは次フレームから）。
  for (const id of state.interpreters.map((i) => i.id)) {
    let budget = MAX_COMMANDS_PER_FRAME;

    for (;;) {
      const interp = s.interpreters.find((i) => i.id === id);
      if (interp === undefined) break;

      // コマンド列の終端：呼び出し元に戻るか、終了する。
      if (interp.pc >= interp.commands.length) {
        const frame = interp.callStack[interp.callStack.length - 1];
        if (frame === undefined) {
          s = replace(s, id, () => null);
          break;
        }
        s = replace(s, id, (i) => ({ ...i, commands: frame.commands, pc: frame.pc, branch: frame.branch, callStack: i.callStack.slice(0, -1) }));
        if (--budget <= 0) break;
        continue;
      }

      const cmd = interp.commands[interp.pc]!;
      const handler = ctx.commands.get(cmd.code) as CommandHandler | undefined;
      if (handler === undefined) {
        effects.push(warn(`未登録のコマンド "${cmd.code}" をスキップした（${id} pc=${interp.pc}）`));
        s = replace(s, id, (i) => ({ ...i, pc: i.pc + 1, wait: { kind: "none" } }));
        if (--budget <= 0) break;
        continue;
      }
      const params = handler.params.safeParse(cmd.params);
      if (!params.success) {
        effects.push(warn(`コマンド "${cmd.code}" の params が不正なのでスキップした（${id} pc=${interp.pc}）: ${params.error.issues[0]?.message ?? ""}`));
        s = replace(s, id, (i) => ({ ...i, pc: i.pc + 1, wait: { kind: "none" } }));
        if (--budget <= 0) break;
        continue;
      }

      const cctx: CommandCtx = { state: s, interp, project: ctx.project, rng, eval: makeEval(s, rng, ctx), input };
      const waiting = isWaiting(interp);
      const result = !waiting ? handler.run(params.data, cctx) : handler.resume ? handler.resume(params.data, cctx) : defaultResume(cctx);
      if (!waiting) budget--;
      if (result.effects) effects.push(...result.effects);
      if (result.state) s = result.state;

      // 制御の適用。`pc` は待機中は変化しない。
      const control = result.control ?? { kind: "next" };
      const branch = result.setBranch;
      s = replace(s, id, (i) => {
        const merged = branch ? { ...i.branch, ...branch } : i.branch;
        switch (control.kind) {
          case "next":
            return { ...i, branch: merged, pc: i.pc + 1, wait: { kind: "none" } };
          case "jump":
            return { ...i, branch: merged, pc: control.pc, wait: { kind: "none" } };
          case "wait":
            return { ...i, branch: merged, wait: control.wait };
          case "call":
            return {
              ...i,
              commands: control.commands,
              pc: 0,
              branch: {},
              wait: { kind: "none" },
              callStack: [...i.callStack, { commands: i.commands, pc: i.pc + 1, branch: merged }],
            };
          case "exit":
            return null;
          case "skipBlock": {
            const target = findBlockEnd(i.commands, i.pc, control.indent);
            return target < 0 ? null : { ...i, branch: merged, pc: target, wait: { kind: "none" } };
          }
        }
      });

      const after = s.interpreters.find((i) => i.id === id);
      if (after === undefined || isWaiting(after)) break;
      if (budget <= 0) break;
    }

    if (budget <= 0) {
      effects.push(warn(`インタプリタ ${id} が 1 フレームの命令数上限（${MAX_COMMANDS_PER_FRAME}）に達したので打ち切った`));
    }
  }

  return { state: { ...s, rng: rng.serialize() }, effects };
}

