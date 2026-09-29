import type { EventCommand } from "@rpg/schema";
import { emptyInput, initialState, inputFrame, startInterpreter, step } from "@rpg/core";
import type { Ctx, Effect, GameState, InputFrame } from "@rpg/core";
import { loadFixtureProject } from "./project.js";

/** コマンド1行を簡潔に書くためのヘルパ。 */
export const cmd = (code: string, params: Record<string, unknown> = {}, indent = 0): EventCommand => ({ code, params, indent });

export interface RunCommandsOptions {
  /** 既定は fixtures の `minimal`。 */
  ctx?: Ctx;
  /** 既定は `initialState(ctx, "harness")`。 */
  state?: GameState;
  mode?: "normal" | "parallel";
  /** これを超えても終わらなければ `finished: false` で返す。既定 600。 */
  maxFrames?: number;
  /**
   * フレームごとの入力。既定は「メッセージが開いていれば決定ボタンを押す、それ以外は何もしない」。
   * `frame` は 0 始まり。
   */
  input?: (frame: number, state: GameState) => InputFrame;
}

export interface RunCommandsResult {
  state: GameState;
  /** 全フレームで発行された Effect を発行順に並べたもの。 */
  effects: Effect[];
  /** 実行した `step` の回数。 */
  frames: number;
  /** 全インタプリタが終了したか。 */
  finished: boolean;
  /** 各フレーム終了時点の状態（`history[0]` は 1 フレーム目の結果）。 */
  history: GameState[];
}

const autoDismiss = (_frame: number, state: GameState): InputFrame => (state.message.open ? inputFrame(["ok"], ["ok"]) : emptyInput());

/**
 * コマンド列を与えて、全インタプリタが終わるまで `step` する。
 * 「メッセージを送る」「待つ」「場所移動する」を含むコマンド列でも、実ゲームと同じ経路で完走させられる。
 */
export function runCommands(commands: EventCommand[], options: RunCommandsOptions = {}): RunCommandsResult {
  const ctx = options.ctx ?? loadFixtureProject("minimal").ctx;
  const maxFrames = options.maxFrames ?? 600;
  const input = options.input ?? autoDismiss;

  let state = startInterpreter(
    options.state ?? initialState(ctx, "harness"),
    { kind: "plugin", name: "interpreterHarness" },
    commands,
    options.mode ?? "normal",
  );
  const effects: Effect[] = [];
  const history: GameState[] = [];
  let frames = 0;
  while (frames < maxFrames && state.interpreters.length > 0) {
    const r = step(state, input(frames, state), ctx);
    state = r.state;
    effects.push(...r.effects);
    history.push(state);
    frames++;
  }
  return { state, effects, frames, finished: state.interpreters.length === 0, history };
}
