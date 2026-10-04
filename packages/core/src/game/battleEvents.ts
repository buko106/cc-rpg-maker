import type { Ctx } from "../ctx-types.js";
import type { InputFrame } from "../input.js";
import { agePopups, battleTick, leaveBattle, nextTroopPage } from "../battle/index.js";
import { runInterpreters } from "../interpreter/index.js";
import type { InterpreterState } from "../interpreter/index.js";
import type { GameState } from "../state.js";
import type { StepResult } from "./actions.js";

const isTroopEvent = (i: InterpreterState): boolean => i.origin.kind === "troop";

/** 敵グループのバトルイベントが動いているか（その間、戦闘は進まず、入力はメッセージにだけ届く）。 */
export const battleEventRunning = (state: GameState): boolean => state.interpreters.some(isTroopEvent);

/** 条件を満たすバトルイベントのページがあれば、動いた印を付けてインタプリタを起動する。無ければ `undefined`。 */
function startTroopEvent(state: GameState, ctx: Ctx): GameState | undefined {
  const b = state.battle;
  const index = nextTroopPage(state, ctx);
  const page = index === undefined || b === undefined ? undefined : ctx.project.troop(b.troopId)?.pages[index];
  if (b === undefined || index === undefined || page === undefined) return undefined;
  // マップのイベントを待っているインタプリタ（BattleProcessing）とは別に起動する（「通常」は一つだけ、の制限を受けない）
  const interp: InterpreterState = {
    id: `i${state.nextInterpreterId}`,
    origin: { kind: "troop", troopId: b.troopId, page: index },
    mode: "normal",
    commands: page.commands,
    pc: 0,
    wait: { kind: "none" },
    branch: {},
    callStack: [],
    locals: {},
  };
  return {
    ...state,
    battle: { ...b, eventPagesRun: [...(b.eventPagesRun ?? []), index] },
    nextInterpreterId: state.nextInterpreterId + 1,
    interpreters: [...state.interpreters, interp],
  };
}

/** バトルイベントのインタプリタだけを 1 フレーム進める（マップのイベントは戦闘の間は止まったまま）。 */
function runTroopEvents(state: GameState, input: InputFrame, ctx: Ctx): StepResult {
  const others = state.interpreters.filter((i) => !isTroopEvent(i));
  const ran = runInterpreters({ ...state, interpreters: state.interpreters.filter(isTroopEvent) }, input, ctx);
  return { state: { ...ran.state, interpreters: [...others, ...ran.state.interpreters] }, effects: ran.effects };
}

/**
 * 戦闘シーンの時間経過。バトルイベントが動いている間はそれだけを進め、戦闘（行動の解決・ターン）は止まる。
 * そうでなければ戦闘を 1 フレーム進め、条件を満たすページがあれば、そのフレームのうちにイベントを動かし始める。
 * 「戦闘の中断」が済んだら（イベントが終わったところで）戦闘から抜ける。
 */
export function battleSceneTick(state: GameState, input: InputFrame, ctx: Ctx): StepResult {
  if (battleEventRunning(state)) {
    const r = runTroopEvents(agePopups(state), input, ctx);
    return finishAbort(r, ctx);
  }
  const ticked = battleTick(state, ctx);
  if (ticked.state.scene.kind !== "battle") return ticked;
  const started = startTroopEvent(ticked.state, ctx);
  if (started === undefined) return finishAbort(ticked, ctx);
  const r = runTroopEvents(started, input, ctx);
  return finishAbort({ state: r.state, effects: [...ticked.effects, ...r.effects] }, ctx);
}

function finishAbort(r: StepResult, ctx: Ctx): StepResult {
  const s = r.state;
  if (s.scene.kind !== "battle" || s.battle?.phase !== "aborted" || battleEventRunning(s)) return r;
  const left = leaveBattle(s, ctx);
  return { state: left.state, effects: [...r.effects, ...left.effects] };
}
